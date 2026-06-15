import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import FocusRail from "~/components/FocusRail.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

const baseSnap = {
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [],
  lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [],
  checkpoints: [], recentEvents: [],
};

describe("FocusRail", () => {
  it("renders the empty state when nothing needs attention", () => {
    const store = createConsoleStore();
    store.hydrate({ ...baseSnap, focusQueue: [] } as any);
    const { getByText } = render(FocusRail, { props: { store, onZoomSlice: () => {}, onZoomRun: () => {} } });
    expect(getByText(/nothing needs attention/)).toBeTruthy();
  });

  it("renders a focus card with reason chips, the failing-run line, and a recommendation", () => {
    const store = createConsoleStore();
    store.hydrate({
      ...baseSnap,
      focusQueue: [
        {
          reason: "blocked,command_failed", sliceId: "SLICE-abc123", title: "Invoice export", status: "blocked",
          retryCount: 3, inspectSliceCommand: "swarm inspect slice SLICE-abc123", focusPriority: 90,
          latestRun: {
            id: "RUN-9", role: "worker", actor: "backend-worker", status: "failed", attempt: 2,
            sessionIdCaptured: true, heartbeatAgeMs: 42000, resultExists: false, stderrExists: true,
            eventStreamExists: true, eventLineCount: 12,
            lastCommand: { command: "npm test", status: "failed", exitCode: 1, outputTail: "boom" },
          },
          activeEscalations: [],
          recommendedInterventions: ["inspect the failing run", "re-run with verbose logging"],
        },
      ],
    } as any);
    const { getByText, getAllByText, container } = render(FocusRail, { props: { store, onZoomSlice: () => {}, onZoomRun: () => {} } });
    expect(getByText("Invoice export")).toBeTruthy();
    const chipText = Array.from(container.querySelectorAll(".focus-reason")).map((el) => el.textContent?.trim());
    expect(chipText).toContain("blocked");              // reason chip
    expect(chipText).toContain("command_failed");       // reason chip
    expect(getByText("↻ 3")).toBeTruthy();              // retry chip
    expect(getByText("exit 1")).toBeTruthy();           // failing command exit
    expect(getByText(/inspect the failing run/)).toBeTruthy();
    // role + actor + status appear on the run line
    expect(getAllByText(/backend-worker/).length).toBeGreaterThan(0);
  });
});
