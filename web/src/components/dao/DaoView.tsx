"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { isNearAccountId } from "@/lib/address";
import { config } from "@/lib/config";
import type { PayrollRow, StreamRecord } from "@/lib/csv";
import {
  callThreshold,
  canPropose,
  cancelProposal,
  fundingProposal,
  nearAmount,
  paydayActionOf,
  proposeCommand,
  thresholdText,
  voteCommand,
  voters,
  type AddProposalArgs,
  type DaoPolicy,
  type DaoProposal,
  type PaydayAction,
} from "@/lib/dao";
import { useNow, useOtherRoleId } from "@/lib/hooks";
import { formatUsdc, vestedAt } from "@/lib/money";
import { getFees, getStreams, getUsdcBalance, view, type Fees } from "@/lib/near";
import { PayrollComposer } from "../employer/PayrollComposer";
import { StreamsTable } from "../employer/StreamsTable";
import { ArrowRightIcon } from "../icons";
import { CountAmount } from "../LiveAmount";
import { AccountChip, Button, Card, CopyButton, Notice, Pill, Skeleton, Stat, TextInput, shortId } from "../ui";

const REFRESH_MS = 15_000;
/** How many of the DAO's most recent proposals to scan for Payday ones. */
const PROPOSAL_WINDOW = 100;
const SIGNER_KEY = "payday:dao-signer";
const ctx = { usdc: config.usdc, payday: config.payday };

interface DaoState {
  name: string;
  policy: DaoPolicy;
  balance: bigint;
  fees: Fees;
  streams: StreamRecord[];
  proposals: Array<DaoProposal & { action: PaydayAction }>;
}

type Load = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: DaoState };

async function loadDao(dao: string): Promise<DaoState> {
  let policy: DaoPolicy;
  try {
    policy = await view<DaoPolicy>(dao, "get_policy");
  } catch {
    throw new Error(`${dao} is not a Sputnik DAO on NEAR ${config.networkId}`);
  }
  const [daoConfig, last, balance, fees, streams] = await Promise.all([
    view<{ name: string }>(dao, "get_config"),
    view<number>(dao, "get_last_proposal_id"),
    getUsdcBalance(dao).catch(() => 0n),
    getFees(),
    getStreams(dao),
  ]);
  const from = Math.max(0, last - PROPOSAL_WINDOW);
  const recent = last > 0 ? await view<DaoProposal[]>(dao, "get_proposals", { from_index: from, limit: PROPOSAL_WINDOW }) : [];
  const proposals = recent
    .map((p) => ({ ...p, action: paydayActionOf(p.kind, ctx) }))
    .filter((p): p is DaoProposal & { action: PaydayAction } => p.action !== null)
    .reverse();
  return {
    name: daoConfig.name || dao,
    policy,
    balance,
    fees,
    streams: streams.filter((s) => s.employer === dao),
    proposals,
  };
}

function useDao(dao: string) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    loadDao(dao).then(
      (data) => !cancelled && setState({ status: "ready", data }),
      (e: unknown) => !cancelled && setState({ status: "error", error: e instanceof Error ? e.message : String(e) }),
    );
    const t = setTimeout(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dao, tick, refresh]);
  return { state, refresh };
}

/** The member's account, remembered so every command on the page is ready to paste. */
const signerListeners = new Set<() => void>();
function useSigner(): [string, (v: string) => void] {
  const value = useSyncExternalStore(
    (fn) => {
      signerListeners.add(fn);
      return () => signerListeners.delete(fn);
    },
    () => {
      try {
        return localStorage.getItem(SIGNER_KEY) ?? "";
      } catch {
        return "";
      }
    },
    () => "",
  );
  const set = (v: string) => {
    try {
      localStorage.setItem(SIGNER_KEY, v.trim());
    } catch {
      // Not remembered; the command still uses it.
    }
    signerListeners.forEach((fn) => fn());
  };
  return [value, set];
}

function Command({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="num max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-bg p-3 pr-20 text-xs leading-relaxed">
        {text}
      </pre>
      <span className="absolute right-2 top-2">
        <CopyButton value={text} />
      </span>
    </div>
  );
}

