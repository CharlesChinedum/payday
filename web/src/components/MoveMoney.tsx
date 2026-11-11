"use client";

import { useEffect, useState } from "react";
import type { KeyPair } from "near-api-js";
import { addressHint, checkAddress, isNearAccountId } from "@/lib/address";
import { CASH_OUT_ASSETS, GAS_TGAS, ONE_USDC, ONE_YOCTO, config, type CashOutAsset } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import type { LogFn } from "@/lib/hooks";
import { formatUsdc, parseUsdc, usdcDecimal } from "@/lib/money";
import { explain, isRegisteredForUsdc, paidOut, relayCall, type Fees, type RelayResult } from "@/lib/near";
import { report } from "@/lib/report";
import { availableNow } from "./StreamMath";
import { Button, Card, Field, Notice, Pill, TextInput, shortId } from "./ui";

interface Quote {
  amountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate: number | null;
  depositAddress: string | null;
}

interface Offer {
  quote: Quote;
  deadline: number;
  asset: CashOutAsset;
}

interface CashOutRecord {
  depositAddress: string;
  label: string;
  amount: string;
  sentAt: number;
  status: string;
}

type Source = "salary" | "account";
type Destination = "chain" | "near";

const FINAL_STATUSES = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const STATUS_POLL_MS = 5_000;
const MAX_RECORDS = 10;

const recordsItem = (accountId: string) => `payday:${config.networkId}:cashouts:${accountId}`;

function loadRecords(accountId: string): CashOutRecord[] {
  try {
    return JSON.parse(localStorage.getItem(recordsItem(accountId)) ?? "[]") as CashOutRecord[];
  } catch {
    return [];
  }
}

