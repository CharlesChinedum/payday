import { base58 } from "@scure/base";
import { validateMnemonic } from "bip39-light";
import { KeyPair, KeyPairSigner, PublicKey, Signer, type KeyPairString } from "near-api-js";
import { generateSeedPhrase, parseSeedPhrase } from "near-api-js/seed-phrase";
import { config } from "./config";

export type Role = "employer" | "worker";

/** A browser account: something that signs, and the implicit account it controls. */
export interface BrowserKey {
  signer: Signer;
  publicKey: PublicKey;
  accountId: string;
}

export type Backup = { kind: "phrase"; words: string[] } | { kind: "key"; secret: string };

/**
 * Where keys live (H-05). Each role's signing key is a non-extractable WebCrypto Ed25519
 * key in IndexedDB: pages can ask the browser to sign with it, but no script, extension
 * or storage dump can read it out. The recovery phrase is kept in localStorage only until
 * the user confirms they saved it, then deleted. Browsers without WebCrypto Ed25519 keep
 * the old localStorage key on test networks and are refused on mainnet.
 */
const ns = `payday:${config.networkId}`;
const accountItem = (role: Role) => `${ns}:account:${role}`;
const pendingBackupItem = (role: Role) => `${ns}:backup:${role}`;
const backedUpItem = (role: Role) => `${ns}:backed-up:${role}`;
/** The pre-WebCrypto layout: the secret key and phrase in plain localStorage. */
const legacyKeyItem = (role: Role) => `${ns}:key:${role}`;
const legacyPhraseItem = (role: Role) => `${ns}:phrase:${role}`;
const recordId = (role: Role) => `${config.networkId}:${role}`;

export interface KeyRecord {
  publicKey: string;
  privateKey: CryptoKey;
}

/** Persistent storage for key records; IndexedDB in browsers, swappable in tests. */
export interface KeyStore {
  available(): boolean;
  get(id: string): Promise<KeyRecord | undefined>;
  put(id: string, record: KeyRecord): Promise<void>;
}

const DB_NAME = "payday";
const DB_STORE = "keys";

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
    open.onerror = () => reject(open.error ?? new Error("Could not open this browser's key store"));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(DB_STORE, mode);
      const req = run(tx.objectStore(DB_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result as T);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error("This browser's key store failed"));
      };
    };
  });
}

const indexedDbStore: KeyStore = {
  available: () => typeof indexedDB !== "undefined",
  get: (id) => request<KeyRecord | undefined>("readonly", (s) => s.get(id)),
  put: (id, record) => request<void>("readwrite", (s) => s.put(record, id)),
};

let records: KeyStore = indexedDbStore;

/** Tests only: replace IndexedDB with another store. */
export function setKeyStore(store: KeyStore) {
  records = store;
  support = null;
}

/** Signs with a key the page cannot read. */
class CryptoKeySigner extends Signer {
  readonly #privateKey: CryptoKey;
  readonly #publicKey: PublicKey;

  constructor(privateKey: CryptoKey, publicKey: PublicKey) {
    super();
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.#publicKey;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign("Ed25519", this.#privateKey, bytes as BufferSource));
  }
}

/** The implicit account a public key controls: its 32 bytes in hex. */
export function accountIdOf(publicKey: PublicKey): string {
  if (!publicKey.ed25519Key) throw new Error("Expected an ed25519 key");
  return Array.from(publicKey.ed25519Key.data, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 8410 PKCS#8 wrapping of a 32-byte Ed25519 seed. */
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** Moves a key pair into WebCrypto as a non-extractable signing key. */
export async function importSigningKey(keyPair: KeyPair): Promise<CryptoKey> {
  const secret = base58.decode(keyPair.toString().split(":")[1]);
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(secret.subarray(0, 32), 16);
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  } finally {
    pkcs8.fill(0);
    secret.fill(0);
  }
}

let support: Promise<boolean> | null = null;

/** Whether this browser can hold keys the safe way: IndexedDB and WebCrypto Ed25519 that verifies. */
function canHoldKeysSafely(): Promise<boolean> {
  support ??= (async () => {
    if (!records.available() || typeof crypto === "undefined" || !crypto.subtle) return false;
    try {
      const probe = KeyPair.fromRandom("ed25519");
      const key = await importSigningKey(probe);
      const message = new Uint8Array([1, 2, 3]);
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, message));
      return probe.getPublicKey().verify(message, signature);
    } catch {
      return false;
    }
  })();
  return support;
}

function read(item: string): string | null {
  try {
    return localStorage.getItem(item);
  } catch {
    return null;
  }
}

function browserKey(publicKey: PublicKey, privateKey: CryptoKey): BrowserKey {
  return { signer: new CryptoKeySigner(privateKey, publicKey), publicKey, accountId: accountIdOf(publicKey) };
}

/**
 * Stores a key the safe way. The record is written before anything is removed, so a crash
 * part-way leaves the old copy in place rather than no key at all.
 */
async function save(role: Role, keyPair: KeyPair, backup: string | null, backedUp: boolean): Promise<BrowserKey> {
  const privateKey = await importSigningKey(keyPair);
  const publicKey = keyPair.getPublicKey();
  await records.put(recordId(role), { publicKey: publicKey.toString(), privateKey });
  const key = browserKey(publicKey, privateKey);
  localStorage.setItem(accountItem(role), key.accountId);
  if (backedUp) {
    localStorage.setItem(backedUpItem(role), "yes");
    localStorage.removeItem(pendingBackupItem(role));
  } else {
    localStorage.removeItem(backedUpItem(role));
    if (backup) localStorage.setItem(pendingBackupItem(role), backup);
  }
  localStorage.removeItem(legacyKeyItem(role));
  localStorage.removeItem(legacyPhraseItem(role));
  return key;
}

