import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import OverseerTurnDetail from "~/components/OverseerTurnDetail.svelte";
import type { HarnessEvent } from "~/lib/types";

function ev(type: string, payload: Record<string, unknown>): HarnessEvent {
  return {
    id: `ev-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    actor: "overseer",
    type,
    entityType: "harness" as any,
    entityId: "scenario-1",
    payload,
  };
}

describe("OverseerTurnDetail", () => {
  it("renders a decision event with its summary and recommended commands", () => {
    const event = ev("overseer.decision_recorded", {
      runId: "RUN-abc",
      scenario: "live-agent-smoke",
      status: "recommend_commands",
      summary: "Dispatch the worker to implement the export slice.",
      currentPriority: "Unblock the failing review.",
      nextAction: "Run the worker for SLICE-9.",
      recommendedCommands: [
        { command: "swarm run worker SLICE-9", purpose: "Implement the export." },
        { command: "npm test", purpose: "Verify the change." },
      ],
      lanePlan: [{ laneName: "backend", nextAction: "Keep building API slices." }],
      blockers: [],
    });
    const { getByText, getAllByText } = render(OverseerTurnDetail, { props: { event } });
    // Title is humanized from the type tail.
    expect(getByText("Decision recorded")).toBeTruthy();
    // The decision summary is the one-line meat.
    expect(getByText("Dispatch the worker to implement the export slice.")).toBeTruthy();
    // Recommended commands section + a purpose.
    expect(getByText("Recommended commands")).toBeTruthy();
    expect(getByText("Implement the export.")).toBeTruthy();
    // Lane plan rendered.
    expect(getByText(/Keep building API slices\./)).toBeTruthy();
    // runId surfaced (mono).
    expect(getAllByText("RUN-abc").length).toBeGreaterThan(0);
  });

  it("renders a completed command with a red exit chip when the exit code is non-zero", () => {
    const event = ev("overseer.command_completed", {
      runId: "RUN-xyz",
      index: 2,
      command: "npm test",
      commandKey: "verify",
      childRole: "verifier",
      sliceId: "SLICE-7",
      exitCode: 1,
      stdoutPath: "C:\\w\\.swarm\\artifacts\\scenario-1\\overseer-command-RUN-xyz-2.stdout.log",
      stderrPath: "C:\\w\\.swarm\\artifacts\\scenario-1\\overseer-command-RUN-xyz-2.stderr.log",
      purpose: "Run the test suite.",
      expectedStateChange: "Tests pass.",
    });
    const { getByText, container } = render(OverseerTurnDetail, { props: { event } });
    expect(getByText("Command completed")).toBeTruthy();
    // Exit chip present, non-zero, and carries the .bad (red) tone.
    const exitChip = getByText("exit 1");
    expect(exitChip).toBeTruthy();
    expect(exitChip.classList.contains("bad")).toBe(true);
    // Purpose + expected state change surfaced.
    expect(getByText("Run the test suite.")).toBeTruthy();
    expect(getByText("Tests pass.")).toBeTruthy();
    // Log references rendered as toggle buttons (derivable artifacts-relative path).
    expect(container.querySelectorAll(".ovt-log-btn").length).toBe(2);
  });

  it("falls back to the raw payload for an unknown event type", () => {
    const event = ev("overseer.mystery_event", { runId: "RUN-q", weird: { nested: 42 } });
    const { getByText, queryByText } = render(OverseerTurnDetail, { props: { event } });
    // Humanized title still renders.
    expect(getByText("Mystery event")).toBeTruthy();
    // No structured command/decision sections — only the raw-payload toggle is the path in.
    expect(queryByText("Recommended commands")).toBeNull();
    expect(queryByText("Command")).toBeNull();
    expect(getByText("▸ Raw payload")).toBeTruthy();
  });
});
