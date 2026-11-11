"use client";

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { accountUrl, txUrl } from "@/lib/config";

export function Card({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      {(title || aside) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="font-semibold">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const styles = {
    primary: "bg-accent text-accent-ink hover:opacity-90",
    secondary: "border border-border bg-surface hover:bg-surface-2",
    danger: "border border-border text-danger hover:bg-danger-soft",
  }[variant];
  return (
    <button
      {...props}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function AccountChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <a href={accountUrl(id)} target="_blank" rel="noreferrer" className="num text-sm underline" title={id}>
        {shortId(id)}
      </a>
      <button
        className="rounded border border-border px-1.5 text-xs text-muted hover:text-text"
        onClick={() => {
          navigator.clipboard.writeText(id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a href={txUrl(hash)} target="_blank" rel="noreferrer" className="num underline">
      {hash.slice(0, 8)}…
    </a>
  );
}

export interface LogEntry {
  at: number;
  text: string;
  txHash?: string;
  error?: boolean;
}

export function ActivityLog({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Card title="Activity">
      <ul className="space-y-2 text-sm">
        {entries.map((e) => (
          <li key={e.at} className={e.error ? "text-danger" : ""}>
            <span className="num mr-2 text-xs text-muted">{new Date(e.at).toLocaleTimeString()}</span>
            {e.text}
            {e.txHash && (
              <>
                {" · "}
                <TxLink hash={e.txHash} />
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error"; children: ReactNode }) {
  const bg = { info: "bg-accent-soft", warn: "bg-warn-soft", error: "bg-danger-soft text-danger" }[tone];
  return <div className={`rounded-lg px-3.5 py-2.5 text-sm ${bg}`}>{children}</div>;
}
