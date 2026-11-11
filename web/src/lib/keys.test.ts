import { describe, expect, it } from "vitest";
import { generateSeedPhrase } from "near-api-js/seed-phrase";
import { parseBackup } from "./keys";

describe("restoring a backup", () => {
  it("restores the same key from its recovery phrase, ignoring case and spacing", () => {
    const { seedPhrase, keyPair } = generateSeedPhrase();
    const restored = parseBackup(`  ${seedPhrase.toUpperCase().split(" ").join("   ")} `);
    expect(restored.keyPair.getPublicKey().toString()).toBe(keyPair.getPublicKey().toString());
    expect(restored.phrase).toBe(seedPhrase);
  });

  it("rejects a phrase with a typo instead of opening a different account", () => {
    const words = generateSeedPhrase().seedPhrase.split(" ");
    words[3] = words[3] === "abandon" ? "ability" : "abandon";
    expect(() => parseBackup(words.join(" "))).toThrow("typo");
  });

  it("accepts a raw secret key and rejects anything else", () => {
    const { keyPair } = generateSeedPhrase();
    expect(parseBackup(keyPair.toString()).keyPair.toString()).toBe(keyPair.toString());
    expect(() => parseBackup("ed25519:nope")).toThrow("not valid");
    expect(() => parseBackup("one two three")).toThrow("12-word");
  });
});
