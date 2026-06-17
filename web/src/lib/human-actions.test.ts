import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/svelte";
import { fetchHumanActions, runActionCommand, type HumanActionQueue } from "~/lib/human-actions";
import HumanActionsRail from "~/components/HumanActionsRail.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

function queue(actions: HumanActionQueue["actions"]): HumanActionQueue {
  return {
    generatedAt: "2026-06-17T00:00:00Z",
    totals: {
      total: actions.length,
      decisionRequired: actions.filter((a) => a.kind === "decision_required").length,
      humanVerification: actions.filter((a) => a.kind === "human_verification" || a.kind === "human_verification_rework").length,
      blockers: actions.filter((a) => a.kind === "clear_blocker" || a.kind === "blocked_requirement").length,
    },
    actions,
  };
}

const baseSnap = {
  workspace: "/w", runMode: "live-agent-smoke", generatedAt: "", targets: [], sources: [], domains: [],
  lanes: [], slices: [], dependencies: [], agentRuns: [], heartbeats: [], activeEscalations: [],
  checkpoints: [], recentEvents: [], focusQueue: [],
};

describe("human-actions lib", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetchHumanActions GETs /api/human-actions and parses the queue", async () => {
    const q = queue([
      { id: "escalation:E1", kind: "clear_blocker", severity: "warning", title: "Blocker", summary: "s", status: "blocker", entityType: "slice", entityId: "SLICE-1", links: [], allowedActions: [] },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => q });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchHumanActions();
    expect(fetchMock).toHaveBeenCalledWith("/api/human-actions", expect.objectContaining({ headers: expect.any(Object) }));
    expect(res.totals.total).toBe(1);
    expect(res.actions[0].id).toBe("escalation:E1");
  });

  it("runActionCommand merges bodyTemplate + overrides + actor and returns the refreshed humanActions", async () => {
    const refreshed = queue([]);
    let sentBody: any = null;
    const fetchMock = vi.fn().mockImplementation(async (_path: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ ok: true, escalation: {}, humanActions: refreshed }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await runActionCommand(
      { kind: "clear_escalation", method: "POST", path: "/api/escalations/E1/clear", bodyTemplate: { actor: "human", reason: "" } },
      { reason: "Decided." },
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/escalations/E1/clear", expect.objectContaining({ method: "POST" }));
    // override wins over the template, and actor is forced to "human"
    expect(sentBody).toEqual({ actor: "human", reason: "Decided." });
    expect(res.ok).toBe(true);
    expect(res.humanActions).toBe(refreshed);
  });

  it("merges record_human_verification template fields with status + notes overrides", async () => {
    let sentBody: any = null;
    const fetchMock = vi.fn().mockImplementation(async (_path: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ ok: true, result: {}, humanActions: queue([]) }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await runActionCommand(
      { kind: "record_human_verification", method: "POST", path: "/api/human-verify", bodyTemplate: { sliceId: "SLICE-1", ref: "AC-1", status: "human_verified", actor: "human", notes: "" } },
      { status: "needs_rework", notes: "Re-check edge cases." },
    );
    expect(sentBody).toEqual({ sliceId: "SLICE-1", ref: "AC-1", status: "needs_rework", actor: "human", notes: "Re-check edge cases." });
  });

  it("surfaces the server error message on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "A clearance reason is required." }) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await runActionCommand(
      { kind: "clear_escalation", method: "POST", path: "/api/escalations/E1/clear", bodyTemplate: { actor: "human", reason: "" } },
      { reason: "" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("A clearance reason is required.");
  });

  it("returns a friendly error when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await runActionCommand(
      { kind: "clear_escalation", method: "POST", path: "/api/escalations/E1/clear", bodyTemplate: {} },
      { reason: "x" },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network down/);
  });
});

describe("HumanActionsRail", () => {
  it("renders the empty state when the queue is empty", () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setHumanActions(queue([]));
    const { getByText } = render(HumanActionsRail, { props: { store, onSelect: () => {} } });
    expect(getByText(/Nothing needs you right now/)).toBeTruthy();
  });

  it("renders the empty state when the queue is unset/null", () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    const { getByText } = render(HumanActionsRail, { props: { store, onSelect: () => {} } });
    expect(getByText(/Nothing needs you right now/)).toBeTruthy();
  });

  it("groups cards by severity (danger first) and shows count + ref/sliceId", () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setHumanActions(queue([
      { id: "warn-1", kind: "clear_blocker", severity: "warning", title: "Warn blocker", summary: "w", status: "blocker", entityType: "slice", entityId: "SLICE-2", sliceId: "SLICE-2", links: [], allowedActions: [] },
      { id: "danger-1", kind: "human_verification", severity: "danger", title: "Verify AC-1", summary: "needs sign-off", status: "awaiting_human_verification", entityType: "slice", entityId: "SLICE-1", ref: "AC-1", sliceId: "SLICE-1", links: [], allowedActions: [] },
    ]));
    const { container, getByText } = render(HumanActionsRail, { props: { store, onSelect: () => {} } });

    // count badge present
    expect(getByText("2")).toBeTruthy();
    // danger card renders before the warning card despite array order
    const cards = Array.from(container.querySelectorAll(".ha-card"));
    expect(cards.length).toBe(2);
    expect(cards[0].classList.contains("ha-danger")).toBe(true);
    expect(cards[1].classList.contains("ha-warning")).toBe(true);
    // ref + sliceId render as mono chips
    expect(getByText("AC-1")).toBeTruthy();
    expect(getByText("SLICE-2")).toBeTruthy();
  });

  it("calls onSelect with the action id when a card is clicked", async () => {
    const store = createConsoleStore();
    store.hydrate(baseSnap as any);
    store.setHumanActions(queue([
      { id: "danger-1", kind: "human_verification", severity: "danger", title: "Verify AC-1", summary: "x", status: "s", entityType: "slice", entityId: "SLICE-1", links: [], allowedActions: [] },
    ]));
    const onSelect = vi.fn();
    const { container } = render(HumanActionsRail, { props: { store, onSelect } });
    (container.querySelector(".ha-card") as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith("danger-1");
  });
});
