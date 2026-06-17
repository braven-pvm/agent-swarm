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
});
