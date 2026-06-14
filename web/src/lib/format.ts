import type { EscalationRecord } from "~/lib/types";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface CmdToken { text: string; kind: "exe" | "flag" | "arg"; }
// Split a (already prettified) command into styled tokens: first token = executable/subject,
// tokens starting with - or -- (after any leading quote) = flags, everything else = args.
export function tokenizeCommand(s: string): CmdToken[] {
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.map((p, i) => {
    if (i === 0) return { text: p.replace(/^["']|["']$/g, ""), kind: "exe" as const };
    const bare = p.replace(/^["']+/, "");
    if (/^-{1,2}[A-Za-z]/.test(bare)) return { text: p, kind: "flag" as const };
    return { text: p, kind: "arg" as const };
  });
}

const VERB: Record<string, string> = {
  idle: "Idle", thinking: "Thinking", reading: "Reading", editing: "Editing",
  testing: "Running", verifying: "Verifying", waiting: "Waiting", blocked: "Blocked",
};
export function activityVerb(state: string | undefined): string {
  return (state && VERB[state]) || "Active";
}

// Collapse any path-like token to its basename (handles quoted paths with spaces, drive letters, relative, posix).
export function prettifyTarget(target: string): string {
  if (!target) return target;
  let out = target;
  // quoted paths (may contain spaces): "C:\Program Files\...\x.exe", '.\a\b.md', "/a/b.md", 'C:\Users\..\SKILL.md'
  out = out.replace(/(["'])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^"']*)\1/g, (_m, q, p) => {
    const base = String(p).split(/[\\/]/).filter(Boolean).pop() || p;
    return q + base + q;
  });
  // unquoted path tokens (no spaces): C:\a\b\x.exe, ./a/b, /a/b/c.md, .\a\b
  // Use lookbehind to ensure lone / or \ only matches when at word boundary (not mid-token like src/x.ts)
  out = out.replace(/(?:(?<=[^A-Za-z0-9_]|^)[\\/]|[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s"']+/g, (m) => {
    const base = m.split(/[\\/]/).filter(Boolean).pop() || m;
    return base;
  });
  return out;
}

export interface EscalationGroup {
  key: string;
  level: EscalationRecord["level"];
  entityType: string;
  entityId: string;
  message: string;       // latest representative message
  latest: string;        // latest updatedAt
  count: number;
  instances: EscalationRecord[];
}

export function normalizeEscalationMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+/g, "<path>")     // windows paths
    .replace(/\/[^\s]+/g, "<path>")            // posix paths
    .replace(/\(\d+[^)]*\)/g, "(<n>)")         // "(3 items)"
    .replace(/\d+/g, "<n>")                     // bare numbers
    .replace(/\s+/g, " ")
    .trim();
}

export function groupEscalations(list: EscalationRecord[]): EscalationGroup[] {
  const map = new Map<string, EscalationGroup>();
  for (const esc of list) {
    const key = `${esc.entityType}:${esc.entityId}:${esc.level}:${normalizeEscalationMessage(esc.message)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { key, level: esc.level, entityType: esc.entityType, entityId: esc.entityId, message: esc.message, latest: esc.updatedAt, count: 1, instances: [esc] });
    } else {
      existing.count += 1;
      existing.instances.push(esc);
      if (esc.updatedAt > existing.latest) { existing.latest = esc.updatedAt; existing.message = esc.message; }
    }
  }
  // most severe + most recent first
  const order: Record<EscalationRecord["level"], number> = { critical: 0, human_required: 1, blocker: 2, warning: 3, info: 4 };
  return Array.from(map.values()).sort((a, b) => order[a.level] - order[b.level] || (a.latest < b.latest ? 1 : -1));
}

export function formatAge(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
