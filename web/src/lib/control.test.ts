import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchControlCommands,
  fetchDevServers,
  postContinue,
  postRecoveryScan,
  postRecoveryRevive,
  postRecoveryRestart,
  postDevServerStart,
  postDevServerStop,
  commandKindLabel,
  statusTone,
} from "~/lib/control";

// Stub fetch and capture the (path, init) of the single request a helper makes. Returns a helper
// to read back the parsed JSON body that was POSTed.
function stubFetch(response: unknown, ok = true, status = 200) {
  let lastPath: string | undefined;
  let lastInit: RequestInit | undefined;
  const fetchMock = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
    lastPath = path;
    lastInit = init;
    return { ok, status, json: async () => response, text: async () => String(response) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    get path() { return lastPath; },
    get init() { return lastInit; },
    get body() { return lastInit?.body ? JSON.parse(lastInit.body as string) : undefined; },
  };
}

describe("control lib — request assembly", () => {
  afterEach(() => vi.restoreAllMocks());

  it("postContinue posts scenario + reset, defaulting reset to false, omitting runId", async () => {
    const f = stubFetch({ ok: true, runId: "RUN-9", scenario: "s", command: {} });
    const res = await postContinue({ scenario: "live-agent-smoke-h2" });
    expect(f.path).toBe("/api/control/continue");
    expect(f.init?.method).toBe("POST");
    expect(f.body).toEqual({ scenario: "live-agent-smoke-h2", reset: false });
    expect(res.ok).toBe(true);
  });

  it("postContinue includes runId + reset:true when given", async () => {
    const f = stubFetch({ ok: true });
    await postContinue({ scenario: "s", runId: "RUN-1", reset: true });
    expect(f.body).toEqual({ scenario: "s", reset: true, runId: "RUN-1" });
  });

  it("postRecoveryScan always sends actor human-ui and markStale, and includes staleAfter when set", async () => {
    const f = stubFetch({ ok: true });
    await postRecoveryScan({ markStale: true, staleAfter: 300 });
    expect(f.path).toBe("/api/control/recovery/scan");
    expect(f.body).toEqual({ markStale: true, release: false, actor: "human-ui", staleAfter: 300 });
  });

  it("postRecoveryScan omits staleAfter when not given and defaults markStale/release to false", async () => {
    const f = stubFetch({ ok: true });
    await postRecoveryScan({});
    expect(f.body).toEqual({ markStale: false, release: false, actor: "human-ui" });
  });

  it("postRecoveryRevive sends runId + actor, and model only when provided", async () => {
    const f = stubFetch({ ok: true, command: {} });
    await postRecoveryRevive({ runId: "RUN-7" });
    expect(f.path).toBe("/api/control/recovery/revive");
    expect(f.body).toEqual({ runId: "RUN-7", actor: "human-ui" });

    const f2 = stubFetch({ ok: true });
    await postRecoveryRevive({ runId: "RUN-7", model: "gpt-x" });
    expect(f2.body).toEqual({ runId: "RUN-7", actor: "human-ui", model: "gpt-x" });
  });

  it("postRecoveryRestart sends runId + actor, with driver/model only when provided", async () => {
    const f = stubFetch({ ok: true });
    await postRecoveryRestart({ runId: "RUN-3", driver: "codex", model: "m" });
    expect(f.path).toBe("/api/control/recovery/restart");
    expect(f.body).toEqual({ runId: "RUN-3", actor: "human-ui", driver: "codex", model: "m" });

    const f2 = stubFetch({ ok: true });
    await postRecoveryRestart({ runId: "RUN-3" });
    expect(f2.body).toEqual({ runId: "RUN-3", actor: "human-ui" });
  });

  it("postDevServerStart sends targetName, with port only when provided", async () => {
    const f = stubFetch({ ok: true, server: {} });
    await postDevServerStart({ targetName: "support-ui" });
    expect(f.path).toBe("/api/control/dev-server/start");
    expect(f.body).toEqual({ targetName: "support-ui" });

    const f2 = stubFetch({ ok: true });
    await postDevServerStart({ targetName: "support-ui", port: 4322 });
    expect(f2.body).toEqual({ targetName: "support-ui", port: 4322 });
  });

  it("postDevServerStop posts to the id-scoped stop path with an empty body", async () => {
    const f = stubFetch({ ok: true });
    await postDevServerStop("dev-42");
    expect(f.path).toBe("/api/control/dev-server/dev-42/stop");
    expect(f.body).toEqual({});
  });
});

describe("control lib — response handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("surfaces a server { ok:false, error } as a friendly error result", async () => {
    stubFetch({ ok: false, error: "Target has no start script." }, false, 400);
    const res = await postDevServerStart({ targetName: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Target has no start script.");
  });

  it("falls back to an HTTP status message when no server error is present", async () => {
    stubFetch({}, false, 500);
    const res = await postContinue({ scenario: "s" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/500/);
  });

  it("returns a friendly error (and never throws) when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await postRecoveryScan({ markStale: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network down/);
  });

  it("fetchControlCommands plucks the commands array, and yields [] on failure", async () => {
    stubFetch({ commands: [{ id: "c1", kind: "continue-run", status: "running", command: "swarm", args: [] }] });
    const cmds = await fetchControlCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("c1");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchControlCommands()).toEqual([]);
  });

  it("fetchDevServers plucks the servers array, and yields [] on a non-ok response", async () => {
    stubFetch({ servers: [{ id: "d1", status: "running", targetName: "ui", command: "npm", args: ["run", "start"] }] });
    const servers = await fetchDevServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].targetName).toBe("ui");

    stubFetch({}, false, 404);
    expect(await fetchDevServers()).toEqual([]);
  });
});

describe("control lib — humanizers + tones", () => {
  it("commandKindLabel maps known kinds and sentence-cases unknown kebab kinds", () => {
    expect(commandKindLabel("continue-run")).toBe("Continue run");
    expect(commandKindLabel("recovery-revive")).toBe("Recovery revive");
    expect(commandKindLabel("recovery-restart")).toBe("Recovery restart");
    expect(commandKindLabel("some-other-kind")).toBe("Some other kind");
    expect(commandKindLabel(undefined)).toBe("Command");
  });

  it("statusTone pairs each status with a glyph + tone class, pulsing only when running", () => {
    expect(statusTone("running")).toMatchObject({ glyph: "●", pulse: true, cls: "cov-badge-in_progress" });
    expect(statusTone("completed")).toMatchObject({ glyph: "✓", cls: "cov-badge-done" });
    expect(statusTone("failed")).toMatchObject({ glyph: "✕", cls: "cov-badge-failed" });
    expect(statusTone("stale")).toMatchObject({ glyph: "⚠", cls: "ctl-badge-stale" });
    expect(statusTone("running").pulse).toBe(true);
    expect(statusTone("completed").pulse).toBeUndefined();
  });
});
