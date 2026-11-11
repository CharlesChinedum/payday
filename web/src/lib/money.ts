import { USDC_DECIMALS } from "./config";

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** "1234.5" -> 1234500000n. Throws on more than 6 decimals or anything not a number. */
export function parseUsdc(input: string): bigint {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m) throw new Error(`"${input}" is not a USDC amount`);
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

/** 1234500000n -> "1,234.50" (at least 2 decimals, up to `decimals`). */
export function formatUsdc(units: bigint, decimals = 2): string {
  const whole = units / SCALE;
  const frac = (units % SCALE).toString().padStart(USDC_DECIMALS, "0").slice(0, decimals);
  const trimmed = frac.replace(/0+$/, "").padEnd(Math.min(2, decimals), "0");
  return `${whole.toLocaleString("en-US")}${trimmed ? `.${trimmed}` : ""}`;
}

/** Plain decimal for CSV: no thousands separators, all 6 decimals. */
export function usdcDecimal(units: bigint): string {
  return `${units / SCALE}.${(units % SCALE).toString().padStart(USDC_DECIMALS, "0")}`;
}

/** Same linear vesting as the contract, so the UI can tick between reads. */
export function vestedAt(deposit: bigint, start: number, stop: number, nowSecs: number): bigint {
  if (nowSecs <= start) return 0n;
  if (nowSecs >= stop) return deposit;
  const duration = BigInt(stop - start);
  const elapsed = BigInt(Math.floor(nowSecs - start));
  return (deposit * elapsed) / duration;
}

/** Fractional-second precision for a smooth counter; never exceeds the deposit. */
export function vestedSmooth(deposit: bigint, start: number, stop: number, nowMs: number): bigint {
  const now = nowMs / 1000;
  if (now <= start) return 0n;
  if (now >= stop) return deposit;
  const durationMs = BigInt((stop - start) * 1000);
  const elapsedMs = BigInt(Math.floor(nowMs - start * 1000));
  return (deposit * elapsedMs) / durationMs;
}
