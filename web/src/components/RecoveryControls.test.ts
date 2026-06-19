import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import RecoveryControls from "~/components/RecoveryControls.svelte";

// Stub fetch so the write helpers (postRecoveryScan/revive/restart) resolve without a real server.
function stubFetch(response: unknown = { ok: true }, ok = true, status = 200) {
  const fetchMock = vi.fn().mockImplementation(async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => String(response),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const base = {
  runId: "RUN-1",
  status: "stale" as string | undefined,
  role: "worker" as string | undefined,
  driver: "codex" as string | undefined,
  sessionId: "sess-1" as string | undefined,
  stalled: false,
};

describe("RecoveryControls — gating", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing for a healthy running run", () => {
    const { container } = render(RecoveryControls, {
      props: { ...base, status: "running", stalled: false },
    });
    expect(container.querySelector(".rec")).toBeNull();
  });

  it("renders nothing for a completed run", () => {
    const { container } = render(RecoveryControls, { props: { ...base, status: "completed" } });
    expect(container.querySelector(".rec")).toBeNull();
  });

  it("offers Mark stale (not revive/restart) for a running-but-stalled run", () => {
    const { getByText, queryByText } = render(RecoveryControls, {
      props: { ...base, status: "running", stalled: true },
    });
    expect(getByText("Mark stale")).toBeTruthy();
    expect(queryByText("Revive session")).toBeNull();
    expect(queryByText("Restart agent")).toBeNull();
  });

  it("enables revive for a stale run with a resumable driver + session, and offers restart for a worker", () => {
    const { getByText } = render(RecoveryControls, {
      props: { ...base, status: "stale", driver: "claude", sessionId: "s", role: "worker" },
    });
    const revive = getByText("Revive session") as HTMLButtonElement;
    expect(revive.disabled).toBe(false);
    expect((getByText("Restart agent") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables revive with a hint when there is no captured session, but still allows restart", () => {
    const { getByText } = render(RecoveryControls, {
      props: { ...base, status: "failed", driver: "codex", sessionId: undefined, role: "worker" },
    });
    expect((getByText("Revive session") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText(/No captured session/i)).toBeTruthy();
    expect((getByText("Restart agent") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not offer revive for a non-resumable driver, and hides restart for a non-worker role", () => {
    const { queryByText } = render(RecoveryControls, {
      props: { ...base, status: "stale", driver: "fixture", role: "reviewer", sessionId: "s" },
    });
    expect(queryByText("Revive session")).toBeNull();
    expect(queryByText("Restart agent")).toBeNull();
  });
});

describe("RecoveryControls — write actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("revive posts, shows a success note, and calls onRefresh", async () => {
    const fetchMock = stubFetch({ ok: true, command: {} });
    const onRefresh = vi.fn();
    const { getByText } = render(RecoveryControls, {
      props: { ...base, status: "stale", driver: "codex", sessionId: "s", role: "worker", onRefresh },
    });
    await fireEvent.click(getByText("Revive session"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/control/recovery/revive",
      expect.objectContaining({ method: "POST" }),
    );
    expect(getByText(/see Control tab/i)).toBeTruthy();
    expect(onRefresh).toHaveBeenCalled();
  });

  it("surfaces an inline error when restart fails and does not call onRefresh", async () => {
    stubFetch({ ok: false, error: "Restart blocked." }, false, 400);
    const onRefresh = vi.fn();
    const { getByText } = render(RecoveryControls, {
      props: { ...base, status: "failed", driver: "codex", sessionId: undefined, role: "worker", onRefresh },
    });
    await fireEvent.click(getByText("Restart agent"));
    expect(getByText("Restart blocked.")).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
