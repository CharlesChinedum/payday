import { isNearAccountId } from "./address";
import { GAS_TGAS, ONE_USDC, ONE_YOCTO, TGAS } from "./config";

/** One function call inside a signed delegate action, already decoded. */
export interface DelegateCall {
  methodName: string;
  args: unknown;
  gas: bigint;
  deposit: bigint;
}

export interface DelegateSummary {
  senderId: string;
  receiverId: string;
  /** `ed25519:…` of the signing key, or null for any other key type. */
  publicKey: string | null;
  nonce: bigint;
  maxBlockHeight: bigint;
  /** null for any action that is not a function call. */
  calls: Array<DelegateCall | null>;
}

export interface PolicyContext {
  payday: string;
  usdc: string;
}

export interface StreamRequest {
  worker: string;
  amount: bigint;
  start: number;
  stop: number;
}

/** A sponsored call, parsed and typed, ready for the on-chain pre-flight. */
export type SponsoredCall =
  | { kind: "withdraw"; streamId: number; amount: bigint | null; receiver: string | null }
  | { kind: "claim_owed"; receiver: string | null }
  | { kind: "cancel"; streamId: number }
  | { kind: "fund"; amount: bigint; streams: StreamRequest[] }
  | { kind: "send"; amount: bigint; sendTo: string };

export type PolicyResult = { ok: true; call: SponsoredCall } | { ok: false; reason: string };

type Args = Record<string, unknown>;
type Parsed = SponsoredCall | string;

interface Rule {
  /** Exactly this much gas: less could fail part-way, which the relayer would pay for. */
  gas: bigint;
  deposit: bigint;
  /** Exactly these keys may appear; `required` ones must. */
  keys: readonly string[];
  required: readonly string[];
  parse: (args: Args, ctx: PolicyContext) => Parsed;
}

const MAX_STREAMS = 25;
const MAX_MSG_BYTES = 6 * 1024;
const MAX_MEMO_CHARS = 64;
const U128 = /^(0|[1-9]\d{0,38})$/;

const payoutGas = BigInt(GAS_TGAS.payout) * TGAS;
const fundingGas = BigInt(GAS_TGAS.funding) * TGAS;

function streamId(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

function amountOf(value: unknown): bigint | null {
  return typeof value === "string" && U128.test(value) ? BigInt(value) : null;
}

function accountOf(value: unknown): string | null {
  return typeof value === "string" && isNearAccountId(value) ? value : null;
}

/** Payday and the token reject payouts to themselves; refusing here saves the gas. */
function receiverOf(value: unknown, ctx: PolicyContext): string | null {
  const account = accountOf(value);
  return account && account !== ctx.payday && account !== ctx.usdc ? account : null;
}

function optional<T>(args: Args, key: string, parse: (v: unknown) => T | null): T | null | undefined {
  if (!(key in args) || args[key] === null) return null;
  return parse(args[key]) ?? undefined;
}

function parseStream(raw: unknown, ctx: PolicyContext): StreamRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Args;
  if (Object.keys(r).sort().join() !== "amount,start,stop,worker") return null;
  const worker = receiverOf(r.worker, ctx);
  const amount = amountOf(r.amount);
  const start = Number.isSafeInteger(r.start) ? (r.start as number) : null;
  const stop = Number.isSafeInteger(r.stop) ? (r.stop as number) : null;
  if (!worker || amount === null || start === null || stop === null) return null;
  return { worker, amount, start, stop };
}

