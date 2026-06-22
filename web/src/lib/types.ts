export type EntityType = "harness" | "source" | "target" | "lane" | "slice" | "lease" | "dependency" | "agent_run" | "heartbeat" | "escalation" | "evidence";
export type HeartbeatState = "idle" | "thinking" | "reading" | "editing" | "testing" | "verifying" | "waiting" | "blocked";
export type RunMode = "unspecified" | "fixture" | "scripted-codex" | "live-agent-smoke";
export type AgentRole = "overseer" | "planner" | "worker" | "verifier" | "reviewer" | "skeptic" | "recovery";
export type SliceStatus = "candidate" | "ready" | "claimed" | "implementing" | "implemented" | "verifying" | "repairing" | "blocked" | "ready_for_review" | "accepted" | "closed";

export interface HarnessEvent { id: string; timestamp: string; actor: string; type: string; entityType: EntityType; entityId: string; payload: Record<string, unknown>; }
export interface AgentActivity { state: HeartbeatState; target?: string; label: string; }
export interface SourceRecord { id: string; adapterId: string; kind: string; uri: string; title: string; hash: string; metadata?: Record<string, unknown>; createdAt: string; updatedAt: string; }
export interface LaneRecord { id: string; name: string; purpose: string; focusLabels: string[]; targetId: string; orchestrator: string; worktree: string; state: "active" | "paused" | "closed"; createdAt: string; updatedAt: string; }
export interface LeaseRecord { id: string; frAcRef: string; sliceId: string; laneId: string; status: "active" | "released" | "completed"; createdAt: string; updatedAt: string; }
export interface HeartbeatRecord { id: string; actor: string; state: HeartbeatState; detail?: string; entityType?: EntityType; entityId?: string; timestamp: string; }
export interface SkillIsolationFinding { kind: "global_user_skill_reference"; severity: "warning"; path: string; snippet: string; lineNumber?: number; }
export interface AgentRunRecord { id: string; sliceId: string; role?: AgentRole; entityType?: EntityType; entityId?: string; actor: string; driver: string; status: "running" | "completed" | "failed" | "stale" | "released"; sessionId?: string; attempt: number; eventsPath?: string; resultPath?: string; stderrPath?: string; skills?: unknown; skillBindingPath?: string; skillPacketPath?: string; skillIsolationFindings?: SkillIsolationFinding[]; startedAt: string; updatedAt: string; }
export interface EvidenceRecord { id: string; sliceId: string; kind: "command" | "worker_result" | "review_result" | "finding_challenge" | "artifact" | "note"; summary: string; ref?: string; payload: Record<string, unknown>; createdAt: string; }
export type FrAcVerificationStatus = "passed" | "failed" | "missing_evidence" | "awaiting_human_verification" | "human_verified" | "human_input_required" | "overridden";
export interface VerificationCriterionResult { criterionId: string; status: FrAcVerificationStatus; expectedOutcome: string; actualOutcome: string; evidenceIds: string[]; }
export interface FrAcVerificationResult { ref: string; status: FrAcVerificationStatus; evidenceIds: string[]; proof: string; verifiedBy: string; criteriaResults?: VerificationCriterionResult[]; }
export type VerificationObligationMode = "automated" | "reviewer" | "human_verification_required" | "hybrid";
export interface VerificationCriterion { id: string; expectedOutcome: string; evidenceRequired: string[]; acceptanceThreshold: string; }
export interface VerificationObligation {
  ref: string; sourceRef?: string; sourceUri?: string; sourceTitle?: string; sourceText: string; sourceContext?: string;
  mode: VerificationObligationMode; responsibleParty: string; criteria: VerificationCriterion[];
  createdBy: string; createdAt: string; immutable: boolean; guidance: string[];
}
export interface EscalationRecord { id: string; level: "info" | "warning" | "blocker" | "human_required" | "critical"; status: "active" | "cleared"; entityType: EntityType; entityId: string; message: string; reason?: string; createdBy: string; clearedBy?: string; createdAt: string; updatedAt: string; }
export interface DependencyEdge { id: string; fromType: "slice" | "lane"; fromId: string; target: string; reason: string; status: "pending" | "satisfied" | "blocked"; createdAt: string; updatedAt: string; }
export type CheckpointRole = "planner" | "worker" | "verifier" | "reviewer" | "recovery" | "overseer";
export interface CheckpointRecord { id: string; role: CheckpointRole; entityType: EntityType; entityId: string; summary: string; payload: Record<string, unknown>; createdBy: string; createdAt: string; updatedAt: string; }
export interface ReviewFinding { ref: string; status: "passed" | "failed" | "missing_evidence" | "uncertain"; evidence: string[]; finding: string; }
export interface ReviewQualityDimension { dimension: "runtime_path" | "stub_or_hardcode" | "test_meaningfulness" | "error_handling" | "integration_fit" | "maintainability" | "real_world_readiness"; status: "passed" | "warning" | "failed" | "not_applicable"; risk: "none" | "low" | "medium" | "high"; evidence: string[]; finding: string; }
export interface ReviewQualityGate { status: "passed" | "warning" | "failed"; summary: string; dimensions: ReviewQualityDimension[]; blockingConcerns: string[]; residualRisks: string[]; }
export interface ReviewResult { status: "accepted" | "repair_required" | "blocked" | "human_required"; summary: string; frAcFindings: ReviewFinding[]; testAssessment: string; sourceMutationDetected: boolean; stubOrHardcodeRisk: "none" | "low" | "medium" | "high"; qualityGate: ReviewQualityGate; requiredFixes: string[]; escalations: Array<{ level: string; message: string }>; recommendation: string; }
export interface DomainSummary { domain: string; sources: number; refs: number; available: number; active: number; blocked: number; completed: number; acceptedSlices: number; activeSlices: number; blockedSlices: number; sourceIds: string[]; tags: string[]; highestPriority: number; }
export interface TargetRef { id: string; path: string; name: string; }

