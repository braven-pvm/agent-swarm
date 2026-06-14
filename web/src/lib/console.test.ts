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
    reviewResult: { status: "accepted", summary: "", frAcFindings: [{ ref: "AC-INV-001.1", status: "passed", evidence: ["spec says X", "test passes"], finding: "good" }], testAssessment: "", sourceMutationDetected: false, stubOrHardcodeRisk: "none", requiredFixes: [], escalations: [], recommendation: "" },
    agentRuns: [], createdAt: "", updatedAt: "",
  }],
  dependencies: [], agentRuns: [{ id: "R1", sliceId: "SLICE-1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "", updatedAt: "" }],
  heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "idle", detail: "done", timestamp: "2026-06-14T08:00:00Z" }],
  activeEscalations: [], checkpoints: [], recentEvents: [],
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
});
