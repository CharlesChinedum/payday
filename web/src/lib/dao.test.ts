import { describe, expect, it } from "vitest";
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
  type DaoPolicy,
} from "./dao";

const ctx = { dao: "team.sputnikv2.testnet", usdc: "usdc.test", payday: "app.test" };
const rows = [
  { worker: "ada.testnet", amount: 1_000_000_000n, start: 1_800_000_000, stop: 1_802_592_000 },
  { worker: "bo.testnet", amount: 500_000_000n, start: 1_800_000_000, stop: 1_802_592_000 },
];
const FEE = 10_000n;

const argsOf = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString()) as Record<string, string>;

describe("DAO funding proposals", () => {
  it("make the same ft_transfer_call the employer page makes, with fees, 1 yocto and 150 Tgas", () => {
    const { proposal } = fundingProposal(ctx, rows, FEE);
    const call = proposal.kind.FunctionCall;
    expect(call.receiver_id).toBe("usdc.test");
    expect(call.actions).toHaveLength(1);
    expect(call.actions[0]).toMatchObject({ method_name: "ft_transfer_call", deposit: "1", gas: "150000000000000" });
    const args = argsOf(call.actions[0].args);
    expect(args.receiver_id).toBe("app.test");
    expect(args.amount).toBe((1_500_000_000n + 2n * FEE).toString());
    expect(JSON.parse(args.msg).streams).toEqual([
      { worker: "ada.testnet", amount: "1000000000", start: 1_800_000_000, stop: 1_802_592_000 },
      { worker: "bo.testnet", amount: "500000000", start: 1_800_000_000, stop: 1_802_592_000 },
    ]);
    expect(proposal.description).toContain("1,500.00 USDC to 2 contributors");
    expect(proposal.description).toContain("0.02 USDC in Payday fees");
  });

  it("refuse an empty payroll or a salary to the DAO itself", () => {
    expect(() => fundingProposal(ctx, [], FEE)).toThrow();
    expect(() => fundingProposal(ctx, [{ ...rows[0], worker: ctx.dao }], FEE)).toThrow("itself");
  });

  it("read back exactly what they fund", () => {
    const action = paydayActionOf(fundingProposal(ctx, rows, FEE).proposal.kind, ctx);
    expect(action).toEqual({ kind: "fund", total: 1_500_020_000n, streams: rows });
  });
});

describe("reading proposals", () => {
  it("recognizes cancels", () => {
    expect(paydayActionOf(cancelProposal(ctx, 7, "ada.testnet").proposal.kind, ctx)).toEqual({ kind: "cancel", streamId: 7 });
  });

  it("ignores anything that is not a Payday call, whatever its description says", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const call = (receiver_id: string, method_name: string, args: unknown) => ({
      FunctionCall: { receiver_id, actions: [{ method_name, args: b64(args), deposit: "1", gas: "1" }] },
    });
    const streams = JSON.stringify({ streams: [{ worker: "a.testnet", amount: "1", start: 1, stop: 2 }] });
    expect(paydayActionOf({ Transfer: { token_id: "", receiver_id: "x", amount: "1" } }, ctx)).toBeNull();
    expect(paydayActionOf(call("usdc.test", "ft_transfer_call", { receiver_id: "thief.testnet", amount: "1", msg: streams }), ctx)).toBeNull();
    expect(paydayActionOf(call("fake-usdc.testnet", "ft_transfer_call", { receiver_id: "app.test", amount: "1", msg: streams }), ctx)).toBeNull();
    expect(paydayActionOf(call("app.test", "upgrade", {}), ctx)).toBeNull();
    expect(paydayActionOf(call("usdc.test", "ft_transfer_call", { receiver_id: "app.test", amount: "1", msg: "{" }), ctx)).toBeNull();
    expect(
      paydayActionOf({ FunctionCall: { receiver_id: "app.test", actions: [{ method_name: "cancel", args: "!!", deposit: "0", gas: "1" }] } }, ctx),
    ).toBeNull();
  });
});

describe("CLI commands", () => {
  it("submit with the DAO's bond and stop before choosing how to sign", () => {
    const cmd = proposeCommand(ctx.dao, fundingProposal(ctx, rows, FEE), "100000000000000000000000", "ada.testnet", "testnet");
    expect(cmd).toContain("near contract call-function as-transaction team.sputnikv2.testnet add_proposal");
    expect(cmd).toContain("attached-deposit '0.1 NEAR'");
    expect(cmd.trimEnd().endsWith("sign-as ada.testnet network-config testnet")).toBe(true);
  });

  it("quote JSON so a description cannot break out of the shell argument", () => {
    const args = { proposal: { description: "it's $(rm -rf ~)", kind: { FunctionCall: { receiver_id: "x", actions: [] } } } };
    const cmd = proposeCommand("dao.testnet", args, "0", "", "testnet");
    expect(cmd).toContain(`'{"proposal":{"description":"it'\\''s $(rm -rf ~)"`);
    expect(cmd).toContain("sign-as YOUR_ACCOUNT");
  });

  it("vote with the proposal kind and enough gas to run it", () => {
    const kind = cancelProposal(ctx, 3, "ada.testnet").proposal.kind;
    const cmd = voteCommand(ctx.dao, 4, kind, "bo.testnet", "testnet");
    expect(cmd).toContain('"id":4,"action":"VoteApprove","proposal":{"FunctionCall"');
    expect(cmd).toContain("prepaid-gas '300 Tgas'");
  });
});

describe("policy", () => {
  const policy: DaoPolicy = {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"] },
      { name: "council", kind: { Group: ["ada.testnet", "bo.testnet"] }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject"] },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "1000000000000000000000000",
    proposal_period: "604800000000000",
  };

  it("lists who approves and who may propose", () => {
    expect(voters(policy)).toEqual([{ role: "council", members: ["ada.testnet", "bo.testnet"] }]);
    expect(canPropose(policy, "anyone.testnet")).toBe(true);
    expect(canPropose({ ...policy, roles: [policy.roles[1]] }, "anyone.testnet")).toBe(false);
    expect(canPropose({ ...policy, roles: [policy.roles[1]] }, "bo.testnet")).toBe(true);
  });

  it("describes thresholds and bonds", () => {
    expect(thresholdText([1, 2])).toBe("more than half of the voters");
    expect(thresholdText({ Weight: "2" })).toBe("2 approvals");
    expect(callThreshold(policy)).toEqual([1, 2]);
    const strict = { ...policy, roles: [{ ...policy.roles[1], vote_policy: { call: { threshold: { Weight: "2" } } } }] };
    expect(callThreshold(strict)).toEqual({ Weight: "2" });
    expect(nearAmount("1000000000000000000000000")).toBe("1");
    expect(nearAmount("100000000000000000000000")).toBe("0.1");
    expect(nearAmount("0")).toBe("0");
  });
});
