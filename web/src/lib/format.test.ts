import { describe, it, expect } from "vitest";
import { normalizeEscalationMessage, groupEscalations, formatAge } from "~/lib/format";
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
