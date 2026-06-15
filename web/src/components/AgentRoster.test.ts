import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import AgentRoster from "~/components/AgentRoster.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

describe("AgentRoster", () => {
  it("renders an agent row with a present-tense now-line + target while working", () => {
    const store = createConsoleStore();
    const now = new Date().toISOString();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], checkpoints: [], activeEscalations: [],
      agentRuns: [{ id: "R1", sliceId: "S1", role: "worker", actor: "backend-worker", driver: "codex", status: "running", attempt: 1, startedAt: now, updatedAt: now }],
      heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "editing", detail: "Editing src/x.ts", timestamp: now }],
      recentEvents: [
        { id: "E1", timestamp: now, actor: "backend-worker", type: "agent_event", entityType: "agent_run", entityId: "R1", payload: { activity: { state: "editing", target: "src/x.ts", label: "Editing src/x.ts" } } },
      ],
    } as any);
    const { getByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    expect(getByText("backend-worker")).toBeTruthy();
    // Working + running → present tense "editing" with the file target rendered.
    expect(getByText("editing")).toBeTruthy();
    expect(getByText("src/x.ts")).toBeTruthy();
  });

  it("renders past-tense now-line once the agent is no longer in a working state", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], checkpoints: [], activeEscalations: [],
      agentRuns: [{ id: "R1", sliceId: "S1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "2026-06-14T08:00:00Z", updatedAt: "2026-06-14T08:00:00Z" }],
      // newest signal is a non-working state (verifying done → waiting), so the now-line flips to past
      heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "waiting", detail: "awaiting review", timestamp: "2026-06-14T08:00:05Z" }],
      recentEvents: [],
    } as any);
    const { getByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    // state "waiting" is not a working state → past tense "waited".
    expect(getByText("waited")).toBeTruthy();
  });
});
