"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { formatUsdc } from "@/lib/money";
import { LiveAmount } from "../LiveAmount";
import { LiveDot } from "../ui";

const SECONDS_PER_MONTH = 30 * 86_400;
const UNITS_PER_USDC = 1_000_000;
const SALARY = { min: 500, max: 12_000, step: 100, initial: 3_000 };

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span>{label}</span>
      <span className="flex-1 border-b border-dotted border-paper-rule" aria-hidden="true" />
      <span className="num">{children}</span>
    </div>
  );
}

/**
 * A payslip that fills in while you watch. The figure is an illustration driven by the
 * slider, not chain data; it accrues at exactly the rate the contract would stream.
 */
export function HeroPayslip() {
  const [monthly, setMonthly] = useState(SALARY.initial);
  const unitsPerSecond = (monthly * UNITS_PER_USDC) / SECONDS_PER_MONTH;
  const meter = useRef({ earnedUnits: 0, lastMs: 0 });

  // Accumulating per frame keeps what was already earned when the salary changes.
  const earnedAt = useCallback(
    (nowMs: number) => {
      const m = meter.current;
      if (m.lastMs > 0) m.earnedUnits += (unitsPerSecond * (nowMs - m.lastMs)) / 1000;
      m.lastMs = nowMs;
      return BigInt(Math.floor(m.earnedUnits));
    },
    [unitsPerSecond],
  );

  return (
    <div className="group relative mx-auto w-full max-w-sm [perspective:1200px]">
      <div className="payslip-edge bg-paper px-6 pb-7 pt-6 text-paper-ink shadow-lift transition-transform duration-500 ease-out group-hover:-translate-y-1">
        <div className="flex items-center justify-between text-xs font-medium">
          <span className="opacity-60">Payslip</span>
          <span className="inline-flex items-center gap-2">
            <LiveDot /> Streaming
          </span>
        </div>

        <div className="my-4 border-t border-paper-rule" />

        <label className="block text-xs">
          <span className="flex items-baseline justify-between">
            <span>Monthly salary</span>
            <span className="num text-sm font-medium">{monthly.toLocaleString("en-US")} USDC</span>
          </span>
          <input
            type="range"
            min={SALARY.min}
            max={SALARY.max}
            step={SALARY.step}
            value={monthly}
            onChange={(e) => setMonthly(Number(e.target.value))}
            className="mt-2 w-full cursor-grab accent-[var(--lime)] active:cursor-grabbing"
          />
        </label>

        <div className="mt-4 space-y-2 text-xs">
          <Line label="Per second">{formatUsdc(BigInt(Math.round(unitsPerSecond)), 6)}</Line>
          <Line label="Per day">{formatUsdc(BigInt(Math.round(unitsPerSecond * 86_400)))}</Line>
        </div>

        <div className="my-4 border-t border-paper-rule" />

        <p className="text-xs font-medium opacity-60">Earned since you opened this page</p>
        <p className="mt-1 text-4xl font-medium tracking-tight">
          <LiveAmount amountAt={earnedAt} />
        </p>

        <div className="my-4 border-t border-paper-rule" />

        <div className="space-y-2 text-xs">
          <Line label="Gas paid by worker">0.00 NEAR</Line>
          <Line label="Wait until month-end">none</Line>
        </div>
      </div>
      <p className="mt-4 text-center text-xs text-muted">Drag the salary. This is the rate Payday streams on-chain.</p>
    </div>
  );
}