/** `ft_transfer_call` to Payday: either fund streams or send through Payday. */
function parseTransferCall(args: Args, ctx: PolicyContext): Parsed {
  if (args.receiver_id !== ctx.payday) return "Token transfers may only go to Payday";
  const amount = amountOf(args.amount);
  if (amount === null || amount < ONE_USDC) return "Transfers must be at least 1 USDC";
  if ("memo" in args && args.memo !== null && (typeof args.memo !== "string" || args.memo.length > MAX_MEMO_CHARS)) {
    return "Invalid memo";
  }
  if (typeof args.msg !== "string" || args.msg.length > MAX_MSG_BYTES) return "Invalid msg";
  let msg: unknown;
  try {
    msg = JSON.parse(args.msg);
  } catch {
    return "Invalid msg";
  }
  if (typeof msg !== "object" || msg === null) return "Invalid msg";
  const keys = Object.keys(msg);
  const m = msg as Args;
  if (keys.length === 1 && keys[0] === "send_to") {
    const sendTo = receiverOf(m.send_to, ctx);
    return sendTo ? { kind: "send", amount, sendTo } : "Invalid send_to";
  }
  if (keys.length === 1 && keys[0] === "streams" && Array.isArray(m.streams)) {
    if (m.streams.length < 1 || m.streams.length > MAX_STREAMS) return `Fund 1 to ${MAX_STREAMS} streams at a time`;
    const streams = m.streams.map((raw) => parseStream(raw, ctx));
    if (streams.some((s) => s === null)) return "Invalid stream in msg";
    return { kind: "fund", amount, streams: streams as StreamRequest[] };
  }
  return "msg needs exactly one of streams or send_to";
}

const PAYDAY_RULES: Record<string, Rule> = {
  withdraw: {
    gas: payoutGas,
    deposit: 0n,
    keys: ["stream_id", "amount", "receiver"],
    required: ["stream_id"],
    parse: (args, ctx) => {
      const id = streamId(args.stream_id);
      const amount = optional(args, "amount", amountOf);
      const receiver = optional(args, "receiver", (v) => receiverOf(v, ctx));
      if (id === null || amount === undefined || receiver === undefined) return "Invalid withdraw arguments";
      return { kind: "withdraw", streamId: id, amount, receiver };
    },
  },
  claim_owed: {
    gas: payoutGas,
    deposit: 0n,
    keys: ["receiver"],
    required: [],
    parse: (args, ctx) => {
      const receiver = optional(args, "receiver", (v) => receiverOf(v, ctx));
      return receiver === undefined ? "Invalid receiver" : { kind: "claim_owed", receiver };
    },
  },
  cancel: {
    gas: payoutGas,
    deposit: 0n,
    keys: ["stream_id"],
    required: ["stream_id"],
    parse: (args) => {
      const id = streamId(args.stream_id);
      return id === null ? "Invalid stream_id" : { kind: "cancel", streamId: id };
    },
  },
};

const TOKEN_RULES: Record<string, Rule> = {
  ft_transfer_call: {
    gas: fundingGas,
    deposit: ONE_YOCTO,
    keys: ["receiver_id", "amount", "msg", "memo"],
    required: ["receiver_id", "amount", "msg"],
    parse: parseTransferCall,
  },
};

const fail = (reason: string): PolicyResult => ({ ok: false, reason });

/**
 * Decides, from the delegate alone, whether it is a call the relayer sponsors: a single
 * function call to Payday, or a USDC transfer to Payday, with exact gas, an exact
 * deposit and strictly shaped arguments. On-chain checks follow in the pre-flight.
 */
export function checkDelegate(d: DelegateSummary, ctx: PolicyContext): PolicyResult {
  const rules = d.receiverId === ctx.payday ? PAYDAY_RULES : d.receiverId === ctx.usdc ? TOKEN_RULES : null;
  if (!rules) return fail(`Receiver ${d.receiverId} is not sponsored`);
  if (d.calls.length !== 1) return fail("Exactly one action is sponsored per request");

  const call = d.calls[0];
  if (!call) return fail("Only function calls are sponsored");

  const rule = Object.hasOwn(rules, call.methodName) ? rules[call.methodName] : undefined;
  if (!rule) return fail(`Method ${call.methodName} is not sponsored`);
  if (call.gas !== rule.gas) return fail(`Gas must be exactly ${rule.gas / TGAS} Tgas`);
  if (call.deposit !== rule.deposit) return fail(`Deposit must be ${rule.deposit} yoctoNEAR`);

  if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) {
    return fail("Arguments must be a JSON object");
  }
  const args = call.args as Args;
  const extra = Object.keys(args).find((k) => !rule.keys.includes(k));
  if (extra) return fail(`Unexpected argument ${extra}`);
  const missing = rule.required.find((k) => !(k in args));
  if (missing) return fail(`Missing argument ${missing}`);

  const parsed = rule.parse(args, ctx);
  return typeof parsed === "string" ? fail(parsed) : { ok: true, call: parsed };
}
