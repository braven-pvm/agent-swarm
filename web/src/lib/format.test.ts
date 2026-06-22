import { describe, it, expect } from "vitest";
import { normalizeEscalationMessage, groupEscalations, formatAge, prettifyTarget, activityVerb, tokenizeCommand, formatDuration, extractFrAcRefs, summarizeCommand, describeActivity, livenessLevel, livenessLabel, shortAge, fmtClock, groupRunActivity, groupAgentsByRole, roleGroupLabel, cleanSliceTitle, type RosterGroupRow } from "~/lib/format";
import type { EscalationRecord } from "~/lib/types";

const esc = (id: string, message: string, entityId = "scenario:live"): EscalationRecord => ({
  id, level: "warning", status: "active", entityType: "harness", entityId, message,
  createdBy: "x", createdAt: "2026-06-14T08:00:00.000Z", updatedAt: "2026-06-14T08:00:00.000Z",
});

describe("normalizeEscalationMessage", () => {
  it("strips paths and digits so near-duplicates collapse", () => {
    const a = normalizeEscalationMessage("Modified /a/b/c.ts and 3 files");
    const b = normalizeEscalationMessage("Modified /x/y/z.ts and 9 files");
    expect(a).toBe(b);
  });
});

describe("groupEscalations", () => {
  it("collapses same-entity near-duplicate messages with a count", () => {
    const groups = groupEscalations([
      esc("E1", "git status shows modified files /p/1 (3 items)"),
      esc("E2", "git status shows modified files /p/2 (4 items)"),
      esc("E3", "unrelated blocker", "SLICE-1"),
    ]);
    expect(groups.length).toBe(2);
    const big = groups.find((g) => g.count === 2);
    expect(big).toBeTruthy();
    expect(big!.instances.length).toBe(2);
  });
});

describe("formatAge", () => {
  it("returns a compact age string", () => {
    const now = Date.parse("2026-06-14T08:05:00.000Z");
    expect(formatAge("2026-06-14T08:00:00.000Z", now)).toMatch(/5m/);
  });
});

describe("activityVerb", () => {
  it("maps known states to labels", () => {
    expect(activityVerb("testing")).toBe("Running");
    expect(activityVerb("thinking")).toBe("Thinking");
    expect(activityVerb("editing")).toBe("Editing");
  });
  it("returns Active for unknown/undefined", () => {
    expect(activityVerb(undefined)).toBe("Active");
    expect(activityVerb("unknown-state")).toBe("Active");
  });
});