export interface SliceWithDetail {
  id: string; laneId: string; targetId: string; title: string; status: SliceStatus;
  sourceRefs: unknown[]; frAcRefs: string[]; deliveryQuestion: string;
  verificationObligations?: VerificationObligation[];
  leases: LeaseRecord[]; evidence: EvidenceRecord[]; frAcResults: FrAcVerificationResult[]; reviewResult?: ReviewResult; agentRuns: AgentRunRecord[];
  createdAt: string; updatedAt: string;
}

export interface FocusItem {
  reason: string;            // comma-joined, e.g. "blocked,command_failed" or "none"
  sliceId: string;
  title: string;
  status: string;
  laneName?: string;
  targetName?: string;
  retryCount: number;
  inspectSliceCommand: string;
  inspectRunCommand?: string;
  focusPriority: number;
  latestRun?: {
    id: string; role?: string; actor: string; status: string; attempt: number;
    sessionIdCaptured: boolean; heartbeatState?: string; heartbeatAgeMs?: number;
    promptPath?: string; resultExists: boolean; stderrExists: boolean;
    eventStreamExists: boolean; eventLineCount: number;
    lastCommand?: { command: string; status?: string; exitCode?: number; outputTail: string };
    globalSkillReferences?: SkillIsolationFinding[];
  };
  activeEscalations: Array<{ id: string; level: string; status: string; entityType: string; entityId: string; message: string; reason?: string; updatedAt: string }>;
  recommendedInterventions: string[];
  error?: string;
}

export interface AgentFocusItem {
  reason: string;
  runId: string;
  actor: string;
  role?: string;
  status: string;
  entityType?: string;
  entityId?: string;
  sliceId?: string;
  inspectRunCommand: string;
  heartbeatState?: string;
  heartbeatAgeMs?: number;
  promptPath?: string;
  resultExists: boolean;
  stderrExists: boolean;
  eventStreamExists: boolean;
  eventLineCount: number;
  globalSkillReferences?: SkillIsolationFinding[];
  focusPriority: number;
  lastCommand?: { command: string; status?: string; exitCode?: number; outputTail: string };
  recommendedInterventions: string[];
  error?: string;
}

export type CoverageStatus = "done" | "in_progress" | "blocked" | "failed" | "not_started";
export type RequirementKind = "fr" | "ac" | "unknown";
export type RequirementLedgerStatus =
  | "not_started"
  | "planned"
  | "in_progress"
  | "implemented_unverified"
  | "review_passed"
  | "verified"
  | "awaiting_human_verification"
  | "human_verified"
  | "human_input_required"
  | "failed"
  | "blocked"
  | "accepted";
