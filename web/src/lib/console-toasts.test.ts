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

describe("console store — notice toasts (notify)", () => {
  it("pushes a one-shot notice toast at the front of the stack", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([]));                    // first load seeds silently
    s.notify("Handed back to agent repair.", { title: "Recorded" });
    expect(s.toasts.length).toBe(1);
    const t = s.toasts[0];
    expect(t.id).toMatch(/^notice-/);
    expect(t.kind).toBe("notice");
    if (t.kind === "notice") {
      expect(t.title).toBe("Recorded");
      expect(t.message).toBe("Handed back to agent repair.");
      expect(t.tone).toBe("ok"); // default tone
    }
  });

  it("coexists with action toasts (newest-first) and dismisses by its generated id", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([action("E1")]));                  // seed (no toast)
    s.setHumanActions(queue([action("E1"), action("E2")]));    // E2 → action toast
    s.notify("Verification saved.", { title: "Recorded" });    // notice on top
    expect(s.toasts.length).toBe(2);
    expect(s.toasts[0].id).toMatch(/^notice-/);
    expect(s.toasts[0].kind).toBe("notice");
    expect(s.toasts[1].id).toBe("E2");

    const noticeId = s.toasts[0].id;
    s.dismissToast(noticeId);
    expect(s.toasts.map((t) => t.id)).toEqual(["E2"]);
  });

  it("gives every notice a distinct id so they stack independently", () => {
    const s = createConsoleStore();
    s.setHumanActions(queue([]));
    s.notify("Handed back to agent repair.", { title: "Recorded" });
    s.notify("Verification saved.", { title: "Recorded" });
    const ids = s.toasts.map((t) => t.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2); // unique
  });
});