const STATUS_TONE: Record<string, "good" | "bad" | "wait" | "neutral"> = {
  InProgress: "wait",
  Approved: "good",
  Rejected: "bad",
  Failed: "bad",
  Removed: "neutral",
  Expired: "neutral",
  Moved: "neutral",
};
const STATUS_TEXT: Record<string, string> = { InProgress: "voting", Approved: "approved", Failed: "failed to run" };

const fmtDate = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

/**
 * What a proposal does, read from its arguments: every stream with its full account,
 * amount and dates, and how much would be withdrawable the moment the vote passes.
 */
function ActionSummary({ action, nowSecs, open }: { action: PaydayAction; nowSecs: number; open: boolean }) {
  if (action.kind === "cancel") {
    return <p className="text-sm">Stops stream #{action.streamId}; the unearned rest returns to the DAO.</p>;
  }
  const upfront = action.streams.reduce((sum, s) => sum + vestedAt(s.amount, s.start, s.stop, nowSecs), 0n);
  return (
    <div className="space-y-1 text-sm">
      <p>{formatUsdc(action.total)} USDC leaves the treasury, including fees:</p>
      <ul className="space-y-0.5 text-xs">
        {action.streams.map((s, i) => (
          <li key={i} className="num break-all">
            {formatUsdc(s.amount)} USDC to {s.worker}, {fmtDate(s.start)} to {fmtDate(s.stop)}
          </li>
        ))}
      </ul>
      {open && upfront > 0n && (
        <p className="text-xs text-danger">
          Starts in the past: {formatUsdc(upfront)} USDC would be withdrawable as soon as this passes.
        </p>
      )}
    </div>
  );
}

