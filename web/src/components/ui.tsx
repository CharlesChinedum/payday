"use client";

import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { shortId } from "@/lib/address";
import { accountUrl, txUrl } from "@/lib/config";
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "./icons";

export function Card({
  title,
  aside,
  children,
  className = "",
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-5 sm:p-6 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

const BUTTON_VARIANTS = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  lime: "bg-lime text-lime-ink hover:brightness-105",
  secondary: "border border-border bg-surface hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "border border-border text-danger hover:bg-danger-soft",
} as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  loading?: boolean;
};

export function Button({ variant = "primary", loading = false, className = "", children, disabled, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 animate-spin" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const PILL_TONES = {
  live: "bg-gold-soft text-gold",
  neutral: "bg-surface-2 text-muted",
  good: "bg-accent-soft text-accent",
  bad: "bg-danger-soft text-danger",
  wait: "bg-warn-soft text-text",
} as const;

export function Pill({ tone = "neutral", children }: { tone?: keyof typeof PILL_TONES; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${PILL_TONES[tone]}`}>
      {tone === "live" && <LiveDot />}
      {children}
    </span>
  );
}

/** Live state, in gold on any surface. */
export function LiveDot() {
  return <span className="h-1.5 w-1.5 animate-live rounded-full bg-lime" aria-hidden="true" />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export { shortId };

const COPIED_MS = 1600;

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  }
  return (
    <button
      onClick={copy}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition duration-150 active:scale-95 ${
        copied ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:text-text"
      }`}
    >
      {copied ? <CheckIcon className="animate-pop" /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** A link to the network's explorer, or plain text on a network without one. */
export function ExplorerLink({
  href,
  title,
  className = "",
  children,
}: {
  href: string | null;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  if (!href) {
    return (
      <span title={title} className={className}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={`underline decoration-border underline-offset-4 hover:decoration-text ${className}`}
    >
      {children}
    </a>
  );
}

export function AccountChip({ id }: { id: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ExplorerLink href={accountUrl(id)} title={id} className="num text-sm">
        {shortId(id)}
      </ExplorerLink>
      <CopyButton value={id} />
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const href = txUrl(hash);
  return (
    <ExplorerLink href={href} title={hash} className="num inline-flex items-center gap-0.5">
      {hash.slice(0, 8)}…
      {href && <ArrowUpRightIcon width={12} height={12} />}
    </ExplorerLink>
  );
}

const NOTICE_TONES = {
  info: "bg-accent-soft",
  warn: "bg-warn-soft",
  error: "bg-danger-soft text-danger",
} as const;

export function Notice({ tone = "info", children }: { tone?: keyof typeof NOTICE_TONES; children: ReactNode }) {
  return <div className={`rounded-xl px-4 py-3 text-sm ${NOTICE_TONES[tone]}`}>{children}</div>;
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-border bg-bg px-3.5 py-2.5 text-sm transition-shadow placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 ${className}`}
    />
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block space-y-1.5 text-sm ${className}`}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{children}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full origin-left rounded-full bg-lime transition-transform duration-1000 ease-linear"
        style={{ transform: `scaleX(${Math.min(1, Math.max(0, fraction))})` }}
      />
    </div>
  );
}
