import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import AgentRoster from "~/components/AgentRoster.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

const NOW = new Date().toISOString();
// agent run; status defaults to "completed" (→ idle). role/status overridable.
const run = (actor: string, role: string, status = "completed") => ({
  id: `R:${actor}`, sliceId: "S1", role, actor, driver: "fixture", status, attempt: 1, startedAt: NOW, updatedAt: NOW,
});
const base = () => ({
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [],
  slices: [], dependencies: [], checkpoints: [], activeEscalations: [], heartbeats: [], recentEvents: [],
});

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

  it("renders a sentence-case-plural group header with a count per non-empty role", () => {
    const store = createConsoleStore();
    store.hydrate({
      ...base(),
      agentRuns: [run("ov", "overseer"), run("rv1", "reviewer"), run("rv2", "reviewer")],
    } as any);
    const { getByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    // Eyebrow label + count, sentence-case pluralized.
    expect(getByText("Overseers")).toBeTruthy();
    const reviewers = getByText("Reviewers");
    expect(reviewers).toBeTruthy();
    expect(reviewers.textContent).toContain("2");
  });

  it("truncates the idle tail to 3 with a '+N idle' toggle that expands the rest", async () => {
    const store = createConsoleStore();
    // 6 idle (completed) verifiers + 1 active → idle tail of 6 should cap at 3, hiding 3.
    const verifiers = ["va", "vb", "vc", "vd", "ve", "vf"].map((a) => run(a, "verifier", "completed"));
    store.hydrate({
      ...base(),
      agentRuns: [run("v-live", "verifier", "running"), ...verifiers],
    } as any);
    const { getByText, queryByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    // Active one always shown; first 3 idle shown; the 6th idle hidden until expand.
    expect(getByText("v-live")).toBeTruthy();
    expect(getByText("va")).toBeTruthy();
    expect(queryByText("vf")).toBeNull();
    const toggle = getByText("+3 idle");
    expect(toggle).toBeTruthy();
    await fireEvent.click(toggle);
    // Now the hidden idle agents are revealed and the toggle flips.
    expect(getByText("vf")).toBeTruthy();
    expect(getByText("Show fewer")).toBeTruthy();
  });

  it("always shows every active and stalled agent (never truncated)", () => {
    const store = createConsoleStore();
    // 5 active verifiers — all must render even though >3, because truncation targets idle only.
    const active = ["a1", "a2", "a3", "a4", "a5"].map((a) => run(a, "verifier", "running"));
    store.hydrate({ ...base(), agentRuns: active } as any);
    const { getByText, queryByText } = render(AgentRoster, { props: { store, onSelect: () => {} } });
    for (const a of ["a1", "a2", "a3", "a4", "a5"]) expect(getByText(a)).toBeTruthy();
    expect(queryByText(/^\+\d+ idle$/)).toBeNull(); // no "+N idle" toggle when nothing is idle
  });
});
