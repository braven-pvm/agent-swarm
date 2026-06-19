import { describe, it, expect } from "vitest";
import { createConsoleStore } from "~/lib/console.svelte";
import type { HumanActionItem, HumanActionQueue } from "~/lib/human-actions";

function action(id: string, over: Partial<HumanActionItem> = {}): HumanActionItem {
  return {
    id,
    kind: "clear_blocker",
    severity: "danger",
    title: `Clear blocker ${id}`,
    summary: "review gate blocked",
    status: "blocker",
    entityType: "escalation",
    entityId: id,
    links: [],
    allowedActions: [],
    ...over,
  };
}

function queue(actions: HumanActionItem[]): HumanActionQueue {
  return {
    generatedAt: "2026-06-19T00:00:00Z",
    totals: {
      total: actions.length,
      decisionRequired: actions.filter((a) => a.kind === "decision_required").length,
      humanVerification: actions.filter(
        (a) => a.kind === "human_verification" || a.kind === "human_verification_rework",
      ).length,
      blockers: actions.filter((a) => a.kind === "clear_blocker" || a.kind === "blocked_requirement").length,
    },
    actions,
  };
}

describe("console store — new-action toasts", () => {
  it("emits NO toasts on the first load (initial backlog is seeded silently)", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([action("E1"), action("E2")]));
    expect(s.toasts.length).toBe(0);
    expect(s.humanActions?.totals.total).toBe(2);
  });

  it("emits a toast for an id added on a LATER poll, not for re-seen ids", () => {
    const s = createConsoleStore();
    // First load: backlog of one, no toast.
    s.setHumanActions(queue([action("E1")]));
    expect(s.toasts.length).toBe(0);

    // Later poll: E1 persists (already seen → no toast), E2 is new → exactly one toast.
    s.setHumanActions(queue([action("E1"), action("E2", { title: "New blocker" })]));
    expect(s.toasts.length).toBe(1);
    expect(s.toasts[0].id).toBe("E2");
    expect(s.toasts[0].action.title).toBe("New blocker");

    // A further poll with no NEW ids adds nothing (E1/E2 already seen).
    s.setHumanActions(queue([action("E1"), action("E2")]));
    expect(s.toasts.length).toBe(1);
  });

  it("does NOT re-toast an id that already toasted, even if it leaves and returns", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([action("E1")]));        // seed
    s.setHumanActions(queue([action("E1"), action("E2")])); // E2 toasts
    expect(s.toasts.map((t) => t.id)).toEqual(["E2"]);

    // E2 resolves away (leaves the queue) …
    s.setHumanActions(queue([action("E1")]));
    // … and later reappears: it was already seen, so no second toast.
    s.setHumanActions(queue([action("E1"), action("E2")]));
    expect(s.toasts.map((t) => t.id)).toEqual(["E2"]);
  });

  it("dismissToast removes only the targeted toast", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([]));                                  // first load (empty backlog)
    s.setHumanActions(queue([action("E1"), action("E2"), action("E3")])); // 3 new → 3 toasts
    expect(s.toasts.length).toBe(3);

    s.dismissToast("E2");
    expect(s.toasts.map((t) => t.id).sort()).toEqual(["E1", "E3"]);

    s.dismissToast("E1");
    s.dismissToast("E3");
    expect(s.toasts.length).toBe(0);
  });
});
