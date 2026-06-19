import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import ObservabilityCallout from "~/components/ObservabilityCallout.svelte";
import { createConsoleStore } from "~/lib/console.svelte";
import type { DevServer } from "~/lib/control";

const baseSnap = {
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [],
  lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [],
  checkpoints: [], recentEvents: [], focusQueue: [], agentFocusQueue: [],
  runObservability: {
    // A success/neutral outcome → the OUTCOME callout is hidden; the dev-server blocker must still show.
    outcomeVsCoverage: { state: "accepted_complete", severity: "success", headline: "Run accepted", detail: "", truthRows: [] },
  },
};

const failedServer: DevServer = {
  id: "SERVER-9", status: "failed", targetName: "support-ui", targetPath: "/w/support-ui",
  command: "npm", args: ["run", "start"], url: "", port: 0, stderrHref: "/api/artifacts/e.log",
};

describe("ObservabilityCallout — dev-server readiness blocker", () => {
  it("surfaces a failed dev server as a readiness blocker even when the run outcome is accepted", () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setDevServers([failedServer]);
    const { getByText, container } = render(ObservabilityCallout, {
      props: { store, onGoCoverage: () => {}, onGoControl: () => {} },
    });
    expect(getByText(/Dev server support-ui failed — product readiness blocked/i)).toBeTruthy();
    expect(container.querySelector(".obs-devfail")).toBeTruthy();
    // A direct stderr link is provided so the failure isn't silent.
    const stderrLink = Array.from(container.querySelectorAll(".obs-devfail a")).find(
      (a) => (a as HTMLAnchorElement).getAttribute("href") === "/api/artifacts/e.log",
    );
    expect(stderrLink).toBeTruthy();
  });

  it("does not render a blocker when no dev server has failed", () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setDevServers([{ ...failedServer, status: "running", url: "http://127.0.0.1:1/" }]);
    const { container } = render(ObservabilityCallout, {
      props: { store, onGoCoverage: () => {}, onGoControl: () => {} },
    });
    expect(container.querySelector(".obs-devfail")).toBeNull();
  });

  it("the Open Control link invokes onGoControl", async () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setDevServers([failedServer]);
    const onGoControl = vi.fn();
    const { getByText } = render(ObservabilityCallout, {
      props: { store, onGoCoverage: () => {}, onGoControl },
    });
    await fireEvent.click(getByText(/Open Control/i));
    expect(onGoControl).toHaveBeenCalled();
  });
});
