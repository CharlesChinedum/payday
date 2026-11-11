import type { LogFn } from "./hooks";
import type { RelayResult } from "./near";
import type { TxOutcome } from "./outcome";

export type Verdict = { ok: true; text: string } | { ok: false; text: string };

export type Reported = "done" | "failed" | "unknown";

export const UNCONFIRMED_TEXT =
  "Sent, but not confirmed yet. Your balances refresh in a moment: check them before trying again.";

/**
 * Logs what a relayed call actually did. An unconfirmed call is reported as unknown,
 * never as failed, so nobody is invited to pay twice.
 */
export function report(log: LogFn, res: RelayResult, judge: (outcome: TxOutcome) => Verdict): Reported {
  if (res.status === "refused") {
    log(res.error, undefined, true);
    return "failed";
  }
  if (res.status === "unknown") {
    log(UNCONFIRMED_TEXT, undefined, true);
    return "unknown";
  }
  const verdict = judge(res.outcome);
  log(verdict.text, res.outcome.txHash, !verdict.ok);
  return verdict.ok ? "done" : "failed";
}
