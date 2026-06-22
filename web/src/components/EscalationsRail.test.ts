import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import EscalationsRail from "~/components/EscalationsRail.svelte";
import { createConsoleStore } from "~/lib/console.svelte";
import { WORKER_REPAIR_PROOF_BLOCKER_MESSAGE } from "~/lib/format";
import type { EscalationRecord } from "~/lib/types";

const baseSnap = {
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [],
  lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [],
  checkpoints: [], recentEvents: [], focusQueue: [],
};

const esc = (over: Partial<EscalationRecord>): EscalationRecord => ({
  id: "E1", level: "blocker", status: "active", entityType: "slice", entityId: "SLICE-1",
  message: "m", createdBy: "x", createdAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:00:00.000Z",
  ...over,
});

function mount(escalations: EscalationRecord[]) {
  const store = createConsoleStore();
  store.hydrate({ ...baseSnap, activeEscalations: escalations } as any);
  return render(EscalationsRail, { props: { store, onSelect: () => {} } });
}

describe("EscalationsRail — worker repair-proof concern", () => {
  it("renders the repair-proof blocker as an agent-resolvable concern with its reason", () => {
    const { container, getByText } = mount([
      esc({ id: "RP", message: WORKER_REPAIR_PROOF_BLOCKER_MESSAGE, reason: "Missing FR-API-001 repair evidence" }),
    ]);
    const card = container.querySelector(".esc");
    expect(card?.classList.contains("esc-agent-resolvable")).toBe(true);
    // Reads as a concern the agent retries, not a human-resolve blocker (glyph + text, never colour-alone).
    expect(getByText(/targeted repair · agent will retry/)).toBeTruthy();
    expect(getByText("concern")).toBeTruthy();
    // The who/what — the gate reason — is surfaced.
    expect(getByText(/Missing FR-API-001 repair evidence/)).toBeTruthy();
  });

  it("keeps a generic blocker as a danger blocker (not agent-resolvable)", () => {
    const { container, getByText } = mount([
      esc({ id: "B1", message: "A real human-resolve blocker" }),
    ]);
    const card = container.querySelector(".esc");
    expect(card?.classList.contains("esc-agent-resolvable")).toBe(false);
    expect(card?.classList.contains("esc-blocker")).toBe(true);
    expect(getByText("blocker")).toBeTruthy();
  });

  it("does not tag a human_required escalation as agent-resolvable", () => {
    const { container } = mount([
      esc({ id: "H1", level: "human_required", message: "Human required decision" }),
    ]);
    const card = container.querySelector(".esc");
    expect(card?.classList.contains("esc-agent-resolvable")).toBe(false);
    expect(card?.classList.contains("esc-human_required")).toBe(true);
  });
});
