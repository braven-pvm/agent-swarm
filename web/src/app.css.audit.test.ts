import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Stylesheet-contract tests for the Practical-UI audit fixes. These lock in the
// accessibility invariants (focus ring, load-bearing border token, faint->muted
// text) so a later edit that regresses them fails loudly. We assert on the source
// of app.css rather than a rendered DOM because these are token/rule-level rules.
let css = "";

beforeAll(() => {
  // vitest runs with cwd at the web package root; app.css lives at src/app.css.
  css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
});

/**
 * Return the declaration block of the rule whose selector list EXACTLY equals
 * `selector` (whitespace-normalised). Avoids matching a selector that merely
 * appears as one member of a different multi-selector rule.
 */
function block(selector: string): string {
  const want = selector.replace(/\s+/g, " ").trim();
  // Strip comments so a comment preceding a rule isn't captured into its selector.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const sel = m[1].replace(/\s+/g, " ").trim();
    if (sel === want) return m[2];
  }
  return "";
}

describe("app.css — global keyboard focus ring", () => {
  it("defines a single global :focus-visible accent ring", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline-offset:\s*2px/);
  });

  it("uses an inset ring on overflow:hidden cards so it is not clipped", () => {
    expect(css).toMatch(/\.spec-card:focus-visible[^{]*\{[^}]*outline-offset:\s*-2px/);
  });

  it("uses a box-shadow ring for chips that sit on tinted fills", () => {
    expect(css).toMatch(
      /\.spec-ref:focus-visible[\s\S]*?box-shadow:\s*0 0 0 2px var\(--bg\), 0 0 0 4px var\(--accent\)/,
    );
  });
});

describe("app.css — load-bearing border token", () => {
  it("declares --line-3 at 0.34 alpha (verified >=3:1 on bg and panel)", () => {
    expect(css).toMatch(/--line-3:\s*rgba\(255,\s*255,\s*255,\s*0?\.34\)/);
  });

  it("promotes click-target cards to --line-3", () => {
    const b = block(".agent, .slice-card, .esc, .turn");
    expect(b).toContain("border: 1px solid var(--line-3)");
  });

  it("keeps form fields + buttons on --line-3 (the border is the affordance)", () => {
    expect(block(".search")).toContain("border: 1px solid var(--line-3)");
    expect(block(".close")).toContain("border: 1px solid var(--line-3)");
  });

  it("lets static display panels lean on elevation, not a heavy border (--line-2)", () => {
    // Panels are --panel on the recessed --bg stage, so elevation delimits them; the border is
    // decorative reinforcement, not load-bearing. Avoids the boxy/over-bordered look.
    expect(block(".statusbar")).toContain("border-bottom: 1px solid var(--line-2)");
    expect(block(".rail")).toContain("border: 1px solid var(--line-2)");
  });
});

describe("app.css — faint -> muted for meaning-bearing text", () => {
  // Selectors whose <=13px text was promoted off --faint (which fails AA at 4.5:1).
  const promoted = [
    ".agent-role",
    ".agent-next",
    ".runtime",
    ".slice-id",
    ".cov-label",
    ".cov-more",
    ".slice-foot",
    ".evidence",
    ".lv-idle",
    ".agent-ref-more",
    ".truth-meaning",
    ".act-time",
    ".empty",
  ];
  for (const sel of promoted) {
    it(`${sel} no longer uses --faint`, () => {
      const b = block(sel);
      expect(b).not.toContain("var(--faint)");
      expect(b).toContain("var(--muted)");
    });
  }

  it("idle agent dims only the chrome, not the text (no whole-card opacity)", () => {
    const b = block(".agent.idle");
    expect(b).not.toMatch(/opacity:\s*\.72/);
    expect(b).toContain("background: var(--bg)");
  });
});

describe("app.css — outward-increasing spacing", () => {
  it("declares --s6: 32px", () => {
    expect(css).toMatch(/--s6:\s*32px/);
  });

  it("raises the gap between cockpit regions above the within-card 8px", () => {
    const b = block(".cockpit");
    expect(b).toContain("gap: var(--s4)");
  });

  it("sets coverage inter-section gap to 32 (exceeds 16px card padding)", () => {
    expect(block(".coverage")).toContain("gap: var(--s6)");
  });
});

describe("app.css — panel elevation hierarchy", () => {
  it("recesses the centre stage to the base canvas", () => {
    expect(block(".center")).toContain("background: var(--bg)");
  });

  it("lifts the board columns above the recessed canvas to --panel", () => {
    expect(block(".board-col")).toContain("background: var(--panel)");
  });
});
