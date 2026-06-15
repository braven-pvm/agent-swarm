import { marked } from "marked";
import DOMPurify from "dompurify";
import { FRAC_RE, refTone, slugify } from "~/lib/format";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  if (!md) return "";
  return DOMPurify.sanitize(marked.parse(md) as string);
}

export function renderInline(md: string): string {
  if (!md) return "";
  return DOMPurify.sanitize(marked.parseInline(md) as string);
}

// ── Spec Build Map post-processing ──────────────────────────────────────
// These passes operate on an already-DOMPurify-sanitized HTML STRING. They are
// text-node-safe: they scan tag depth + a code/pre/anchor flag while walking the
// string, only rewriting text that sits OUTSIDE any tag and outside <code>/<pre>/
// <a>. Everything they emit uses a fixed, known-safe class + data-ref/id shape,
// so the result remains within DOMPurify's allow-list (no re-sanitize needed).

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeAttr = (s: string) => escapeHtml(s).replace(/'/g, "&#39;");

interface Segment {
  text: string;
  /** True when this text segment is safe to rewrite (outside tags + outside code/pre/a). */
  editable: boolean;
}

// Split sanitized HTML into alternating tag / text segments, tracking whether each
// text run is inside a <code>/<pre>/<a> region (where we must NOT inject chips).
function segmentHtml(html: string): Segment[] {
  const segments: Segment[] = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
  let last = 0;
  let depth = 0; // nesting depth of skip regions (code/pre/a)
  const SKIP = new Set(["code", "pre", "a"]);
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) {
      segments.push({ text: html.slice(last, m.index), editable: depth === 0 });
    }
    const full = m[0];
    const name = m[1].toLowerCase();
    const isClose = full.startsWith("</");
    const isSelfClose = full.endsWith("/>");
    if (SKIP.has(name) && !isSelfClose) {
      if (isClose) depth = Math.max(0, depth - 1);
      else depth += 1;
    }
    // the tag itself is never editable
    segments.push({ text: full, editable: false });
    last = tagRe.lastIndex;
  }
  if (last < html.length) {
    segments.push({ text: html.slice(last), editable: depth === 0 });
  }
  return segments;
}

/**
 * Wrap every FR/AC token in the rendered body's prose (outside code/pre/anchors)
 * in a status-colored, clickable RefChip button. `statusByRef` maps UPPERCASE ref
 * → coverage status (absent ref → neutral "not indexed" chip). Idempotent: always
 * called on the freshly-rendered HTML, never on its own output.
 */
export function linkifyRefs(html: string, statusByRef: Map<string, string>): string {
  if (!html) return "";
  const segments = segmentHtml(html);
  return segments
    .map((seg) => {
      if (!seg.editable) return seg.text;
      return seg.text.replace(FRAC_RE, (raw) => {
        const ref = raw.toUpperCase();
        const status = statusByRef.get(ref);
        const tone = refTone(status);
        const unindexed = !status;
        const cls = `spec-ref ${tone.cls}`;
        const disabledAttr = unindexed ? " disabled" : "";
        return (
          `<button type="button" class="${cls}" data-ref="${escapeAttr(ref)}"${disabledAttr}>` +
          `<span class="spec-ref-glyph">${tone.glyph}</span>${escapeHtml(raw)}</button>`
        );
      });
    })
    .join("");
}

/**
 * Inject id="<slug>" anchors onto rendered <h2>/<h3> headings so the TOC can
 * scroll-jump to them. Slugs must match parseHeadings() output (same order, same
 * counter de-dup), so we recompute them positionally as we walk the headings.
 */
export function injectHeadingIds(html: string): string {
  if (!html) return "";
  const seen = new Map<string, number>();
  return html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (_full, level, attrs, inner) => {
    // text content for the slug = inner stripped of any tags
    const text = inner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
    let slug = slugify(text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    // preserve any existing attrs but ensure a single id
    const cleaned = String(attrs).replace(/\s*id="[^"]*"/g, "");
    return `<h${level}${cleaned} id="${escapeAttr(slug)}">${inner}</h${level}>`;
  });
}

/**
 * Highlight case-insensitive plain-text matches of `query` in body prose with
 * <mark class="find-hit">. Text-node-safe like linkifyRefs and additionally skips
 * inside already-emitted RefChips (class="spec-ref ...") so it never breaks a chip.
 * Returns the count of hits via the out param so callers can show "k / N".
 */
export function highlightFind(html: string, query: string): { html: string; count: number } {
  const q = query.trim();
  if (!html || q.length < 1) return { html, count: 0 };
  // A RefChip is a <button> — those open/close tags push onto the skip stack via
  // segmentHtml? No: button isn't in SKIP. So also guard against splitting a chip
  // by only editing text that is NOT immediately the chip's own label. We add
  // "button" handling: treat <button ...>…</button> as a skip region too.
  const segments = segmentHtmlWithButtons(html);
  let count = 0;
  const needle = q.toLowerCase();
  const out = segments
    .map((seg) => {
      if (!seg.editable) return seg.text;
      // operate on the decoded-ish text; we only need case-insensitive substring on
      // the raw HTML text run (entities are rare in prose words and safe to skip).
      let result = "";
      let i = 0;
      const lower = seg.text.toLowerCase();
      while (i < seg.text.length) {
        const idx = lower.indexOf(needle, i);
        if (idx === -1) {
          result += seg.text.slice(i);
          break;
        }
        result += seg.text.slice(i, idx);
        const matched = seg.text.slice(idx, idx + q.length);
        result += `<mark class="find-hit" data-find-hit>${matched}</mark>`;
        count += 1;
        i = idx + q.length;
      }
      return result;
    })
    .join("");
  return { html: out, count };
}

// Like segmentHtml but ALSO treats <button> regions as non-editable, so find
// highlighting never injects a <mark> inside a RefChip label.
function segmentHtmlWithButtons(html: string): Segment[] {
  const segments: Segment[] = [];
  const tagRe = /<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
  let last = 0;
  let depth = 0;
  const SKIP = new Set(["code", "pre", "a", "button", "mark"]);
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) segments.push({ text: html.slice(last, m.index), editable: depth === 0 });
    const full = m[0];
    const name = m[1].toLowerCase();
    const isClose = full.startsWith("</");
    const isSelfClose = full.endsWith("/>");
    if (SKIP.has(name) && !isSelfClose) {
      if (isClose) depth = Math.max(0, depth - 1);
      else depth += 1;
    }
    segments.push({ text: full, editable: false });
    last = tagRe.lastIndex;
  }
  if (last < html.length) segments.push({ text: html.slice(last), editable: depth === 0 });
  return segments;
}
