import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import InspectorDrawer from "~/components/InspectorDrawer.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

describe("InspectorDrawer", () => {
  it("shows the FR/AC proof chain for a selected slice", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [{ id: "L1", frAcRef: "AC-1", sliceId: "SLICE-1", laneId: "L", status: "completed", createdAt: "", updatedAt: "" }], evidence: [], frAcResults: [{ ref: "AC-1", status: "passed", evidenceIds: [], proof: "p", verifiedBy: "v" }], reviewResult: { status: "accepted", summary: "", frAcFindings: [{ ref: "AC-1", status: "passed", evidence: ["spec quote", "npm test passed"], finding: "ok" }], testAssessment: "", sourceMutationDetected: false, stubOrHardcodeRisk: "none", qualityGate: { status: "passed", summary: "quality passed", dimensions: [], blockingConcerns: [], residualRisks: [] }, requiredFixes: [], escalations: [], recommendation: "" }, agentRuns: [], createdAt: "", updatedAt: "" }],
    } as any);
    store.select({ kind: "slice", id: "SLICE-1" });
    const { getByText } = render(InspectorDrawer, { props: { store } });
    expect(getByText("AC-1")).toBeTruthy();
    expect(getByText(/npm test passed/)).toBeTruthy();
  });

  it('labels a skeptic run "Challenge" in the run card', () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], evidence: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "" }],
      agentRuns: [{ id: "RUN-1", sliceId: "SLICE-1", role: "skeptic", actor: "skeptic-1", driver: "claude", status: "completed", attempt: 1, startedAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:01:00.000Z" }],
    } as any);
    store.select({ kind: "agent", actor: "skeptic-1" });
    const { container } = render(InspectorDrawer, { props: { store } });
    const op = container.querySelector(".run-op");
    expect(op?.textContent).toBe("Challenge");
  });

  it("surfaces a quality-gate override callout on a slice with a review.finding_downgraded", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [],
      recentEvents: [{
        id: "E1", timestamp: "2026-06-14T08:05:00.000Z", actor: "verifier-1", type: "review.finding_downgraded",
        entityType: "slice", entityId: "SLICE-1",
        payload: { dimension: "runtime_path", targetKind: "dimension", fromSeverity: "blocker", skepticVerdict: "refuted", reasoning: "The flagged path is exercised by the e2e suite.", skepticActor: "skeptic-1", challengeEvidenceId: "ec", reviewEvidenceId: "er" },
      }],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], evidence: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "" }],
    } as any);
    store.select({ kind: "slice", id: "SLICE-1" });
    const { container, getByText } = render(InspectorDrawer, { props: { store } });
    expect(container.querySelector(".downgrade-callout")).toBeTruthy();
    expect(getByText(/Quality gate overrides \(1\)/)).toBeTruthy();
    expect(getByText(/runtime_path/)).toBeTruthy();        // WHAT
    expect(getByText(/skeptic-1/)).toBeTruthy();            // WHO
    expect(getByText(/exercised by the e2e suite/)).toBeTruthy(); // WHY
  });

  it("renders NO override callout on a clean slice (default / neutral path)", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], evidence: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "" }],
    } as any);
    store.select({ kind: "slice", id: "SLICE-1" });
    const { container } = render(InspectorDrawer, { props: { store } });
    expect(container.querySelector(".downgrade-callout")).toBeNull();
  });

  it("shows the skeptic's per-finding challenge verdicts in the run card", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], heartbeats: [], activeEscalations: [], checkpoints: [],
      // skeptic.finding_challenged events live in recentEvents AND are fetched into agentHistory; the
      // run card reads them from agentHistory, but with no /api the fallback reads the evidence record.
      recentEvents: [],
      slices: [{
        id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "",
        evidence: [{
          id: "ec", sliceId: "SLICE-1", kind: "finding_challenge", summary: "Skeptic refuted: ok", ref: "p", createdAt: "",
          payload: { skepticActor: "skeptic-1", skepticResult: { status: "refuted", summary: "ok", findingVerdicts: [
            { ref: "AC-1", dimension: "runtime_path", verdict: "refuted", severity: "blocker", reasoning: "covered by e2e" },
          ] } },
        }],
      }],
      agentRuns: [{ id: "RUN-1", sliceId: "SLICE-1", role: "skeptic", actor: "skeptic-1", driver: "claude", status: "completed", attempt: 1, startedAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:01:00.000Z" }],
    } as any);
    store.select({ kind: "agent", actor: "skeptic-1" });
    const { container, getByText } = render(InspectorDrawer, { props: { store } });
    expect(getByText(/Challenged findings \(1\)/)).toBeTruthy();
    expect(container.querySelector(".sk-verdict-refuted")).toBeTruthy();
    expect(getByText(/covered by e2e/)).toBeTruthy();
  });

  it("shows a journal 'replayed' badge on a worker run card when worker.journal_hit fired for the run", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], heartbeats: [], activeEscalations: [], checkpoints: [],
      // The journal_hit is on the rolling tail; the run card derives the badge from it (no /api in tests).
      recentEvents: [{
        id: "E1", timestamp: "2026-06-14T08:01:00.000Z", actor: "worker-1", type: "worker.journal_hit",
        entityType: "slice", entityId: "SLICE-1",
        payload: { runId: "RUN-1", driver: "fixture", journalKey: "jk-1", storedAt: "2026-06-13T10:00:00.000Z", storedDriver: "codex", soundnessNote: "Replayed the RESULT artifact only." },
      }],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], evidence: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "" }],
      agentRuns: [{ id: "RUN-1", sliceId: "SLICE-1", role: "worker", actor: "worker-1", driver: "fixture", status: "completed", attempt: 1, startedAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:01:00.000Z" }],
    } as any);
    store.select({ kind: "agent", actor: "worker-1" });
    const { container, getByText } = render(InspectorDrawer, { props: { store } });
    const badge = container.querySelector(".run-replayed");
    expect(badge).toBeTruthy();
    expect(getByText("replayed")).toBeTruthy();
    // The tooltip answers WHAT was replayed (who stored it) + the soundness boundary.
    expect(badge?.getAttribute("title")).toContain("codex");
    expect(badge?.getAttribute("title")).toContain("RESULT artifact only");
  });

  it("shows NO replayed badge on a worker run with the journal off (default workspaces)", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], dependencies: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [],
      slices: [{ id: "SLICE-1", laneId: "L", targetId: "T", title: "Inv", status: "accepted", sourceRefs: [], frAcRefs: ["AC-1"], deliveryQuestion: "", leases: [], evidence: [], frAcResults: [], agentRuns: [], createdAt: "", updatedAt: "" }],
      agentRuns: [{ id: "RUN-1", sliceId: "SLICE-1", role: "worker", actor: "worker-1", driver: "fixture", status: "completed", attempt: 1, startedAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:01:00.000Z" }],
    } as any);
    store.select({ kind: "agent", actor: "worker-1" });
    const { container } = render(InspectorDrawer, { props: { store } });
    expect(container.querySelector(".run-replayed")).toBeNull();
  });
});
