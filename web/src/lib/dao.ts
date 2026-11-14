import { isNearAccountId } from "./address";
import { fundingMsg, type PayrollRow } from "./csv";
import { formatUsdc } from "./money";

/**
 * Payroll from a Sputnik DAO (v2) treasury. Payday never signs for a DAO: it drafts the
 * proposal, a member submits it, the council votes, and the approved proposal itself
 * makes the same `ft_transfer_call` the employer page makes, so the DAO is the employer.
 */

const TGAS = 1_000_000_000_000n;
/** Gas the approved proposal gives each call; matches what the relayer allows a browser. */
export const DAO_FUNDING_GAS = 150n * TGAS;
export const DAO_CANCEL_GAS = 100n * TGAS;
/** Gas for the vote that passes a proposal, which also runs the proposal's call. */
export const DAO_VOTE_TGAS = 300;
export const DAO_PROPOSE_TGAS = 50;

export interface DaoContext {
  dao: string;
  usdc: string;
  payday: string;
}

export interface FunctionCallAction {
  method_name: string;
  /** Base64 of the JSON arguments. */
  args: string;
  deposit: string;
  gas: string;
}

export interface FunctionCallKind {
  FunctionCall: { receiver_id: string; actions: FunctionCallAction[] };
}

export interface AddProposalArgs {
  proposal: { description: string; kind: FunctionCallKind };
}

export type ProposalStatus = "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";

/** A proposal as Sputnik's `get_proposals` returns it. */
export interface DaoProposal {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, unknown>;
  status: ProposalStatus;
  vote_counts: Record<string, [number, number, number]>;
  votes: Record<string, string>;
  submission_time: string;
}

export interface DaoPolicy {
  roles: Array<{ name: string; kind: unknown; permissions: string[]; vote_policy?: Record<string, { threshold: unknown }> }>;
  default_vote_policy: { weight_kind: string; quorum: string; threshold: unknown };
  proposal_bond: string;
  proposal_period: string;
}

/** What a proposal does to Payday, or null if it is not a Payday proposal. */
export type PaydayAction =
  | { kind: "fund"; total: bigint; streams: PayrollRow[] }
  | { kind: "cancel"; streamId: number };

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromBase64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

const fmtDay = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

/** A short, readable description that a voter can check against what the proposal does. */
export function fundingDescription(rows: PayrollRow[], fees: bigint): string {
  const total = rows.reduce((sum, r) => sum + r.amount, 0n);
  const from = Math.min(...rows.map((r) => r.start));
  const to = Math.max(...rows.map((r) => r.stop));
  const who = rows.length === 1 ? rows[0].worker : `${rows.length} contributors`;
  return `Payday payroll: stream ${formatUsdc(total)} USDC to ${who}, ${fmtDay(from)} to ${fmtDay(to)} (UTC), plus ${formatUsdc(fees)} USDC in Payday fees.`;
}

/**
 * The `add_proposal` arguments that fund `rows` from the DAO's USDC: a USDC
 * `ft_transfer_call` to Payday for the stream amounts plus the stream fees.
 */
export function fundingProposal(ctx: DaoContext, rows: PayrollRow[], streamFee: bigint): AddProposalArgs {
  if (rows.length === 0) throw new Error("Add at least one contributor");
  if (rows.some((r) => r.worker === ctx.dao)) throw new Error("The DAO cannot stream a salary to itself");
  const fees = streamFee * BigInt(rows.length);
  const total = rows.reduce((sum, r) => sum + r.amount, fees);
  const args = { receiver_id: ctx.payday, amount: total.toString(), msg: fundingMsg(rows) };
  return {
    proposal: {
      description: fundingDescription(rows, fees),
      kind: {
        FunctionCall: {
          receiver_id: ctx.usdc,
          actions: [{ method_name: "ft_transfer_call", args: toBase64(JSON.stringify(args)), deposit: "1", gas: DAO_FUNDING_GAS.toString() }],
        },
      },
    },
  };
}

/** The `add_proposal` arguments that cancel one of the DAO's streams; the refund goes to the DAO. */
export function cancelProposal(ctx: DaoContext, streamId: number, worker: string): AddProposalArgs {
  return {
    proposal: {
      description: `Payday payroll: stop stream #${streamId} to ${worker}. The unearned rest returns to the DAO; ${worker} keeps what they earned.`,
      kind: {
        FunctionCall: {
          receiver_id: ctx.payday,
          actions: [
            { method_name: "cancel", args: toBase64(JSON.stringify({ stream_id: streamId })), deposit: "0", gas: DAO_CANCEL_GAS.toString() },
          ],
        },
      },
    },
  };
}

function isStreamList(value: unknown): value is Array<{ worker: string; amount: string; start: number; stop: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof s.worker === "string" &&
        typeof s.amount === "string" &&
        /^\d{1,39}$/.test(s.amount) &&
        Number.isSafeInteger(s.start) &&
        Number.isSafeInteger(s.stop),
    )
  );
}

/**
 * Reads what a proposal would do to Payday from its actual arguments, never from its
 * description, so a misleading description cannot hide what a vote approves.
 */