/** Browsers without WebCrypto Ed25519: the old localStorage key, never on mainnet. */
function legacyKey(keyPair: KeyPair): BrowserKey {
  const publicKey = keyPair.getPublicKey();
  return { signer: new KeyPairSigner(keyPair), publicKey, accountId: accountIdOf(publicKey) };
}

function refuseUnsafeBrowser() {
  if (config.networkId === "mainnet") {
    throw new Error("This browser cannot keep a key safely. Use a current Chrome, Edge, Firefox or Safari.");
  }
}

async function loadOrCreate(role: Role): Promise<BrowserKey> {
  if (!(await canHoldKeysSafely())) {
    refuseUnsafeBrowser();
    const saved = read(legacyKeyItem(role));
    if (saved) return legacyKey(KeyPair.fromString(saved as KeyPairString));
    const { seedPhrase, keyPair } = generateSeedPhrase();
    localStorage.setItem(legacyKeyItem(role), keyPair.toString());
    localStorage.setItem(legacyPhraseItem(role), seedPhrase);
    localStorage.removeItem(backedUpItem(role));
    return legacyKey(keyPair);
  }

  const record = await records.get(recordId(role));
  if (record) {
    const key = browserKey(PublicKey.fromString(record.publicKey), record.privateKey);
    if (read(accountItem(role)) !== key.accountId) localStorage.setItem(accountItem(role), key.accountId);
    return key;
  }
  // Migrate a key from the old layout, keeping its phrase (or secret) only if not yet backed up.
  const legacy = read(legacyKeyItem(role));
  if (legacy) {
    const keyPair = KeyPair.fromString(legacy as KeyPairString);
    return save(role, keyPair, read(legacyPhraseItem(role)) ?? keyPair.toString(), isBackedUp(role));
  }
  const { seedPhrase, keyPair } = generateSeedPhrase();
  return save(role, keyPair, seedPhrase, false);
}

/**
 * The role's key, created (or migrated) on first use. Runs under a Web Lock, re-reading
 * storage inside it, so two tabs opened at once end up with the same key.
 */
export async function loadOrCreateKey(role: Role): Promise<BrowserKey> {
  try {
    localStorage.getItem(accountItem(role));
  } catch {
    throw new Error("This browser blocks local storage, so Payday cannot keep your key.");
  }
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`payday-key-${role}`, () => loadOrCreate(role));
  }
  return loadOrCreate(role);
}

/** The role's account id in this browser, if it has one; synchronous, for display. */
export function readAccountId(role: Role): string | null {
  const id = read(accountItem(role));
  if (id) return id;
  const legacy = read(legacyKeyItem(role));
  return legacy ? accountIdOf(KeyPair.fromString(legacy as KeyPairString).getPublicKey()) : null;
}

/** The phrase (or, for older accounts, the secret key) while it is still kept for backup. */
export function backupOf(role: Role): Backup | null {
  const text = read(pendingBackupItem(role)) ?? read(legacyPhraseItem(role)) ?? read(legacyKeyItem(role));
  if (!text) return null;
  return text.startsWith("ed25519:") ? { kind: "key", secret: text } : { kind: "phrase", words: text.split(" ") };
}

export function isBackedUp(role: Role): boolean {
  return read(backedUpItem(role)) === "yes";
}

/** The user saved their copy: the browser's copy of the phrase is deleted. */
export function markBackedUp(role: Role) {
  localStorage.setItem(backedUpItem(role), "yes");
  localStorage.removeItem(pendingBackupItem(role));
}

/** Parses a recovery phrase or an `ed25519:` secret key; throws a readable error. */
export function parseBackup(input: string): { keyPair: KeyPair; phrase: string | null } {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.startsWith("ed25519:")) {
    try {
      return { keyPair: KeyPair.fromString(text as KeyPairString), phrase: null };
    } catch {
      throw new Error("That secret key is not valid");
    }
  }
  const phrase = text.toLowerCase();
  if (phrase.split(" ").length !== 12) {
    throw new Error("Enter your 12-word recovery phrase, or a secret key starting with ed25519:");
  }
  // parseSeedPhrase derives a key from any words at all, so a typo would silently open
  // a different, empty account. The BIP-39 checksum catches it.
  if (!validateMnemonic(phrase)) throw new Error("That recovery phrase has a typo: check each word");
  return { keyPair: parseSeedPhrase(phrase), phrase };
}

/** Replaces this browser's key for the role with a restored one. */
export async function restoreKey(role: Role, input: string): Promise<BrowserKey> {
  const { keyPair, phrase } = parseBackup(input);
  if (await canHoldKeysSafely()) return save(role, keyPair, null, true);
  refuseUnsafeBrowser();
  localStorage.setItem(legacyKeyItem(role), keyPair.toString());
  if (phrase) localStorage.setItem(legacyPhraseItem(role), phrase);
  else localStorage.removeItem(legacyPhraseItem(role));
  markBackedUp(role);
  return legacyKey(keyPair);
}
