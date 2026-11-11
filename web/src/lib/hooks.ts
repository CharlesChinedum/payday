"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyPair } from "near-api-js";
import type { StreamRecord } from "./csv";
import { getStreams, getUsdcBalance, implicitId, loadKeyPair, onboard, type Role } from "./near";

export type AccountState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; keyPair: KeyPair; accountId: string };

/** This browser's account for `role`: creates a key and its on-chain account if needed. */
export function useRoleAccount(role: Role): AccountState {
  const [state, setState] = useState<AccountState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keyPair = loadKeyPair(role, true);
      if (!keyPair) throw new Error("This browser blocks local storage, so Payday cannot keep your key.");
      return { keyPair, accountId: await onboard(keyPair) };
    })().then(
      (ready) => !cancelled && setState({ status: "ready", ...ready }),
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
      const kp = loadKeyPair(role, false);
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
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

type LedgerData = Omit<Ledger, "refresh">;

/** Streams and USDC balance for an account, refreshed every 15 s and on demand. */
export function useLedger(accountId: string | null): Ledger {
  const [data, setData] = useState<LedgerData>({ streams: [], balance: 0n, loaded: false, error: null });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const load = () =>
      Promise.all([getStreams(accountId), getUsdcBalance(accountId)]).then(
        ([streams, balance]) => !cancelled && setData({ streams, balance, loaded: true, error: null }),
        (e: unknown) =>
          !cancelled &&
          setData((d) => ({ ...d, loaded: true, error: e instanceof Error ? e.message : String(e) })),
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
