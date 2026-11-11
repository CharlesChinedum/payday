"use client";

import { useEffect, useState } from "react";
import { accountUrl, config } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { useNow } from "@/lib/hooks";
import { formatUsdc, vestedSmooth } from "@/lib/money";
import { getStream } from "@/lib/near";
import { ArrowUpRightIcon } from "../icons";
import { LiveAmount } from "../LiveAmount";
import { fmtDate, progress, ratePerDay, statusOf } from "../StreamMath";
import { Pill, ProgressBar, Skeleton, shortId } from "../ui";

type Load = { status: "loading" } | { status: "missing" } | { status: "ready"; stream: StreamRecord };

function useDemoStream(): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    const id = config.demoStreamId;
    let cancelled = false;
    const settle = (next: Load) => !cancelled && setLoad(next);
    Promise.resolve(id === undefined ? null : getStream(id)).then(
      (stream) => settle(stream ? { status: "ready", stream } : { status: "missing" }),
      () => settle({ status: "missing" }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return load;
}

function StreamCard({ stream }: { stream: StreamRecord }) {
  const now = useNow(1000);
  const deposit = BigInt(stream.deposit);
  const status = statusOf(stream, now);
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone={status === "streaming" ? "live" : "neutral"}>
          {status === "streaming" ? "Streaming now" : status === "scheduled" ? "Scheduled" : "Finished"}
        </Pill>
        <a
          href={accountUrl(config.payday)}
          target="_blank"
          rel="noreferrer"
          className="num inline-flex items-center gap-1 text-xs text-muted underline decoration-border underline-offset-4 hover:text-text"
        >
          {config.payday}
          <ArrowUpRightIcon width={12} height={12} />
        </a>
      </div>

      <p className="mt-5 text-xs font-medium uppercase tracking-wider text-muted">Earned so far, stream #{stream.id}</p>
      <p className="mt-1 text-4xl font-semibold tracking-tight sm:text-5xl">
        <LiveAmount amountAt={(nowMs) => vestedSmooth(deposit, stream.start, stream.stop, nowMs)} />
      </p>
      <p className="mt-1 text-sm text-muted">
        of {formatUsdc(deposit)} test USDC · {formatUsdc(ratePerDay(stream))} per day
      </p>

      <div className="mt-5">
        <ProgressBar fraction={progress(stream, now)} />
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span>{fmtDate(stream.start)}</span>
          <span>{fmtDate(stream.stop)}</span>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm">
        <div>
          <dt className="text-xs text-muted">From</dt>
          <dd className="num mt-0.5">{shortId(stream.employer)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">To</dt>
          <dd className="num mt-0.5">{shortId(stream.worker)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** A real salary stream read from the Payday contract, so the claim can be checked. */
export function LiveStream() {
  const load = useDemoStream();
  if (load.status === "ready") return <StreamCard stream={load.stream} />;
  if (load.status === "loading") {
    return (
      <div className="space-y-4 rounded-2xl border border-border bg-surface p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-surface p-6 text-sm text-muted">
      The demo stream is not available right now. Open the worker page and start one of your own; it takes about a
      minute.
    </div>
  );
}
