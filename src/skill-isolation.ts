export interface SkillIsolationFinding {
  kind: "global_user_skill_reference";
  severity: "warning";
  path: string;
  snippet: string;
  lineNumber?: number;
}

const GLOBAL_CODEX_SKILL_PATTERNS = [
  /(?:[A-Za-z]:|~)?[\\/][^\s"'`<>|]*?\.codex[\\/]skills[\\/][^\s"'`<>|]*/gi,
  /\.codex[\\/]skills[\\/][^\s"'`<>|]*/gi,
];

export function detectGlobalSkillReferences(
  value: unknown,
  options: { lineNumber?: number; maxFindings?: number } = {},
): SkillIsolationFinding[] {
  const maxFindings = Math.max(1, options.maxFindings ?? 8);
  const findings: SkillIsolationFinding[] = [];
  const seen = new Set<string>();
  for (const text of collectStrings(value)) {
    for (const pattern of GLOBAL_CODEX_SKILL_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const raw = match[0];
        const normalized = trimPath(raw);
        if (!normalized || isDuplicatePath(normalized, seen)) continue;
        seen.add(normalized.toLowerCase());
        findings.push({
          kind: "global_user_skill_reference",
          severity: "warning",
          path: normalized,
          snippet: snippetAround(text, match.index ?? 0, raw.length),
          lineNumber: options.lineNumber,
        });
        if (findings.length >= maxFindings) return findings;
      }
    }
  }
  return findings;
}

function isDuplicatePath(pathValue: string, seen: Set<string>): boolean {
  const normalized = pathValue.toLowerCase();
  for (const existing of seen) {
    if (existing === normalized || existing.endsWith(normalized) || normalized.endsWith(existing)) return true;
  }
  return false;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (value === undefined || value === null || depth > 6) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  const strings: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    strings.push(key);
    strings.push(...collectStrings(child, depth + 1));
  }
  return strings;
}

function trimPath(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function snippetAround(value: string, index: number, length: number): string {
  const before = Math.max(0, index - 90);
  const after = Math.min(value.length, index + length + 90);
  const prefix = before > 0 ? "..." : "";
  const suffix = after < value.length ? "..." : "";
  return `${prefix}${value.slice(before, after)}${suffix}`.replace(/\s+/g, " ").slice(0, 320);
}
