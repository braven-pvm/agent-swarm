import { describe, it, expect } from "vitest";
import {
  refTone,
  worstStatus,
  countRefStatuses,
  refFamily,
  groupRefsByFamily,
  domainTint,
  slugify,
  parseHeadings,
  statusLabel,
} from "~/lib/format";
import { linkifyRefs, injectHeadingIds, highlightFind, renderMarkdown } from "~/lib/markdown";

describe("refTone", () => {
  it("maps each coverage status to its reused cov-badge class + glyph", () => {
    expect(refTone("done").cls).toBe("cov-badge-done");
    expect(refTone("done").glyph).toBe("✓");
    expect(refTone("in_progress").cls).toBe("cov-badge-in_progress");
    expect(refTone("blocked").cls).toBe("cov-badge-blocked");
    expect(refTone("failed").cls).toBe("cov-badge-failed");
    expect(refTone("not_started").cls).toBe("cov-badge-not_started");
  });
  it("treats undefined / unknown as a neutral, non-cov-badge 'Not indexed' tone", () => {
    expect(refTone(undefined).cls).toBe("spec-ref-unindexed");
    expect(refTone(undefined).label).toBe("Not indexed");
    expect(refTone("bogus").cls).toBe("spec-ref-unindexed");
  });
});

describe("statusLabel", () => {
  it("returns sentence-case labels for all known statuses", () => {
    expect(statusLabel("done")).toBe("Done");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("blocked")).toBe("Blocked");
    expect(statusLabel("failed")).toBe("Failed");
    expect(statusLabel("not_started")).toBe("Not started");
  });
  it("returns 'Not indexed' for unknown/not-indexed statuses", () => {
    expect(statusLabel("not_indexed")).toBe("Not indexed");
    expect(statusLabel("bogus")).toBe("Not indexed");
    expect(statusLabel("")).toBe("Not indexed");
  });
});

describe("worstStatus", () => {
  it("applies failed/blocked > in_progress > not_started > done precedence", () => {
    expect(worstStatus(["done", "in_progress", "blocked"])).toBe("blocked");
    expect(worstStatus(["done", "failed"])).toBe("failed");
    expect(worstStatus(["done", "in_progress"])).toBe("in_progress");
    expect(worstStatus(["done", "not_started"])).toBe("not_started");
    expect(worstStatus(["done", "done"])).toBe("done");
  });
  it("returns undefined when no statuses are present", () => {
    expect(worstStatus([undefined, undefined])).toBeUndefined();
    expect(worstStatus([])).toBeUndefined();
  });
});

describe("countRefStatuses", () => {
  it("tallies per-status counts and indexed/total against a refMap", () => {
    const refMap = new Map<string, { status: string }>([
      ["AC-API-1", { status: "done" }],
      ["AC-API-2", { status: "in_progress" }],
      ["FR-DATA-1", { status: "blocked" }],
      ["FR-DATA-2", { status: "not_started" }],
    ]);
    const c = countRefStatuses(["AC-API-1", "AC-API-2", "FR-DATA-1", "FR-DATA-2", "FR-UI-9"], refMap);
    expect(c.total).toBe(5);
    expect(c.indexed).toBe(4);
    expect(c.done).toBe(1);
    expect(c.inProgress).toBe(1);
    expect(c.blockedFailed).toBe(1);
    expect(c.notStarted).toBe(1);
  });
  it("counts everything as not-indexed against an empty map (coverage === null)", () => {
    const c = countRefStatuses(["AC-API-1", "FR-DATA-1"], new Map());
    expect(c).toMatchObject({ total: 2, indexed: 0, done: 0 });
  });
});

describe("refFamily / groupRefsByFamily", () => {
  it("extracts the family segment after FR-/AC-", () => {
    expect(refFamily("AC-API-3")).toBe("API");
    expect(refFamily("FR-DATA-12")).toBe("DATA");
    expect(refFamily("FR-123")).toBe("Other");
  });
  it("orders known families first, then alphabetical, with Other last", () => {
    const groups = groupRefsByFamily(["FR-ZED-1", "AC-API-2", "AC-API-1", "FR-123", "FR-UI-1"]);
    expect(groups.map((g) => g.family)).toEqual(["API", "UI", "ZED", "Other"]);
    // refs within a family are sorted
    expect(groups[0].refs).toEqual(["AC-API-1", "AC-API-2"]);
  });
});

