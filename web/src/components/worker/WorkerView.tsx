"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GAS_TGAS, config } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { useLedger, useLog, useNow, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { monthOf, monthPeriod, payslipPath, recentMonths } from "@/lib/payslip";
import { explain, isRegisteredForUsdc, paidOut, relayCall } from "@/lib/near";
import { report } from "@/lib/report";
import { MAX_NOTE_LENGTH, parseRequest, requestCardPath, requestPath, requestSummary, type PayRequest } from "@/lib/request";
import { WaitingAnimation } from "../animations";
import { ActivityLog, Toasts } from "../feedback";
import { ArrowUpRightIcon } from "../icons";
import { BackupBanner, KeyBackup } from "../KeyBackup";
import { CountAmount, LiveAmount } from "../LiveAmount";
import { CurrencyPicker, LocalAmount, RateNote } from "../LocalCurrency";
import { MoveMoney } from "../MoveMoney";
import { ShareLinks, useOrigin } from "../ShareLinks";
import { availableNow, fmtDate, progress, ratePerDay, statusOf, withdrawableNow } from "../StreamMath";
import { AccountChip, Button, Card, CopyButton, Field, LiveDot, Notice, Pill, ProgressBar, Skeleton, Stat, TextInput, shortId } from "../ui";

const sumAvailable = (streams: StreamRecord[], nowMs: number) =>
  streams.reduce((sum, s) => sum + availableNow(s, nowMs), 0n);

function BalanceHero(props: {
  streams: StreamRecord[];
  now: number;
  maxFees: bigint;
  payoutFee: bigint | null;
  withdrawing: boolean;
  onWithdrawAll: () => void;
}) {
  const { streams, now, maxFees, payoutFee, withdrawing, onWithdrawAll } = props;
  const streaming = streams.filter((s) => statusOf(s, now) === "streaming");
  const perDay = streaming.reduce((sum, s) => sum + ratePerDay(s), 0n);
  const nothingToWithdraw = streams.every((s) => withdrawableNow(s, now, maxFees) === 0n);

  return (
    <section className="relative overflow-hidden rounded-3xl bg-hero p-6 text-hero-ink sm:p-8">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-hero-ink/60">
        {streaming.length > 0 && <LiveDot tone="lime" />}
        Available to withdraw
      </div>
      <p className="mt-3 text-5xl font-semibold tracking-tight sm:text-6xl">
        <LiveAmount amountAt={(nowMs) => sumAvailable(streams, nowMs)} />
      </p>
      <p className="mt-2 text-sm text-hero-ink/60">
        USDC
        {streaming.length > 0 &&
          ` · earning ${formatUsdc(perDay)} a day from ${streaming.length} stream${streaming.length === 1 ? "" : "s"}`}
      </p>
      <LocalAmount units={sumAvailable(streams, now)} className="mt-1 block text-lg text-hero-ink/80" />
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button variant="lime" loading={withdrawing} disabled={nothingToWithdraw} onClick={onWithdrawAll}>
          {streams.length > 1 ? "Withdraw all" : "Withdraw"}
        </Button>
        <span className="text-xs text-hero-ink/60">
          Payday pays the network fee
          {payoutFee !== null && ` and charges ${formatUsdc(payoutFee)} USDC per withdrawal`}. Withdrawals open at 1 USDC.
        </span>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hero-ink/10 pt-4 text-hero-ink/80">
        <CurrencyPicker />
        <RateNote className="flex-1" />
      </div>
    </section>
  );
}

