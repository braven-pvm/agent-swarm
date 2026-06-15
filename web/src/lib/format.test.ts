import { describe, it, expect } from "vitest";
import { normalizeEscalationMessage, groupEscalations, formatAge, prettifyTarget, activityVerb, tokenizeCommand, formatDuration, extractFrAcRefs, summarizeCommand, describeActivity, livenessLevel, shortAge, fmtClock } from "~/lib/format";
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
  it("running + 2m → stale", () => {
    expect(livenessLevel("running", 120_000)).toBe("stale");
  });
  it("running + 20m → dead", () => {
    expect(livenessLevel("running", 1_200_000)).toBe("dead");
  });
  it("completed + 20m → done", () => {
    expect(livenessLevel("completed", 1_200_000)).toBe("done");
  });
  it("released → done regardless of age", () => {
    expect(livenessLevel("released", 1_000)).toBe("done");
  });
  it("undefined run status defaults to active classification", () => {
    expect(livenessLevel(undefined, 30_000)).toBe("quiet");
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
