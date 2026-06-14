import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import AgentRoster from "~/components/AgentRoster.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

describe("AgentRoster", () => {
  it("renders an agent row with state and now-line", () => {
    const store = createConsoleStore();
    store.hydrate({
      workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], checkpoints: [], activeEscalations: [],
      agentRuns: [{ id: "R1", sliceId: "S1", role: "worker", actor: "backend-worker", driver: "codex", status: "completed", attempt: 1, startedAt: "", updatedAt: "2026-06-14T08:00:00Z" }],
      heartbeats: [{ id: "heartbeat:backend-worker", actor: "backend-worker", state: "editing", detail: "Editing src/x.ts", timestamp: "2026-06-14T08:00:00Z" }],
      recentEvents: [],
    } as any);
    const { getByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    expect(getByText("backend-worker")).toBeTruthy();
    expect(getByText(/Editing src\/x\.ts/)).toBeTruthy();
  });
});