describe("tokenizeCommand", () => {
  it("classifies first token as exe, -Flag tokens as flag, rest as arg", () => {
    const tokens = tokenizeCommand(`"pwsh.exe" -Command 'npm test'`);
    expect(tokens[0]).toEqual({ text: "pwsh.exe", kind: "exe" });
    const flag = tokens.find((t) => t.text === "-Command");
    expect(flag?.kind).toBe("flag");
    const arg1 = tokens.find((t) => t.text === "'npm");
    expect(arg1?.kind).toBe("arg");
    const arg2 = tokens.find((t) => t.text === "test'");
    expect(arg2?.kind).toBe("arg");
  });
  it("handles a single-token command", () => {
    expect(tokenizeCommand("dashboard.js")).toEqual([{ text: "dashboard.js", kind: "exe" }]);
  });
  it("classifies --files as flag", () => {
    const tokens = tokenizeCommand("vitest --files src/foo.test.ts");
    const flag = tokens.find((t) => t.text === "--files");
    expect(flag?.kind).toBe("flag");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });
  it("formats minutes", () => {
    expect(formatDuration(600_000)).toBe("10m");
  });
  it("formats hours and minutes", () => {
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
  it("returns empty string for negative or NaN", () => {
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });
});

describe("extractFrAcRefs", () => {
  it("extracts and deduplicates FR and AC refs", () => {
    const md = "See FR-CORE-001 and AC-AUTH-02. Also FR-CORE-001 again. And AC-UI.1";
    const refs = extractFrAcRefs(md);
    expect(refs).toEqual(["AC-AUTH-02", "AC-UI.1", "FR-CORE-001"]);
  });
  it("returns empty array when no refs present", () => {
    expect(extractFrAcRefs("No references here.")).toEqual([]);
  });
  it("is case-insensitive in matching but uppercases output", () => {
    const refs = extractFrAcRefs("fr-core-001 and ac-auth-02");
    expect(refs).toContain("FR-CORE-001");
    expect(refs).toContain("AC-AUTH-02");
  });
});

describe("summarizeCommand", () => {
  it("unwraps pwsh -Command and returns reading/read + target for Get-Content", () => {
    const result = summarizeCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content test\\invoices.test.js"');
    expect(result).toEqual({ present: "reading", past: "read", target: "test\\invoices.test.js" });
  });
  it("unwraps single-quoted inner and returns git status tenses", () => {
    const result = summarizeCommand('"pwsh.exe" -Command \'git -c safe.directory=invoice-dashboard status --short\'');
    expect(result.present).toBe("running git status");
    expect(result.past).toBe("git status");
  });
  it("collapses absolute path to basename for Get-Content -LiteralPath", () => {
    const result = summarizeCommand('"pwsh.exe" -Command "Get-Content -LiteralPath \'C:\\Users\\Marius\\.codex\\skills\\project-overseer\\SKILL.md\'"');
    expect(result).toEqual({ present: "reading", past: "read", target: "SKILL.md" });
  });
  it("returns tests tenses for npm test", () => {
    const result = summarizeCommand('"pwsh.exe" -Command "npm test"');
    expect(result.present).toBe("running tests");
    expect(result.past).toBe("ran tests");
  });
  it("returns script tenses for node -e", () => {
    const result = summarizeCommand('"pwsh.exe" -Command "node --input-type=module -e \\"import x\\""');
    expect(result.present).toBe("running script");
    expect(result.past).toBe("ran script");
  });
});

describe("describeActivity", () => {
  it("phrases a Get-Content command as reading/read", () => {
    const result = describeActivity({ state: "reading", target: '"pwsh.exe" -Command "Get-Content src/foo.ts"' });
    expect(result.present).toBe("reading");
    expect(result.past).toBe("read");
  });
  it("phrases a bare file path by state", () => {
    const result = describeActivity({ state: "editing", target: "src/dashboard.js" });
    expect(result.present).toBe("editing");
    expect(result.past).toBe("edited");
    expect(result.target).toBe("src/dashboard.js");
  });
  it("collapses an absolute bare path to basename", () => {
    const result = describeActivity({ state: "editing", target: "C:\\repos\\app\\src\\dashboard.js" });
    expect(result.target).toBe("dashboard.js");
  });
  it("maps a no-target state to its tenses", () => {
    expect(describeActivity({ state: "thinking" })).toEqual({ present: "thinking", past: "thought" });
  });
});

describe("livenessLevel", () => {
  it("running + 5s → alive", () => {
    expect(livenessLevel("running", 5_000)).toBe("alive");
  });
  it("running + 30s → quiet", () => {
    expect(livenessLevel("running", 30_000)).toBe("quiet");
  });
  it("running + 2m → stale", () => {
    expect(livenessLevel("running", 120_000)).toBe("stale");
  });
  it("running + 20m → dead (live run gone silent = genuinely stalled)", () => {
    expect(livenessLevel("running", 1_200_000)).toBe("dead");
  });
  it("harness-flagged stale run → dead regardless of age", () => {
    expect(livenessLevel("stale", 1_000)).toBe("dead");
  });
  it("completed + 20m → done", () => {
    expect(livenessLevel("completed", 1_200_000)).toBe("done");
  });
  it("released → done regardless of age", () => {
    expect(livenessLevel("released", 1_000)).toBe("done");
  });
  it("failed run → done (finished, not stalled)", () => {
    expect(livenessLevel("failed", 1_200_000)).toBe("done");
  });
  it("no run status (heartbeat-only step) → done, never a false stall", () => {
    expect(livenessLevel(undefined, 30_000)).toBe("done");
    expect(livenessLevel(undefined, 1_200_000)).toBe("done");
  });
});

describe("livenessLabel", () => {
  it("running levels → active", () => {
    expect(livenessLabel("alive")).toBe("active");
    expect(livenessLabel("quiet")).toBe("active");
    expect(livenessLabel("stale")).toBe("active");
  });
  it("dead → stalled, done → idle", () => {
    expect(livenessLabel("dead")).toBe("stalled");
    expect(livenessLabel("done")).toBe("idle");
  });
});

describe("shortAge", () => {
  it("returns now for sub-second", () => {
    expect(shortAge(500)).toBe("now");
  });
  it("returns seconds under a minute", () => {
    expect(shortAge(45_000)).toBe("45s");
  });
  it("returns minutes under an hour", () => {
    expect(shortAge(120_000)).toBe("2m");
  });
  it("returns hours beyond an hour", () => {
    expect(shortAge(7_200_000)).toBe("2h");
  });
});

describe("fmtClock", () => {
  it("returns empty string for invalid input", () => {
    expect(fmtClock("not-a-date")).toBe("");
  });
  it("formats a valid ISO timestamp as 24h time", () => {
    expect(fmtClock("2026-06-14T08:05:09.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("groupRunActivity", () => {
  const ts = (n: number) => `2026-06-14T08:00:0${n}.000Z`;
  it("collapses consecutive same-verb actions into one group with deduped targets", () => {
    const groups = groupRunActivity([
      { state: "reading", target: "a.ts", ts: ts(0) },
      { state: "reading", target: "b.ts", ts: ts(1) },
      { state: "reading", target: "a.ts", ts: ts(2) }, // repeat target deduped
      { state: "testing", target: '"pwsh.exe" -Command "npm test"', ts: ts(3) },
      { state: "reading", target: '"pwsh.exe" -Command "git diff"', ts: ts(4) },
    ]);
    // reads(a,b) | tests | git diff  → 3 groups
    expect(groups.length).toBe(3);
    expect(groups[0].verb).toBe("read");
    expect(groups[0].targets).toEqual(["a.ts", "b.ts"]);
    expect(groups[0].count).toBe(3);
    expect(groups[0].startTs).toBe(ts(0));
    expect(groups[0].endTs).toBe(ts(2));
    expect(groups[1].verb).toBe("ran tests");
    expect(groups[2].verb).toBe("git diff");
  });
  it("sorts ascending by timestamp before grouping", () => {
    const groups = groupRunActivity([
      { state: "reading", target: "b.ts", ts: ts(2) },
      { state: "reading", target: "a.ts", ts: ts(1) },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0].targets).toEqual(["a.ts", "b.ts"]);
    expect(groups[0].startTs).toBe(ts(1));
  });
  it("returns an empty array for no entries", () => {
    expect(groupRunActivity([])).toEqual([]);
  });
});

describe("prettifyTarget", () => {
  it("collapses quoted windows paths to basenames", () => {
    const input = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command \"Get-Content -Raw '.\\..swarm\\artifacts\\scenario-live-agent-smoke\\overseer-prompt-RUN-1c751f2d.md'\"";
    // The double-quoted exe path collapses; the single-quoted .swarm path inside is also handled
    const result = prettifyTarget(input);
    expect(result).toContain("\"pwsh.exe\"");
    expect(result).toContain("'overseer-prompt-RUN-1c751f2d.md'");
    expect(result).not.toContain("Program Files");
    expect(result).not.toContain("scenario-live-agent-smoke");
  });
  it("collapses quoted literal test case 1", () => {
    const input = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command \"Get-Content -Raw '.\\.swarm\\artifacts\\scenario-live-agent-smoke\\overseer-prompt-RUN-1c751f2d.md'\"";
    const expected = "\"pwsh.exe\" -Command \"Get-Content -Raw 'overseer-prompt-RUN-1c751f2d.md'\"";
    expect(prettifyTarget(input)).toBe(expected);
  });
  it("collapses quoted literal test case 2", () => {
    const input = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command \"Get-Content -LiteralPath 'C:\\Users\\Marius\\.codex\\skills\\project-overseer\\SKILL.md'\"";
    const expected = "\"pwsh.exe\" -Command \"Get-Content -LiteralPath 'SKILL.md'\"";
    expect(prettifyTarget(input)).toBe(expected);
  });
  it("leaves plain commands unchanged", () => {
    expect(prettifyTarget("npm test")).toBe("npm test");
  });
});

describe("roleGroupLabel", () => {
  it("maps known roles to sentence-case plurals", () => {
    expect(roleGroupLabel("overseer")).toBe("Overseers");
    expect(roleGroupLabel("worker")).toBe("Workers");
    expect(roleGroupLabel("reviewer")).toBe("Reviewers");
    expect(roleGroupLabel("skeptic")).toBe("Skeptics");
    expect(roleGroupLabel("verifier")).toBe("Verifiers");
    expect(roleGroupLabel("planner")).toBe("Planners");
    expect(roleGroupLabel("recovery")).toBe("Recovery");
  });
  it("humanizes an unknown role and falls back to Other for none", () => {
    expect(roleGroupLabel("custom_role")).toBe("Custom role");
    expect(roleGroupLabel(undefined)).toBe("Other");
  });
});

describe("groupAgentsByRole", () => {
  const NOW = Date.parse("2026-06-14T12:00:00.000Z");
  // latest = NOW → age 0; running → active; running + old → stalled (dead); non-running → idle.
  const row = (actor: string, role: string | undefined, opts: { runStatus?: string; ageMs?: number } = {}): RosterGroupRow => ({
    actor, role, runStatus: opts.runStatus, latest: new Date(NOW - (opts.ageMs ?? 0)).toISOString(),
  });

  it("orders groups overseer→worker→reviewer→skeptic→verifier→planner→recovery, unknown last", () => {
    const groups = groupAgentsByRole([
      row("p", "planner", { runStatus: "running" }),
      row("u", "scout", { runStatus: "running" }),
      row("o", "overseer", { runStatus: "running" }),
      row("w", "worker", { runStatus: "running" }),
      row("rc", "recovery", { runStatus: "running" }),
      row("sk", "skeptic", { runStatus: "running" }),
      row("rv", "reviewer", { runStatus: "running" }),
      row("v", "verifier", { runStatus: "running" }),
    ], NOW);
    expect(groups.map((g) => g.role)).toEqual([
      "overseer", "worker", "reviewer", "skeptic", "verifier", "planner", "recovery", "scout",
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      "Overseers", "Workers", "Reviewers", "Skeptics", "Verifiers", "Planners", "Recovery", "Scout",
    ]);
  });

  it("omits empty groups and counts members", () => {
    const groups = groupAgentsByRole([
      row("w1", "worker", { runStatus: "running" }),
      row("w2", "worker", { runStatus: "completed" }),
    ], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].role).toBe("worker");
    expect(groups[0].count).toBe(2);
  });

  it("sorts active-first within a group: active → stalled → idle, then by actor name", () => {
    const groups = groupAgentsByRole([
      row("zeta", "worker", { runStatus: "completed" }),               // idle
      row("alpha", "worker", { runStatus: "running", ageMs: 10 * 60_000 }), // stalled (dead)
      row("yankee", "worker", { runStatus: "running" }),               // active
      row("bravo", "worker", { runStatus: "running" }),                // active
    ], NOW);
    const g = groups[0];
    // active (alpha-sorted) first, then stalled, then idle
    expect(g.active.map((r) => r.actor)).toEqual(["bravo", "yankee", "alpha"]);
    expect(g.idle.map((r) => r.actor)).toEqual(["zeta"]);
  });

  it("partitions active+stalled into .active and idle into .idle", () => {
    const groups = groupAgentsByRole([
      row("a", "verifier", { runStatus: "running" }),                   // active
      row("b", "verifier", { runStatus: "running", ageMs: 10 * 60_000 }), // stalled
      row("c", "verifier", { runStatus: "released" }),                  // idle
      row("d", "verifier" /* no run */),                                // idle (no runStatus)
    ], NOW);
    const g = groups[0];
    expect(g.active.map((r) => r.actor).sort()).toEqual(["a", "b"]);
    expect(g.idle.map((r) => r.actor).sort()).toEqual(["c", "d"]);
  });
});

describe("cleanSliceTitle", () => {
  it("drops a trailing FR/AC ref dump so the title is the deliverable", () => {
    expect(cleanSliceTitle("Complete Invoice API and seeded data coverage (AC-API-001.1, AC-API-001.2, FR-DATA-001)"))
      .toBe("Complete Invoice API and seeded data coverage");
  });
  it("drops a leading 'Implement ' verb", () => {
    expect(cleanSliceTitle("Implement invoice listing")).toBe("invoice listing");
  });
  it("strips both the verb and the ref dump together", () => {
    expect(cleanSliceTitle("Implement dashboard model (AC-UI-INV-001.1)")).toBe("dashboard model");
  });
  it("leaves a title with no ref dump untouched", () => {
    expect(cleanSliceTitle("Resolve invoice dashboard product readiness"))
      .toBe("Resolve invoice dashboard product readiness");
  });
  it("does not strip a parenthetical that is not a ref list", () => {
    expect(cleanSliceTitle("Mark invoice paid (idempotent)")).toBe("Mark invoice paid (idempotent)");
  });
});
