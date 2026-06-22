import { describe, it, expect } from "vitest";
import { createConsoleStore } from "~/lib/console.svelte";
import type { SnapshotResponse, HeartbeatRecord, HarnessEvent } from "~/lib/types";

const baseSnapshot = (): SnapshotResponse => ({
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "2026-06-14T08:00:00Z",
  targets: [], sources: [], domains: [], lanes: [],
  slices: [{
    id: "SLICE-1", laneId: "L1", targetId: "T1", title: "Invoices", status: "accepted",
    sourceRefs: [], frAcRefs: ["AC-INV-001.1"], deliveryQuestion: "",
    leases: [{ id: "LE1", frAcRef: "AC-INV-001.1", sliceId: "SLICE-1", laneId: "L1", status: "completed", createdAt: "", updatedAt: "" }],
    evidence: [], frAcResults: [{ ref: "AC-INV-001.1", status: "passed", evidenceIds: [], proof: "ok", verifiedBy: "v" }],
    reviewResult: { status: "accepted", summary: "", frAcFindings: [{ ref: "AC-INV-001.1", status: "passed", evidence: ["spec says X", "test passes"], finding: "good" }], testAssessment: "", sourceMutationDetected: false, stubOrHardcodeRisk: "none", qualityGate: { status: "passed", summary: "quality passed", dimensions: [], blockingConcerns: [], residualRisks: [] }, requiredFixes: [], escalations: [], recommendation: "" },
    agentRuns: [], createdAt: "", updatedAt: "",
  }],
  dependencies: [], agentRuns: [{ id: "R1", sliceId: "SLICE-1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "", updatedAt: "" }],
  heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "idle", detail: "done", timestamp: "2026-06-14T08:00:00Z" }],
  activeEscalations: [], checkpoints: [], recentEvents: [],
  focusQueue: [],
  runObservability: {
    generatedAt: "2026-06-14T08:00:00Z",
    workspace: "/w",
    runMode: "live-agent-smoke",
    outcome: { available: true, source: "live-summary", finalOutcome: "accepted", accepted: true },
    coverage: {
      totals: { total: 1, done: 1, inProgress: 0, blocked: 0, failed: 0, notStarted: 0 },
      completionPercent: 100,
      complete: true,
      incomplete: 0,
      state: "complete",
      headline: "1/1 indexed requirements done",
      byDomain: [],
      topIncompleteDomains: [],
    },
    productReadiness: { available: false, acceptedRefs: [], blockers: [] },
    slices: { total: 1, accepted: 1, active: 0, blocked: 0, byStatus: { accepted: 1 } },
    outcomeVsCoverage: {
      state: "accepted_complete",
      severity: "success",
      headline: "Run accepted and indexed requirements are complete",
      detail: "ok",
      truthRows: [],
    },
    warnings: [],
    uiHints: { badges: [], callouts: [], recommendedPrimaryView: "history" },
  },
});

