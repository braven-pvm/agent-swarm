import { describe, it, expect } from "vitest";
import {
  journalReplayForRun, anyJournalReplay, journalReplayTitle, type JournalReplay,
} from "~/lib/journal";
import type { HarnessEvent } from "~/lib/types";

// ── factory builder (tolerant payloads are loose Record<string,unknown>) ─────
const ev = (type: string, payload: Record<string, unknown> = {}, id = `E-${Math.random()}`): HarnessEvent => ({
  id, timestamp: "2026-06-14T08:00:00.000Z", actor: "worker-1", type, entityType: "slice", entityId: "SLICE-1", payload,
});

const hitPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: "RUN-1", driver: "fixture", model: "fixture-1", journalKey: "jk-abc",
  resultPath: "/tmp/result.json", storedAt: "2026-06-13T10:00:00.000Z", storedDriver: "codex",
  soundnessNote: "Replayed a previously validated worker RESULT artifact without re-spawning.", ...over,
});

describe("journalReplayForRun", () => {
  it("returns the flattened replay for a run with a worker.journal_hit", () => {
    const events: HarnessEvent[] = [
      ev("worker.completed", { runId: "RUN-1" }, "A"),
      ev("worker.journal_hit", hitPayload(), "B"),
    ];
    const got = journalReplayForRun(events, "RUN-1");
    expect(got).toBeTruthy();
    expect(got).toMatchObject({
      journalKey: "jk-abc",
      storedAt: "2026-06-13T10:00:00.000Z",
      storedDriver: "codex",
    });
    expect(got!.soundnessNote).toContain("RESULT artifact");
  });

  it("matches strictly by payload.runId (a hit for another run does not leak)", () => {
    const events = [ev("worker.journal_hit", hitPayload({ runId: "RUN-9" }))];
    expect(journalReplayForRun(events, "RUN-1")).toBeUndefined();
    expect(journalReplayForRun(events, "RUN-9")).toBeTruthy();
  });

  it("returns undefined when no journal_hit exists (the default-off norm — no badge)", () => {
    const events = [ev("worker.completed", { runId: "RUN-1" }), ev("worker.started", { runId: "RUN-1" })];
    expect(journalReplayForRun(events, "RUN-1")).toBeUndefined();
    expect(journalReplayForRun([], "RUN-1")).toBeUndefined();
  });

  it("is tolerant of a non-array input, an empty runId, or a malformed payload (never throws)", () => {
    expect(journalReplayForRun(undefined as unknown as HarnessEvent[], "RUN-1")).toBeUndefined();
    expect(journalReplayForRun([ev("worker.journal_hit", hitPayload())], "")).toBeUndefined();
    const bad = { ...ev("worker.journal_hit"), payload: undefined as unknown as Record<string, unknown> };
    expect(journalReplayForRun([bad], "RUN-1")).toBeUndefined();
  });

  it("tolerates a hit whose optional fields are absent (still a replay, fields just undefined)", () => {
    const got = journalReplayForRun([ev("worker.journal_hit", { runId: "RUN-1" })], "RUN-1");
    expect(got).toBeTruthy();
    expect(got!.storedDriver).toBeUndefined();
    expect(got!.soundnessNote).toBeUndefined();
  });
});

describe("anyJournalReplay", () => {
  it("is true when ANY of the given run ids was replayed", () => {
    const events = [ev("worker.journal_hit", hitPayload({ runId: "RUN-2" }))];
    expect(anyJournalReplay(events, ["RUN-1", "RUN-2", "RUN-3"])).toBe(true);
  });

  it("is false when none of the run ids match (default-off → no roster badge)", () => {
    const events = [ev("worker.journal_hit", hitPayload({ runId: "RUN-9" }))];
    expect(anyJournalReplay(events, ["RUN-1", "RUN-2"])).toBe(false);
    expect(anyJournalReplay([], ["RUN-1"])).toBe(false);
    expect(anyJournalReplay(events, [])).toBe(false);
    expect(anyJournalReplay(undefined as unknown as HarnessEvent[], ["RUN-1"])).toBe(false);
  });
});

describe("journalReplayTitle", () => {
  it("composes who/when + the soundness caveat into a tooltip", () => {
    const replay: JournalReplay = {
      storedDriver: "codex", storedAt: "2026-06-13T10:00:00.000Z",
      soundnessNote: "Workspace effect is NOT re-applied.",
    };
    const title = journalReplayTitle(replay);
    expect(title).toContain("Replayed from the result journal");
    expect(title).toContain("Stored by codex.");
    expect(title).toContain("2026-06-13T10:00:00.000Z");
    expect(title).toContain("Workspace effect is NOT re-applied.");
  });

  it("omits absent fields gracefully", () => {
    expect(journalReplayTitle({})).toBe("Replayed from the result journal — not freshly spawned.");
  });
});
