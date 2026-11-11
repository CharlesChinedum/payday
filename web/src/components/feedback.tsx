"use client";

import { useCallback, useEffect, useState } from "react";
import type { LogEntry } from "@/lib/hooks";
import successAnimation from "@/lottie/success.json";
import { AlertIcon, CheckIcon, CloseIcon } from "./icons";
import { Lottie } from "./Lottie";
import { Card, TxLink } from "./ui";

const TOAST_MS = 6000;
const MAX_TOASTS = 3;

function Toast({ entry, onDismiss }: { entry: LogEntry; onDismiss: (id: number) => void }) {
  const { id } = entry;
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, onDismiss]);

  return (
    <div
      role={entry.error ? "alert" : "status"}
      className="flex w-full animate-toast items-start gap-3 rounded-2xl border border-border bg-surface p-3 pr-2 shadow-lift"
    >
      {entry.error ? (
        <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertIcon />
        </span>
      ) : (
        <Lottie data={successAnimation} label="Done" loop={false} className="h-10 w-10 shrink-0" />
      )}
      <div className="min-w-0 flex-1 py-1 text-sm">
        <p className={entry.error ? "text-danger" : ""}>{entry.text}</p>
        {entry.txHash && (
          <p className="mt-0.5 text-xs text-muted">
            Transaction <TxLink hash={entry.txHash} />
          </p>
        )}
      </div>
      <button onClick={() => onDismiss(id)} aria-label="Dismiss" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-text">
        <CloseIcon />
      </button>
    </div>
  );
}

/** Shows each new log entry as a toast for a few seconds; the activity log keeps the history. */
export function Toasts({ entries }: { entries: LogEntry[] }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const dismiss = useCallback((id: number) => setDismissed((prev) => new Set(prev).add(id)), []);
  const visible = entries.filter((e) => !dismissed.has(e.id)).slice(0, MAX_TOASTS);

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col-reverse items-end gap-2 sm:left-auto sm:w-96">
      {visible.map((entry) => (
        <div key={entry.id} className="pointer-events-auto w-full">
          <Toast entry={entry} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Card title="Activity">
      <ul className="space-y-3 text-sm">
        {entries.map((e) => (
          <li key={e.id} className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                e.error ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent"
              }`}
            >
              {e.error ? <AlertIcon width={12} height={12} /> : <CheckIcon width={12} height={12} />}
            </span>
            <span className={`flex-1 ${e.error ? "text-danger" : ""}`}>
              {e.text}
              {e.txHash && (
                <>
                  {" · "}
                  <TxLink hash={e.txHash} />
                </>
              )}
            </span>
            <time className="num shrink-0 text-xs text-muted">{new Date(e.at).toLocaleTimeString()}</time>
          </li>
        ))}
      </ul>
    </Card>
  );
}
