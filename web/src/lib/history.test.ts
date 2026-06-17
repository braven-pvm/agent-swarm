import { describe, it, expect } from "vitest";
import {
  outcomeTone,
  outcomeBucket,
  faultLabel,
  shortRunId,
  sortByStartedDesc,
  filterRuns,
  summarize,
  formatWhen,
  parseArrow,
  compareCountRows,
  buildCompareView,
  humanizeKey,
  type HistoryRun,
} from "~/lib/history";

function run(p: Partial<HistoryRun>): HistoryRun {
  return { runId: "LAR-x-none-1", finalOutcome: "accepted", faultMode: "none", startedAt: "2026-06-10T00:00:00.000Z", ...p };
}

describe("outcomeTone", () => {
  it("maps accepted to a green check, not needing attention", () => {
    const t = outcomeTone({ finalOutcome: "accepted" });
    expect(t.cls).toBe("cov-badge-done");
    expect(t.glyph).toBe("✓");
    expect(t.label).toBe("Accepted");
    expect(t.attention).toBe(false);
  });
  it("maps human_required to an amber warn that needs attention", () => {
    const t = outcomeTone({ finalOutcome: "human_required" });
    expect(t.cls).toBe("cov-badge-human");
    expect(t.glyph).toBe("⚠");
    expect(t.label).toBe("Human required");
    expect(t.attention).toBe(true);
  });
  it("maps any other outcome (blocked) to a red danger that needs attention", () => {
    const t = outcomeTone({ finalOutcome: "blocked" });
    expect(t.cls).toBe("cov-badge-blocked");
    expect(t.glyph).toBe("✕");
    expect(t.label).toBe("Blocked");
    expect(t.attention).toBe(true);
  });
  it("uses warning severity to read as amber even for an unknown outcome", () => {
    const t = outcomeTone({ finalOutcome: "weird_state", classificationSeverity: "warning" });
    expect(t.cls).toBe("cov-badge-human");
    expect(t.glyph).toBe("⚠");
    expect(t.attention).toBe(true);
  });
});

describe("outcomeBucket", () => {
  it("buckets accepted / human_required / everything-else", () => {
    expect(outcomeBucket({ finalOutcome: "accepted" })).toBe("accepted");
    expect(outcomeBucket({ finalOutcome: "human_required" })).toBe("human_required");
    expect(outcomeBucket({ finalOutcome: "blocked" })).toBe("other");
  });
});

describe("faultLabel", () => {
  it("treats none / empty as a neutral non-injected chip", () => {
    expect(faultLabel("none")).toMatchObject({ cls: "cov-badge-not_started", label: "No fault", injected: false });
    expect(faultLabel(undefined).injected).toBe(false);
  });
  it("humanizes an injected fault and tints it", () => {
    const t = faultLabel("source-mutation");
    expect(t.label).toBe("Source mutation");
    expect(t.cls).toBe("cov-badge-human");
    expect(t.injected).toBe(true);
  });
});

describe("shortRunId", () => {
  it("returns the trailing segment of a runId", () => {
    expect(shortRunId("LAR-20260610T181950-live-agent-smoke-none-22340")).toBe("22340");
  });
  it("falls back to the whole id when there is no segment, and em-dash when absent", () => {
    expect(shortRunId("solid")).toBe("solid");
    expect(shortRunId(undefined)).toBe("—");
  });
});

describe("sortByStartedDesc", () => {
  it("orders newest-first by startedAt", () => {
    const a = run({ runId: "a", startedAt: "2026-06-10T00:00:00.000Z" });
    const b = run({ runId: "b", startedAt: "2026-06-11T00:00:00.000Z" });
    const c = run({ runId: "c", startedAt: "2026-06-09T00:00:00.000Z" });
    expect(sortByStartedDesc([a, b, c]).map((r) => r.runId)).toEqual(["b", "a", "c"]);
  });
  it("does not mutate the input array", () => {
    const list = [run({ runId: "a", startedAt: "2026-06-10T00:00:00.000Z" }), run({ runId: "b", startedAt: "2026-06-11T00:00:00.000Z" })];
    const copy = [...list];
    sortByStartedDesc(list);
    expect(list).toEqual(copy);
  });
});

