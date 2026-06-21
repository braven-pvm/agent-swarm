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

export type RunMode = "unspecified" | "fixture" | "scripted-codex" | "live-agent-smoke";
export type AgentRole = "overseer" | "planner" | "worker" | "verifier" | "reviewer" | "recovery" | "skeptic";

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

export type WorkPackageType =
  | "component_pack"
  | "runtime_capability"
  | "proof_pack"
  | "review_fix_pack"
  | "diagnostic";

export type MinimumMeaningfulOutcome =
  | "changes_runtime_path"
  | "removes_blocker"
  | "enables_downstream_lane"
  | "proves_cutover_or_readiness"
  | "fixes_high_risk_finding";

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
  deliveryQuestion: string;
  workPackageType: WorkPackageType;
  minimumMeaningfulOutcome: MinimumMeaningfulOutcome;
  acSizedExceptionReason?: string;
  scope: string[];
  outOfScope: string[];
  expectedEvidence: string[];
  verificationObligations: VerificationObligation[];
  unblockTargets: string[];
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
  role?: AgentRole;
  entityType?: EntityType;
  entityId?: string;
  actor: string;
  driver: string;
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
  kind: "command" | "worker_result" | "review_result" | "artifact" | "note" | "finding_challenge";
  summary: string;
  ref?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type VerificationObligationMode = "automated" | "reviewer" | "human_verification_required" | "hybrid";

export interface VerificationCriterion {
  id: string;
  expectedOutcome: string;
  evidenceRequired: string[];
  acceptanceThreshold: string;
}

export interface VerificationObligation {
  ref: string;
  sourceRef?: string;
  sourceUri?: string;
  sourceTitle?: string;
  sourceText: string;
  sourceContext?: string;
  mode: VerificationObligationMode;
  responsibleParty: string;
  criteria: VerificationCriterion[];
  createdBy: string;
  createdAt: string;
  immutable: boolean;
  guidance: string[];
}

export type FrAcVerificationStatus =
  | "passed"
  | "failed"
  | "missing_evidence"
  | "awaiting_human_verification"
  | "human_verified"
  | "human_input_required"
  | "overridden";

export interface VerificationCriterionResult {
  criterionId: string;
  status: FrAcVerificationStatus;
  expectedOutcome: string;
  actualOutcome: string;
  evidenceIds: string[];
}

export interface FrAcVerificationResult {
  ref: string;
  status: FrAcVerificationStatus;
  evidenceIds: string[];
  proof: string;
  verifiedBy: string;
  criteriaResults?: VerificationCriterionResult[];
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

export type CheckpointRole = "planner" | "worker" | "verifier" | "reviewer" | "recovery" | "overseer";

export interface CheckpointRecord {
  id: string;
  role: CheckpointRole;
  entityType: EntityType;
  entityId: string;
  summary: string;
  payload: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
