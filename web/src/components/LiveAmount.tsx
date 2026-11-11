"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { splitUsdc } from "@/lib/money";

const COUNT_MS = 700;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

type SpanRef = RefObject<HTMLSpanElement | null>;

/** Writes an amount into its two spans, touching the DOM only when the text changes. */
function paint(main: SpanRef, tail: SpanRef, units: bigint) {
  const [m, t] = splitUsdc(units);
  if (main.current && main.current.textContent !== m) main.current.textContent = m;
  if (tail.current && tail.current.textContent !== t) tail.current.textContent = t;
}

function AmountSpans({ main, tail, initial, className = "" }: { main: SpanRef; tail: SpanRef; initial: bigint; className?: string }) {
  const [m, t] = splitUsdc(initial);
  return (
    <span className={`num ${className}`}>
      <span ref={main}>{m}</span>
      <span ref={tail} className="opacity-40">
        {t}
      </span>
    </span>
  );
}

/**
 * An amount that changes every frame, like salary accruing. It writes straight to the DOM
 * so a ticking number never re-renders the page around it.
 */
export function LiveAmount({ amountAt, className }: { amountAt: (nowMs: number) => bigint; className?: string }) {
  const main = useRef<HTMLSpanElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const latest = useRef(amountAt);

  useEffect(() => {
    latest.current = amountAt;
  });

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      paint(main, tail, latest.current(Date.now()));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return <AmountSpans main={main} tail={tail} initial={0n} className={className} />;
}

/** A settled amount that counts to its new value when it changes, e.g. after a withdrawal. */
export function CountAmount({ value, className }: { value: bigint; className?: string }) {
  const main = useRef<HTMLSpanElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  // React renders the first value only; later values are painted by the count animation.
  const [initial] = useState(value);

  useEffect(() => {
    const from = shown.current;
    if (from === value) return;
    const started = performance.now();
    const span = Number(value - from);
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - started) / COUNT_MS);
      const current = progress === 1 ? value : from + BigInt(Math.round(span * easeOutCubic(progress)));
      shown.current = current;
      paint(main, tail, current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <AmountSpans main={main} tail={tail} initial={initial} className={className} />;
}
