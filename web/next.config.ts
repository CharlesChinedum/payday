import type { NextConfig } from "next";
import { rpcUrlFor } from "./src/lib/rpc";

const isDev = process.env.NODE_ENV === "development";
const rpcOrigin = new URL(rpcUrlFor(process.env.NEXT_PUBLIC_NETWORK, process.env.NEXT_PUBLIC_RPC_URL)).origin;

/**
 * Defence in depth, not a guarantee. A nonce-based CSP would force every page to render
 * dynamically, which Partial Prerendering (Cache Components) does not support, so inline
 * scripts stay allowed and the policy does not stop an injected script from running.
 *
 * What it does: loads no third-party scripts, styles or fonts; keeps fetch/XHR to this
 * app and the NEAR RPC; blocks plugins, `<base>` rewrites, cross-site form posts and
 * framing. What it does not: an injected script could still navigate the page elsewhere
 * with data in the URL, or use the key in this browser to sign a transfer through the
 * app's own relayer. The real protection is that no user or third-party content is ever
 * rendered as HTML.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${rpcOrigin}${isDev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
