import { validateMnemonic } from "bip39-light";
import { KeyPair, type KeyPairString } from "near-api-js";
import { generateSeedPhrase, parseSeedPhrase } from "near-api-js/seed-phrase";
import { config } from "./config";

export type Role = "employer" | "worker";

/**
 * Each role's key lives in this browser's localStorage. New keys come from a 12-word
 * recovery phrase, stored alongside so it can be shown for backup; keys created before
 * phrases existed back up as the raw secret key.
 */
const keyItem = (role: Role) => `payday:${config.networkId}:key:${role}`;
const phraseItem = (role: Role) => `payday:${config.networkId}:phrase:${role}`;
const backedUpItem = (role: Role) => `payday:${config.networkId}:backed-up:${role}`;

export type Backup = { kind: "phrase"; words: string[] } | { kind: "key"; secret: string };

function read(item: string): string | null {
  try {
    return localStorage.getItem(item);
  } catch {
    return null;
  }
}

/** The role's key if this browser has one. */
export function readKey(role: Role): KeyPair | null {
  const saved = read(keyItem(role));
  return saved ? KeyPair.fromString(saved as KeyPairString) : null;
}

function store(role: Role, keyPair: KeyPair, phrase: string | null) {
  localStorage.setItem(keyItem(role), keyPair.toString());
  if (phrase) localStorage.setItem(phraseItem(role), phrase);
  else localStorage.removeItem(phraseItem(role));
  localStorage.removeItem(backedUpItem(role));
}

/**
 * The role's key, created on first use. Creation runs under a Web Lock and re-reads
 * storage inside it, so two tabs opened at once end up with the same key.
 */
export async function loadOrCreateKey(role: Role): Promise<KeyPair> {
  const create = () => {
    const existing = readKey(role);
    if (existing) return existing;
    const { seedPhrase, keyPair } = generateSeedPhrase();
    store(role, keyPair, seedPhrase);
    return keyPair;
  };
  try {
    localStorage.getItem(keyItem(role));
  } catch {
    throw new Error("This browser blocks local storage, so Payday cannot keep your key.");
  }
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`payday-key-${role}`, async () => create());
  }
  return create();
}

export function backupOf(role: Role): Backup | null {
  const phrase = read(phraseItem(role));
  if (phrase) return { kind: "phrase", words: phrase.split(" ") };
  const key = read(keyItem(role));
  return key ? { kind: "key", secret: key } : null;
}

export function isBackedUp(role: Role): boolean {
  return read(backedUpItem(role)) === "yes";
}

export function markBackedUp(role: Role) {
  localStorage.setItem(backedUpItem(role), "yes");
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
export function restoreKey(role: Role, input: string): KeyPair {
  const { keyPair, phrase } = parseBackup(input);
  store(role, keyPair, phrase);
  markBackedUp(role);
  return keyPair;
}
