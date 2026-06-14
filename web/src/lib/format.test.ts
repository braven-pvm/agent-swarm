import { describe, it, expect } from "vitest";
import { normalizeEscalationMessage, groupEscalations, formatAge, prettifyTarget, activityVerb, tokenizeCommand } from "~/lib/format";
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
