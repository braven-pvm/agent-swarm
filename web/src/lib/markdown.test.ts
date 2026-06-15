import { describe, it, expect } from "vitest";
import { renderMarkdown, renderInline } from "./markdown";

describe("renderInline", () => {
  it("renders backtick code as <code>", () => {
    const result = renderInline("`x`");
    expect(result).toContain("<code>x</code>");
  });

  it("returns empty string for empty input", () => {
    expect(renderInline("")).toBe("");
  });
});

describe("renderMarkdown", () => {
  it("renders heading with <h1>", () => {
    const result = renderMarkdown("# Heading");
    expect(result).toContain("<h1");
  });

  it("sanitizes script tags", () => {
    const result = renderMarkdown("<script>alert(1)</script>");
    expect(result).not.toContain("<script");
  });

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders unordered list", () => {
    const result = renderMarkdown("- item one\n- item two");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>");
  });

  it("renders inline code within block context", () => {
    const result = renderMarkdown("Use `foo()` here");
    expect(result).toContain("<code>foo()</code>");
  });
});
