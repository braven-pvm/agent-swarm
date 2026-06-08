import { randomUUID } from "node:crypto";

const prefixes = {
  source: "SRC",
  target: "TGT",
  lane: "LANE",
  slice: "SLICE",
  lease: "LEASE",
  dependency: "DEP",
  event: "EVT",
  heartbeat: "HB",
  evidence: "EVD",
  escalation: "ESC",
} as const;

export function makeId(kind: keyof typeof prefixes): string {
  return `${prefixes[kind]}-${randomUUID().slice(0, 8)}`;
}
