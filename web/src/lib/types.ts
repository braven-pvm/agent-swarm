export type EntityType = "harness" | "source" | "target" | "lane" | "slice" | "lease" | "dependency" | "agent_run" | "heartbeat" | "escalation" | "evidence";
export type HeartbeatState = "idle" | "thinking" | "reading" | "editing" | "testing" | "verifying" | "waiting" | "blocked";
export type RunMode = "unspecified" | "fixture" | "scripted-codex" | "live-agent-smoke";
export type AgentRole = "overseer" | "planner" | "worker" | "verifier" | "reviewer" | "recovery";
export type SliceStatus = "candidate" | "ready" | "claimed" | "implementing" | "implemented" | "verifying" | "repairing" | "blocked" | "ready_for_review" | "accepted" | "closed";

export interface HarnessEvent { id: string; timestamp: string; actor: string; type: string; entityType: EntityType; entityId: string; payload: Record<string, unknown>; }
export interface AgentActivity { state: HeartbeatState; target?: string; label: string; }
export interface SourceRecord { id: string; adapterId: string; kind: string; uri: string; title: string; hash: string; metadata?: Record<string, unknown>; createdAt: string; updatedAt: string; }
export interface LaneRecord { id: string; name: string; purpose: string; focusLabels: string[]; targetId: string; orchestrator: string; worktree: string; state: "active" | "paused" | "closed"; createdAt: string; updatedAt: string; }
export interface LeaseRecord { id: string; frAcRef: string; sliceId: string; laneId: string; status: "active" | "released" | "completed"; createdAt: string; updatedAt: string; }
export interface HeartbeatRecord { id: string; actor: string; state: HeartbeatState; detail?: string; entityType?: EntityType; entityId?: string; timestamp: string; }
export interface AgentRunRecord { id: string; sliceId: string; role?: AgentRole; entityType?: EntityType; entityId?: string; actor: string; driver: string; status: "running" | "completed" | "failed" | "stale" | "released"; sessionId?: string; attempt: number; eventsPath?: string; resultPath?: string; stderrPath?: string; startedAt: string; updatedAt: string; }
export interface EvidenceRecord { id: string; sliceId: string; kind: "command" | "worker_result" | "review_result" | "artifact" | "note"; summary: string; ref?: string; payload: Record<string, unknown>; createdAt: string; }
export type FrAcVerificationStatus = "passed" | "failed" | "missing_evidence" | "overridden";
export interface FrAcVerificationResult { ref: string; status: FrAcVerificationStatus; evidenceIds: string[]; proof: string; verifiedBy: string; }
export interface EscalationRecord { id: string; level: "info" | "warning" | "blocker" | "human_required" | "critical"; status: "active" | "cleared"; entityType: EntityType; entityId: string; message: string; reason?: string; createdBy: string; clearedBy?: string; createdAt: string; updatedAt: string; }
export interface DependencyEdge { id: string; fromType: "slice" | "lane"; fromId: string; target: string; reason: string; status: "pending" | "satisfied" | "blocked"; createdAt: string; updatedAt: string; }
export type CheckpointRole = "planner" | "worker" | "verifier" | "reviewer" | "recovery" | "overseer";
export interface CheckpointRecord { id: string; role: CheckpointRole; entityType: EntityType; entityId: string; summary: string; payload: Record<string, unknown>; createdBy: string; createdAt: string; updatedAt: string; }
export interface ReviewFinding { ref: string; status: "passed" | "failed" | "missing_evidence" | "uncertain"; evidence: string[]; finding: string; }
export interface ReviewResult { status: "accepted" | "repair_required" | "blocked" | "human_required"; summary: string; frAcFindings: ReviewFinding[]; testAssessment: string; sourceMutationDetected: boolean; stubOrHardcodeRisk: "none" | "low" | "medium" | "high"; requiredFixes: string[]; escalations: Array<{ level: string; message: string }>; recommendation: string; }
export interface DomainSummary { domain: string; sources: number; refs: number; available: number; active: number; blocked: number; completed: number; acceptedSlices: number; activeSlices: number; blockedSlices: number; sourceIds: string[]; tags: string[]; highestPriority: number; }
export interface TargetRef { id: string; path: string; name: string; }

export interface SliceWithDetail {
  id: string; laneId: string; targetId: string; title: string; status: SliceStatus;
  sourceRefs: unknown[]; frAcRefs: string[]; deliveryQuestion: string;
  leases: LeaseRecord[]; evidence: EvidenceRecord[]; frAcResults: FrAcVerificationResult[]; reviewResult?: ReviewResult; agentRuns: AgentRunRecord[];
  createdAt: string; updatedAt: string;
}

export interface SnapshotResponse {
  workspace: string; runMode: RunMode; generatedAt: string;
  scenario?: string; phase?: string; turnCount?: number;   // scenario derivable in M1; phase/turn surfaced in M3 (— until then)
  targets: TargetRef[]; sources: SourceRecord[]; domains: DomainSummary[];
  lanes: Array<LaneRecord & { activeLeases: string[] }>;
  slices: SliceWithDetail[];
  dependencies: Array<DependencyEdge & { status: "pending" | "satisfied" | "blocked" }>;
  agentRuns: AgentRunRecord[]; heartbeats: HeartbeatRecord[];
  activeEscalations: EscalationRecord[]; checkpoints: CheckpointRecord[]; recentEvents: HarnessEvent[];
}

export interface CoverageRef {
  ref: string;
  domain: string;
  sourceId: string;
  sourceTitle: string;
  sourceUri: string;
  sourceSectionId?: string;
  sourceSectionTitle?: string;
  status: "done" | "in_progress" | "blocked" | "failed" | "not_started";
  statusReason: string;
  nextAction:
    | "none"
    | "pull_slice"
    | "run_worker"
    | "await_worker_result"
    | "run_reviewer"
    | "run_verifier"
    | "repair_or_review"
    | "resolve_blocker"
    | "await_verification"
    | "wait_for_dependency"
    | "inspect_accepted_state";
  lastChangedAt: string;
  sliceId?: string;
  sliceStatus?: string;
  laneId?: string;
  laneName?: string;
  targetId?: string;
  targetName?: string;
  worktree?: string;
  verification?: "passed" | "failed" | "missing_evidence" | "overridden";
  reviewStatus?: "passed" | "failed" | "missing_evidence" | "uncertain";
  proof?: string;
  evidenceIds?: string[];
  actors?: {
    workers: string[];
    reviewers: string[];
    verifiers: string[];
    overseers: string[];
  };
  activeEscalations?: Array<{ level: string; entityId: string; message: string }>;
  dependencies?: Array<{ target: string; status: "pending" | "satisfied" | "blocked"; reason: string; fromId: string }>;
  evidence?: Array<{ id: string; kind: string; summary: string; createdAt: string; ref?: string }>;
}

export interface CoverageDomain {
  domain: string;
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  failed: number;
  notStarted: number;
}

export interface CoverageSummary {
  generatedAt: string;
  totals: { total: number; done: number; inProgress: number; blocked: number; failed: number; notStarted: number };
  byDomain: CoverageDomain[];
  refs: CoverageRef[];
}

export type SSEFrame =
  | { type: "event.appended"; data: HarnessEvent }
  | { type: "heartbeat.changed"; data: HeartbeatRecord }
  | { type: "snapshot.invalidated"; data: { reason: string } };

export type SelectedEntity =
  | { kind: "slice"; id: string }
  | { kind: "agent"; actor: string }
  | { kind: "escalation"; id: string }
  | { kind: "overseerTurn"; eventId: string };