describe("filterRuns", () => {
  const runs: HistoryRun[] = [
    run({ runId: "LAR-1", finalOutcome: "accepted", faultMode: "none", finalReason: "passed gates", sliceId: "SLICE-aaa", classificationCode: "accepted" }),
    run({ runId: "LAR-2", finalOutcome: "human_required", faultMode: "source-mutation", finalReason: "Immutable source mutation detected", sliceId: "SLICE-bbb", classificationCode: "source_mutation" }),
    run({ runId: "LAR-3", finalOutcome: "blocked", faultMode: "low-signal", finalReason: "limit exceeded", sliceId: "SLICE-ccc", classificationCode: "limit_exceeded" }),
  ];
  it("filters by outcome bucket", () => {
    expect(filterRuns(runs, { outcome: "accepted" }).map((r) => r.runId)).toEqual(["LAR-1"]);
    expect(filterRuns(runs, { outcome: "human_required" }).map((r) => r.runId)).toEqual(["LAR-2"]);
    expect(filterRuns(runs, { outcome: "other" }).map((r) => r.runId)).toEqual(["LAR-3"]);
    expect(filterRuns(runs, { outcome: "all" })).toHaveLength(3);
  });
  it("filters by fault mode", () => {
    expect(filterRuns(runs, { fault: "none" }).map((r) => r.runId)).toEqual(["LAR-1"]);
    expect(filterRuns(runs, { fault: "source-mutation" }).map((r) => r.runId)).toEqual(["LAR-2"]);
  });
  it("searches runId / finalReason / sliceId / classificationCode case-insensitively", () => {
    expect(filterRuns(runs, { query: "mutation" }).map((r) => r.runId)).toEqual(["LAR-2"]);
    expect(filterRuns(runs, { query: "slice-ccc" }).map((r) => r.runId)).toEqual(["LAR-3"]);
    expect(filterRuns(runs, { query: "LAR-1" }).map((r) => r.runId)).toEqual(["LAR-1"]);
    expect(filterRuns(runs, { query: "limit_exceeded" }).map((r) => r.runId)).toEqual(["LAR-3"]);
  });
  it("combines outcome + fault + query (AND)", () => {
    expect(filterRuns(runs, { outcome: "human_required", fault: "source-mutation", query: "immutable" }).map((r) => r.runId)).toEqual(["LAR-2"]);
    expect(filterRuns(runs, { outcome: "accepted", query: "mutation" })).toHaveLength(0);
  });
});

describe("summarize", () => {
  const runs: HistoryRun[] = [
    run({ finalOutcome: "accepted", faultMode: "none" }),
    run({ finalOutcome: "accepted", faultMode: "reviewer-repair" }),
    run({ finalOutcome: "human_required", faultMode: "source-mutation" }),
    run({ finalOutcome: "blocked", faultMode: "low-signal" }),
  ];
  it("counts the total and needs-attention (non-accepted)", () => {
    const s = summarize(runs);
    expect(s.total).toBe(4);
    expect(s.needsAttention).toBe(2);
  });
  it("breaks down by outcome with accepted first", () => {
    const s = summarize(runs);
    expect(s.byOutcome[0]).toMatchObject({ outcome: "accepted", count: 2 });
    const map = Object.fromEntries(s.byOutcome.map((o) => [o.outcome, o.count]));
    expect(map).toEqual({ accepted: 2, human_required: 1, blocked: 1 });
  });
  it("breaks down by fault with none first", () => {
    const s = summarize(runs);
    expect(s.byFault[0]).toMatchObject({ fault: "none", count: 1 });
    const map = Object.fromEntries(s.byFault.map((f) => [f.fault, f.count]));
    expect(map).toEqual({ none: 1, "reviewer-repair": 1, "source-mutation": 1, "low-signal": 1 });
  });
});