export interface RequirementRollup {
  rule: "none" | "direct" | "children" | "direct_and_children";
  status: RequirementLedgerStatus;
  reason: string;
  directStatus: CoverageStatus;
  directLedgerStatus: RequirementLedgerStatus;
  childRefs: string[];
  childStatusCounts: Record<RequirementLedgerStatus, number>;
}
export interface HumanVerificationPacketLink {
  evidenceId: string;
  markdownPath: string;
  jsonPath: string;
  status: "awaiting_human_verification" | "human_verified" | "failed" | "needs_rework";
  generatedAt: string;
}
export interface RequirementHumanPath {
  state: "none" | "human_verification_required" | "human_input_required";
  blocksAcceptance: boolean;
  reason: string;
  responsibleParty?: string;
  packet?: HumanVerificationPacketLink;
}
export interface RequirementLedgerEntry {
  ref: string;
  kind: RequirementKind;
  status: RequirementLedgerStatus;
  reason: string;
  coverageStatus: CoverageStatus;
  directStatus: CoverageStatus;
  domain: string;
  sourceId: string;
  sourceTitle: string;
  sourceUri: string;
  sliceId?: string;
  sliceStatus?: string;
  parentRefs: string[];
  childRefs: string[];
  obligation?: CoverageRef["obligation"];
  verification?: CoverageRef["verification"];
  reviewStatus?: CoverageRef["reviewStatus"];
  evidenceIds?: string[];
  activeEscalations?: CoverageRef["activeEscalations"];
  humanPath: RequirementHumanPath;
  rollup?: RequirementRollup;
  lastChangedAt: string;
}
export interface RequirementLedgerSummary {
  generatedAt: string;
  totals: Record<RequirementLedgerStatus, number> & { total: number };
  entries: RequirementLedgerEntry[];
  rollups: RequirementRollup[];
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
  focusQueue: FocusItem[];
  agentFocusQueue: AgentFocusItem[];
  runObservability: RunObservabilitySummary;
}

export interface CoverageRef {
  ref: string;
  domain: string;
  sourceId: string;
  sourceTitle: string;
  sourceUri: string;
  sourceSectionId?: string;
  sourceSectionTitle?: string;
  status: CoverageStatus;
  directStatus?: CoverageStatus;
  statusReason: string;
  kind?: RequirementKind;
  ledgerStatus?: RequirementLedgerStatus;
  ledgerReason?: string;
  parentRefs?: string[];
  childRefs?: string[];
  humanPath?: RequirementHumanPath;
  humanVerificationPacket?: HumanVerificationPacketLink;
  rollup?: RequirementRollup;
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
  verification?: FrAcVerificationStatus;
  obligation?: { status: "present" | "missing"; mode?: string; responsibleParty?: string; criteriaCount: number; expectedOutcomes: string[] };
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
  interpretation: CoverageInterpretation;
  byDomain: CoverageDomain[];
  refs: CoverageRef[];
  ledger: RequirementLedgerSummary;
}

export interface CoverageInterpretation {
  completionPercent: number;
  state: "empty" | "complete" | "partial";
  headline: string;
  detail: string;
  warning?: string;
  nextActions: Array<{ action: CoverageRef["nextAction"]; count: number; label: string }>;
  topIncompleteDomains: Array<CoverageDomain & { incomplete: number; completionPercent: number }>;
}

export interface RunObservabilitySummary {
  generatedAt: string;
  workspace: string;
  runMode: RunMode;
  scenario?: string;
  outcome: {
    available: boolean;
    source: "live-summary" | "harness-state";
    runId?: string;
    finalOutcome?: string;
    finalReason?: string;
    accepted: boolean;
    classification?: { code?: string; severity?: string; explanation?: string };
    generatedAt?: string;
    phase?: string;
    faultMode?: string;
    counts?: Record<string, number>;
    artifacts?: Record<string, string>;
  };
  coverage: {
    totals: CoverageSummary["totals"];
    completionPercent: number;
    complete: boolean;
    incomplete: number;
    state: CoverageInterpretation["state"];
    headline: string;
    warning?: string;
    byDomain: CoverageSummary["byDomain"];
    topIncompleteDomains: CoverageInterpretation["topIncompleteDomains"];
  };
  productReadiness: {
    available: boolean;
    passed?: boolean;
    productName?: string;
    manualUrl?: string;
    acceptedRefs: string[];
    dependencyGate?: {
      satisfied: boolean;
      declaredRefs: string[];
      acceptedRefs: string[];
      missingRefs: string[];
    };
    checks?: { total: number; passed: number; failed: number };
    blockers: Array<{ id?: string; label?: string; message?: string; severity?: string }>;
    probes?: { ui?: boolean; api?: boolean; markPaid?: boolean; workflow?: boolean };
    artifacts?: Record<string, string>;
  };
  slices: {
    total: number;
    accepted: number;
    active: number;
    blocked: number;
    byStatus: Record<string, number>;
  };
  outcomeVsCoverage: {
    state: "accepted_complete" | "accepted_partial" | "not_accepted" | "unknown";
    severity: "success" | "warning" | "danger" | "neutral";
    headline: string;
    detail: string;
    truthRows: Array<{ label: string; state: string; meaning: string; severity: "success" | "warning" | "danger" | "neutral" }>;
  };
  warnings: string[];
  uiHints: {
    badges: Array<{ label: string; value: string; tone: "success" | "warning" | "danger" | "neutral"; tooltip: string }>;
    callouts: Array<{ tone: "success" | "warning" | "danger" | "neutral"; title: string; detail: string }>;
    recommendedPrimaryView: "coverage" | "bridge" | "history";
  };
}

