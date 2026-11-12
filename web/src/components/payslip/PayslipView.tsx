"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { isNearAccountId } from "@/lib/address";
import { accountUrl, config } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { formatUsdc } from "@/lib/money";
import { useNow } from "@/lib/hooks";
import { getStreams, view } from "@/lib/near";
import { HIDE_AMOUNT, monthOf, monthPeriod, payslipCardPath, payslipLines, payslipPath, recentMonths, shareText, type Period } from "@/lib/payslip";
import { formatLocal, toLocal } from "@/lib/rates";
import { CurrencyPicker, RateNote, useCurrency, useRates } from "../LocalCurrency";
import { ShareLinks, useOrigin } from "../ShareLinks";
import { Button, ExplorerLink, Notice, Skeleton, shortId } from "../ui";

type Load =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; streams: StreamRecord[]; names: Record<string, string>; readAt: number };

/** Employers that are DAOs get their DAO's name; anything else keeps its account id. */
async function employerNames(streams: StreamRecord[]): Promise<Record<string, string>> {
  const employers = [...new Set(streams.map((s) => s.employer))];
  const results = await Promise.allSettled(employers.map((e) => view<{ name?: string }>(e, "get_config")));
  const names: Record<string, string> = {};
  results.forEach((r, i) => {
    const name = r.status === "fulfilled" && typeof r.value?.name === "string" ? r.value.name.slice(0, 60) : "";
    if (name) names[employers[i]] = `${name} (DAO)`;
  });
  return names;
}

