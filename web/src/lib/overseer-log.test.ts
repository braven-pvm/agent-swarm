import { describe, it, expect } from "vitest";
import { buildOverseerLog } from "~/lib/console.svelte";
import { humanizeToken } from "~/lib/format";
import type { HarnessEvent, CheckpointRecord } from "~/lib/types";

const ev = (id: string, type: string, ts: string, payload: Record<string, unknown> = {}): HarnessEvent => ({
  id, timestamp: ts, actor: "live-overseer", type,
  entityType: "harness", entityId: "h", payload,
});

const cp = (summary: string, updatedAt: string, createdBy = "live-overseer"): CheckpointRecord => ({
  id: `cp-${updatedAt}`, role: "overseer", entityType: "harness", entityId: "h",
  summary, payload: {}, createdBy, createdAt: updatedAt, updatedAt,
});

const t = (n: number) => `2026-06-14T08:00:${String(n).padStart(2, "0")}.000Z`;

describe("buildOverseerLog", () => {
  it("ignores the agent_event heartbeat stream and keeps overseer.* loop events", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.agent_event", t(1)),
      ev("b", "overseer.command_started", t(2)),
      ev("c", "worker.completed", t(3)),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log.map((r) => r.type)).toEqual(["overseer.command_started"]);
  });

  it("folds consecutive identical types into one row with a ×N count", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.command_completed", t(1)),
      ev("b", "overseer.command_completed", t(2)),
      ev("c", "overseer.command_completed", t(3)),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log).toHaveLength(1);
    expect(log[0].count).toBe(3);
    expect(log[0].action).toBe("Command completed");
    // keeps the NEWEST event in the run as the click target + timestamp
    expect(log[0].id).toBe("c");
    expect(log[0].ts).toBe(t(3));
  });

  it("does not fold non-consecutive repeats", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.command_completed", t(1)),
      ev("b", "overseer.decision_recorded", t(2)),
      ev("c", "overseer.command_completed", t(3)),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    // newest-first: command_completed(c), decision_recorded(b), command_completed(a)
    expect(log.map((r) => r.type)).toEqual([
      "overseer.command_completed", "overseer.decision_recorded", "overseer.command_completed",
    ]);
    expect(log.every((r) => r.count === 1)).toBe(true);
  });

  it("returns rows newest-first", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.command_started", t(1)),
      ev("b", "overseer.command_completed", t(2)),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("prefers an inline decision summary on the event payload", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.decision_recorded", t(1), { summary: "Repair slice S-12 before review" }),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log[0].summary).toBe("Repair slice S-12 before review");
  });

  it("falls back to the nearest overseer checkpoint summary for a decision event", () => {
    const events: HarnessEvent[] = [ev("a", "overseer.decision_recorded", t(5))];
    const checkpoints = [cp("Hold for dependency", t(2)), cp("Escalate blocker", t(4))];
    const log = buildOverseerLog(events, checkpoints, humanizeToken);
    // nearest at/before the event is the t(4) checkpoint
    expect(log[0].summary).toBe("Escalate blocker");
  });

  it("attaches no summary to non-decision events", () => {
    const events: HarnessEvent[] = [ev("a", "overseer.command_completed", t(1))];
    const log = buildOverseerLog(events, [cp("anything", t(1))], humanizeToken);
    expect(log[0].summary).toBeUndefined();
  });

  it("returns an empty array when there are no overseer loop events", () => {
    expect(buildOverseerLog([ev("a", "overseer.agent_event", t(1))], [], humanizeToken)).toEqual([]);
  });

  it("summarises a fast_path row from its command key + slice", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.fast_path", t(1), {
        decisionSource: "deterministic", commandKey: "review", sliceId: "SLICE-9",
        purpose: "Review the export slice.", command: "swarm run reviewer SLICE-9",
      }),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log[0].action).toBe("Fast path");
    expect(log[0].summary).toBe("review SLICE-9");
  });

  it("falls back to purpose then command for a fast_path row missing a key/slice", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.fast_path", t(1), { decisionSource: "deterministic", purpose: "Advance the queue head." }),
    ];
    expect(buildOverseerLog(events, [], humanizeToken)[0].summary).toBe("Advance the queue head.");
  });

  it("tags a fast_path row as a deterministic (code) decision source", () => {
    const events: HarnessEvent[] = [ev("a", "overseer.fast_path", t(1), { decisionSource: "deterministic", commandKey: "work" })];
    expect(buildOverseerLog(events, [], humanizeToken)[0].decisionSource).toBe("deterministic");
  });

  it("defaults a fast_path row to deterministic even if decisionSource is absent", () => {
    const events: HarnessEvent[] = [ev("a", "overseer.fast_path", t(1), { commandKey: "work" })];
    expect(buildOverseerLog(events, [], humanizeToken)[0].decisionSource).toBe("deterministic");
  });

  it("tags LLM decision + completion rows as an llm decision source", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.decision_recorded", t(1), { summary: "Dispatch the worker." }),
      ev("b", "overseer.completed", t(2), { nextAction: "Await the worker result." }),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log.find((r) => r.type === "overseer.decision_recorded")?.decisionSource).toBe("llm");
    expect(log.find((r) => r.type === "overseer.completed")?.decisionSource).toBe("llm");
  });

  it("leaves plumbing rows (command / batch lifecycle) without a decision source", () => {
    const events: HarnessEvent[] = [
      ev("a", "overseer.command_completed", t(1)),
      ev("b", "overseer.commands_completed", t(2), { executed: 2 }),
    ];
    const log = buildOverseerLog(events, [], humanizeToken);
    expect(log.every((r) => r.decisionSource === undefined)).toBe(true);
  });
});
