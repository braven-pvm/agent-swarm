import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import Control from "~/routes/Control.svelte";
import { createConsoleStore } from "~/lib/console.svelte";
import type { DevServer } from "~/lib/control";

// Minimal snapshot — Control only needs scenario/agentRuns/targets/runObservability shape for its
// other panels; these tests focus on the dev-servers panel, so keep it spare.
const baseSnap = {
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", scenario: "live-agent-smoke-h2",
  targets: [{ id: "T-ui", path: "/w/support-ui", name: "support-ui" }],
  sources: [], domains: [], lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [],
  activeEscalations: [], checkpoints: [], recentEvents: [], focusQueue: [], agentFocusQueue: [],
  runObservability: { outcomeVsCoverage: { severity: "neutral", truthRows: [], headline: "", detail: "" } },
};

function storeWithServers(servers: DevServer[]) {
  const store = createConsoleStore();
  store.hydrate(baseSnap as any);
  store.setDevServers(servers);
  return store;
}

// Stub fetch for a POST helper + capture requests, plus serve a fixed body for stderr GETs. The
// component fires a follow-up GET /api/control/dev-servers after each write, so assertions read the
// specific POST call rather than just the last call.
function stubFetch(response: unknown, ok = true, status = 200, textBody = "") {
  const fetchMock = vi.fn().mockImplementation(async (_path: string, _init?: RequestInit) => {
    return { ok, status, json: async () => response, text: async () => textBody };
  });
  vi.stubGlobal("fetch", fetchMock);
  const callFor = (predicate: (path: string) => boolean) => {
    const call = fetchMock.mock.calls.find((c) => predicate(c[0] as string));
    if (!call) return undefined;
    const init = call[1] as RequestInit | undefined;
    return { path: call[0] as string, body: init?.body ? JSON.parse(init.body as string) : undefined };
  };
  return { fetchMock, callFor };
}

const runningServer: DevServer = {
  id: "SERVER-1", status: "running", targetName: "support-ui", targetPath: "/w/support-ui",
  command: "npm", args: ["run", "start"], url: "http://127.0.0.1:4322/", port: 4322, pid: 9100,
  stdoutHref: "/api/artifacts/o.log", stderrHref: "/api/artifacts/e.log",
};
const failedServer: DevServer = {
  id: "SERVER-2", status: "failed", targetName: "support-ui", targetPath: "/w/support-ui",
  command: "npm", args: ["run", "start"], stdoutHref: "/api/artifacts/o2.log", stderrHref: "/api/artifacts/e2.log",
  url: "", port: 0,
};

describe("Control — dev servers panel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders the empty state when there are no dev servers", () => {
    const store = storeWithServers([]);
    const { getByText } = render(Control, { props: { store, onRefresh: () => {} } });
    expect(getByText(/No dev servers yet/i)).toBeTruthy();
  });

  it("renders a running server as a clickable URL link opening a new tab, with a Stop button", () => {
    const store = storeWithServers([runningServer]);
    const { getByText, container } = render(Control, { props: { store, onRefresh: () => {} } });
    const link = container.querySelector('a.ctl-dev-urlchip') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:4322/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect((getByText("Stop") as HTMLButtonElement).tagName).toBe("BUTTON");
  });

  it("surfaces a failed server with a clear failure message and a view-stderr toggle (not silent)", async () => {
    const store = storeWithServers([failedServer]);
    stubFetch({}, true, 200, "npm error Missing script: \"start\"");
    const { getByText, container } = render(Control, { props: { store, onRefresh: () => {} } });
    // The per-server failure message is named, not hidden (scoped to the item's fail message, since
    // the panel lede also mentions "start script").
    expect(container.querySelector(".ctl-dev-fail-msg")!.textContent).toMatch(/no start script/i);
    // The stderr toggle reveals npm's actual stderr (target the toggle button by class — the fail
    // message text also contains "View stderr", so a text match would be ambiguous).
    const toggle = Array.from(container.querySelectorAll(".ctl-log-toggle")).find((b) =>
      /view stderr/i.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    await fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector(".ctl-dev-stderr .ctl-log-out")).toBeTruthy());
    expect(container.querySelector(".ctl-dev-stderr")!.textContent).toContain("Missing script");
  });

  it("starting a dev server posts the target name and shows the returned URL on success", async () => {
    const store = storeWithServers([]);
    const f = stubFetch({ ok: true, server: { targetName: "support-ui", status: "running", url: "http://127.0.0.1:5000/" } });
    const { getByLabelText, getByText, container } = render(Control, { props: { store, onRefresh: () => {} } });
    await fireEvent.input(getByLabelText("Target name"), { target: { value: "support-ui" } });
    await fireEvent.click(getByText("Start dev server"));
    await waitFor(() => expect(container.querySelector(".ctl-dev-startres-ok")).toBeTruthy());
    const post = f.callFor((p) => p === "/api/control/dev-server/start");
    expect(post?.body).toEqual({ targetName: "support-ui" });
    const okLink = container.querySelector(".ctl-dev-startres-ok a") as HTMLAnchorElement;
    expect(okLink.getAttribute("href")).toBe("http://127.0.0.1:5000/");
  });

  it("starting a target with no start script shows the failure + stderr link, not a silent error", async () => {
    const store = storeWithServers([]);
    stubFetch({ ok: false, error: "Target has no start script.", server: { targetName: "support-ui", status: "failed", stderrHref: "/api/artifacts/e.log" } }, false, 400);
    const { getByLabelText, getByText, container } = render(Control, { props: { store, onRefresh: () => {} } });
    await fireEvent.input(getByLabelText("Target name"), { target: { value: "support-ui" } });
    await fireEvent.click(getByText("Start dev server"));
    await waitFor(() => expect(container.querySelector(".ctl-dev-startres-fail")).toBeTruthy());
    expect(getByText("Target has no start script.")).toBeTruthy();
    const link = container.querySelector(".ctl-dev-startres-fail a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/artifacts/e.log");
  });

  it("stopping a running server posts to the id-scoped stop path", async () => {
    const store = storeWithServers([runningServer]);
    const f = stubFetch({ ok: true });
    const { getByText } = render(Control, { props: { store, onRefresh: () => {} } });
    await fireEvent.click(getByText("Stop"));
    await waitFor(() => expect(f.callFor((p) => p === "/api/control/dev-server/SERVER-1/stop")).toBeTruthy());
  });

  it("rejects an out-of-range port before posting", async () => {
    const store = storeWithServers([]);
    const f = stubFetch({ ok: true, server: {} });
    const { getByLabelText, getByText } = render(Control, { props: { store, onRefresh: () => {} } });
    await fireEvent.input(getByLabelText("Target name"), { target: { value: "support-ui" } });
    await fireEvent.input(getByLabelText("Port (optional)"), { target: { value: "99999" } });
    expect((getByText("Start dev server") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText(/between 1 and 65535/i)).toBeTruthy();
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
});