function useWorkerStreams(worker: string): Load {
  const [state, setState] = useState<Load>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getStreams(worker)
      .then(async (all) => {
        const streams = all.filter((s) => s.worker === worker);
        const names = await employerNames(streams).catch(() => ({}));
        if (live) setState({ status: "ready", streams, names, readAt: Date.now() });
      })
      .catch((e: unknown) => live && setState({ status: "error", error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [worker]);
  return state;
}

const fmtDay = (secs: number) => new Date(secs * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtStamp = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span>{label}</span>
      <span className="flex-1 border-b border-dotted border-paper-rule" aria-hidden="true" />
      <span className="num text-right">{children}</span>
    </div>
  );
}

/** The local amount on paper: plain text so it prints, or nothing if no currency is chosen. */
function PaperLocal({ units }: { units: bigint }) {
  const [code] = useCurrency();
  const rates = useRates();
  const rate = code && rates?.perUsd[code];
  return rate ? <span className="block text-xs opacity-70">≈ {formatLocal(toLocal(units, rate), code)}</span> : null;
}

/**
 * A monthly payslip read live from Payday's contract. The link is the proof: anyone who
 * opens it sees the same figures straight from NEAR, so nothing here has to be trusted.
 */
export function PayslipView() {
  const params = useSearchParams();
  const router = useRouter();
  const worker = params.get("worker")?.trim().toLowerCase() ?? "";
  const nowSecs = Math.floor(useNow(60_000) / 1000);
  const month = params.get("month") ?? monthOf(nowSecs);
  const period = monthPeriod(month, nowSecs);
  const hideAmount = params.get("amount") === HIDE_AMOUNT;

  if (!isNearAccountId(worker)) {
    return <Notice tone="error">This payslip link has no valid worker account. Open payslips from the My pay page.</Notice>;
  }
  if (!period) return <Notice tone="error">That month is not a past or current month (use YYYY-MM).</Notice>;

  return (
    <Payslip
      key={`${worker}:${month}`}
      worker={worker}
      period={period}
      nowSecs={nowSecs}
      hideAmount={hideAmount}
      onMonth={(m) => router.replace(payslipPath(worker, m, hideAmount))}
      onHideAmount={(hide) => router.replace(payslipPath(worker, month, hide), { scroll: false })}
    />
  );
}

function Payslip(props: {
  worker: string;
  period: Period;
  nowSecs: number;
  hideAmount: boolean;
  onMonth: (m: string) => void;
  onHideAmount: (hide: boolean) => void;
}) {
  const { worker, period, nowSecs, onMonth } = props;
  const state = useWorkerStreams(worker);

  if (state.status === "loading") {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (state.status === "error") return <Notice tone="error">Could not read the chain: {state.error}</Notice>;

  const lines = payslipLines(state.streams, worker, period);
  const earned = lines.reduce((sum, l) => sum + l.earned, 0n);
  const toDate = lines.reduce((sum, l) => sum + l.earnedToDate, 0n);
  const paidOut = lines.reduce((sum, l) => sum + BigInt(l.stream.withdrawn), 0n);
  const earliest = state.streams.length ? Math.min(...state.streams.map((s) => s.start)) : null;
  const months = recentMonths(nowSecs, earliest);
  const first = lines[0]?.stream.id;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <label className="inline-flex items-center gap-2 text-sm">
          <span className="text-muted">Month</span>
          <select
            aria-label="Payslip month"
            className="rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
            value={period.month}
            onChange={(e) => onMonth(e.target.value)}
          >
            {(months.includes(period.month) ? months : [period.month, ...months]).map((m) => (
              <option key={m} value={m}>
                {monthPeriod(m, nowSecs)?.label ?? m}
              </option>
            ))}
          </select>
        </label>
        <CurrencyPicker className="text-muted" />
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>

      <article className="payslip-edge bg-paper px-6 pb-10 pt-6 text-paper-ink shadow-lift sm:px-10 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em]">Payslip · Payday</p>
            <h1 className="display mt-1 text-4xl">{period.label}</h1>
            <p className="mt-1 text-xs opacity-70">
              {fmtDay(period.from)} to {period.toDate ? `${fmtDay(period.to)} (month to date)` : fmtDay(period.to - 1)}, UTC
            </p>
          </div>
          <div className="text-right text-xs">
            <p className="font-medium uppercase tracking-[0.18em]">Paid to</p>
            <p className="num mt-1 break-all text-sm">{worker}</p>
            <p className="mt-2 opacity-70">Read from NEAR {config.networkId} {fmtStamp(state.readAt)}</p>
          </div>
        </header>

        <div className="my-5 border-t border-dashed border-paper-rule" />

        {lines.length === 0 ? (
          <p className="text-sm">No Payday salary was earned by this account in {period.label}.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.14em] opacity-70">
                <th className="pb-2 font-medium">Employer</th>
                <th className="pb-2 font-medium">Stream</th>
                <th className="pb-2 text-right font-medium">Per day</th>
                <th className="pb-2 text-right font-medium">Earned</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.stream.id} className="border-t border-paper-rule/60 align-top">
                  <td className="py-2 pr-2">
                    <span className="block">{state.names[l.stream.employer] ?? shortId(l.stream.employer)}</span>
                    {state.names[l.stream.employer] && <span className="num block text-xs opacity-70">{shortId(l.stream.employer)}</span>}
                  </td>
                  <td className="num py-2 pr-2">
                    #{l.stream.id}
                    <span className="block text-xs opacity-70">
                      {fmtDay(l.stream.start)} – {fmtDay(l.stream.stop)}
                    </span>
                  </td>
                  <td className="num py-2 text-right">{formatUsdc(l.perDay)}</td>
                  <td className="num py-2 text-right">
                    {formatUsdc(l.earned)}
                    <PaperLocal units={l.earned} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="my-5 border-t border-dashed border-paper-rule" />

        <div className="space-y-2">
          <Row label={`Earned in ${period.label}${period.toDate ? " so far" : ""}`}>
            <span className="font-medium">{formatUsdc(earned)} USDC</span>
            <PaperLocal units={earned} />
          </Row>
          <Row label="Earned from these streams to the end of the period">{formatUsdc(toDate)} USDC</Row>
          <Row label="Withdrawn from these streams, as of today">{formatUsdc(paidOut)} USDC</Row>
        </div>

        <div className="my-5 border-t border-dashed border-paper-rule" />

        <section className="space-y-2 text-xs leading-relaxed">
          <p className="font-medium uppercase tracking-[0.18em]">How to check this payslip</p>
          <p>
            Payday did not sign this document: every figure is read from Payday&apos;s contract{" "}
            <ExplorerLink href={accountUrl(config.payday)} className="num">
              {config.payday}
            </ExplorerLink>{" "}
            on NEAR {config.networkId} each time the link is opened. Salary vests linearly, by the second, between each
            stream&apos;s start and end, and the amounts above follow the contract&apos;s own rule.
          </p>
          {first !== undefined && (
            <p className="num break-all rounded border border-paper-rule px-2 py-1.5">
              near contract call-function as-read-only {config.payday} get_stream json-args &apos;{`{"stream_id":${first}}`}&apos; network-config{" "}
              {config.networkId} now
            </p>
          )}
          <p className="opacity-70">
            Covers streams still held by Payday. A stream that ended and was fully withdrawn is deleted from the contract
            and no longer appears. Amounts are USDC (6 decimals); local amounts are approximate, at a daily mid-market
            rate.
          </p>
        </section>
      </article>

      <SharePanel worker={worker} period={period} hideAmount={props.hideAmount} onHideAmount={props.onHideAmount} />
      <RateNote className="text-muted print:hidden" />
    </div>
  );
}

/**
 * Sharing: the link unfurls into a card drawn from the chain on X, WhatsApp and Telegram.
 * The card can leave the amount out; the payslip itself always shows it.
 */
function SharePanel(props: { worker: string; period: Period; hideAmount: boolean; onHideAmount: (hide: boolean) => void }) {
  const { worker, period, hideAmount, onHideAmount } = props;
  const origin = useOrigin();
  const link = `${origin}${payslipPath(worker, period.month, hideAmount)}`;
  return (
    <section className="rounded-2xl border border-border p-4 sm:p-5 print:hidden">
      <h2 className="text-sm font-medium">Share this payslip</h2>
      <p className="mt-1 text-xs text-muted">
        Anyone with the link sees these figures, as anyone can on the public chain. Send it to a landlord, bank or visa
        office instead of a screenshot. In chats and posts it shows as this card.
      </p>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <Image
          src={payslipCardPath(worker, period.month, hideAmount)}
          alt={`Link preview for the ${period.label} payslip`}
          width={1200}
          height={630}
          unoptimized
          className="w-full rounded-lg border border-border sm:w-72"
        />
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--accent)]"
              checked={hideAmount}
              onChange={(e) => onHideAmount(e.target.checked)}
            />
            <span>
              Leave the amount out of the preview
              <span className="block text-xs text-muted">People who open the link still see the full payslip.</span>
            </span>
          </label>
          {origin && <ShareLinks link={link} text={shareText(period)} />}
        </div>
      </div>
    </section>
  );
}