describe("console store", () => {
  it("hydrates and joins agent rows from runs + heartbeats", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const row = s.agents.find((a) => a.actor === "backend-worker");
    expect(row).toBeTruthy();
    expect(row!.state).toBe("idle");
  });

  it("applyHeartbeat upserts newest-timestamp-wins", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const hb: HeartbeatRecord = { id: "heartbeat:backend-worker", actor: "backend-worker", state: "editing", detail: "Editing a.ts", timestamp: "2026-06-14T08:01:00Z" };
    s.applyHeartbeat(hb);
    expect(s.agents.find((a) => a.actor === "backend-worker")!.state).toBe("editing");
    // applying an older heartbeat must NOT overwrite
    const older: HeartbeatRecord = { id: "heartbeat:backend-worker", actor: "backend-worker", state: "reading", detail: "Reading b.ts", timestamp: "2026-06-14T08:00:30Z" };
    s.applyHeartbeat(older);
    expect(s.agents.find((a) => a.actor === "backend-worker")!.state).toBe("editing");
  });

  it("applyEvent caps recentEvents and updates the agent narrative", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const ev: HarnessEvent = { id: "E1", timestamp: "2026-06-14T08:02:00Z", actor: "backend-worker", type: "worker.agent_event", entityType: "slice", entityId: "SLICE-1", payload: { activity: { state: "testing", target: "npm test", label: "Running npm test" } } };
    s.applyEvent(ev);
    const row = s.agents.find((a) => a.actor === "backend-worker")!;
    expect(row.now).toMatch(/npm test/);
  });

  it("proofChainFor joins ref → lease + review finding", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    const chain = s.proofChainFor("SLICE-1");
    expect(chain.length).toBe(1);
    expect(chain[0].ref).toBe("AC-INV-001.1");
    expect(chain[0].leaseStatus).toBe("completed");
    expect(chain[0].reviewFinding?.status).toBe("passed");
    expect(chain[0].citations).toContain("test passes");
  });

  it("derives downgradeCount on a skeptic/reviewer row from review.finding_downgraded events", () => {
    const s = createConsoleStore();
    const snap = baseSnapshot();
    // A skeptic run on SLICE-1 + a downgrade event on that slice → the row carries downgradeCount 1.
    snap.agentRuns = [
      ...snap.agentRuns,
      { id: "R-SK", sliceId: "SLICE-1", role: "skeptic", actor: "skeptic-1", driver: "claude", status: "completed", attempt: 1, startedAt: "", updatedAt: "" } as any,
    ];
    snap.recentEvents = [{
      id: "DG1", timestamp: "2026-06-14T08:06:00Z", actor: "verifier-1", type: "review.finding_downgraded",
      entityType: "slice", entityId: "SLICE-1",
      payload: { dimension: "runtime_path", targetKind: "dimension", fromSeverity: "blocker", skepticVerdict: "refuted", reasoning: "covered", skepticActor: "skeptic-1" },
    }];
    s.hydrate(snap);
    expect(s.agents.find((a) => a.actor === "skeptic-1")!.downgradeCount).toBe(1);
    // A worker on the SAME slice does NOT get the badge (only review/skeptic/verifier roles).
    expect(s.agents.find((a) => a.actor === "backend-worker")!.downgradeCount).toBeUndefined();
  });

  it("derives journalReplayed on a row when one of its runs has a worker.journal_hit (and not otherwise)", () => {
    const s = createConsoleStore();
    const snap = baseSnapshot();
    // backend-worker's run R1 was replayed from the journal → the row carries journalReplayed.
    snap.recentEvents = [{
      id: "JH1", timestamp: "2026-06-14T08:01:00Z", actor: "backend-worker", type: "worker.journal_hit",
      entityType: "slice", entityId: "SLICE-1",
      payload: { runId: "R1", driver: "codex", journalKey: "jk-1", storedDriver: "codex", soundnessNote: "result only" },
    }];
    s.hydrate(snap);
    expect(s.agents.find((a) => a.actor === "backend-worker")!.journalReplayed).toBe(true);

    // With the journal off (no worker.journal_hit), the same row leaves journalReplayed undefined.
    const clean = createConsoleStore();
    clean.hydrate(baseSnapshot());
    expect(clean.agents.find((a) => a.actor === "backend-worker")!.journalReplayed).toBeUndefined();
  });

  it("applyEvent caps recentEvents at 200, keeping newest", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    for (let n = 1; n <= 250; n += 1) {
      const ts = new Date(Date.UTC(2026, 5, 14, 8, 0, n)).toISOString();
      const ev: HarnessEvent = {
        id: `E${n}`, timestamp: ts, actor: "backend-worker",
        type: "worker.agent_event", entityType: "slice", entityId: "SLICE-1",
        payload: { activity: { state: "testing", target: "npm test", label: `Step ${n}` } },
      };
      s.applyEvent(ev);
    }
    expect(s.snapshot!.recentEvents.length).toBe(200);
    // newest event (n=250) must be the last element
    expect(s.snapshot!.recentEvents[199].id).toBe("E250");
  });

  it("agents roster uses only the newest agent_event per actor", () => {
    const s = createConsoleStore();
    s.hydrate(baseSnapshot());
    // actor starts with heartbeat at 08:00 (state "idle")
    const ev1: HarnessEvent = {
      id: "AE1", timestamp: "2026-06-14T08:03:00Z", actor: "backend-worker",
      type: "worker.agent_event", entityType: "slice", entityId: "SLICE-1",
      payload: { activity: { state: "editing", target: "a.ts", label: "Editing a.ts" } },
    };
    const ev2: HarnessEvent = {
      id: "AE2", timestamp: "2026-06-14T08:05:00Z", actor: "backend-worker",
      type: "worker.agent_event", entityType: "slice", entityId: "SLICE-1",
      payload: { activity: { state: "testing", target: "npm test", label: "Running npm test" } },
    };
    s.applyEvent(ev1);
    s.applyEvent(ev2);
    const row = s.agents.find((a) => a.actor === "backend-worker")!;
    expect(row.now).toBe("Running npm test"); // newest wins, not "Editing a.ts"
  });

  it("control commands: setters hold the feed, newest-first sorts by startedAt, running filter", () => {
    const s = createConsoleStore();
    s.setControlCommands([
      { id: "c1", kind: "continue-run", status: "completed", command: "swarm", args: [], startedAt: "2026-06-19T08:00:00Z" },
      { id: "c2", kind: "recovery-revive", status: "running", command: "swarm", args: [], startedAt: "2026-06-19T08:05:00Z" },
    ]);
    expect(s.controlCommands).toHaveLength(2);
    // newest-first by startedAt → c2 (08:05) before c1 (08:00)
    expect(s.controlCommandsNewestFirst.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(s.runningControlCommands.map((c) => c.id)).toEqual(["c2"]);
  });

  it("control commands: newest-first falls back to tail-first reverse when startedAt is absent", () => {
    const s = createConsoleStore();
    s.setControlCommands([
      { id: "a", kind: "recovery-scan", status: "completed", command: "swarm", args: [] },
      { id: "b", kind: "continue-run", status: "running", command: "swarm", args: [] },
    ]);
    expect(s.controlCommandsNewestFirst.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("setDevServers holds the list and commandKindLabel humanizes a kind", () => {
    const s = createConsoleStore();
    s.setDevServers([{ id: "d1", status: "running", targetName: "ui", command: "npm", args: ["run", "start"] }]);
    expect(s.devServers).toHaveLength(1);
    expect(s.commandKindLabel("recovery-restart")).toBe("Recovery restart");
  });

  it("settings: null until set, then holds the read-only protocol config; resets on null", () => {
    const s = createConsoleStore();
    // Default: no /api/settings read yet → the status strip shows nothing.
    expect(s.settings).toBeNull();
    s.setSettings({ resultJournal: true, maxActiveLanes: 5 });
    expect(s.settings).toEqual({ resultJournal: true, maxActiveLanes: 5 });
    // A later read can replace it wholesale (e.g. journal toggled off, budget restored).
    s.setSettings({ resultJournal: false, maxActiveLanes: 3 });
    expect(s.settings).toEqual({ resultJournal: false, maxActiveLanes: 3 });
    // A null pass (e.g. a swallowed fetch error path) resets to the neutral default.
    s.setSettings(null);
    expect(s.settings).toBeNull();
  });
});