describe("domainTint", () => {
  it("is deterministic per domain and falls back for empty", () => {
    expect(domainTint("payments")).toBe(domainTint("payments"));
    expect(domainTint(undefined)).toBe("rgba(255,255,255,0.18)");
  });
});

describe("slugify / parseHeadings", () => {
  it("slugifies headings and de-duplicates with a counter", () => {
    expect(slugify("API & Data!")).toBe("api-data");
    const toc = parseHeadings("## Setup\n### Setup\ntext\n## Done");
    expect(toc.map((t) => t.slug)).toEqual(["setup", "setup-1", "done"]);
    expect(toc.map((t) => t.level)).toEqual([2, 3, 2]);
  });
  it("ignores headings inside fenced code blocks", () => {
    const toc = parseHeadings("## Real\n```\n## Fake\n```\n## Also Real");
    expect(toc.map((t) => t.text)).toEqual(["Real", "Also Real"]);
  });
});

describe("linkifyRefs", () => {
  const status = new Map<string, string>([
    ["AC-API-1", "done"],
    ["FR-DATA-2", "blocked"],
  ]);

  it("wraps prose refs in clickable status-colored buttons", () => {
    const html = renderMarkdown("We deliver AC-API-1 then FR-DATA-2.");
    const out = linkifyRefs(html, status);
    expect(out).toContain('data-ref="AC-API-1"');
    expect(out).toContain("cov-badge-done");
    expect(out).toContain("cov-badge-blocked");
    expect(out).toContain('class="spec-ref'); // chip class
  });

  it("renders an unindexed ref as a disabled neutral chip", () => {
    const html = renderMarkdown("Also FR-UI-9 here.");
    const out = linkifyRefs(html, status);
    expect(out).toContain('data-ref="FR-UI-9"');
    expect(out).toContain("spec-ref-unindexed");
    expect(out).toContain("disabled");
  });

  it("does NOT linkify refs inside inline code or fenced code", () => {
    const html = renderMarkdown("Inline `AC-API-1` and:\n\n```\nFR-DATA-2 in code\n```\n");
    const out = linkifyRefs(html, status);
    // the code occurrences must remain plain text, not buttons
    expect(out).toContain("<code>AC-API-1</code>");
    expect(out).not.toContain('data-ref="AC-API-1"');
    expect(out).not.toContain('data-ref="FR-DATA-2"');
  });

  it("does not break sanitization (no script injection survives)", () => {
    const html = renderMarkdown("AC-API-1 <script>alert(1)</script>");
    const out = linkifyRefs(html, status);
    expect(out).not.toContain("<script");
  });
});

describe("injectHeadingIds", () => {
  it("adds slug ids matching parseHeadings order/de-dup", () => {
    const html = renderMarkdown("## Setup\n### Setup\n## Done");
    const out = injectHeadingIds(html);
    expect(out).toContain('id="setup"');
    expect(out).toContain('id="setup-1"');
    expect(out).toContain('id="done"');
  });
});

describe("highlightFind", () => {
  it("wraps case-insensitive plain-text matches in <mark> and counts them", () => {
    const html = renderMarkdown("The worker reads the worker prompt.");
    const { html: out, count } = highlightFind(html, "worker");
    expect(count).toBe(2);
    expect(out).toContain('<mark class="find-hit"');
  });

  it("never highlights inside refchips or code", () => {
    let html = renderMarkdown("AC-API-1 and `AC-API-1` again");
    html = linkifyRefs(html, new Map([["AC-API-1", "done"]]));
    const { html: out } = highlightFind(html, "AC-API-1");
    // no <mark> inside the chip button or the code span
    expect(out).not.toContain('<mark class="find-hit">AC');
  });

  it("returns input unchanged for an empty query", () => {
    const html = renderMarkdown("nothing to find");
    expect(highlightFind(html, "").count).toBe(0);
  });
});
