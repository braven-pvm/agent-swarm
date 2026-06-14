import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import App from "~/App.svelte";

beforeEach(() => {
  // @ts-expect-error test stub
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => emptySnapshot, text: async () => "" }));
  // @ts-expect-error jsdom lacks EventSource; sse.ts assigns source.onopen/onerror directly (not via setter)
  globalThis.EventSource = class { onopen: unknown = null; onerror: unknown = null; addEventListener() {} close() {} };
});

const emptySnapshot = { workspace: "/w", runMode: "unspecified", generatedAt: "", targets: [], sources: [], domains: [], lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [], checkpoints: [], recentEvents: [] };

describe("App", () => {
  it("renders the bridge shell", () => {
    const { getByText } = render(App);
    expect(getByText(/Command Bridge/)).toBeTruthy();
    expect(getByText("Agents")).toBeTruthy();
  });
});
