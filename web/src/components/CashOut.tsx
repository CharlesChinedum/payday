"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyPair } from "near-api-js";
import { CASH_OUT_ASSETS, config, ONE_USDC, type CashOutAsset } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { formatUsdc, parseUsdc } from "@/lib/money";
import { emitted, reason, relayCall } from "@/lib/near";
import { availableNow } from "./StreamMath";
import { Button, Card, Notice } from "./ui";

interface Quote {
  amountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  amountOutUsd?: string;
  timeEstimate?: number;
  depositAddress?: string;
}

const ADDRESS: Record<CashOutAsset["kind"], { re: RegExp; hint: string }> = {
  evm: { re: /^0x[0-9a-fA-F]{40}$/, hint: "0x… address" },
  solana: { re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, hint: "Solana address" },
  tron: { re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, hint: "Tron address starting with T" },
};

const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export function CashOut(props: {
  keyPair: KeyPair;
  accountId: string;
  streams: StreamRecord[];
  now: number;
  onDone: () => void;
  log: (text: string, txHash?: string, error?: boolean) => void;
}) {
  const { keyPair, accountId, streams, now, onDone, log } = props;
  const [assetId, setAssetId] = useState<string>(CASH_OUT_ASSETS[0].id);
  const [recipient, setRecipient] = useState("");
  const [amountText, setAmountText] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [dry, setDry] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState<{ depositAddress: string; status: string } | null>(null);

  const asset = CASH_OUT_ASSETS.find((a) => a.id === assetId)!;
  // Cash out from the stream with the most available, so one withdrawal covers it.
  const source = useMemo(
    () => [...streams].sort((a, b) => (availableNow(b, now) > availableNow(a, now) ? 1 : -1))[0],
    [streams, now],
  );
  const max = source ? availableNow(source, now) : 0n;

  useEffect(() => {
    if (!tracking || FINAL.has(tracking.status)) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/quote?depositAddress=${tracking.depositAddress}`);
      const data = await res.json();
      if (data.status && data.status !== tracking.status) {
        setTracking({ ...tracking, status: data.status });
        log(`Cash-out status: ${data.status}`, undefined, data.status === "FAILED");
      }
    }, 5000);
    return () => clearInterval(t);
  }, [tracking, log]);

  function validate(): bigint | null {
    setError(null);
    let amount: bigint;
    try {
      amount = parseUsdc(amountText);
    } catch {
      setError("Enter an amount in USDC, like 25 or 12.50");
      return null;
    }
    if (amount < ONE_USDC) return setError("Cash out at least 1 USDC"), null;
    if (amount > max) return setError(`At most ${formatUsdc(max, 6)} USDC is available in one cash-out`), null;
    if (!ADDRESS[asset.kind].re.test(recipient.trim())) return setError(`Enter a valid ${ADDRESS[asset.kind].hint}`), null;
    return amount;
  }

  async function getQuote() {
    const amount = validate();
    if (amount === null) return;
    setBusy(true);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount.toString(), destination: assetId, recipient: recipient.trim(), refundTo: accountId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Quote failed");
      setQuote(data.quote);
      setDry(data.dry);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cashOut() {
    if (!quote?.depositAddress || !source) return;
    setBusy(true);
    try {
      const res = await relayCall(
        keyPair,
        config.payday,
        "withdraw",
        { stream_id: source.id, amount: quote.amountIn, receiver: quote.depositAddress },
        50,
      );
      if (emitted(res, "payday", "withdrawn")) {
        log(`Sent ${formatUsdc(BigInt(quote.amountIn))} USDC to NEAR Intents for ${asset.label}`, res.txHash);
        setTracking({ depositAddress: quote.depositAddress, status: "PENDING_DEPOSIT" });
      } else {
        log(`Cash-out failed: ${reason(res, "the transfer was reverted and your balance restored")}`, res.txHash, true);
      }
    } finally {
      setBusy(false);
      setQuote(null);
      onDone();
    }
  }

  const fee = quote ? BigInt(quote.amountIn) - BigInt(quote.amountOut) : 0n;

  return (
    <Card title="Cash out to another chain" aside={<span className="text-xs text-muted">via NEAR Intents</span>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-muted">Receive</span>
          <select
            className="w-full rounded-lg border border-border bg-surface px-3 py-2"
            value={assetId}
            onChange={(e) => {
              setAssetId(e.target.value);
              setQuote(null);
            }}
          >
            {CASH_OUT_ASSETS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="text-muted">To address</span>
          <input
            className="num w-full rounded-lg border border-border bg-surface px-3 py-2"
            placeholder={ADDRESS[asset.kind].hint}
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setQuote(null);
            }}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted">Amount (USDC)</span>
          <input
            className="num w-full rounded-lg border border-border bg-surface px-3 py-2"
            inputMode="decimal"
            placeholder={formatUsdc(max)}
            value={amountText}
            onChange={(e) => {
              setAmountText(e.target.value);
              setQuote(null);
            }}
          />
        </label>
        <div className="flex items-end sm:col-span-2">
          <Button variant="secondary" disabled={busy} onClick={getQuote}>
            {busy && !quote ? "Getting quote…" : "Get quote"}
          </Button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      {quote && (
        <div className="mt-4 space-y-3">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-surface-2 p-4 text-sm sm:grid-cols-4">
            <dt className="text-muted">You send</dt>
            <dt className="text-muted">You receive</dt>
            <dt className="text-muted">At least</dt>
            <dt className="text-muted">Arrives in</dt>
            <dd className="num">{formatUsdc(BigInt(quote.amountIn), 6)} USDC</dd>
            <dd className="num">
              {quote.amountOutFormatted} {asset.label.split(" ")[0]}
            </dd>
            <dd className="num">{formatUsdc(BigInt(quote.minAmountOut), 6)}</dd>
            <dd className="num">~{quote.timeEstimate ?? "?"} s</dd>
          </dl>
          <p className="text-xs text-muted">
            Fees and price impact: {formatUsdc(fee, 6)} USDC. Funds come straight from salary stream #{source?.id}; if
            the swap cannot complete, NEAR Intents refunds your NEAR account.
          </p>
          {dry ? (
            <Notice tone="warn">
              This is a live mainnet price. NEAR Intents has no testnet, so on testnet Payday only quotes. On mainnet,
              Cash out sends this amount from your stream to the quote&apos;s deposit address in one gas-free step.
            </Notice>
          ) : (
            <Button disabled={busy} onClick={cashOut}>
              {busy ? "Sending…" : `Cash out ${formatUsdc(BigInt(quote.amountIn))} USDC`}
            </Button>
          )}
        </div>
      )}

      {tracking && (
        <p className="mt-3 text-sm">
          Status: <span className="num font-medium">{tracking.status}</span>
          {!FINAL.has(tracking.status) && <span className="text-muted"> · checking every 5 s</span>}
        </p>
      )}
    </Card>
  );
}
