"use client";

import { useEffect, useState } from "react";
import type { KeyPair } from "near-api-js";
import { CASH_OUT_ASSETS, config, ONE_USDC, type CashOutAsset } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { formatUsdc, parseUsdc, usdcDecimal } from "@/lib/money";
import { reason, relayCall, withdrawnAmount } from "@/lib/near";
import { availableNow } from "../StreamMath";
import { Button, Card, Field, Notice, Pill, TextInput } from "../ui";

interface Quote {
  amountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  timeEstimate?: number;
  depositAddress?: string;
}

const ADDRESS: Record<CashOutAsset["kind"], { pattern: RegExp; hint: string }> = {
  evm: { pattern: /^0x[0-9a-fA-F]{40}$/, hint: "0x… address" },
  solana: { pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, hint: "Solana address" },
  tron: { pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, hint: "Tron address starting with T" },
};

const FINAL_STATUSES = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const STATUS_POLL_MS = 5000;
const WITHDRAW_TO_GAS_TGAS = 50;

type LogFn = (text: string, txHash?: string, error?: boolean) => void;

async function fetchQuote(body: { amount: string; destination: string; recipient: string; refundTo: string }) {
  const res = await fetch("/api/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: { quote?: Quote; dry?: boolean; error?: string } = await res.json();
  if (!res.ok || !data.quote) throw new Error(data.error ?? "Quote failed");
  return { quote: data.quote, dry: data.dry !== false };
}

/** Follows a cash-out through NEAR Intents until it succeeds, refunds or fails. */
function useCashOutStatus(log: LogFn) {
  const [tracking, setTracking] = useState<{ depositAddress: string; status: string } | null>(null);

  useEffect(() => {
    if (!tracking || FINAL_STATUSES.has(tracking.status)) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/quote?depositAddress=${tracking.depositAddress}`);
      // A failed poll is retried on the next tick; only a reported status changes state.
      if (!res.ok) return;
      const data: { status?: string } = await res.json();
      if (!data.status || data.status === tracking.status) return;
      setTracking({ ...tracking, status: data.status });
      log(`Cash-out status: ${data.status}`, undefined, data.status === "FAILED");
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [tracking, log]);

  return { tracking, track: (depositAddress: string) => setTracking({ depositAddress, status: "PENDING_DEPOSIT" }) };
}

function QuoteSummary({ quote, asset, sourceId }: { quote: Quote; asset: CashOutAsset; sourceId: number }) {
  // Every destination is a 6-decimal dollar stablecoin, so in minus out is the total cost.
  const cost = BigInt(quote.amountIn) - BigInt(quote.amountOut);
  const rows = [
    ["You send", `${formatUsdc(BigInt(quote.amountIn), 6)} USDC`],
    ["You receive", `${quote.amountOutFormatted} ${asset.label}`],
    ["At least", formatUsdc(BigInt(quote.minAmountOut), 6)],
    ["Arrives in", quote.timeEstimate ? `about ${quote.timeEstimate} s` : "unknown"],
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
        Fees and price impact: {formatUsdc(cost, 6)} USDC. Funds come straight from salary stream #{sourceId}; if the
        swap cannot complete, NEAR Intents refunds your NEAR account.
      </p>
    </div>
  );
}

export function CashOut(props: {
  keyPair: KeyPair;
  accountId: string;
  streams: StreamRecord[];
  now: number;
  onDone: () => void;
  log: LogFn;
}) {
  const { keyPair, accountId, streams, now, onDone, log } = props;
  const [asset, setAsset] = useState<CashOutAsset>(CASH_OUT_ASSETS[0]);
  const [recipient, setRecipient] = useState("");
  const [amountText, setAmountText] = useState("");
  const [offer, setOffer] = useState<{ quote: Quote; dry: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { tracking, track } = useCashOutStatus(log);

  // One withdrawal pays one cash-out, so it comes from the stream with the most available.
  const source = streams.reduce((best, s) => (availableNow(s, now) > availableNow(best, now) ? s : best), streams[0]);
  const max = availableNow(source, now);

  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setOffer(null);
      setError(null);
    };
  }

  function validAmount(): bigint | string {
    let amount: bigint;
    try {
      amount = parseUsdc(amountText);
    } catch {
      return "Enter an amount in USDC, like 25 or 12.50";
    }
    if (amount < ONE_USDC) return "Cash out at least 1 USDC";
    if (amount > max) return `At most ${formatUsdc(max, 6)} USDC is available in one cash-out`;
    if (!ADDRESS[asset.kind].pattern.test(recipient.trim())) return `Enter a valid ${ADDRESS[asset.kind].hint}`;
    return amount;
  }

  async function getQuote() {
    const amount = validAmount();
    if (typeof amount === "string") return setError(amount);
    setBusy(true);
    setError(null);
    try {
      setOffer(
        await fetchQuote({ amount: amount.toString(), destination: asset.id, recipient: recipient.trim(), refundTo: accountId }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cashOut(quote: Quote, depositAddress: string) {
    setBusy(true);
    try {
      const res = await relayCall(
        keyPair,
        config.payday,
        "withdraw",
        { stream_id: source.id, amount: quote.amountIn, receiver: depositAddress },
        WITHDRAW_TO_GAS_TGAS,
      );
      const sent = withdrawnAmount(res);
      if (sent === null) {
        log(`Cash-out failed: ${reason(res, "the transfer was reverted and your balance restored")}`, res.txHash, true);
        return;
      }
      log(`Sent ${formatUsdc(sent)} USDC to NEAR Intents for ${asset.label}`, res.txHash);
      track(depositAddress);
    } catch (e) {
      log(`Cash-out failed: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    } finally {
      setBusy(false);
      setOffer(null);
      onDone();
    }
  }

  // A dry-run quote (testnet) carries no deposit address, so there is nothing to send to.
  const depositAddress = offer && !offer.dry ? offer.quote.depositAddress : undefined;

  return (
    <Card title="Cash out to another chain" aside={<Pill>via NEAR Intents</Pill>}>
      <fieldset>
        <legend className="text-xs font-medium text-muted">Receive</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {CASH_OUT_ASSETS.map((option) => {
            const selected = option.id === asset.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => edit(setAsset)(option)}
                className={`rounded-xl border px-3 py-2.5 text-left text-sm transition duration-150 active:scale-[0.97] ${
                  selected ? "border-accent bg-accent-soft font-medium text-accent" : "border-border hover:border-muted"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Field label="To address">
          <TextInput
            className="num"
            placeholder={ADDRESS[asset.kind].hint}
            value={recipient}
            spellCheck={false}
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
              onClick={() => edit(setAmountText)(usdcDecimal(max))}
              className="absolute inset-y-1.5 right-1.5 rounded-lg px-2 text-xs font-medium text-accent hover:bg-accent-soft"
            >
              Max
            </button>
          </span>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={busy && !offer} disabled={busy} onClick={getQuote}>
          Get quote
        </Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      {offer && (
        <div className="mt-4 space-y-3">
          <QuoteSummary quote={offer.quote} asset={asset} sourceId={source.id} />
          {depositAddress ? (
            <Button loading={busy} onClick={() => cashOut(offer.quote, depositAddress)}>
              Cash out {formatUsdc(BigInt(offer.quote.amountIn))} USDC
            </Button>
          ) : (
            <Notice tone="warn">
              This is a live mainnet price. NEAR Intents has no testnet, so on testnet Payday only quotes. On mainnet,
              Cash out sends this amount from your stream to the quote&apos;s deposit address in one gas-free step.
            </Notice>
          )}
        </div>
      )}

      {tracking && (
        <p className="mt-4 flex items-center gap-2 text-sm">
          Status <Pill tone={FINAL_STATUSES.has(tracking.status) ? "neutral" : "live"}>{tracking.status}</Pill>
        </p>
      )}
    </Card>
  );
}
