import type { StreamRecord } from "@/lib/csv";
import { vestedSmooth } from "@/lib/money";

/** Withdrawable right now, ticking between chain reads. */
export function availableNow(s: StreamRecord, nowMs: number): bigint {
  const v = vestedSmooth(BigInt(s.deposit), s.start, s.stop, nowMs) - BigInt(s.withdrawn);
  return v > 0n ? v : 0n;
}

/** USDC base units per day. */
export function ratePerDay(s: StreamRecord): bigint {
  return (BigInt(s.deposit) * 86_400n) / BigInt(Math.max(1, s.stop - s.start));
}

export function progress(s: StreamRecord, nowMs: number): number {
  const now = nowMs / 1000;
  if (now <= s.start) return 0;
  if (now >= s.stop) return 1;
  return (now - s.start) / (s.stop - s.start);
}

export function statusOf(s: StreamRecord, nowMs: number): "scheduled" | "streaming" | "finished" {
  const now = nowMs / 1000;
  return now < s.start ? "scheduled" : now < s.stop ? "streaming" : "finished";
}

export const fmtDate = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