export function paydayActionOf(kind: unknown, ctx: Omit<DaoContext, "dao">): PaydayAction | null {
  const call = (kind as Partial<FunctionCallKind> | null)?.FunctionCall;
  if (!call || !Array.isArray(call.actions) || call.actions.length !== 1) return null;
  const [action] = call.actions;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(fromBase64(action.args)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (call.receiver_id === ctx.usdc && action.method_name === "ft_transfer_call" && args.receiver_id === ctx.payday) {
    if (typeof args.amount !== "string" || typeof args.msg !== "string") return null;
    let msg: unknown;
    try {
      msg = JSON.parse(args.msg);
    } catch {
      return null;
    }
    const streams = (msg as { streams?: unknown })?.streams;
    if (!isStreamList(streams)) return null;
    return {
      kind: "fund",
      total: BigInt(args.amount),
      streams: streams.map((s) => ({ worker: s.worker, amount: BigInt(s.amount), start: s.start, stop: s.stop })),
    };
  }
  if (call.receiver_id === ctx.payday && action.method_name === "cancel" && Number.isSafeInteger(args.stream_id)) {
    return { kind: "cancel", streamId: args.stream_id as number };
  }
  return null;
}

/** Yocto NEAR as a short decimal, e.g. "0.1". */
export function nearAmount(yocto: string): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "").slice(0, 4);
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Single-quoted for a POSIX shell: the JSON is ours, but quotes in it must not break out. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A NEAR CLI (near-cli-rs) command that submits the proposal. It stops before choosing
 * how to sign, so the CLI asks the member for their own key, Ledger or wallet.
 */
export function proposeCommand(dao: string, args: AddProposalArgs, bondYocto: string, signer: string, network: string): string {
  return [
    `near contract call-function as-transaction ${dao} add_proposal`,
    `json-args ${shellQuote(JSON.stringify(args))}`,
    `prepaid-gas '${DAO_PROPOSE_TGAS} Tgas' attached-deposit '${nearAmount(bondYocto)} NEAR'`,
    `sign-as ${signerArg(signer)} network-config ${network}`,
  ].join(" \\\n  ");
}

/** A NEAR CLI command to vote for a proposal. The vote that passes it also runs it, hence the gas. */
export function voteCommand(dao: string, id: number, kind: unknown, signer: string, network: string): string {
  return [
    `near contract call-function as-transaction ${dao} act_proposal`,
    `json-args ${shellQuote(JSON.stringify({ id, action: "VoteApprove", proposal: kind }))}`,
    `prepaid-gas '${DAO_VOTE_TGAS} Tgas' attached-deposit '0 NEAR'`,
    `sign-as ${signerArg(signer)} network-config ${network}`,
  ].join(" \\\n  ");
}

/** Only a valid account id reaches the command line; anything else becomes a placeholder. */
const signerArg = (signer: string) => (isNearAccountId(signer) ? signer : "YOUR_ACCOUNT");

/**
 * Who can approve a function-call proposal, from the policy: each role with that
 * permission, and its members when the role is a fixed group (null for "everyone" or
 * token-weighted roles).
 */
export function voters(policy: DaoPolicy): Array<{ role: string; members: string[] | null }> {
  const approves = (p: string) => ["*:*", "*:VoteApprove", "call:*", "call:VoteApprove"].includes(p);
  return policy.roles
    .filter((r) => r.permissions.some(approves))
    .map((r) => {
      const group = typeof r.kind === "object" && r.kind !== null ? (r.kind as { Group?: unknown }).Group : undefined;
      return { role: r.name, members: Array.isArray(group) ? (group as string[]) : null };
    });
}

/** Whether `account` may submit a function-call proposal under this policy. */
export function canPropose(policy: DaoPolicy, account: string): boolean {
  const adds = (p: string) => ["*:*", "*:AddProposal", "call:*", "call:AddProposal"].includes(p);
  return policy.roles.some((r) => {
    if (!r.permissions.some(adds)) return false;
    if (r.kind === "Everyone") return true;
    const group = typeof r.kind === "object" && r.kind !== null ? (r.kind as { Group?: unknown }).Group : undefined;
    return Array.isArray(group) && group.includes(account);
  });
}

/** The threshold that applies to function-call proposals: a role's own `call` rule, else the default. */
export function callThreshold(policy: DaoPolicy): unknown {
  const own = policy.roles.map((r) => r.vote_policy?.call?.threshold).find((t) => t !== undefined);
  return own ?? policy.default_vote_policy.threshold;
}

/** "more than half", "at least 2 of 3"... from a Sputnik threshold. */
export function thresholdText(threshold: unknown): string {
  if (Array.isArray(threshold) && threshold.length === 2) {
    const [n, d] = threshold.map(Number);
    if (n === 1 && d === 2) return "more than half of the voters";
    return `more than ${n}/${d} of the voters`;
  }
  const weight = (threshold as { Weight?: string } | null)?.Weight;
  return weight ? `${weight} approvals` : "the DAO's vote threshold";
}