function ProposalRow({ p, dao, signer }: { p: DaoState["proposals"][number]; dao: string; signer: string }) {
  const [showVote, setShowVote] = useState(false);
  const now = useNow(60_000);
  const approvals = Object.values(p.votes).filter((v) => v === "Approve").length;
  const rejections = Object.values(p.votes).filter((v) => v === "Reject").length;
  return (
    <li className="space-y-2 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Proposal {p.id}</span>
        <Pill tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_TEXT[p.status] ?? p.status.toLowerCase()}</Pill>
        <span className="text-xs text-muted">
          {approvals} for · {rejections} against · by {shortId(p.proposer)}
        </span>
      </div>
      {/* What the proposal does, read from its arguments: the description is the proposer's words. */}
      <ActionSummary action={p.action} nowSecs={Math.floor(now / 1000)} open={p.status === "InProgress"} />
      <p className="text-xs text-muted">“{p.description.slice(0, 280)}”</p>
      {p.status === "InProgress" && (
        <div>
          <button className="text-xs text-accent underline underline-offset-4" onClick={() => setShowVote((v) => !v)}>
            {showVote ? "Hide" : "Vote for it"}
          </button>
          {showVote && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted">
                Any council member runs this with the NEAR CLI, or votes in their usual DAO app. The vote that passes it
                also carries it out.
              </p>
              <Command text={voteCommand(dao, p.id, p.kind, signer, config.networkId)} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DraftPanel({ dao, draft, policy, signer, onClose }: { dao: string; draft: AddProposalArgs; policy: DaoPolicy; signer: string; onClose: () => void }) {
  const allowed = signer ? canPropose(policy, signer) : null;
  const ref = useRef<HTMLDivElement>(null);
  // Drafts start from the form or a stream lower down the page; bring the result into view.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [draft]);
  return (
    <div ref={ref} className="scroll-mt-20">
      <Card title="Your proposal is ready" aside={<Button variant="ghost" onClick={onClose}>Close</Button>} className="animate-pop">
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Submit it: run this with the NEAR CLI. It attaches the DAO&apos;s {nearAmount(policy.proposal_bond)} NEAR proposal bond.</li>
          <li>Your council votes. It needs {thresholdText(callThreshold(policy))}.</li>
          <li>
            {paydayActionOf(draft.proposal.kind, ctx)?.kind === "cancel"
              ? "The vote that passes it stops the stream. The unearned rest returns to the treasury; the contributor keeps what they earned."
              : "The vote that passes it sends the USDC to Payday, and every salary starts streaming at its start date."}
          </li>
        </ol>
        <p className="mb-3 rounded-xl bg-surface-2 px-4 py-3 text-sm">“{draft.proposal.description}”</p>
        <Command text={proposeCommand(dao, draft, policy.proposal_bond, signer, config.networkId)} />
        {allowed === false && (
          <div className="mt-3">
            <Notice tone="warn">{signer} cannot submit function-call proposals in this DAO. Ask a council member to submit it.</Notice>
          </div>
        )}
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Raw proposal, for other DAO tools</summary>
          <div className="mt-2">
            <Command text={JSON.stringify(draft, null, 2)} />
          </div>
        </details>
      </Card>
    </div>
  );
}

function DaoPicker({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  function open(e: FormEvent) {
    e.preventDefault();
    const dao = value.trim().toLowerCase();
    if (!isNearAccountId(dao)) return setError("Enter the DAO's account, like team.sputnik-dao.near");
    setError(null);
    router.replace(`${pathname}?dao=${encodeURIComponent(dao)}`);
  }
  return (
    <form onSubmit={open} className="flex flex-wrap items-start gap-2">
      <TextInput
        className="num max-w-md flex-1"
        placeholder={config.networkId === "mainnet" ? "yourdao.sputnik-dao.near" : "yourdao.sputnikv2.testnet"}
        aria-label="DAO account"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" variant="secondary">
        Open <ArrowRightIcon />
      </Button>
      {error && <p className="w-full text-sm text-danger">{error}</p>}
    </form>
  );
}

function Intro() {
  return (
    <Card>
      <ol className="grid gap-6 sm:grid-cols-3">
        {[
          ["Draft", "Add contributors here, or import a CSV. Payday writes the proposal: one USDC transfer that opens every salary."],
          ["Vote", "A member submits it and your council votes, in the NEAR CLI or the DAO app you already use."],
          ["Stream", "The vote that passes it funds Payday. Contributors withdraw by the second, gas-free, and cash out to any chain."],
        ].map(([title, body], i) => (
          <li key={title}>
            <span className="num text-xs text-muted">0{i + 1}</span>
            <h3 className="mt-1 font-medium">{title}</h3>
            <p className="mt-1 text-sm text-muted">{body}</p>
          </li>
        ))}
      </ol>
      {config.demoDao && (
        <p className="mt-6 border-t border-border pt-4 text-sm">
          See one running:{" "}
          <Link className="num text-accent underline underline-offset-4" href={`/dao?dao=${config.demoDao}`}>
            {config.demoDao}
          </Link>
        </p>
      )}
    </Card>
  );
}

/**
 * Payroll for a Sputnik DAO: what the DAO pays, its Payday proposals and their votes, and
 * a composer that drafts new payroll and stop proposals. Payday reads everything from the
 * chain and never signs for the DAO.
 */
export function DaoView() {
  const params = useSearchParams();
  const raw = params.get("dao")?.trim().toLowerCase() ?? "";
  const dao = isNearAccountId(raw) ? raw : null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-4xl sm:text-5xl">DAO payroll</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Pay contributors from a Sputnik DAO treasury. Payday drafts the proposal, your council votes, and the vote that
          passes it starts every salary streaming.
        </p>
      </div>
      <DaoPicker key={`picker:${dao ?? ""}`} initial={dao ?? ""} />
      {/* Keyed so switching DAOs starts from a clean slate rather than the last DAO's data. */}
      {dao ? <DaoPanel key={`panel:${dao}`} dao={dao} /> : <Intro />}
    </div>
  );
}

function DaoPanel({ dao }: { dao: string }) {
  const { state, refresh } = useDao(dao);
  const [signer, setSigner] = useSigner();
  const [draft, setDraft] = useState<AddProposalArgs | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const now = useNow(1000);
  const ownWorkerId = useOtherRoleId("worker");

  const data = state.status === "ready" ? state.data : null;

  function draftFunding(rows: PayrollRow[]): Promise<boolean> {
    if (!data) return Promise.resolve(false);
    try {
      setDraft(fundingProposal({ dao, ...ctx }, rows, data.fees.stream));
      setDraftError(null);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    }
    return Promise.resolve(false);
  }

  function draftCancel(streamId: number) {
    const stream = data?.streams.find((s) => s.id === streamId);
    if (!stream) return;
    setDraft(cancelProposal({ dao, ...ctx }, streamId, stream.worker));
  }

  const committed = data ? data.streams.reduce((sum, s) => sum + BigInt(s.deposit) - BigInt(s.withdrawn), 0n) : 0n;

  return (
    <div className="space-y-6">
      {state.status === "loading" ? (
        <Card>
          <Skeleton className="h-6 w-56" />
          <Skeleton className="mt-4 h-16 w-full" />
        </Card>
      ) : state.status === "error" ? (
        <Notice tone="error">{state.error}</Notice>
      ) : (
        data && (
          <>
            <Card title={data.name} aside={<AccountChip id={dao} />}>
              <div className="grid gap-6 sm:grid-cols-3">
                <Stat label="Treasury USDC">
                  <CountAmount value={data.balance} />
                </Stat>
                <Stat label="Committed to salaries" hint={`${data.streams.length} live stream${data.streams.length === 1 ? "" : "s"}`}>
                  <CountAmount value={committed} />
                </Stat>
                <div className="text-sm">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted">Who decides</div>
                  <ul className="mt-2 space-y-1">
                    {voters(data.policy).map((v) => (
                      <li key={v.role}>
                        <span className="font-medium">{v.role}</span>{" "}
                        <span className="text-muted">{v.members ? `${v.members.length} member${v.members.length === 1 ? "" : "s"}` : "open"}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-muted">
                    Passes with {thresholdText(callThreshold(data.policy))}. Bond {nearAmount(data.policy.proposal_bond)} NEAR.
                  </p>
                </div>
              </div>
              <div className="mt-5 max-w-sm border-t border-border pt-4">
                <label className="block space-y-1.5 text-sm">
                  <span className="text-xs font-medium text-muted">Your NEAR account (fills in the commands below)</span>
                  <TextInput className="num" placeholder="you.near" spellCheck={false} value={signer} onChange={(e) => setSigner(e.target.value)} />
                </label>
              </div>
            </Card>

            {voters(data.policy).length === 0 && (
              <Notice tone="warn">
                No role in this DAO may approve function-call proposals, which is what a Payday payroll is. The council
                must first add <span className="num">call:AddProposal</span> and <span className="num">call:VoteApprove</span> to a
                role, with a policy proposal.
              </Notice>
            )}
            {draft && <DraftPanel dao={dao} draft={draft} policy={data.policy} signer={signer} onClose={() => setDraft(null)} />}
            {draftError && <Notice tone="error">{draftError}</Notice>}

            <PayrollComposer
              title="New payroll proposal"
              submitLabel="Draft proposal"
              payer="The treasury needs"
              allowShortfall
              balance={data.balance}
              streamFee={data.fees.stream}
              nowSecs={Math.floor(now / 1000)}
              ownWorkerId={ownWorkerId}
              funding={false}
              disabled={false}
              onFund={draftFunding}
            />

            <Card title="Payday proposals" aside={<Button variant="ghost" onClick={refresh}>Refresh</Button>}>
              {data.proposals.length === 0 ? (
                <p className="text-sm text-muted">No Payday proposals in this DAO&apos;s last {PROPOSAL_WINDOW} proposals yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.proposals.map((p) => (
                    <ProposalRow key={p.id} p={p} dao={dao} signer={signer} />
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Salaries this DAO pays">
              {data.streams.length === 0 ? (
                <p className="text-sm text-muted">None yet. They appear here once a payroll proposal passes.</p>
              ) : (
                <StreamsTable streams={data.streams} now={now} disabled={false} cancellingId={null} onCancel={draftCancel} proposeOnly />
              )}
            </Card>
          </>
        )
      )}
    </div>
  );
}
