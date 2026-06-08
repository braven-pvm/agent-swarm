export type EntityType =
  | "harness"
  | "source"
  | "target"
  | "lane"
  | "slice"
  | "lease"
  | "dependency"
  | "agent_run"
  | "heartbeat"
  | "escalation"
  | "evidence";

export type HeartbeatState =
  | "idle"
  | "thinking"
  | "reading"
  | "editing"
  | "testing"
  | "verifying"
  | "waiting"
  | "blocked";

export interface SourceRef {
  adapterId: string;
  kind: string;
  uri: string;
  title?: string;
  version?: string;
  hash?: string;
  section?: string;
}

export interface HarnessEvent {
  id: string;
  timestamp: string;
  actor: string;
  type: string;
  entityType: EntityType;
  entityId: string;
  payload: Record<string, unknown>;
}

export interface TargetConfig {
  target: {
    name: string;
    root: string;
    language?: string;
    packageManager?: string;
  };
  commands: Record<string, string>;
  discovery: {
    generatedAt: string;
    sources: Record<string, string>;
  };
}

export interface SourceRecord {
  id: string;
  adapterId: string;
  kind: string;
  uri: string;
  title: string;
  hash: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LaneRecord {
  id: string;
  name: string;
  purpose: string;
  focusLabels: string[];
  targetId: string;
  orchestrator: string;
  worktree: string;
  state: "active" | "paused" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface SliceRecord {
  id: string;
  laneId: string;
  targetId: string;
  title: string;
  status:
    | "candidate"
    | "ready"
    | "claimed"
    | "implementing"
    | "implemented"
    | "verifying"
    | "repairing"
    | "blocked"
    | "ready_for_review"
    | "accepted"
    | "closed";
  sourceRefs: SourceRef[];
  frAcRefs: string[];
  scope: string[];
  outOfScope: string[];
  verificationRequirements: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LeaseRecord {
  id: string;
  frAcRef: string;
  sliceId: string;
  laneId: string;
  status: "active" | "released" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface HeartbeatRecord {
  id: string;
  actor: string;
  state: HeartbeatState;
  detail?: string;
  entityType?: EntityType;
  entityId?: string;
  timestamp: string;
}

export interface AgentRunRecord {
  id: string;
  sliceId: string;
  actor: string;
  driver: "codex" | "fixture";
  status: "running" | "completed" | "failed" | "stale" | "released";
  sessionId?: string;
  attempt: number;
  eventsPath?: string;
  resultPath?: string;
  stderrPath?: string;
  startedAt: string;
  updatedAt: string;
}

export interface EvidenceRecord {
  id: string;
  sliceId: string;
  kind: "command" | "worker_result" | "artifact" | "note";
  summary: string;
  ref?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface EscalationRecord {
  id: string;
  level: "info" | "warning" | "blocker" | "human_required" | "critical";
  status: "active" | "cleared";
  entityType: EntityType;
  entityId: string;
  message: string;
  reason?: string;
  createdBy: string;
  clearedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DependencyEdge {
  id: string;
  fromType: "slice" | "lane";
  fromId: string;
  target: string;
  reason: string;
  status: "pending" | "satisfied" | "blocked";
  createdAt: string;
  updatedAt: string;
}
