/** Default RPC endpoints, shared by the app config and the security headers. */
export const DEFAULT_RPC = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
} as const;

/** The RPC this build talks to, from the same environment variables the app reads. */
export function rpcUrlFor(networkId: string | undefined, override: string | undefined): string {
  if (override) return override;
  return networkId === "mainnet" ? DEFAULT_RPC.mainnet : DEFAULT_RPC.testnet;
}
