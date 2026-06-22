import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import OverseerTimeline from "~/components/OverseerTimeline.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

const NOW = new Date().toISOString();

// Minimal snapshot skeleton; recentEvents drives the loop log (buildOverseerLog).
const base = (recentEvents: any[]) => ({
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [], lanes: [],
  slices: [], dependencies: [], checkpoints: [], activeEscalations: [], agentRuns: [], heartbeats: [], recentEvents,
});

const ev = (id: string, type: string, payload: Record<string, unknown> = {}) => ({
  id, timestamp: NOW, actor: "live-overseer", type, entityType: "harness", entityId: "h", payload,
});

describe("OverseerTimeline — fast-path / source chip", () => {
  it("tags a fast_path row with the calm code (deterministic) source chip", () => {
    const store = createConsoleStore();
    store.hydrate(base([
      ev("a", "overseer.fast_path", { decisionSource: "deterministic", commandKey: "review", sliceId: "SLICE-9" }),
    ]) as any);
    const { getByText, container } = render(OverseerTimeline, { props: { store, onSelect: () => {} } });
    // The humanized action label renders, plus the calm "Code" chip — glyph + label, never colour alone.
    expect(getByText("Fast path")).toBeTruthy();
    const chip = container.querySelector(".ov-src-code");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toMatch(/Code/);
    // Subject detail (command key + slice) surfaces as the row summary.
    expect(getByText("review SLICE-9")).toBeTruthy();
  });

  it("tags an LLM decision row with the LLM source chip", () => {
    const store = createConsoleStore();
    store.hydrate(base([
      ev("a", "overseer.decision_recorded", { summary: "Dispatch the worker for SLICE-9." }),
    ]) as any);
    const { container } = render(OverseerTimeline, { props: { store, onSelect: () => {} } });
    const chip = container.querySelector(".ov-src-llm");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toMatch(/LLM/);
    expect(container.querySelector(".ov-src-code")).toBeNull();
  });

  it("renders no source chip on plumbing rows (command lifecycle)", () => {
    const store = createConsoleStore();
    store.hydrate(base([
      ev("a", "overseer.command_completed", { commandKey: "work", sliceId: "SLICE-1", exitCode: 0 }),
    ]) as any);
    const { container } = render(OverseerTimeline, { props: { store, onSelect: () => {} } });
    expect(container.querySelector(".ov-src")).toBeNull();
  });
});
