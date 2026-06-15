import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  if (!md) return "";
  return DOMPurify.sanitize(marked.parse(md) as string);
}

export function renderInline(md: string): string {
  if (!md) return "";
  return DOMPurify.sanitize(marked.parseInline(md) as string);
}
