/**
 * The pages' Content Security Policy (I-01). Every page is rendered per request with a
 * fresh nonce, and only scripts carrying it (Next.js's own, and what they load) may run:
 * no inline script an attacker manages to inject will execute, there is no third-party
 * code, fetch is limited to this app and the NEAR RPC, and the app cannot be framed.
 * Styles keep 'unsafe-inline' because React style attributes need it; CSS cannot run code.
 */
export function pageCsp({ nonce, rpcOrigin, isDev }: { nonce: string; rpcOrigin: string; isDev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${rpcOrigin}${isDev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** API responses and files are never documents: nothing in them may load or run. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
