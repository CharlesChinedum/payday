declare module "bip39-light" {
  /** True if the phrase uses the English word list and its BIP-39 checksum matches. */
  export function validateMnemonic(mnemonic: string): boolean;
}