function StreamRow(props: {
  stream: StreamRecord;
  now: number;
  maxFees: bigint;
  busy: boolean;
  loading: boolean;
  onWithdraw: () => void;
}) {
  const { stream, now, maxFees, busy, loading, onWithdraw } = props;
  const status = statusOf(stream, now);
  return (
    <li className="grid gap-4 py-5 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Stream #{stream.id}</span>
          <Pill tone={status === "streaming" ? "live" : "neutral"}>{status}</Pill>
          <span className="text-muted">
            from <span className="num">{shortId(stream.employer)}</span>
          </span>
        </div>
        <ProgressBar fraction={progress(stream, now)} />
        <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted">
          <span>
            {formatUsdc(BigInt(stream.deposit))} USDC · {formatUsdc(ratePerDay(stream))} a day
          </span>
          <span>
            {fmtDate(stream.start)} – {fmtDate(stream.stop)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <LiveAmount className="text-lg font-medium" amountAt={(nowMs) => availableNow(stream, nowMs)} />
        <Button variant="secondary" loading={loading} disabled={busy || withdrawableNow(stream, now, maxFees) === 0n} onClick={onWithdraw}>
          Withdraw
        </Button>
      </div>
    </li>
  );
}

function NoSalaryYet({ accountId }: { accountId: string }) {
  const steps = [
    <>
      Copy your Payday account. <CopyButton value={accountId} label="Copy account" />
    </>,
    <>
      Your employer adds it to a payroll. Trying it yourself? Open{" "}
      <Link className="underline underline-offset-4" href="/employer">
        Run payroll
      </Link>{" "}
      in another tab.
    </>,
    <>Come back here and watch your salary arrive, second by second.</>,
  ];
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[10rem_1fr]">
      <WaitingAnimation className="mx-auto h-28 w-40" />
      <div>
        <h3 className="font-semibold tracking-tight">No salary yet</h3>
        <ol className="mt-3 space-y-3 text-sm text-muted">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="num mt-0.5 text-xs text-text">0{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Shown until the worker's account can hold USDC, so the one-time fee is not a surprise. */
function FirstWithdrawalNote({ accountId, fee, payoutFee }: { accountId: string; fee: bigint; payoutFee: bigint }) {
  const [registered, setRegistered] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    isRegisteredForUsdc(accountId).then(
      (r) => !cancelled && setRegistered(r),
      () => !cancelled && setRegistered(true),
    );
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  if (registered !== false) return null;
  return (
    <Notice>
      Your first withdrawal sets up your account to hold USDC. Payday deducts a one-time {formatUsdc(fee)} USDC for
      it; after that, each withdrawal carries only the {formatUsdc(payoutFee)} USDC payout fee.
    </Notice>
  );
}

function WorkerSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Setting up your Payday account">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  );
}

/** Proof of income: a monthly payslip anyone can check, read live from the chain. */
function Payslips({ accountId, streams, now }: { accountId: string; streams: StreamRecord[]; now: number }) {
  const nowSecs = Math.floor(now / 1000);
  const months = recentMonths(nowSecs, Math.min(...streams.map((s) => s.start)));
  const [month, setMonth] = useState<string | null>(null);
  const chosen = month ?? monthOf(nowSecs);
  const href = payslipPath(accountId, chosen);
  return (
    <Card title="Payslips">
      <p className="text-sm text-muted">
        A monthly statement of what you earned, for a landlord, bank or visa office. It is read live from the chain each
        time the link is opened, so whoever you send it to can check it themselves.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          aria-label="Payslip month"
          className="rounded-xl border border-border bg-bg px-3 py-2.5 text-sm"
          value={chosen}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {monthPeriod(m, nowSecs)?.label ?? m}
            </option>
          ))}
        </select>
        <Link
          href={href}
          target="_blank"
          className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink transition duration-150 hover:brightness-110 active:scale-[0.97]"
        >
          Open payslip <ArrowUpRightIcon />
        </Link>
      </div>
    </Card>
  );
}

const REQUEST_DAYS = [7, 14, 30, 60, 90, 180, 365];

/**
 * A link that asks someone to pay you: it opens Run payroll with your stream filled in,
 * and shows as a card when posted. Nothing moves until the payer funds it themselves.
 */