function saveRecords(accountId: string, records: CashOutRecord[]) {
  try {
    localStorage.setItem(recordsItem(accountId), JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch {
    // Tracking is a convenience; the cash-out itself is on-chain.
  }
}

async function fetchQuote(body: { amount: string; destination: string; recipient: string; refundTo: string }) {
  const res = await fetch("/api/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { quote?: Quote; deadline?: string; error?: string };
  if (!res.ok || !data.quote || !data.deadline) throw new Error(data.error ?? "Quote failed");
  return { quote: data.quote, deadline: Date.parse(data.deadline) };
}

/** Saved cash-outs, polled until NEAR Intents reports a final status. Survives reloads. */
function useCashOutRecords(accountId: string, log: LogFn) {
  const [records, setRecords] = useState<CashOutRecord[]>(() => loadRecords(accountId));

  useEffect(() => {
    const open = records.filter((r) => !FINAL_STATUSES.has(r.status));
    if (open.length === 0) return;
    const timer = setInterval(async () => {
      const updates = await Promise.all(
        open.map(async (r) => {
          const res = await fetch(`/api/quote?depositAddress=${r.depositAddress}`).catch(() => null);
          const data = res?.ok ? ((await res.json()) as { status?: string | null }) : null;
          return data?.status && data.status !== r.status ? { ...r, status: data.status } : null;
        }),
      );
      const changed = updates.filter((u): u is CashOutRecord => u !== null);
      if (changed.length === 0) return;
      for (const c of changed) log(`Cash-out of ${c.amount} USDC to ${c.label}: ${c.status}`, undefined, c.status === "FAILED");
      setRecords((prev) => {
        const next = prev.map((r) => changed.find((c) => c.depositAddress === r.depositAddress) ?? r);
        saveRecords(accountId, next);
        return next;
      });
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [records, accountId, log]);

  function add(record: CashOutRecord) {
    setRecords((prev) => {
      const next = [record, ...prev];
      saveRecords(accountId, next);
      return next;
    });
  }

  return { records, add };
}

function Choice<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-border p-1 text-sm">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={`rounded-lg px-3 py-1.5 transition ${props.value === o.value ? "bg-surface-2 font-medium" : "text-muted hover:text-text"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function QuoteSummary({ offer, gross, now }: { offer: Offer; gross: bigint; now: number }) {
  const secondsLeft = Math.max(0, Math.floor((offer.deadline - now) / 1000));
  const rows = [
    ["You send", `${formatUsdc(gross, 6)} USDC`],
    ["They receive", `${offer.quote.amountOutFormatted} ${offer.asset.label}`],
    ["At least", formatUsdc(BigInt(offer.quote.minAmountOut), 6)],
    ["Arrives in", offer.quote.timeEstimate ? `about ${offer.quote.timeEstimate} s` : "unknown"],
  ];
  return (
    <div className="animate-pop rounded-2xl bg-surface-2 p-4">
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="num mt-1 font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        Includes the one-time 0.01 USDC setup for the deposit address and NEAR Intents&apos; fees. If the swap cannot
        complete, the USDC is refunded to your Payday account.{" "}
        {secondsLeft > 0 ? `Quote valid for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}.` : "This quote has expired."}
      </p>
    </div>
  );
}

/**
 * Moves money out of Payday: from salary streams (workers) or the account balance, to
 * another chain through NEAR Intents or to any NEAR account. Also claims anything Payday
 * is holding for the account after a transfer could not complete.
 */
export function MoveMoney(props: {
  keyPair: KeyPair;
  accountId: string;
  streams: StreamRecord[];
  balance: bigint;
  owed: bigint;
  fees: Fees | null;
  now: number;
  onDone: () => void;
  log: LogFn;
}) {
  const { keyPair, accountId, streams, balance, owed, fees, now, onDone, log } = props;
  const salaryAvailable = streams.length > 0;
  const [source, setSource] = useState<Source>(salaryAvailable ? "salary" : "account");
  const [destination, setDestination] = useState<Destination>("chain");
  const [asset, setAsset] = useState<CashOutAsset>(CASH_OUT_ASSETS[0]);
  const [recipient, setRecipient] = useState("");
  const [amountText, setAmountText] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"quote" | "send" | "claim" | null>(null);
  const { records, add } = useCashOutRecords(accountId, log);

  const registrationFee = fees?.registration ?? 0n;
  // One payout draws from one stream, so salary comes from the stream with the most.
  const stream = streams.reduce<StreamRecord | null>(
    (best, s) => (!best || availableNow(s, now) > availableNow(best, now) ? s : best),
    null,
  );
  const effectiveSource: Source = salaryAvailable ? source : "account";
  const available = effectiveSource === "salary" ? (stream ? availableNow(stream, now) : 0n) : balance;

  function edit<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setOffer(null);
      setError(null);
    };
  }

  function amountOrError(): bigint | string {
    let amount: bigint;
    try {
      amount = parseUsdc(amountText);
    } catch (e) {
      return e instanceof Error ? e.message : "Enter an amount";
    }
    if (amount < ONE_USDC) return "Move at least 1 USDC";
    if (amount > available) return `At most ${formatUsdc(available, 6)} USDC is available from this source`;
    return amount;
  }

  /** Pays `gross` to `receiver` from the chosen source, gas-free. */
  function pay(receiver: string, gross: bigint): Promise<RelayResult> {
    if (effectiveSource === "salary" && stream) {
      return relayCall(keyPair, config.payday, "withdraw", { stream_id: stream.id, amount: gross.toString(), receiver }, GAS_TGAS.payout);
    }
    const msg = JSON.stringify({ send_to: receiver });
    return relayCall(keyPair, config.usdc, "ft_transfer_call", { receiver_id: config.payday, amount: gross.toString(), msg }, GAS_TGAS.funding, ONE_YOCTO);
  }

  async function getQuote() {
    const amount = amountOrError();
    if (typeof amount === "string") return setError(amount);
    const address = checkAddress(asset.kind, recipient);
    if (!address.ok) return setError(address.reason);
    setBusy("quote");
    setError(null);
    try {
      // A fresh deposit address needs registering, which Payday deducts from the payout,
      // so quote for what will arrive.
      const amountIn = amount - registrationFee;
      const { quote, deadline } = await fetchQuote({
        amount: amountIn.toString(),
        destination: asset.id,
        recipient: address.address,
        refundTo: accountId,
      });
      setOffer({ quote, deadline, asset });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function sendCashOut(current: Offer) {
    const depositAddress = current.quote.depositAddress;
    if (!depositAddress) return;
    if (Date.now() >= current.deadline) return setError("This quote has expired. Get a new one.");
    setBusy("send");
    try {
      const amountIn = BigInt(current.quote.amountIn);
      // NEAR Intents expects exactly amountIn: add the setup fee only if Payday will charge it.
      const gross = (await isRegisteredForUsdc(depositAddress)) ? amountIn : amountIn + registrationFee;
      if (gross > available) return setError("The amount available changed. Get a new quote.");
      const res = await pay(depositAddress, gross);
      const outcome = report(log, res, (o) => {
        const paid = paidOut(o).find((p) => p.receiver === depositAddress);
        return paid
          ? { ok: true, text: `Sent ${formatUsdc(paid.amount)} USDC to NEAR Intents for ${current.asset.label}` }
          : { ok: false, text: `Cash-out did not go through: ${explain(o, "the payout failed")}` };
      });
      if (outcome !== "failed") {
        add({ depositAddress, label: current.asset.label, amount: formatUsdc(amountIn), sentAt: Date.now(), status: "PENDING_DEPOSIT" });
      }
      setOffer(null);
    } finally {
      setBusy(null);
      onDone();
    }
  }

  async function sendToAccount() {
    const amount = amountOrError();
    if (typeof amount === "string") return setError(amount);
    const receiver = recipient.trim();
    if (!isNearAccountId(receiver)) return setError("Enter a NEAR account, like alice.near");
    if (receiver === accountId) return setError("That is this account");
    setBusy("send");
    setError(null);
    try {
      const res = await pay(receiver, amount);
      report(log, res, (o) => {
        const paid = paidOut(o).find((p) => p.receiver === receiver);
        if (!paid) return { ok: false, text: `Not sent: ${explain(o, "the payout failed")}` };
        const fee = paid.fee > 0n ? ` (${formatUsdc(paid.fee)} USDC set up their account)` : "";
        return { ok: true, text: `Sent ${formatUsdc(paid.amount)} USDC to ${shortId(receiver)}${fee}` };
      });
      setAmountText("");
    } finally {
      setBusy(null);
      onDone();
    }
  }

  async function claim() {
    setBusy("claim");
    try {
      const res = await relayCall(keyPair, config.payday, "claim_owed", {}, GAS_TGAS.payout);
      report(log, res, (o) => {
        const paid = paidOut(o).find((p) => p.receiver === accountId);
        return paid
          ? { ok: true, text: `Claimed ${formatUsdc(paid.amount, 6)} USDC into your account` }
          : { ok: false, text: `Not claimed: ${explain(o, "the payout failed")}` };
      });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  const depositAddress = offer?.quote.depositAddress ?? null;
  const offerGross = offer ? BigInt(offer.quote.amountIn) + registrationFee : 0n;
  const expired = offer ? now >= offer.deadline : false;
  const nothingToMove = available === 0n;

  return (
    <Card title="Move money out" aside={<Pill>gas-free</Pill>}>
      {owed > 0n && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-accent-soft px-4 py-3 text-sm">
          <p className="flex-1">
            <span className="num font-medium">{formatUsdc(owed, 6)} USDC</span> is waiting for you: salary left over
            from a cancelled stream, or a transfer that could not complete.
          </p>
          <Button loading={busy === "claim"} disabled={busy !== null} onClick={claim}>
            Claim
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {salaryAvailable && (
          <Choice
            value={effectiveSource}
            onChange={edit(setSource)}
            options={[
              { value: "salary", label: "From my salary" },
              { value: "account", label: "From my account" },
            ]}
          />
        )}
        <Choice
          value={destination}
          onChange={edit(setDestination)}
          options={[
            { value: "chain", label: "To another chain" },
            { value: "near", label: "To a NEAR account" },
          ]}
        />
        <span className="text-xs text-muted">
          Available: <span className="num">{formatUsdc(available, 6)}</span> USDC
        </span>
      </div>

      {destination === "chain" && (
        <fieldset className="mt-4">
          <legend className="text-xs font-medium text-muted">Receive</legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {CASH_OUT_ASSETS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === asset.id}
                onClick={() => edit(setAsset)(option)}
                className={`rounded-xl border px-3 py-2.5 text-left text-sm transition duration-150 active:scale-[0.97] ${
                  option.id === asset.id ? "border-accent bg-accent-soft font-medium text-accent" : "border-border hover:border-muted"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Field label={destination === "chain" ? "To address" : "To NEAR account"}>
          <TextInput
            className="num"
            placeholder={destination === "chain" ? addressHint(asset.kind) : "alice.near"}
            value={recipient}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => edit(setRecipient)(e.target.value)}
          />
        </Field>
        <Field label="Amount (USDC)">
          <span className="relative block">
            <TextInput
              className="num pr-14"
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              onChange={(e) => edit(setAmountText)(e.target.value)}
            />
            <button
              type="button"
              onClick={() => edit(setAmountText)(usdcDecimal(available))}
              className="absolute inset-y-1.5 right-1.5 rounded-lg px-2 text-xs font-medium text-accent hover:bg-accent-soft"
            >
              Max
            </button>
          </span>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {destination === "chain" ? (
          <Button variant="secondary" loading={busy === "quote"} disabled={busy !== null || nothingToMove} onClick={getQuote}>
            Get quote
          </Button>
        ) : (
          <Button loading={busy === "send"} disabled={busy !== null || nothingToMove} onClick={sendToAccount}>
            Send
          </Button>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
      {destination === "near" && (
        <p className="mt-2 text-xs text-muted">
          If that account has never held USDC, {formatUsdc(registrationFee)} USDC is deducted to set it up.
        </p>
      )}

      {offer && destination === "chain" && (
        <div className="mt-4 space-y-3">
          <QuoteSummary offer={offer} gross={offerGross} now={now} />
          {depositAddress ? (
            <Button loading={busy === "send"} disabled={busy !== null || expired} onClick={() => sendCashOut(offer)}>
              {expired ? "Quote expired" : `Cash out ${formatUsdc(offerGross)} USDC`}
            </Button>
          ) : (
            <Notice tone="warn">
              This is a live mainnet price. NEAR Intents has no testnet, so on testnet Payday only quotes. On mainnet,
              this sends the amount to the quote&apos;s deposit address in one gas-free step.
            </Notice>
          )}
        </div>
      )}

      {records.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">Recent cash-outs</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {records.map((r) => (
              <li key={r.depositAddress} className="flex flex-wrap items-center gap-2">
                <span className="num">{r.amount} USDC</span>
                <span className="text-muted">to {r.label}</span>
                <Pill tone={FINAL_STATUSES.has(r.status) ? "neutral" : "live"}>{r.status}</Pill>
                <span className="text-xs text-muted">{new Date(r.sentAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
