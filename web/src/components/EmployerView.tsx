"use client";

import { useMemo, useState } from "react";
import { config, ONE_YOCTO } from "@/lib/config";
import { fundingMsg, parsePayrollCsv, streamsCsv, summarizeRows, type PayrollRow } from "@/lib/csv";
import { useLedger, useLog, useNow, useOtherRoleId, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { emitted, reason, relayCall } from "@/lib/near";
import { eventsNamed } from "@/lib/outcome";
import { availableNow, fmtDate, statusOf } from "./StreamMath";
import { AccountChip, ActivityLog, Button, Card, Notice, shortId } from "./ui";

const TEST_MINT = 5_000_000_000n; // 5,000 USDC

function fundingGasTgas(streams: number): number {
  return Math.min(250, 60 + 8 * streams);
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function EmployerView() {
  const account = useRoleAccount("employer");
  const accountId = account.status === "ready" ? account.accountId : null;
  const workerId = useOtherRoleId("worker");
  const ledger = useLedger(accountId);
  const now = useNow(1000);
  const log = useLog();
  const [csv, setCsv] = useState("worker,amount,start,end\n");
  const [busy, setBusy] = useState<string | null>(null);

  const nowSecs = Math.floor(now / 1000);
  const parsed = useMemo((): { rows: PayrollRow[] } | { error: string } => {
    try {
      return { rows: parsePayrollCsv(csv, nowSecs) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [csv, nowSecs]);

  if (account.status === "loading") return <p className="text-muted">Setting up your Payday account…</p>;
  if (account.status === "error") return <Notice tone="error">{account.error}</Notice>;

  const mine = ledger.streams.filter((s) => s.employer === account.accountId);
  const total = "rows" in parsed ? parsed.rows.reduce((sum, r) => sum + r.amount, 0n) : 0n;

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    try {
      await action();
    } catch (e) {
      log.add(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    } finally {
      setBusy(null);
      ledger.refresh();
    }
  }

  const mint = () =>
    run("Mint", async () => {
      if (account.status !== "ready") return;
      const res = await relayCall(account.keyPair, config.usdc, "mint", { account_id: account.accountId, amount: TEST_MINT.toString() }, 10);
      if (emitted(res, "nep141", "ft_mint")) log.add("Received 5,000 test USDC", res.txHash);
      else log.add(`Mint failed: ${reason(res, "the token did not mint")}`, res.txHash, true);
    });

  const fund = () =>
    run("Funding", async () => {
      if (account.status !== "ready" || !("rows" in parsed)) return;
      const rows = parsed.rows;
      const res = await relayCall(
        account.keyPair,
        config.usdc,
        "ft_transfer_call",
        { receiver_id: config.payday, amount: total.toString(), msg: fundingMsg(rows) },
        fundingGasTgas(rows.length),
        ONE_YOCTO,
      );
      // Payday emits one stream_created per stream; if it rejects the payroll the token
      // refunds the whole transfer and there are none.
      const created = res.error === undefined ? eventsNamed(res, "payday", "stream_created").length : 0;
      if (created === rows.length) {
        log.add(`Funded ${summarizeRows(rows)}`, res.txHash);
        setCsv("worker,amount,start,end\n");
      } else {
        log.add(`Payroll refunded: ${reason(res, "Payday rejected the payroll")}`, res.txHash, true);
      }
    });

  const cancel = (id: number) =>
    run("Cancel", async () => {
      if (account.status !== "ready") return;
      const res = await relayCall(account.keyPair, config.payday, "cancel", { stream_id: id }, 40);
      if (emitted(res, "payday", "stream_canceled")) log.add(`Cancelled stream #${id}; unearned salary refunded`, res.txHash);
      else log.add(`Cancel failed: ${reason(res, "Payday did not cancel the stream")}`, res.txHash, true);
    });

  function addWorker() {
    if (!workerId) return;
    const base = csv.endsWith("\n") || csv === "" ? csv : `${csv}\n`;
    setCsv(`${base}${workerId},1000,,\n`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Run payroll</h1>
        <p className="text-muted">Fund every salary in one transfer. Each worker&apos;s pay streams by the second.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="text-sm text-muted">USDC balance</div>
          <div className="num mt-1 text-3xl font-semibold">{formatUsdc(ledger.balance)}</div>
          {config.networkId === "testnet" && (
            <Button className="mt-3" variant="secondary" disabled={busy !== null} onClick={mint}>
              {busy === "Mint" ? "Minting…" : "Get 5,000 test USDC"}
            </Button>
          )}
        </Card>
        <Card>
          <div className="text-sm text-muted">Your employer account</div>
          <div className="mt-2">
            <AccountChip id={account.accountId} />
          </div>
          <p className="mt-2 text-xs text-muted">Created in this browser. Payday&apos;s relayer pays your gas on testnet.</p>
        </Card>
      </div>

      <Card
        title="New payroll"
        aside={
          <label className="cursor-pointer text-sm underline">
            Load CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
                e.target.value = "";
              }}
            />
          </label>
        }
      >
        <p className="mb-2 text-sm text-muted">
          One row per worker: <span className="num">worker,amount,start,end</span>. Amount is in USDC; dates are
          YYYY-MM-DD in UTC. Leave start empty to start now and end empty for 30 days.
        </p>
        <textarea
          className="num h-36 w-full rounded-lg border border-border bg-surface p-3 text-sm"
          spellCheck={false}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy !== null || !("rows" in parsed) || total > ledger.balance}
            onClick={fund}
          >
            {busy === "Funding" ? "Funding…" : "rows" in parsed ? `Fund ${summarizeRows(parsed.rows)}` : "Fund payroll"}
          </Button>
          {workerId && (
            <Button variant="secondary" onClick={addWorker}>
              Add my worker account
            </Button>
          )}
          <span className={`text-sm ${"error" in parsed ? "text-muted" : total > ledger.balance ? "text-danger" : "text-muted"}`}>
            {"error" in parsed
              ? parsed.error
              : total > ledger.balance
                ? `You need ${formatUsdc(total - ledger.balance)} more USDC`
                : "Ready to fund"}
          </span>
        </div>
      </Card>

      <Card
        title="Streams you pay"
        aside={
          mine.length > 0 && (
            <Button variant="secondary" onClick={() => download(`payday-${new Date().toISOString().slice(0, 10)}.csv`, streamsCsv(mine, new Date()))}>
              Export CSV
            </Button>
          )
        }
      >
        {mine.length === 0 ? (
          <p className="text-sm text-muted">{ledger.loaded ? "No streams yet." : "Loading…"}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-2 pr-4 font-normal">#</th>
                  <th className="py-2 pr-4 font-normal">Worker</th>
                  <th className="py-2 pr-4 text-right font-normal">Total</th>
                  <th className="py-2 pr-4 text-right font-normal">Paid out</th>
                  <th className="py-2 pr-4 text-right font-normal">Earned, unpaid</th>
                  <th className="py-2 pr-4 font-normal">Period</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mine.map((s) => {
                  const status = statusOf(s, now);
                  return (
                    <tr key={s.id}>
                      <td className="num py-2.5 pr-4">{s.id}</td>
                      <td className="num py-2.5 pr-4" title={s.worker}>{shortId(s.worker)}</td>
                      <td className="num py-2.5 pr-4 text-right">{formatUsdc(BigInt(s.deposit))}</td>
                      <td className="num py-2.5 pr-4 text-right">{formatUsdc(BigInt(s.withdrawn))}</td>
                      <td className="num py-2.5 pr-4 text-right">{formatUsdc(availableNow(s, now), 4)}</td>
                      <td className="py-2.5 pr-4 text-muted">
                        {fmtDate(s.start)} – {fmtDate(s.stop)} · {status}
                      </td>
                      <td className="py-2.5 text-right">
                        {status !== "finished" && (
                          <Button variant="danger" disabled={busy !== null} onClick={() => cancel(s.id)}>
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ActivityLog entries={log.entries} />
    </div>
  );
}
