"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CURRENCIES, formatLocal, guessCurrency, toLocal, type Rates } from "@/lib/rates";

const KEY = "payday:currency";
/** Stored when the visitor turns local amounts off. */
const OFF = "off";

let ratesPromise: Promise<Rates | null> | null = null;
/** One request per page load, shared by every amount on the page. */
function loadRates(): Promise<Rates | null> {
  ratesPromise ??= fetch("/api/rates")
    .then((r) => (r.ok ? (r.json() as Promise<Rates>) : null))
    .catch(() => null);
  return ratesPromise;
}

export function useRates(): Rates | null {
  const [rates, setRates] = useState<Rates | null>(null);
  useEffect(() => {
    let live = true;
    loadRates().then((r) => live && setRates(r));
    return () => {
      live = false;
    };
  }, []);
  return rates;
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  // Prerendered as "none"; re-read the visitor's choice once hydrated.
  fn();
  return () => listeners.delete(fn);
}

function readCurrency(): string | null {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === OFF) return null;
    if (stored && CURRENCIES.some((c) => c.code === stored)) return stored;
  } catch {
    // Fall through to a guess.
  }
  return guessCurrency(navigator.languages ?? [navigator.language]);
}

/** The visitor's local currency: chosen, or guessed from the browser's language; null if off. */
export function useCurrency(): [string | null, (code: string | null) => void] {
  const code = useSyncExternalStore(subscribe, readCurrency, () => null);
  const set = (next: string | null) => {
    try {
      localStorage.setItem(KEY, next ?? OFF);
    } catch {
      // Applies to this page view only.
    }
    listeners.forEach((fn) => fn());
  };
  return [code, set];
}

/** "≈ ₦1,349,823" next to a USDC amount, or nothing if no currency is chosen or rates are missing. */
export function LocalAmount({ units, className = "" }: { units: bigint; className?: string }) {
  const [code] = useCurrency();
  const rates = useRates();
  const rate = code && rates?.perUsd[code];
  if (!rate) return null;
  return <span className={`num ${className}`}>≈ {formatLocal(toLocal(units, rate), code)}</span>;
}

/** A compact select for the local currency, with "USDC only" to turn it off. */
export function CurrencyPicker({ className = "" }: { className?: string }) {
  const [code, setCode] = useCurrency();
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs ${className}`}>
      <span className="opacity-70">Show in</span>
      <select
        aria-label="Local currency"
        className="rounded-lg border border-current/20 bg-transparent px-1.5 py-1 text-xs"
        value={code ?? OFF}
        onChange={(e) => setCode(e.target.value === OFF ? null : e.target.value)}
      >
        <option value={OFF}>USDC only</option>
        {CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} · {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Where the rate comes from and how old it is: required attribution, and honest about accuracy. */
export function RateNote({ className = "" }: { className?: string }) {
  const [code] = useCurrency();
  const rates = useRates();
  const rate = code && rates?.perUsd[code];
  if (!rate || !rates) return null;
  const day = new Date(rates.updated * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <p className={`text-xs opacity-70 ${className}`}>
      1 USDC ≈ {formatLocal(rate, code)} at the {day} mid-market rate (
      <a className="underline underline-offset-2" href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
        Rates By Exchange Rate API
      </a>
      ). What your bank or exchange pays can differ.
    </p>
  );
}
