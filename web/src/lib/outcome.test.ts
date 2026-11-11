import { describe, expect, it } from "vitest";
import { eventsNamed, summarizeOutcome } from "./outcome";

const ev = (standard: string, event: string, data: object = {}) =>
  `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data: [data] })}`;

const receipt = (logs: string[], status: unknown = { SuccessValue: "" }) => ({ outcome: { logs, status } });

describe("summarizeOutcome", () => {
  it("collects events from every receipt of a relayed transaction", () => {
    const out = summarizeOutcome({
      transaction: { hash: "H" },
      status: { SuccessValue: "" },
      receipts_outcome: [
        receipt([]),
        receipt([ev("nep141", "ft_transfer")]),
        receipt([ev("payday", "stream_created", { id: 3 }), "not an event"]),
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
    expect(eventsNamed(out, "payday", "stream_created")).toHaveLength(1);
  });

  it("surfaces the contract's panic message when a receipt fails", () => {
    const out = summarizeOutcome({
      transaction: { hash: "H" },
      status: { SuccessValue: "IjAi" },
      receipts_outcome: [
        receipt([]),
        receipt([], {
          Failure: {
            ActionError: {
              index: 0,
              kind: {
                FunctionCallError: {
                  ExecutionError: "Smart contract panicked: Stream amounts must add up to the amount sent",
                },
              },
            },
          },
        }),
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual(["Stream amounts must add up to the amount sent"]);
    expect(eventsNamed(out, "payday", "stream_created")).toHaveLength(0);
  });

  it("marks the transaction failed when its own status fails", () => {
    const out = summarizeOutcome({ transaction: { hash: "H" }, status: { Failure: { InvalidTxError: "x" } } });
    expect(out.ok).toBe(false);
    expect(out.failures).toHaveLength(1);
  });
});
