import { describe, expect, it } from "vitest";
import { eventsNamed, summarizeOutcome } from "./outcome";

const emitters = { payday: "app.test", nep141: "usdc.test" };

const ev = (standard: string, event: string, data: object = {}) =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "2.0.0", event, data: [data] })}`;

const receipt = (executor_id: string, logs: string[], status: unknown = { SuccessValue: "" }) => ({
  outcome: { executor_id, logs, status },
});

describe("summarizeOutcome", () => {
  it("collects events from every receipt of a relayed transaction", () => {
    const out = summarizeOutcome(
      {
        transaction: { hash: "H" },
        status: { SuccessValue: "" },
        receipts_outcome: [
          receipt("a".repeat(64), []),
          receipt("usdc.test", [ev("nep141", "ft_transfer")]),
          receipt("app.test", [ev("payday", "stream_created", { id: 3 }), "not an event"]),
        ],
      },
      emitters,
    );
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(eventsNamed(out, "payday", "stream_created")).toHaveLength(1);
    expect(eventsNamed(out, "nep141", "ft_transfer")).toHaveLength(1);
  });

  it("ignores events logged by any other contract (I-03)", () => {
    const out = summarizeOutcome(
      {
        transaction: { hash: "H" },
        status: { SuccessValue: "" },
        receipts_outcome: [receipt("impostor.test", [ev("payday", "paid", { amount: "1" }), ev("nep141", "ft_mint")])],
      },
      emitters,
    );
    expect(out.events).toEqual([]);
  });

  it("surfaces the contract's panic message when a receipt fails", () => {
    const out = summarizeOutcome(
      {
        transaction: { hash: "H" },
        status: { SuccessValue: "IjAi" },
        receipts_outcome: [
          receipt("usdc.test", []),
          receipt("app.test", [], {
            Failure: {
              ActionError: {
                index: 0,
                kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Funding is paused" } },
              },
            },
          }),
        ],
      },
      emitters,
    );
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual(["Funding is paused"]);
  });

  it("marks the transaction failed when its own status fails", () => {
    const out = summarizeOutcome({ transaction: { hash: "H" }, status: { Failure: { InvalidTxError: "x" } } }, emitters);
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
  });
});
