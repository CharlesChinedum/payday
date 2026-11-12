import { DEFAULT_RPC } from "./rpc";

export type NetworkId = "testnet" | "mainnet" | "localnet";

export interface NetworkConfig {
  networkId: NetworkId;
  rpcUrl: string;
  payday: string;
  usdc: string;
  /** Block explorer, if the network has one. */
  explorer: string | null;
  /** Mainnet asset id of the token workers cash out from (1Click `originAsset`). */
  originAsset: string;
  /** Test networks mint mock USDC through `/api/faucet`. */
  hasFaucet: boolean;
  /** A long-running public stream the landing page shows live, where one exists. */
  demoStreamId?: number;
  /** A Sputnik DAO that pays through Payday, shown on the DAO payroll page. */
  demoDao?: string;
}


const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ORIGIN_ASSET = `nep141:${MAINNET_USDC}`;

// Next.js inlines NEXT_PUBLIC_* only where they are written out literally, so each is
// read here by name rather than through a helper.
function buildConfig(): NetworkConfig {
  const networkId = process.env.NEXT_PUBLIC_NETWORK ?? "testnet";
  switch (networkId) {
    case "testnet":
      return {
        networkId,
        rpcUrl: DEFAULT_RPC.testnet,
        payday: "app.payday-dev.testnet",
        usdc: "usdc.payday-dev.testnet",
        explorer: "https://testnet.nearblocks.io",
        originAsset: ORIGIN_ASSET,
        hasFaucet: true,
        demoStreamId: 1,
      };
    case "mainnet":
      return {
        networkId,
        rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC.mainnet,
        payday: required("NEXT_PUBLIC_PAYDAY", process.env.NEXT_PUBLIC_PAYDAY),
        usdc: MAINNET_USDC,
        explorer: "https://nearblocks.io",
        originAsset: ORIGIN_ASSET,
        hasFaucet: false,
      };
    case "localnet":
      return {
        networkId,
        rpcUrl: required("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL),
        payday: required("NEXT_PUBLIC_PAYDAY", process.env.NEXT_PUBLIC_PAYDAY),
        usdc: required("NEXT_PUBLIC_USDC", process.env.NEXT_PUBLIC_USDC),
        explorer: null,
        originAsset: ORIGIN_ASSET,
        hasFaucet: true,
      };
    default:
      throw new Error(`NEXT_PUBLIC_NETWORK must be testnet, mainnet or localnet, not "${networkId}"`);
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} must be set for this network`);
  return value;
}

export const config: NetworkConfig = buildConfig();

export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;
export const ONE_YOCTO = 1n;
export const TGAS = 1_000_000_000_000n;

/** Gas each relayed call attaches; the relayer's policy allows exactly these maxima. */
export const GAS_TGAS = {
  payout: 100,
  funding: 150,
} as const;

/** Destinations a worker can cash out to through NEAR Intents 1Click. */
/** Every destination is a 6-decimal dollar stablecoin, so its base units compare 1:1 with USDC's. */
export const CASH_OUT_ASSETS = [
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", label: "USDC on Base", kind: "evm" },
  { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", label: "USDC on Arbitrum", kind: "evm" },
  { id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", label: "USDC on Ethereum", kind: "evm" },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", label: "USDC on Solana", kind: "solana" },
  { id: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", label: "USDT on Tron", kind: "tron" },
] as const;

export type CashOutAsset = (typeof CASH_OUT_ASSETS)[number];

export function txUrl(hash: string): string | null {
  return config.explorer && `${config.explorer}/txns/${hash}`;
}

export function accountUrl(accountId: string): string | null {
  return config.explorer && `${config.explorer}/address/${accountId}`;
}
