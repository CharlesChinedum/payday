export type NetworkId = "testnet" | "mainnet";

export interface NetworkConfig {
  networkId: NetworkId;
  rpcUrl: string;
  payday: string;
  usdc: string;
  explorer: string;
  /** Mainnet asset id of the token workers cash out from (1Click `originAsset`). */
  originAsset: string;
  /** A long-running public stream the landing page shows live, where one exists. */
  demoStreamId?: number;
}

const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    networkId: "testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    payday: "app.payday-dev.testnet",
    usdc: "usdc.payday-dev.testnet",
    explorer: "https://testnet.nearblocks.io",
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    demoStreamId: 1,
  },
  mainnet: {
    networkId: "mainnet",
    rpcUrl: "https://free.rpc.fastnear.com",
    payday: process.env.NEXT_PUBLIC_PAYDAY_MAINNET ?? "",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    explorer: "https://nearblocks.io",
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
};

const networkId = (process.env.NEXT_PUBLIC_NETWORK as NetworkId | undefined) ?? "testnet";

export const config: NetworkConfig = NETWORKS[networkId];

export const USDC_DECIMALS = 6;
export const ONE_USDC = 1_000_000n;
export const ONE_YOCTO = 1n;
export const TGAS = 1_000_000_000_000n;

/** Destinations a worker can cash out to through NEAR Intents 1Click. */
export const CASH_OUT_ASSETS = [
  { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", label: "USDC on Base", kind: "evm" },
  { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", label: "USDC on Arbitrum", kind: "evm" },
  { id: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", label: "USDC on Ethereum", kind: "evm" },
  { id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", label: "USDC on Solana", kind: "solana" },
  { id: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", label: "USDT on Tron", kind: "tron" },
] as const;

export type CashOutAsset = (typeof CASH_OUT_ASSETS)[number];

export function txUrl(hash: string): string {
  return `${config.explorer}/txns/${hash}`;
}

export function accountUrl(accountId: string): string {
  return `${config.explorer}/address/${accountId}`;
}
