"use client";

import { useState } from "react";
import { config } from "@/lib/config";
import { useLedger, useLog, useNow, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { emitted, reason, relayCall } from "@/lib/near";
import { availableNow, fmtDate, progress, ratePerDay } from "./StreamMath";
import { CashOut } from "./CashOut";
import { AccountChip, ActivityLog, Button, Card, Notice, shortId } from "./ui";

export function WorkerView() {
  const account = useRoleAccount("worker");
  const accountId = account.status === "ready" ? account.accountId : null;
  const ledger = useLedger(accountId);
  const now = useNow(100);
  const log = useLog();
  const [busy, setBusy] = useState<number | null>(null);

  if (account.status === "loading") return <p className="text-muted">Setting up your Payday account…</p>;
  if (account.status === "error") return <Notice tone="error">{account.error}</Notice>;

  const mine = ledger.streams.filter((s) => s.worker === account.accountId);
  const total = mine.reduce((sum, s) => sum + availableNow(s, now), 0n);

  async function withdraw(streamId: number) {
    if (account.status !== "ready") return;
    setBusy(streamId);
    try {
      const res = await relayCall(account.keyPair, config.payday, "withdraw", { stream_id: streamId }, 40);
      if (emitted(res, "payday", "withdrawn")) log.add(`Withdrew from stream #${streamId}, no gas paid`, res.txHash);
      else log.add(`Withdrawal failed: ${reason(res, "the transfer was reverted and your balance restored")}`, res.txHash, true);
    } catch (e) {
      log.add(`Withdrawal failed: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    } finally {
      setBusy(null);
      ledger.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your pay</h1>
        <p className="text-muted">Salary that grows every second. Withdraw any time; Payday pays the gas.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <div className="text-sm text-muted">Available to withdraw</div>
          <div className="num mt-1 text-3xl font-semibold">{formatUsdc(total, 6)}</div>
          <div className="text-sm text-muted">USDC</div>
        </Card>
        <Card>
          <div className="text-sm text-muted">In your account</div>
          <div className="num mt-1 text-3xl font-semibold">{formatUsdc(ledger.balance)}</div>
          <div className="text-sm text-muted">USDC</div>
        </Card>
        <Card>
          <div className="text-sm text-muted">Your Payday account</div>
          <div className="mt-2">
            <AccountChip id={account.accountId} />
          </div>
          <p className="mt-2 text-xs text-muted">Give this to your employer so they can pay you.</p>
        </Card>
      </div>

      <Card title="Salary streams">
        {!ledger.loaded ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="text-sm text-muted">
            No salary yet. Copy your account above and add it to a payroll on the{" "}
            <a className="underline" href="/employer">Employer</a> page.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((s) => {
              const available = availableNow(s, now);
              return (
                <li key={s.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                  <div className="flex-1 space-y-1.5">
                    <div className="text-sm">
                      <span className="font-medium">#{s.id}</span> from <span className="num">{shortId(s.employer)}</span>
                      <span className="text-muted">
                        {" "}· {formatUsdc(BigInt(s.deposit))} USDC · {formatUsdc(ratePerDay(s))}/day ·{" "}
                        {fmtDate(s.start)} – {fmtDate(s.stop)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full bg-accent" style={{ width: `${progress(s, now) * 100}%` }} />
                    </div>
                  </div>
                  <div className="num w-36 text-right font-medium">{formatUsdc(available, 6)}</div>
                  <Button disabled={busy !== null || available === 0n} onClick={() => withdraw(s.id)}>
                    {busy === s.id ? "Withdrawing…" : "Withdraw"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {ledger.error && <p className="mt-3 text-sm text-danger">Could not read the chain: {ledger.error}</p>}
      </Card>

      {mine.length > 0 && (
        <CashOut
          keyPair={account.keyPair}
          accountId={account.accountId}
          streams={mine}
          now={now}
          onDone={ledger.refresh}
          log={log.add}
        />
      )}

      <ActivityLog entries={log.entries} />
    </div>
  );
}
