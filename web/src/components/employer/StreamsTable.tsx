"use client";

import { useState } from "react";
import type { StreamRecord } from "@/lib/csv";
import { formatUsdc, vestedAt } from "@/lib/money";
import { LiveAmount } from "../LiveAmount";
import { availableNow, fmtDate, progress, statusOf } from "../StreamMath";
import { Button, Pill, ProgressBar, shortId } from "../ui";

function CancelConfirm(props: { stream: StreamRecord; now: number; onConfirm: () => void; onKeep: () => void }) {
  const { stream, now, onConfirm, onKeep } = props;
  const deposit = BigInt(stream.deposit);
  const refund = deposit - vestedAt(deposit, stream.start, stream.stop, now / 1000);
  return (
    <div className="flex animate-pop flex-wrap items-center justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3 lg:col-span-3">
      <p className="text-sm">
        Cancel stream #{stream.id}? About <span className="num font-medium">{formatUsdc(refund)} USDC</span> comes back
        to you. The worker keeps what they have earned.
      </p>
      <div className="flex gap-2">
        <Button variant="danger" onClick={onConfirm}>
          Yes, cancel
        </Button>
        <Button variant="ghost" onClick={onKeep}>
          Keep paying
        </Button>
      </div>
    </div>
  );
}

function StreamRow(props: {
  stream: StreamRecord;
  now: number;
  disabled: boolean;
  cancelling: boolean;
  onCancel: () => void;
  proposeOnly: boolean;
}) {
  const { stream, now, disabled, cancelling, onCancel, proposeOnly } = props;
  const [confirming, setConfirming] = useState(false);
  const status = statusOf(stream, now);
  return (
    <li className="grid gap-4 py-5 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_8rem] lg:items-center">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">#{stream.id}</span>
          <span className="num" title={stream.worker}>
            {shortId(stream.worker)}
          </span>
          <Pill tone={status === "streaming" ? "live" : "neutral"}>{status}</Pill>
        </div>
        <ProgressBar fraction={progress(stream, now)} />
        <div className="text-xs text-muted">
          {fmtDate(stream.start)} – {fmtDate(stream.stop)}
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Total</dt>
          <dd className="num mt-0.5">{formatUsdc(BigInt(stream.deposit))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Paid out</dt>
          <dd className="num mt-0.5">{formatUsdc(BigInt(stream.withdrawn))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Earned, unpaid</dt>
          <dd className="mt-0.5">
            <LiveAmount amountAt={(nowMs) => availableNow(stream, nowMs)} />
          </dd>
        </div>
      </dl>

      <div className="flex justify-end">
        {status !== "finished" &&
          (proposeOnly ? (
            // A DAO decides by vote, so there is nothing to confirm here: this only drafts.
            <Button variant="secondary" disabled={disabled} onClick={onCancel}>
              Propose stop
            </Button>
          ) : (
            <Button variant="danger" loading={cancelling} disabled={disabled || confirming} onClick={() => setConfirming(true)}>
              Cancel
            </Button>
          ))}
      </div>

      {confirming && (
        <CancelConfirm
          stream={stream}
          now={now}
          onKeep={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onCancel();
          }}
        />
      )}
    </li>
  );
}

export function StreamsTable(props: {
  streams: StreamRecord[];
  now: number;
  disabled: boolean;
  cancellingId: number | null;
  onCancel: (streamId: number) => void;
  /** For a DAO's streams: the button drafts a cancel proposal instead of cancelling. */
  proposeOnly?: boolean;
}) {
  const { streams, now, disabled, cancellingId, onCancel, proposeOnly = false } = props;
  return (
    <ul className="divide-y divide-border">
      {streams.map((s) => (
        <StreamRow
          key={s.id}
          stream={s}
          now={now}
          disabled={disabled}
          cancelling={cancellingId === s.id}
          onCancel={() => onCancel(s.id)}
          proposeOnly={proposeOnly}
        />
      ))}
    </ul>
  );
}