function RequestPayment({ accountId }: { accountId: string }) {
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");
  const [made, setMade] = useState<PayRequest | null>(null);
  const origin = useOrigin();
  const request = parseRequest(new URLSearchParams({ pay: accountId, amount: amount.trim(), days, note }));
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setMade(null);
  };
  return (
    <Card title="Request payment">
      <p className="text-sm text-muted">
        Make a link that asks a client or employer to pay you by the second. It opens Run payroll with your stream
        filled in; nothing moves until they fund it.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="Amount (USDC)">
          <TextInput className="num" inputMode="decimal" placeholder="3000" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} />
        </Field>
        <Field label="Paid over">
          <select
            className="w-full rounded-xl border border-border bg-bg px-3 py-2.5 text-sm"
            value={days}
            onChange={(e) => edit(setDays)(e.target.value)}
          >
            {REQUEST_DAYS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </Field>
        <Field label="What it is for (optional)">
          <TextInput
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Design work, November"
            value={note}
            onChange={(e) => edit(setNote)(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={!request} onClick={() => setMade(request)}>
          Make link
        </Button>
        <span className="text-sm text-muted">
          {request ? requestSummary(request) : amount.trim() ? "Enter at least 1 USDC, like 3000 or 12.50" : ""}
        </span>
      </div>
      {made && origin && (
        <div className="mt-5 flex animate-rise flex-col gap-4 border-t border-border pt-5 sm:flex-row sm:items-start">
          <Image
            src={requestCardPath(made)}
            alt={`Link preview: pay ${requestSummary(made)}`}
            width={1200}
            height={630}
            unoptimized
            className="w-full rounded-lg border border-border sm:w-72"
          />
          <div className="min-w-0 space-y-3">
            <p className="num break-all rounded-lg bg-surface-2 px-3 py-2 text-xs">{`${origin}${requestPath(made)}`}</p>
            <ShareLinks
              link={`${origin}${requestPath(made)}`}
              text={`Pay me ${requestSummary(made)} with Payday: salary streams to me by the second on NEAR.`}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

export function WorkerView() {
  const account = useRoleAccount("worker");
  const accountId = account.status === "ready" ? account.accountId : null;
  const ledger = useLedger(accountId);
  const now = useNow(1000);
  const log = useLog();
  const [pending, setPending] = useState<number[]>([]);
  const backupCard = useRef<HTMLDivElement>(null);

  if (account.status === "loading") return <WorkerSkeleton />;
  if (account.status === "error") return <Notice tone="error">{account.error}</Notice>;

  const { key } = account;
  const mine = ledger.streams.filter((s) => s.worker === account.accountId);
  const busy = pending.length > 0;

  async function withdrawOne(streamId: number) {
    const res = await relayCall(key, config.payday, "withdraw", { stream_id: streamId }, GAS_TGAS.payout);
    report(log.add, res, (o) => {
      const paid = paidOut(o).find((p) => p.source === "stream");
      if (!paid) return { ok: false, text: `Withdrawal did not go through: ${explain(o, "the payout failed")}` };
      const fee = paid.fee > 0n ? ` after ${formatUsdc(paid.fee)} USDC in Payday fees` : "";
      return { ok: true, text: `Withdrew ${formatUsdc(paid.amount, 6)} USDC from stream #${streamId}${fee}. You paid no gas.` };
    });
  }

  // Sequential on purpose: each relayed call consumes the next nonce of the same key.
  async function withdraw(streamIds: number[]) {
    setPending(streamIds);
    for (const id of streamIds) {
      await withdrawOne(id);
      setPending((ids) => ids.filter((other) => other !== id));
    }
    setPending([]);
    ledger.refresh();
  }

  // The most a withdrawal can be charged: the payout fee, plus registration the first time.
  const maxFees = ledger.fees ? ledger.fees.payout + ledger.fees.registration : 0n;
  const withdrawable = mine.filter((s) => withdrawableNow(s, now, maxFees) > 0n).map((s) => s.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-4xl sm:text-5xl">Your pay</h1>
          <p className="mt-2 text-muted">Salary that grows every second. Withdraw any time.</p>
        </div>
      </div>

      <BackupBanner role="worker" onOpen={() => backupCard.current?.scrollIntoView({ behavior: "smooth" })} />

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <BalanceHero
          streams={mine}
          now={now}
          maxFees={maxFees}
          payoutFee={ledger.fees?.payout ?? null}
          withdrawing={busy}
          onWithdrawAll={() => withdraw(withdrawable)}
        />
        <Card className="flex flex-col justify-between gap-6">
          <Stat label="In your account" hint="USDC you have already withdrawn">
            <CountAmount value={ledger.balance} />
            <LocalAmount units={ledger.balance} className="mt-1 block text-sm font-normal text-muted" />
          </Stat>
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Your Payday account</div>
            <div className="mt-2">
              <AccountChip id={account.accountId} />
            </div>
            <p className="mt-2 text-xs text-muted">Give this to your employer so they can pay you.</p>
          </div>
        </Card>
      </div>

      <Card title="Salary streams">
        {!ledger.loaded ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : mine.length === 0 ? (
          <NoSalaryYet accountId={account.accountId} />
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((s) => (
              <StreamRow
                key={s.id}
                stream={s}
                now={now}
                maxFees={maxFees}
                busy={busy}
                loading={pending.includes(s.id)}
                onWithdraw={() => withdraw([s.id])}
              />
            ))}
          </ul>
        )}
        {ledger.error && <p className="mt-4 text-sm text-danger">Could not read the chain: {ledger.error}</p>}
      </Card>

      {mine.length > 0 && ledger.balance === 0n && ledger.fees && (
        <FirstWithdrawalNote accountId={account.accountId} fee={ledger.fees.registration} payoutFee={ledger.fees.payout} />
      )}

      {(mine.length > 0 || ledger.balance > 0n || ledger.owed > 0n) && (
        <MoveMoney
          signingKey={key}
          accountId={account.accountId}
          streams={mine}
          balance={ledger.balance}
          owed={ledger.owed}
          fees={ledger.fees}
          now={now}
          onDone={ledger.refresh}
          log={log.add}
        />
      )}

      {mine.length > 0 && <Payslips accountId={account.accountId} streams={mine} now={now} />}

      <RequestPayment accountId={account.accountId} />

      <div ref={backupCard} className="scroll-mt-24">
        <KeyBackup role="worker" accountId={account.accountId} />
      </div>

      <ActivityLog entries={log.entries} />
      <Toasts entries={log.entries} />
    </div>
  );
}
