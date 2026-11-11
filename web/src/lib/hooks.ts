"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyPair } from "near-api-js";
import type { StreamRecord } from "./csv";
import { loadOrCreateKey, readKey, type Role } from "./keys";
import { getFees, getOwed, getStreams, getUsdcBalance, implicitId, type Fees } from "./near";

export type AccountState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; keyPair: KeyPair; accountId: string };

/**
 * This browser's account for `role`. The key is created on first use; the on-chain
 * account is created later, the first time it needs to sign something.
 */
export function useRoleAccount(role: Role): AccountState {
  const [state, setState] = useState<AccountState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    loadOrCreateKey(role).then(
      (keyPair) => !cancelled && setState({ status: "ready", keyPair, accountId: implicitId(keyPair) }),
      (e: Error) => !cancelled && setState({ status: "error", error: e.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [role]);
  return state;
}

const noop = () => () => {};

/** The other role's account id in this browser, if that role has been opened before. */
export function useOtherRoleId(role: Role): string | null {
  return useSyncExternalStore(
    noop,
    () => {
      const kp = readKey(role);
      return kp ? implicitId(kp) : null;
    },
    () => null,
  );
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface Ledger {
  streams: StreamRecord[];
  balance: bigint;
  owed: bigint;
  fees: Fees | null;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

type LedgerData = Omit<Ledger, "refresh">;

/** Streams, USDC balance, owed balance and fees for an account; refreshed every 15 s. */
export function useLedger(accountId: string | null): Ledger {
  const [data, setData] = useState<LedgerData>({
    streams: [],
    balance: 0n,
    owed: 0n,
    fees: null,
    loaded: false,
    error: null,
  });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const load = () =>
      Promise.all([getStreams(accountId), getUsdcBalance(accountId), getOwed(accountId), getFees()]).then(
        ([streams, balance, owed, fees]) =>
          !cancelled && setData({ streams, balance, owed, fees, loaded: true, error: null }),
        (e: unknown) =>
          !cancelled && setData((d) => ({ ...d, loaded: true, error: e instanceof Error ? e.message : String(e) })),
      );
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [accountId, version]);

  return { ...data, refresh };
}

export interface LogEntry {
  id: number;
  at: number;
  text: string;
  txHash?: string;
  error?: boolean;
}

const LOG_LIMIT = 20;

/** Newest-first record of what the user did this session; feeds the toasts and the activity card. */
export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const nextId = useRef(1);
  const add = useCallback((text: string, txHash?: string, error?: boolean) => {
    const entry: LogEntry = { id: nextId.current++, at: Date.now(), text, txHash, error };
    setEntries((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
  }, []);
  return { entries, add };
}

export type LogFn = ReturnType<typeof useLog>["add"];