export type SSEFrame =
  | { type: "event.appended"; data: HarnessEvent }
  | { type: "heartbeat.changed"; data: HeartbeatRecord }
  | { type: "snapshot.invalidated"; data: { reason: string } };

export type SelectedEntity =
  | { kind: "slice"; id: string }
  | { kind: "agent"; actor: string }
  | { kind: "escalation"; id: string }
  | { kind: "overseerTurn"; eventId: string }
  | { kind: "focusSlice"; id: string }
  | { kind: "focusRun"; id: string };

// ── New backend store artifacts (skeptic / downgrade / fast-path / journal / settings) ──
// These shapes mirror loose HarnessEvent.payload / EvidenceRecord.payload fields emitted by the
// backend. They are kept additive + all-optional so tolerant readers (which guard for absence)
// never throw on a partial or future payload; the canonical source is src/cli.ts.

/** Verdict an independent skeptic returns when challenging a reviewer finding. */
export type SkepticVerdict = "real" | "refuted" | "uncertain";
/** Severity of the challenged finding (mirrors the reviewer/verifier severity ladder). */
export type SkepticSeverity = "blocker" | "major" | "minor" | "nit";
/** Where the challenged finding originated. */
export type SkepticFindingSource = "fr_ac_finding" | "quality_dimension" | "required_fix" | "escalation";
/** Overall skeptic-run outcome. */
export type SkepticStatus = "upheld" | "partially_refuted" | "refuted" | "uncertain";

/** Payload of a `skeptic.finding_challenged` event — one per challenged verdict (src/cli.ts:3596). */
export interface SkepticFindingChallengedPayload {
  runId?: string;
  ref?: string;
  dimension?: string;
  source?: SkepticFindingSource;
  verdict?: SkepticVerdict;
  severity?: SkepticSeverity;
  reasoning?: string;
  challengedReviewEvidenceId?: string;
}

/** Per-verdict entry inside a `finding_challenge` evidence record's `skepticResult` (src/schemas.ts:114). */
export interface SkepticFindingVerdict {
  ref?: string;
  dimension?: string;
  source?: SkepticFindingSource;
  verdict?: SkepticVerdict;
  severity?: SkepticSeverity;
  reasoning?: string;
}

/** `skepticResult` object carried on a `finding_challenge` evidence payload (src/schemas.ts:123). */
export interface SkepticResult {
  status?: SkepticStatus;
  summary?: string;
  challengedReviewStatus?: "accepted" | "repair_required" | "blocked" | "human_required";
  findingVerdicts?: SkepticFindingVerdict[];
  recommendation?: string;
}

/** Payload of a `finding_challenge` EvidenceRecord (src/cli.ts:3536). */
export interface FindingChallengePayload {
  path?: string;
  skepticResult?: SkepticResult;
  challengedReviewEvidenceId?: string;
  skepticActor?: string;
}

/**
 * Payload of a `review.finding_downgraded` event (src/cli.ts:1076). Emitted by the VERIFIER when an
 * independent skeptic overrode a blocking quality concern to accept — a SAFETY-relevant override
 * that does NOT mutate reviewResult.qualityGate.
 */
export interface FindingDowngradedPayload {
  dimension?: string;
  concern?: string;
  targetKind?: "dimension" | "concern" | "status";
  fromSeverity?: string;
  skepticVerdict?: SkepticVerdict;
  reasoning?: string;
  skepticActor?: string;
  challengeEvidenceId?: string;
  reviewEvidenceId?: string;
}

/** Source of an overseer turn's decision: deterministic code vs an LLM turn. */
export type OverseerDecisionSource = "deterministic" | "llm";

/** Payload of an `overseer.fast_path` event (src/cli.ts:2312) — a deterministic (code) decision. */
export interface OverseerFastPathPayload {
  runId?: string;
  scenario?: string;
  decisionSource?: OverseerDecisionSource;
  sliceId?: string;
  sliceStatus?: string;
  commandKey?: string;
  command?: string;
  purpose?: string;
  reason?: string;
}

/**
 * Payload of a `worker.journal_hit` event (src/cli.ts:2717) — the worker leaf was REPLAYED from the
 * opt-in result journal, not freshly spawned. Only fires when the journal is enabled (default off).
 */
export interface WorkerJournalHitPayload {
  runId?: string;
  driver?: string;
  model?: string;
  journalKey?: string;
  resultPath?: string;
  storedAt?: string;
  storedDriver?: string;
  soundnessNote?: string;
}

/** Read-only swarm settings exposed by GET /api/settings. */
export interface SettingsResponse {
  resultJournal: boolean;
  maxActiveLanes: number;
}
