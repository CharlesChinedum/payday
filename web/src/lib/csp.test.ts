import { describe, expect, it } from "vitest";
import { API_CSP, newNonce, pageCsp } from "./csp";

const directives = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0], d] as const));

describe("content security policy (I-01)", () => {
  it("lets only nonce-carrying scripts run in production, never inline ones", () => {
    const csp = directives(pageCsp({ nonce: "abc123==", rpcOrigin: "https://rpc.example", isDev: false }));
    const scripts = csp.get("script-src")!;
    expect(scripts).toContain("'nonce-abc123=='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
    expect(csp.get("connect-src")).toBe("connect-src 'self' https://rpc.example");
    expect(csp.get("object-src")).toBe("object-src 'none'");
    expect(csp.get("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(csp.get("base-uri")).toBe("base-uri 'none'");
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("allows eval and the dev server's socket only in development", () => {
    const csp = directives(pageCsp({ nonce: "n", rpcOrigin: "https://rpc.example", isDev: true }));
    expect(csp.get("script-src")).toContain("'unsafe-eval'");
    expect(csp.get("connect-src")).toContain("ws:");
  });

  it("issues a fresh 128-bit nonce per request, and API responses allow nothing", () => {
    const a = newNonce();
    expect(atob(a)).toHaveLength(16);
    expect(newNonce()).not.toBe(a);
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
