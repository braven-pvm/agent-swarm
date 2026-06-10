import type { SourceRecord } from "./types.js";

export interface SourceIndexMetadata {
  domain?: string;
  tags?: string[];
  priority?: number;
  dependsOn?: string[];
  frAcRefs?: string[];
  sections?: SourceSection[];
}

export interface SourceSection {
  id: string;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  refs: string[];
  snippet: string;
}

export function extractFrAcRefs(text: string): string[] {
  const explicitRefs = extractExplicitFrAcRefs(text);
  if (explicitRefs.length > 0) return explicitRefs;

  const found = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line) || /^\s*[-*]\s+/.test(line)) {
      found.add(`AC-FILE-${index + 1}`);
    }
  }
  if (found.size > 0) return [...found].slice(0, 10);

  return ["AC-FILE-1"];
}

export function extractExplicitFrAcRefs(text: string): string[] {
  const found = new Set<string>();
  const explicit = /\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\.[0-9]+)?\b/gi;
  for (const match of text.matchAll(explicit)) {
    found.add(match[0].toUpperCase());
  }
  return [...found];
}

export function sourceDomain(source: SourceRecord): string {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  const domain = metadata?.domain;
  return typeof domain === "string" && domain.trim() ? domain.trim() : "Unassigned";
}

export function sourceTags(source: SourceRecord): string[] {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  return Array.isArray(metadata?.tags) ? metadata.tags.map((tag) => String(tag)).filter(Boolean) : [];
}

export function sourcePriority(source: SourceRecord): number {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  return typeof metadata?.priority === "number" && Number.isFinite(metadata.priority) ? metadata.priority : 100;
}

export function sourceFrAcRefs(source: SourceRecord): string[] {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  return Array.isArray(metadata?.frAcRefs)
    ? metadata.frAcRefs.map((ref) => String(ref).toUpperCase()).filter(Boolean)
    : [];
}

export function sourceSections(source: SourceRecord): SourceSection[] {
  const metadata = source.metadata as SourceIndexMetadata | undefined;
  if (!Array.isArray(metadata?.sections)) return [];
  return metadata.sections.map((section) => ({
    id: String(section.id),
    title: String(section.title),
    level: Number(section.level),
    startLine: Number(section.startLine),
    endLine: Number(section.endLine),
    refs: Array.isArray(section.refs) ? section.refs.map((ref) => String(ref).toUpperCase()) : [],
    snippet: String(section.snippet ?? ""),
  }));
}

export function extractMarkdownSections(text: string, sourceId: string): SourceSection[] {
  const lines = text.split(/\r?\n/);
  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /^#{1,6}\s+\S/.test(item.line.trim()));

  if (headingIndexes.length === 0) {
    return [
      {
        id: `${sourceId}#document`,
        title: "Document",
        level: 1,
        startLine: 1,
        endLine: lines.length,
        refs: extractExplicitFrAcRefs(text),
        snippet: snippetFor(text),
      },
    ];
  }

  return headingIndexes.map((heading, position) => {
    const next = headingIndexes[position + 1];
    const bodyLines = lines.slice(heading.index, next ? next.index : lines.length);
    const headingText = heading.line.trim();
    const title = headingText.replace(/^#{1,6}\s+/, "").trim();
    const level = headingText.match(/^#+/)?.[0].length ?? 1;
    const body = bodyLines.join("\n");
    return {
      id: `${sourceId}#${slug(title) || `section-${position + 1}`}`,
      title,
      level,
      startLine: heading.index + 1,
      endLine: next ? next.index : lines.length,
      refs: extractExplicitFrAcRefs(body),
      snippet: snippetFor(body),
    };
  });
}

export function matchesSourceFilters(
  source: SourceRecord,
  filters: { domain?: string; tags?: string[] } = {},
): boolean {
  if (filters.domain && sourceDomain(source).toLowerCase() !== filters.domain.toLowerCase()) return false;
  if (filters.tags?.length) {
    const sourceTagSet = new Set(sourceTags(source).map((tag) => tag.toLowerCase()));
    return filters.tags.every((tag) => sourceTagSet.has(tag.toLowerCase()));
  }
  return true;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function snippetFor(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .slice(0, 280);
}
