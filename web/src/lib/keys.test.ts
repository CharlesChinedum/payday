import { beforeEach, describe, expect, it } from "vitest";
import { actions, buildDelegateAction, KeyPair } from "near-api-js";
import { generateSeedPhrase } from "near-api-js/seed-phrase";
import { verifyDelegateSignature } from "./delegate";
import {
  backupOf,
  importSigningKey,
  isBackedUp,
  loadOrCreateKey,
  markBackedUp,
  parseBackup,
  readAccountId,
  restoreKey,
  setKeyStore,
  type BrowserKey,
  type KeyRecord,
} from "./keys";

class MemoryStorage {
  items = new Map<string, string>();
  getItem = (k: string) => this.items.get(k) ?? null;
  setItem = (k: string, v: string) => void this.items.set(k, String(v));
  removeItem = (k: string) => void this.items.delete(k);
}

let storage: MemoryStorage;
let records: Map<string, KeyRecord>;

function useMemoryStores(available = true) {
  storage = new MemoryStorage();
  records = new Map();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  setKeyStore({
    available: () => available,
    get: async (id) => records.get(id),
    put: async (id, record) => void records.set(id, record),
  });
}

/** Signs a delegate the way relayCall does and runs the relayer's own check on it. */
async function relayerAccepts(key: BrowserKey): Promise<boolean> {
  const delegate = buildDelegateAction({
    senderId: key.accountId,
    receiverId: "app.payday.testnet",
    actions: [actions.functionCall("withdraw", { stream_id: 1 }, 50n * 10n ** 12n, 0n)],
    nonce: 1n,
    maxBlockHeight: 100n,
    publicKey: key.publicKey,
  });
  const { signedDelegate } = await key.signer.signDelegateAction(delegate);
  return verifyDelegateSignature(signedDelegate).ok;
}

const LEGACY_KEY = "payday:testnet:key:worker";
const LEGACY_PHRASE = "payday:testnet:phrase:worker";

beforeEach(() => useMemoryStores());

describe("keys the page cannot read (H-05)", () => {
  it("import as non-extractable WebCrypto keys that sign like the original", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const key = await importSigningKey(keyPair);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
    const message = new Uint8Array([7, 7, 7]);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, message));
    expect(keyPair.getPublicKey().verify(message, signature)).toBe(true);
  });

  it("create an account whose key never reaches localStorage, and sign delegates the relayer accepts", async () => {
    const key = await loadOrCreateKey("worker");
    expect(await relayerAccepts(key)).toBe(true);
    expect(readAccountId("worker")).toBe(key.accountId);
    expect([...storage.items.values()].some((v) => v.startsWith("ed25519:"))).toBe(false);
    expect(records.get("testnet:worker")?.privateKey.extractable).toBe(false);
    // The phrase waits for the backup, then is deleted.
    expect(backupOf("worker")?.kind).toBe("phrase");
    markBackedUp("worker");
    expect(backupOf("worker")).toBeNull();
    expect(isBackedUp("worker")).toBe(true);
    const again = await loadOrCreateKey("worker");
    expect(again.accountId).toBe(key.accountId);
    expect(await relayerAccepts(again)).toBe(true);
  });

  it("migrate an old localStorage key to the same account, keeping the phrase only until backed up", async () => {
    const { seedPhrase, keyPair } = generateSeedPhrase();
    storage.setItem(LEGACY_KEY, keyPair.toString());
    storage.setItem(LEGACY_PHRASE, seedPhrase);
    const key = await loadOrCreateKey("worker");
    expect(key.publicKey.toString()).toBe(keyPair.getPublicKey().toString());
    expect(storage.getItem(LEGACY_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_PHRASE)).toBeNull();
    expect(backupOf("worker")).toEqual({ kind: "phrase", words: seedPhrase.split(" ") });
    expect(await relayerAccepts(key)).toBe(true);

    useMemoryStores();
    storage.setItem(LEGACY_KEY, keyPair.toString());
    storage.setItem(LEGACY_PHRASE, seedPhrase);
    storage.setItem("payday:testnet:backed-up:worker", "yes");
    await loadOrCreateKey("worker");
    expect(backupOf("worker")).toBeNull();
    expect(isBackedUp("worker")).toBe(true);
  });

  it("restore from a phrase into the safe store, marked as backed up", async () => {
    await loadOrCreateKey("worker");
    const { seedPhrase, keyPair } = generateSeedPhrase();
    const restored = await restoreKey("worker", seedPhrase);
    expect(restored.publicKey.toString()).toBe(keyPair.getPublicKey().toString());
    expect(readAccountId("worker")).toBe(restored.accountId);
    expect(isBackedUp("worker")).toBe(true);
    expect(backupOf("worker")).toBeNull();
  });

  it("fall back to the old layout on test networks when the browser has no safe store", async () => {
    useMemoryStores(false);
    const key = await loadOrCreateKey("employer");
    expect(storage.getItem("payday:testnet:key:employer")).toMatch(/^ed25519:/);
    expect(readAccountId("employer")).toBe(key.accountId);
    expect(await relayerAccepts(key)).toBe(true);
  });
});

describe("restoring a backup", () => {
  it("restores the same key from its recovery phrase, ignoring case and spacing", () => {
    const { seedPhrase, keyPair } = generateSeedPhrase();
    const restored = parseBackup(`  ${seedPhrase.toUpperCase().split(" ").join("   ")} `);
    expect(restored.keyPair.getPublicKey().toString()).toBe(keyPair.getPublicKey().toString());
    expect(restored.phrase).toBe(seedPhrase);
  });

  it("rejects a phrase with a typo instead of opening a different account", () => {
    // "abandon" ×11 + "about" is a valid phrase; changing its last word breaks the checksum.
    const valid = `${"abandon ".repeat(11)}about`;
    expect(() => parseBackup(valid)).not.toThrow();
    expect(() => parseBackup("abandon ".repeat(12).trim())).toThrow("typo");
  });

  it("accepts a raw secret key and rejects anything else", () => {
    const { keyPair } = generateSeedPhrase();
    expect(parseBackup(keyPair.toString()).keyPair.toString()).toBe(keyPair.toString());
    expect(() => parseBackup("ed25519:nope")).toThrow("not valid");
    expect(() => parseBackup("one two three")).toThrow("12-word");
  });
});
