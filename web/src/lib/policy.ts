import { ONE_YOCTO, TGAS } from "./config";

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
  /** null for any action that is not a function call. */
  calls: Array<DelegateCall | null>;
}

export interface PolicyContext {
  payday: string;
  usdc: string;
  /** Allow minting the mock token (testnet only). */
  allowMint: boolean;
}

export type PolicyResult = { ok: true } | { ok: false; reason: string };

interface Rule {
  maxGas: bigint;
  deposit: bigint;
  check?: (args: Record<string, unknown>, senderId: string, ctx: PolicyContext) => string | null;
}

const PAYDAY_RULES: Record<string, Rule> = {
  withdraw: { maxGas: 50n * TGAS, deposit: 0n },
  claim_owed: { maxGas: 30n * TGAS, deposit: 0n },
  cancel: { maxGas: 40n * TGAS, deposit: 0n },
};

const TOKEN_RULES: Record<string, Rule> = {
  ft_transfer_call: {
    maxGas: 250n * TGAS,
    deposit: ONE_YOCTO,
    check: (args, _sender, ctx) =>
      args.receiver_id === ctx.payday ? null : "Token transfers may only fund Payday",
  },
  mint: {
    maxGas: 30n * TGAS,
    deposit: 0n,
    check: (args, senderId, ctx) => {
      if (!ctx.allowMint) return "Minting is disabled on this network";
      return args.account_id === senderId ? null : "You can only mint to yourself";
    },
  },
};

const fail = (reason: string): PolicyResult => ({ ok: false, reason });

/**
 * Decides whether the relayer pays for a signed delegate action. The relayer only
 * sponsors single function calls to Payday, or to the token when they fund Payday.
 */
export function checkDelegate(d: DelegateSummary, ctx: PolicyContext): PolicyResult {
  const rules =
    d.receiverId === ctx.payday ? PAYDAY_RULES : d.receiverId === ctx.usdc ? TOKEN_RULES : null;
  if (!rules) return fail(`Receiver ${d.receiverId} is not sponsored`);
  if (d.calls.length !== 1) return fail("Exactly one action is sponsored per request");

  const call = d.calls[0];
  if (!call) return fail("Only function calls are sponsored");

  const rule = Object.hasOwn(rules, call.methodName) ? rules[call.methodName] : undefined;
  if (!rule) return fail(`Method ${call.methodName} is not sponsored`);
  if (call.gas > rule.maxGas) return fail(`Gas above ${rule.maxGas / TGAS} Tgas`);
  if (call.deposit !== rule.deposit) return fail(`Deposit must be ${rule.deposit} yoctoNEAR`);

  if (rule.check) {
    if (typeof call.args !== "object" || call.args === null) return fail("Arguments must be JSON");
    const reason = rule.check(call.args as Record<string, unknown>, d.senderId, ctx);
    if (reason) return fail(reason);
  }
  return { ok: true };
}
