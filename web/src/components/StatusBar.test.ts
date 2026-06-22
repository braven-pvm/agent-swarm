import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import StatusBar from "~/components/StatusBar.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

// Minimal snapshot skeleton so the status bar has a non-null snapshot to derive from.
const base = () => ({
  workspace: "/w/invoice-api", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [],
  domains: [], lanes: [], slices: [], dependencies: [], checkpoints: [], activeEscalations: [],
  heartbeats: [], recentEvents: [], agentRuns: [],
});

describe("StatusBar — read-only settings strip", () => {
  it("renders nothing settings-related until /api/settings lands (neutral default)", () => {
    const store = createConsoleStore();
    store.hydrate(base() as any);
    const { queryByText, container } = render(StatusBar, { props: { store } });
    // The snapshot is hydrated but settings is still null — no journal/lane-budget indicators.
    expect(queryByText(/result journal/i)).toBeNull();
    expect(queryByText(/lane budget/i)).toBeNull();
    expect(container.querySelector(".sb-journal")).toBeNull();
    expect(container.querySelector(".sb-setting")).toBeNull();
  });

  it("shows 'result journal: off' (with the ○ glyph) and the lane budget when the journal is off", () => {
    const store = createConsoleStore();
    store.hydrate(base() as any);
    store.setSettings({ resultJournal: false, maxActiveLanes: 3 });
    const { getByText, container } = render(StatusBar, { props: { store } });
    const journal = container.querySelector(".sb-journal");
    expect(journal).toBeTruthy();
    expect(journal?.textContent).toMatch(/result journal:\s*off/i);
    // Meaning is carried by a glyph + text, never colour alone; off must NOT carry the green on-tint.
    expect(journal?.querySelector(".sb-setting-glyph")?.textContent).toBe("○");
    expect(journal?.classList.contains("on")).toBe(false);
    // Lane budget surfaces the resolved number.
    expect(getByText(/lane budget:/i)).toBeTruthy();
    expect(getByText("3")).toBeTruthy();
  });

  it("shows 'result journal: on' (● glyph + on-tone) when the workspace opts in", () => {
    const store = createConsoleStore();
    store.hydrate(base() as any);
    store.setSettings({ resultJournal: true, maxActiveLanes: 5 });
    const { container } = render(StatusBar, { props: { store } });
    const journal = container.querySelector(".sb-journal");
    expect(journal).toBeTruthy();
    expect(journal?.textContent).toMatch(/result journal:\s*on/i);
    expect(journal?.querySelector(".sb-setting-glyph")?.textContent).toBe("●");
    // The on-tone is reinforcement on top of the glyph + text (paired, not colour-alone).
    expect(journal?.classList.contains("on")).toBe(true);
    // Raised lane budget renders.
    const lane = Array.from(container.querySelectorAll(".sb-setting")).find((el) =>
      /lane budget:/i.test(el.textContent ?? ""),
    );
    expect(lane?.textContent).toMatch(/5/);
  });
});
