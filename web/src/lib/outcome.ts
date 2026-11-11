/** A NEP-297 event emitted by any receipt of a transaction. */
export interface ChainEvent {
  standard: string;
  event: string;
  data: unknown[];
}

export interface TxOutcome {
  txHash: string;
  /** False only when the transaction itself failed. */
  ok: boolean;
  events: ChainEvent[];
  /** Readable messages from every failed receipt, e.g. a contract panic. */
  failures: string[];
}

interface ReceiptOutcome {
  outcome: { logs: string[]; status: unknown; executor_id?: string };
}

/** Which account may emit events of each standard: anything else is ignored. */
export type Emitters = Record<string, string>;

interface RawResult {
  transaction: { hash: string };
  status: unknown;
  receipts_outcome?: ReceiptOutcome[];
}

const PREFIX = "EVENT_JSON:";

function failureMessage(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /"ExecutionError":"(?:Smart contract panicked: )?([^"]+)"/.exec(text);
  return panic ? panic[1] : text;
}

function failureOf(status: unknown): unknown {
  return status && typeof status === "object" && "Failure" in status ? (status as { Failure: unknown }).Failure : undefined;
}

/**
 * A relayed meta transaction's own status only covers the delegate wrapper, so success is
 * read from the contracts' events and from failures in any receipt. An event counts only
 * if the receipt that logged it ran on the account `emitters` names for its standard.
 */
export function summarizeOutcome(res: RawResult, emitters: Emitters): TxOutcome {
  const receipts = res.receipts_outcome ?? [];
  const events: ChainEvent[] = [];
  const failures: string[] = [];
  for (const r of receipts) {
    for (const log of r.outcome.logs) {
      if (!log.startsWith(PREFIX)) continue;
      let event: ChainEvent;
      try {
        event = JSON.parse(log.slice(PREFIX.length));
      } catch {
        continue; // malformed logs are not events
      }
      if (emitters[event.standard] === r.outcome.executor_id) events.push(event);
    }
    const failure = failureOf(r.outcome.status);
    if (failure !== undefined) failures.push(failureMessage(failure));
  }
  const txFailure = failureOf(res.status);
  if (txFailure !== undefined && failures.length === 0) failures.push(failureMessage(txFailure));
  return { txHash: res.transaction.hash, ok: txFailure === undefined, events, failures };
}

export function eventsNamed(outcome: Pick<TxOutcome, "events">, standard: string, event: string): ChainEvent[] {
  return outcome.events.filter((e) => e.standard === standard && e.event === event);
}
