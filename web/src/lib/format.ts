import type { EscalationRecord } from "~/lib/types";

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
