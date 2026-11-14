import { NextResponse, type NextRequest } from "next/server";
import { newNonce, pageCsp } from "./lib/csp";
import { rpcUrlFor } from "./lib/rpc";

const rpcOrigin = new URL(rpcUrlFor(process.env.NEXT_PUBLIC_NETWORK, process.env.NEXT_PUBLIC_RPC_URL)).origin;
const isDev = process.env.NODE_ENV === "development";

/**
 * Gives every page request its own nonce. Next.js reads it from the request's CSP header
 * and puts it on its scripts; the root layout puts it on the theme script.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = pageCsp({ nonce, rpcOrigin, isDev });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: API routes, build files and images get their own fixed policy.
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