describe("formatWhen", () => {
  it("splits an ISO timestamp into a date + HH:MM:SS", () => {
    const w = formatWhen("2026-06-10T18:19:50.302Z");
    expect(w.date).not.toBe("—");
    expect(w.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
  it("returns em-dashes for missing / invalid input", () => {
    expect(formatWhen(undefined)).toEqual({ date: "—", time: "—" });
    expect(formatWhen("not-a-date")).toEqual({ date: "—", time: "—" });
  });
});

describe("humanizeKey", () => {
  it("sentence-cases camelCase and snake/kebab keys", () => {
    expect(humanizeKey("graphEdges")).toBe("Graph edges");
    expect(humanizeKey("leftSummary")).toBe("Left summary");
    expect(humanizeKey("active_escalations")).toBe("Active escalations");
    expect(humanizeKey("rightArtifactIndex")).toBe("Right artifact index");
  });
});

describe("parseArrow", () => {
  it("splits a 'left -> right' delta", () => {
    expect(parseArrow("accepted -> human_required")).toEqual({ left: "accepted", right: "human_required" });
  });
  it("mirrors a bare value and handles undefined", () => {
    expect(parseArrow("accepted")).toEqual({ left: "accepted", right: "accepted" });
    expect(parseArrow(undefined)).toEqual({ left: "", right: "" });
  });
});

describe("compareCountRows", () => {
  it("keeps only non-zero deltas, biggest absolute first, with humanized labels", () => {
    const rows = compareCountRows({ turns: -4, verifyRuns: 0, graphEdges: -62, activeEscalations: 1 });
    expect(rows.map((r) => r.label)).toEqual(["Graph edges", "Turns", "Active escalations"]);
    expect(rows[0].delta).toBe(-62);
  });
  it("returns [] for missing deltas", () => {
    expect(compareCountRows(undefined)).toEqual([]);
  });
});

describe("buildCompareView", () => {
  const raw = {
    interpretation: "Run outcome moved away from accepted.",
    changes: { finalOutcomeChanged: true, classificationChanged: true, faultModeChanged: true, phaseChanged: true },
    deltas: {
      counts: { turns: -4, activeEscalations: 1, verifyRuns: 0 },
      finalOutcome: "accepted -> human_required",
      classification: "accepted -> source_mutation",
      faultMode: "none -> source-mutation",
    },
    artifacts: { leftSummary: "X:/a/summary.json", rightSummary: "X:/b/summary.json" },
  };
  it("produces structured pairs flagged with changed", () => {
    const v = buildCompareView(raw);
    const outcome = v.pairs.find((p) => p.label === "Outcome")!;
    expect(outcome).toMatchObject({ left: "accepted", right: "human_required", changed: true });
    expect(v.pairs.find((p) => p.label === "Classification")!.right).toBe("source_mutation");
  });
  it("surfaces non-zero count rows, interpretation, artifacts, and anyChange", () => {
    const v = buildCompareView(raw);
    expect(v.interpretation).toContain("moved away");
    expect(v.counts.map((c) => c.label)).toContain("Turns");
    expect(v.counts.find((c) => c.label === "Verify runs")).toBeUndefined();
    expect(v.artifacts).toHaveLength(2);
    expect(v.artifacts[0].label).toBe("Left summary");
    expect(v.anyChange).toBe(true);
  });
  it("degrades gracefully on null / empty input", () => {
    const v = buildCompareView(null);
    expect(v.interpretation).toBe("");
    expect(v.pairs).toEqual([]);
    expect(v.counts).toEqual([]);
    expect(v.artifacts).toEqual([]);
    expect(v.anyChange).toBe(false);
  });
});
