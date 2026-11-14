"use client";

import { useSyncExternalStore } from "react";

const TICKS = 60;

/** The current second of the minute, updated each second; -1 on the server or with reduced motion. */
function subscribe(onChange: () => void) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const id = setInterval(onChange, 1000);
  return () => clearInterval(id);
}
const currentSecond = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? -1 : new Date().getSeconds();
const noSecond = () => -1;

/**
 * Payday's signature: a ruler of the 60 seconds in a minute, the current one lit in gold.
 * It is what a salary on Payday does: it moves on every tick, not once a month.
 */
export function SecondsRuler() {
  const second = useSyncExternalStore(subscribe, currentSecond, noSecond);
  return (
    <div className="pointer-events-none select-none" aria-hidden="true">
      <div className="flex h-7 items-end justify-between">
        {Array.from({ length: TICKS }, (_, i) => {
          const major = i % 5 === 0;
          const lit = i === second;
          const passed = second >= 0 && i < second;
          return (
            <span
              key={i}
              className={`w-0.5 rounded-full transition-[height,background-color] duration-300 ${
                lit ? "h-7 bg-lime" : major ? "h-4" : "h-2.5"
              } ${lit ? "" : passed ? "bg-text/45" : major ? "bg-text/30" : "bg-text/18"}`}
            />
          );
        })}
      </div>
      <div className="num relative mt-2 h-4 text-[11px] text-muted">
        <span className="absolute left-0">:00</span>
        <span className="absolute right-0">:59</span>
        {second > 2 && second < 57 && (
          <span
            className="absolute -translate-x-1/2 text-gold transition-[left] duration-300"
            style={{ left: `${(second / (TICKS - 1)) * 100}%` }}
          >
            :{String(second).padStart(2, "0")}
          </span>
        )}
      </div>
    </div>
  );
}
