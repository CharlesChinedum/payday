import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { clientIp, ipv6Prefix } = await import("./http");

const req = (ip: string) => new Request("http://x", { headers: { "x-forwarded-for": ip } });

describe("clientIp (N-03)", () => {
  it("keys IPv4 clients by address", () => {
    expect(clientIp(req("203.0.113.7, 10.0.0.1"))).toBe("203.0.113.7");
  });

  it("keys every address in one IPv6 /64 the same", () => {
    const a = clientIp(req("2001:db8:abcd:12:1::1"));
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(clientIp(req("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff"))).toBe(a);
    expect(clientIp(req("[2001:db8:abcd:12::9]:443"))).toBe(a);
  });

  it("expands :: wherever it sits", () => {
    expect(ipv6Prefix("::1")).toBe("0:0:0:0::/64");
    expect(ipv6Prefix("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipv6Prefix("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
});
