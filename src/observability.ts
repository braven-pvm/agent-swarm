import fs from "node:fs";
import path from "node:path";
import { buildDomainSummaries } from "./domains.js";
import { buildAgentFocusQueue, buildOverseerFocusQueue } from "./focus.js";
import { swarmDir } from "./paths.js";
import { reviewResultSchema, type ReviewResult } from "./schemas.js";
import { readSourceText } from "./source-adapter.js";
import {
  extractMarkdownSections,
  sourceDomain,
  sourceFrAcRefs,
  sourcePriority,
  sourceSections,
  sourceTags,
} from "./source-index.js";
import { SwarmStore } from "./storage.js";
import type { FrAcVerificationResult, RunMode, SliceRecord } from "./types.js";

export const RUN_MODE_META_KEY = "run_mode";
export const DEFAULT_RUN_MODE: RunMode = "unspecified";

export type LiveRunHistoryRecord = {
  runId: string;
  scenario?: string;
  runMode?: string;
  phase?: string;
  driver?: string;
  faultMode?: string;
  generatedAt?: string;
  startedAt?: string;
  finalOutcome?: string;
  finalReason?: string;
  classificationCode?: string;
  classificationSeverity?: string;
  sliceId?: string;
  finalSliceStatus?: string;
  counts?: Record<string, number>;
  summary: string;
  artifactIndex: string;
  artifactIndexMarkdown?: string;
  originalSummary?: string;
  originalArtifactIndex?: string;
  originalArtifactIndexMarkdown?: string;
};

export function defaultLiveRunHistoryRoot(workspace: string): string {
  const resolved = path.resolve(workspace);
  const parent = path.dirname(resolved);
  if (path.basename(parent).toLowerCase() === ".swarm-demo") {
    return path.join(parent, "live-agent-run-history");
  }
  return path.join(swarmDir(resolved), "run-history");
}

export function listLiveRunHistory(historyRoot: string): { historyRoot: string; exists: boolean; runs: LiveRunHistoryRecord[]; updatedAt?: string } {
  const root = path.resolve(historyRoot);
  const indexPath = path.join(root, "runs.json");
  if (!fs.existsSync(indexPath)) return { historyRoot: root, exists: false, runs: [] };
  const index = safeReadHistoryJson(root, indexPath) as { updatedAt?: string; runs?: LiveRunHistoryRecord[] };
  const runs = (index.runs ?? []).map((run) => ({ ...run })).sort((left, right) => String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")));
  return { historyRoot: root, exists: true, updatedAt: index.updatedAt, runs };
}

export function loadLiveRunHistoryDetail(
  historyRoot: string,
  runId: string,
): { historyRoot: string; record: LiveRunHistoryRecord; summary: Record<string, unknown>; artifactIndex: Record<string, unknown>; artifactIndexMarkdown?: string } | undefined {
  const root = path.resolve(historyRoot);
  const record = listLiveRunHistory(root).runs.find((run) => run.runId === runId);
  if (!record) return undefined;
  return {
    historyRoot: root,
    record,
    summary: safeReadHistoryJson(root, record.summary) as Record<string, unknown>,
    artifactIndex: safeReadHistoryJson(root, record.artifactIndex) as Record<string, unknown>,
    artifactIndexMarkdown: record.artifactIndexMarkdown ? safeReadHistoryText(root, record.artifactIndexMarkdown) : undefined,
  };
}

export function compareLiveRunHistory(historyRoot: string, leftId?: string, rightId?: string): Record<string, unknown> | undefined {
  const history = listLiveRunHistory(historyRoot);
  if (history.runs.length < 2 && (!leftId || !rightId)) return undefined;
  const selected = selectHistoryRuns(history.runs, leftId, rightId);
  if (!selected) return undefined;
  const leftDetail = loadLiveRunHistoryDetail(history.historyRoot, selected.left.runId);
  const rightDetail = loadLiveRunHistoryDetail(history.historyRoot, selected.right.runId);
  if (!leftDetail || !rightDetail) return undefined;
  const left = summarizeHistoryRun(leftDetail.summary, selected.left);
  const right = summarizeHistoryRun(rightDetail.summary, selected.right);
  const countKeys = ["turns", "verifyRuns", "lanes", "slices", "agentRuns", "evidence", "activeEscalations", "graphNodes", "graphEdges", "timelineItems"];
  const countDeltas = Object.fromEntries(countKeys.map((key) => [key, (right.counts[key] ?? 0) - (left.counts[key] ?? 0)]));
  const changes = {
    finalOutcomeChanged: left.finalOutcome !== right.finalOutcome,
    classificationChanged: left.classification.code !== right.classification.code,
    faultModeChanged: left.faultMode !== right.faultMode,
    phaseChanged: left.phase !== right.phase,
    finalSliceStatusChanged: left.finalSliceStatus !== right.finalSliceStatus,
  };
  return {
    generatedAt: new Date().toISOString(),
    historyRoot: history.historyRoot,
    mode: selected.mode,
    left,
    right,
    changes,
    deltas: {
      counts: countDeltas,
      finalOutcome: `${left.finalOutcome} -> ${right.finalOutcome}`,
      classification: `${left.classification.code} -> ${right.classification.code}`,
      faultMode: `${left.faultMode} -> ${right.faultMode}`,
    },
    artifacts: {
      leftSummary: selected.left.summary,
      rightSummary: selected.right.summary,
      leftArtifactIndex: selected.left.artifactIndex,
      rightArtifactIndex: selected.right.artifactIndex,
    },
    interpretation: interpretHistoryComparison(left, right, changes, countDeltas),
  };
}

export function selectHistoryRuns(
  runs: LiveRunHistoryRecord[],
  leftId?: string,
  rightId?: string,
): { left: LiveRunHistoryRecord; right: LiveRunHistoryRecord; mode: "latest-two" | "explicit" } | undefined {
  const sorted = [...runs].sort((left, right) => String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")));
  if (!leftId && !rightId) {
    const left = sorted.at(-2);
    const right = sorted.at(-1);
    return left && right ? { left, right, mode: "latest-two" } : undefined;
  }
  if (!leftId || !rightId) return undefined;
  const left = sorted.find((run) => run.runId === leftId);
  const right = sorted.find((run) => run.runId === rightId);
  return left && right ? { left, right, mode: "explicit" } : undefined;
}

export function summarizeHistoryRun(summary: Record<string, unknown>, record: LiveRunHistoryRecord) {
  const outcomeClassification = objectValue(summary.outcomeClassification);
  const fault = objectValue(summary.fault);
  return {
    runId: stringValue(summary.runId) ?? record.runId,
    scenario: stringValue(summary.scenario) ?? record.scenario,
    runMode: stringValue(summary.runMode) ?? record.runMode,
    phase: stringValue(summary.phase) ?? record.phase,
    driver: stringValue(summary.driver) ?? record.driver,
    faultMode: stringValue(fault?.mode) ?? record.faultMode,
    startedAt: stringValue(summary.startedAt) ?? record.startedAt,
    generatedAt: stringValue(summary.generatedAt) ?? record.generatedAt,
    finalOutcome: stringValue(summary.finalOutcome) ?? record.finalOutcome ?? "unknown",
    finalReason: stringValue(summary.finalReason) ?? record.finalReason,
    classification: {
      code: stringValue(outcomeClassification?.code) ?? record.classificationCode ?? "unknown",
      severity: stringValue(outcomeClassification?.severity) ?? record.classificationSeverity ?? "unknown",
      explanation: stringValue(outcomeClassification?.explanation),
    },
    sliceId: stringValue(summary.sliceId) ?? record.sliceId,
    finalSliceStatus: stringValue(summary.finalSliceStatus) ?? record.finalSliceStatus,
    counts: pickComparableHistoryCounts(objectValue(summary.counts) ?? record.counts),
  };
}

export function pickComparableHistoryCounts(counts: Record<string, unknown> | Record<string, number> | undefined): Record<string, number> {
  const keys = ["turns", "verifyRuns", "lanes", "slices", "agentRuns", "evidence", "activeEscalations", "graphNodes", "graphEdges", "timelineItems"];
  return Object.fromEntries(keys.map((key) => [key, numberValue(counts?.[key]) ?? 0]));
}

export function interpretHistoryComparison(
  left: ReturnType<typeof summarizeHistoryRun>,
  right: ReturnType<typeof summarizeHistoryRun>,
  changes: Record<string, boolean>,
  countDeltas: Record<string, number>,
): string {
  if (left.finalOutcome !== "accepted" && right.finalOutcome === "accepted") return "Run outcome improved to accepted.";
  if (left.finalOutcome === "accepted" && right.finalOutcome !== "accepted") {
    return "Run outcome moved away from accepted; inspect classification and blockers before treating this as progress.";
  }
  if (changes.classificationChanged) return "Outcome classification changed; inspect the archived summaries for the new stop reason.";
  if (Object.values(countDeltas).some((value) => value !== 0)) return "Lifecycle shape changed while outcome stayed comparable; inspect count deltas and artifact indexes.";
  return "No material outcome or lifecycle count changes detected.";
}

export function safeReadHistoryJson(historyRoot: string, filePath: string): unknown {
  return JSON.parse(safeReadHistoryText(historyRoot, filePath));
}

export function safeReadHistoryText(historyRoot: string, filePath: string): string {
  const root = path.resolve(historyRoot);
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) {
    throw new Error(`Archived run path escapes history root: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8");
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseOptionalPositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function buildSliceReport(store: SwarmStore, sliceId: string): string {
  const slice = store.listSlices().find((item) => item.id === sliceId);
  if (!slice) throw new Error(`Slice not found: ${sliceId}`);
  const lane = store.listLanes().find((item) => item.id === slice.laneId);
  const leases = store.listLeases().filter((lease) => lease.sliceId === slice.id);
  const evidence = store.listEvidence(slice.id);
  const escalations = store.listEscalations("active").filter((item) => item.entityId === slice.id);
  const frAcResults = latestFrAcResults(evidence);
  const reviewResult = latestReviewResult(evidence);
  const lines = [
    `# Slice Report: ${slice.title}`,
    "",
    `Status: ${slice.status}`,
    `Slice: ${slice.id}`,
    `Lane: ${lane ? `${lane.name} (${lane.id})` : slice.laneId}`,
    `Delivery question: ${slice.deliveryQuestion}`,
    `Work package: ${slice.workPackageType}`,
    `Minimum meaningful outcome: ${slice.minimumMeaningfulOutcome}`,
    ...(slice.acSizedExceptionReason ? [`AC-sized exception: ${slice.acSizedExceptionReason}`] : []),
    "",
    "Source refs:",
    ...slice.sourceRefs.map((source) => `- ${source.title ?? source.uri} (${source.uri})`),
    "",
    "FR/AC coverage:",
    ...slice.frAcRefs.map((ref) => {
      const result = frAcResults.find((item) => item.ref === ref);
      return result
        ? `- ${ref}: ${result.status} (${result.proof})`
        : `- ${ref}: unverified`;
    }),
    "",
    "Expected evidence:",
    ...slice.expectedEvidence.map((item) => `- ${item}`),
    "",
    "Unblock targets:",
    ...(slice.unblockTargets.length > 0 ? slice.unblockTargets.map((item) => `- ${item}`) : ["- none declared"]),
    "",
    "Leases:",
    ...(leases.length > 0 ? leases.map((lease) => `- ${lease.frAcRef}: ${lease.status}`) : ["- none"]),
    "",
    "Evidence:",
    ...(evidence.length > 0 ? evidence.map((item) => `- ${item.kind}: ${item.summary}${item.ref ? ` (${item.ref})` : ""}`) : ["- none"]),
    "",
    "Latest review:",
    ...(reviewResult
      ? [
          `- status: ${reviewResult.status}`,
          `- summary: ${reviewResult.summary}`,
          `- stub/hardcode risk: ${reviewResult.stubOrHardcodeRisk}`,
          `- quality gate: ${reviewResult.qualityGate.status} (${reviewResult.qualityGate.summary})`,
          ...(reviewResult.qualityGate.blockingConcerns.length > 0
            ? reviewResult.qualityGate.blockingConcerns.map((item) => `- quality blocker: ${item}`)
            : ["- quality blockers: none"]),
          ...(reviewResult.qualityGate.residualRisks.length > 0
            ? reviewResult.qualityGate.residualRisks.map((item) => `- residual quality risk: ${item}`)
            : ["- residual quality risks: none"]),
          ...reviewResult.qualityGate.dimensions.map(
            (dimension) =>
              `- quality ${dimension.dimension}: ${dimension.status}/${dimension.risk} (${dimension.finding})`,
          ),
          `- recommendation: ${reviewResult.recommendation}`,
          ...(reviewResult.requiredFixes.length > 0
            ? reviewResult.requiredFixes.map((item) => `- required fix: ${item}`)
            : ["- required fixes: none"]),
          ...reviewResult.frAcFindings.map((finding) => `- ${finding.ref}: ${finding.status} (${finding.finding})`),
        ]
      : ["- none"]),
    "",
    "Active escalations:",
    ...(escalations.length > 0 ? escalations.map((escalation) => `- ${escalation.level}: ${escalation.message}`) : ["- none"]),
    "",
    "Verification requirements:",
    ...slice.verificationRequirements.map((req) => `- ${req}`),
  ];
  return lines.join("\n");
}

export function latestFrAcResults(evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>): FrAcVerificationResult[] {
  const commandEvidence = evidence
    .filter((item) => item.kind === "command" && Array.isArray(item.payload.frAcResults))
    .at(-1);
  if (!commandEvidence) return [];
  return commandEvidence.payload.frAcResults as unknown as FrAcVerificationResult[];
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
  verification?: "passed" | "failed" | "missing_evidence" | "awaiting_human_verification" | "human_verified" | "human_input_required" | "overridden";
  obligation?: {
    status: "present" | "missing";
    mode?: string;
    responsibleParty?: string;
    criteriaCount: number;
    expectedOutcomes: string[];
  };
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
    probes?: { ui?: boolean; api?: boolean; markPaid?: boolean };
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

/**
 * Authoritative FR/AC requirement-coverage rollup.
 *
 * The denominator is every FR/AC ref indexed across all registered sources (incl.
 * requirements not yet pulled into any slice). Per-ref status is derived from the
 * owning slice's lease, verification (frAcResults) and review (frAcFindings) evidence.
 */
export function buildCoverage(store: SwarmStore): CoverageSummary {
  const slices = store.listSlices();
  const leases = store.listLeases();
  const sources = store.listSources();
  const lanes = store.listLanes();
  const targets = store.listTargets();
  const agentRuns = store.listAgentRuns();
  const activeEscalations = store.listEscalations("active");
  const dependencies = store.listDependencies();
  const events = store.listEvents();

  // 1. Inventory (denominator): de-duplicated map of every indexed FR/AC ref.
  //    First occurrence wins for domain/sourceId attribution — matches the
  //    `refsForSources` de-dupe semantics used by buildDomainSummaries.
  const inventory = new Map<
    string,
    {
      domain: string;
      sourceId: string;
      sourceTitle: string;
      sourceUri: string;
      sourceSectionId?: string;
      sourceSectionTitle?: string;
      sourceUpdatedAt: string;
    }
  >();
  for (const source of sources) {
    const domain = sourceDomain(source);
    const sections = sourceSections(source);
    for (const ref of sourceFrAcRefs(source)) {
      const section = sections.find((item) => item.refs.includes(ref));
      if (!inventory.has(ref)) {
        inventory.set(ref, {
          domain,
          sourceId: source.id,
          sourceTitle: source.title,
          sourceUri: source.uri,
          sourceSectionId: section?.id,
          sourceSectionTitle: section?.title,
          sourceUpdatedAt: source.updatedAt,
        });
      }
    }
  }

  // Cache the most-advanced owning slice per ref, plus that slice's evidence-derived
  // verification/review results (loaded once per slice, not once per ref).
  const evidenceCache = new Map<
    string,
    {
      evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>;
      frAcResults: FrAcVerificationResult[];
      reviewResult: ReviewResult | undefined;
    }
  >();
  const sliceEvidence = (sliceId: string) => {
    let cached = evidenceCache.get(sliceId);
    if (!cached) {
      const evidence = store.listEvidence(sliceId);
      cached = { evidence, frAcResults: latestFrAcResults(evidence), reviewResult: latestReviewResult(evidence) };
      evidenceCache.set(sliceId, cached);
    }
    return cached;
  };

  const refs: CoverageRef[] = [...inventory.entries()].map(([ref, attribution]) => {
    const owning = owningSliceForRef(slices, ref);
    if (!owning) {
      const relatedDependencies = dependencies.filter((item) => item.target === ref);
      const dependencyBlocks = relatedDependencies.some((item) => currentDependencyStatus(store, item) !== "satisfied");
      return {
        ref,
        domain: attribution.domain,
        sourceId: attribution.sourceId,
        sourceTitle: attribution.sourceTitle,
        sourceUri: attribution.sourceUri,
        sourceSectionId: attribution.sourceSectionId,
        sourceSectionTitle: attribution.sourceSectionTitle,
        status: "not_started" as const,
        statusReason: dependencyBlocks
          ? "Indexed from source but waiting for prerequisite dependency evidence before a slice can safely own it."
          : "Indexed from source but not currently owned by any slice.",
        nextAction: dependencyBlocks ? "wait_for_dependency" : "pull_slice",
        lastChangedAt: maxIso([attribution.sourceUpdatedAt, ...relatedDependencies.map((item) => item.updatedAt)]),
        dependencies: coverageDependencies(store, relatedDependencies),
        obligation: {
          status: "missing",
          criteriaCount: 0,
          expectedOutcomes: [],
        },
      };
    }
    const lease = leases
      .filter((item) => item.sliceId === owning.id && item.frAcRef === ref)
      .at(-1);
    const { evidence, frAcResults, reviewResult } = sliceEvidence(owning.id);
    const frAcResult = frAcResults.find((item) => item.ref === ref);
    const obligation = owning.verificationObligations.find((item) => item.ref === ref);
    const reviewFinding = reviewResult?.frAcFindings.find((item) => item.ref === ref);
    const lane = lanes.find((item) => item.id === owning.laneId);
    const target = targets.find((item) => item.id === owning.targetId);
    const relatedAgentRuns = agentRuns.filter((item) => item.sliceId === owning.id);
    const relatedEscalations = activeEscalations.filter(
      (item) => item.entityId === ref || item.entityId === owning.id || item.entityId === owning.laneId,
    );
    const relatedDependencies = dependencies.filter((item) => item.fromId === owning.id || item.target === ref);
    const relatedEvents = events.filter(
      (item) =>
        item.entityId === ref ||
        item.entityId === owning.id ||
        item.entityId === owning.laneId ||
        String(item.payload.sliceId ?? "") === owning.id,
    );
    const hasBlockingEscalation = relatedEscalations.some((item) =>
      ["blocker", "human_required", "critical"].includes(item.level),
    );

    let status: CoverageRef["status"];
    if (
      !hasBlockingEscalation &&
      (frAcResult?.status === "passed" || frAcResult?.status === "human_verified" || (lease?.status === "completed" && owning.status === "accepted"))
    ) {
      status = "done";
    } else if (frAcResult?.status === "failed" || reviewFinding?.status === "failed") {
      status = "failed";
    } else if (owning.status === "blocked" || hasBlockingEscalation) {
      status = "blocked";
    } else {
      status = "in_progress";
    }

    const coverageRef: CoverageRef = {
      ref,
      domain: attribution.domain,
      sourceId: attribution.sourceId,
      sourceTitle: attribution.sourceTitle,
      sourceUri: attribution.sourceUri,
      sourceSectionId: attribution.sourceSectionId,
      sourceSectionTitle: attribution.sourceSectionTitle,
      status,
      statusReason: coverageStatusReason({ status, slice: owning, lease, frAcResult, reviewFinding, relatedEscalations }),
      nextAction: coverageNextAction({ status, slice: owning, reviewResult, frAcResult, hasBlockingEscalation }),
      lastChangedAt: maxIso([
        attribution.sourceUpdatedAt,
        owning.updatedAt,
        lease?.updatedAt,
        ...evidence.map((item) => item.createdAt),
        ...relatedAgentRuns.map((item) => item.updatedAt),
        ...relatedEscalations.map((item) => item.updatedAt),
        ...relatedDependencies.map((item) => item.updatedAt),
        ...relatedEvents.map((item) => item.timestamp),
      ]),
      sliceId: owning.id,
      sliceStatus: owning.status,
      laneId: lane?.id,
      laneName: lane?.name,
      targetId: target?.id,
      targetName: target?.name,
      worktree: lane?.worktree,
      actors: coverageActors(relatedAgentRuns, frAcResult),
      activeEscalations: relatedEscalations.map((item) => ({
        level: item.level,
        entityId: item.entityId,
        message: item.message,
      })),
      dependencies: coverageDependencies(store, relatedDependencies),
      evidence: evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        summary: item.summary,
        createdAt: item.createdAt,
        ref: item.ref,
      })),
      humanVerificationPacket: latestHumanVerificationPacketLink(evidence, ref),
      obligation: obligation
        ? {
            status: "present",
            mode: obligation.mode,
            responsibleParty: obligation.responsibleParty,
            criteriaCount: obligation.criteria.length,
            expectedOutcomes: obligation.criteria.map((criterion) => criterion.expectedOutcome),
          }
        : {
            status: "missing",
            criteriaCount: 0,
            expectedOutcomes: [],
          },
    };
    if (frAcResult) {
      coverageRef.verification = frAcResult.status;
      coverageRef.proof = frAcResult.proof;
      coverageRef.evidenceIds = frAcResult.evidenceIds;
    }
    if (reviewFinding) {
      coverageRef.reviewStatus = reviewFinding.status;
      if (!coverageRef.proof && reviewFinding.finding) coverageRef.proof = reviewFinding.finding;
      if (!coverageRef.evidenceIds && reviewFinding.evidence.length > 0) coverageRef.evidenceIds = reviewFinding.evidence;
    }
    return coverageRef;
  });

  const generatedAt = new Date().toISOString();
  const ledger = buildRequirementLedger(refs, generatedAt);

  refs.sort((a, b) => a.domain.localeCompare(b.domain) || a.ref.localeCompare(b.ref));

  // 3. Aggregate totals + byDomain from the deduped refs.
  const totals = { total: refs.length, done: 0, inProgress: 0, blocked: 0, failed: 0, notStarted: 0 };
  const domains = new Map<string, CoverageDomain>();
  for (const ref of refs) {
    countCoverage(totals, ref.status);
    let domain = domains.get(ref.domain);
    if (!domain) {
      domain = { domain: ref.domain, total: 0, done: 0, inProgress: 0, blocked: 0, failed: 0, notStarted: 0 };
      domains.set(ref.domain, domain);
    }
    domain.total += 1;
    countCoverage(domain, ref.status);
  }
  const byDomain = [...domains.values()].sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain));

  const interpretation = buildCoverageInterpretation(totals, byDomain, refs);
  return { generatedAt, totals, interpretation, byDomain, refs, ledger };
}

const LEDGER_STATUSES: RequirementLedgerStatus[] = [
  "not_started",
  "planned",
  "in_progress",
  "implemented_unverified",
  "review_passed",
  "verified",
  "awaiting_human_verification",
  "human_verified",
  "human_input_required",
  "failed",
  "blocked",
  "accepted",
];

function buildRequirementLedger(refs: CoverageRef[], generatedAt: string): RequirementLedgerSummary {
  const byRef = new Map(refs.map((ref) => [ref.ref.toUpperCase(), ref]));
  const childrenByParent = new Map<string, CoverageRef[]>();

  for (const row of refs) {
    row.kind = requirementKind(row.ref);
    row.directStatus = row.status;
    row.parentRefs = [];
    row.childRefs = [];
  }

  for (const row of refs) {
    if (row.kind !== "ac") continue;
    const parentRef = inferredParentFrRef(row.ref);
    if (!parentRef || !byRef.has(parentRef.toUpperCase())) continue;
    row.parentRefs = [parentRef];
    const siblings = childrenByParent.get(parentRef.toUpperCase()) ?? [];
    siblings.push(row);
    childrenByParent.set(parentRef.toUpperCase(), siblings);
  }

  for (const [parentKey, children] of childrenByParent.entries()) {
    const parent = byRef.get(parentKey);
    if (parent) parent.childRefs = children.map((child) => child.ref).sort((a, b) => a.localeCompare(b));
  }

  for (const row of refs) {
    const directStatus = directLedgerStatus(row);
    row.ledgerStatus = directStatus;
    row.ledgerReason = directLedgerReason(row, directStatus);
    row.humanPath = requirementHumanPath(row, directStatus);
  }

  for (const [parentKey, children] of childrenByParent.entries()) {
    const parent = byRef.get(parentKey);
    if (!parent) continue;
    const rollup = buildParentRequirementRollup(parent, children);
    parent.rollup = rollup;
    parent.ledgerStatus = rollup.status;
    parent.ledgerReason = rollup.reason;
    parent.humanPath = requirementHumanPath(parent, rollup.status);
    parent.statusReason = rollup.reason;
    parent.status = coverageStatusFromLedgerStatus(rollup.status);
    parent.nextAction = nextActionFromLedgerStatus(parent.nextAction, rollup.status);
    parent.lastChangedAt = maxIso([parent.lastChangedAt, ...children.map((child) => child.lastChangedAt)]);
  }

  const entries = refs
    .map((row) => {
      const status = row.ledgerStatus ?? directLedgerStatus(row);
      const entry: RequirementLedgerEntry = {
        ref: row.ref,
        kind: row.kind ?? requirementKind(row.ref),
        status,
        reason: row.ledgerReason ?? directLedgerReason(row, status),
        coverageStatus: row.status,
        directStatus: row.directStatus ?? row.status,
        domain: row.domain,
        sourceId: row.sourceId,
        sourceTitle: row.sourceTitle,
        sourceUri: row.sourceUri,
        sliceId: row.sliceId,
        sliceStatus: row.sliceStatus,
        parentRefs: row.parentRefs ?? [],
        childRefs: row.childRefs ?? [],
        obligation: row.obligation,
        verification: row.verification,
        reviewStatus: row.reviewStatus,
        evidenceIds: row.evidenceIds,
        activeEscalations: row.activeEscalations,
        humanPath: row.humanPath ?? requirementHumanPath(row, status),
        rollup: row.rollup,
        lastChangedAt: row.lastChangedAt,
      };
      return entry;
    })
    .sort((a, b) => a.domain.localeCompare(b.domain) || a.ref.localeCompare(b.ref));

  const totals = emptyRequirementLedgerTotals();
  for (const entry of entries) {
    totals.total += 1;
    totals[entry.status] += 1;
  }

  return {
    generatedAt,
    totals,
    entries,
    rollups: entries.map((entry) => entry.rollup).filter((rollup): rollup is RequirementRollup => Boolean(rollup)),
  };
}

function emptyRequirementLedgerTotals(): RequirementLedgerSummary["totals"] {
  return {
    total: 0,
    not_started: 0,
    planned: 0,
    in_progress: 0,
    implemented_unverified: 0,
    review_passed: 0,
    verified: 0,
    awaiting_human_verification: 0,
    human_verified: 0,
    human_input_required: 0,
    failed: 0,
    blocked: 0,
    accepted: 0,
  };
}

function requirementKind(ref: string): RequirementKind {
  if (/^FR[-_]/i.test(ref)) return "fr";
  if (/^AC[-_]/i.test(ref)) return "ac";
  return "unknown";
}

function inferredParentFrRef(ref: string): string | undefined {
  const match = /^AC-(.+)-(\d+)(?:\.\d+)?$/i.exec(ref);
  if (!match) return undefined;
  return `FR-${match[1]}-${match[2]}`;
}

function directLedgerStatus(row: CoverageRef): RequirementLedgerStatus {
  if (row.verification === "human_input_required" || hasHumanRequiredEscalation(row)) return "human_input_required";
  if (row.verification === "human_verified") return row.sliceStatus === "accepted" || row.sliceStatus === "closed" ? "accepted" : "human_verified";
  if (row.verification === "awaiting_human_verification") return "awaiting_human_verification";
  if (row.verification === "failed" || row.reviewStatus === "failed" || row.status === "failed") return "failed";
  if (row.status === "blocked") return "blocked";
  if (row.status === "not_started") return "not_started";
  if (row.status === "done") {
    if (row.obligation?.mode === "human_verification_required" && row.verification !== "passed") {
      return "awaiting_human_verification";
    }
    if (row.sliceStatus === "accepted" || row.sliceStatus === "closed") return "accepted";
    return "verified";
  }
  if (row.reviewStatus === "passed") return "review_passed";
  if (row.verification === "missing_evidence") return "implemented_unverified";
  if (row.sliceStatus && ["candidate", "ready", "claimed"].includes(row.sliceStatus)) return "planned";
  if (row.sliceStatus && ["implemented", "verifying", "ready_for_review", "repairing"].includes(row.sliceStatus)) {
    return "implemented_unverified";
  }
  return "in_progress";
}

function directLedgerReason(row: CoverageRef, status: RequirementLedgerStatus): string {
  if (status === "accepted") return "Accepted by the owning slice after verifier/reviewer evidence satisfied the requirement.";
  if (status === "verified") return "Verifier evidence passed, but the owning slice has not reached final acceptance.";
  if (status === "human_verified") return "Human verification has been recorded for this requirement.";
  if (status === "awaiting_human_verification") {
    return "Implementation evidence exists or is expected, but the verification obligation requires human sign-off before acceptance.";
  }
  if (status === "human_input_required") return "Human input is required before this requirement can be safely implemented or verified.";
  if (status === "failed") return row.statusReason || "Verification or independent review failed for this requirement.";
  if (status === "blocked") return row.statusReason || "The requirement is blocked by an active escalation or dependency.";
  if (status === "implemented_unverified") return "Implementation has progressed, but requirement-level verification is not complete.";
  if (status === "review_passed") return "Independent review passed, but verifier or acceptance evidence is not final.";
  if (status === "planned") return "The requirement is included in a planned or claimed slice.";
  if (status === "in_progress") return row.statusReason || "The requirement is actively leased by a slice.";
  return row.statusReason || "The requirement is indexed but not currently owned by a slice.";
}

function requirementHumanPath(row: CoverageRef, status: RequirementLedgerStatus): RequirementHumanPath {
  if (status === "human_input_required") {
    return {
      state: "human_input_required",
      blocksAcceptance: true,
      reason: "The requirement needs clarification or an external decision; downstream dependent work must stay blocked.",
      responsibleParty: row.obligation?.responsibleParty,
      packet: row.humanVerificationPacket,
    };
  }
  if (status === "awaiting_human_verification" || row.obligation?.mode === "human_verification_required") {
    const accepted = status === "accepted" || status === "human_verified";
    return {
      state: "human_verification_required",
      blocksAcceptance: !accepted,
      reason: accepted
        ? "Human-verification requirement has been satisfied for this accepted ref."
        : "Human verification is required before this ref can be accepted.",
      responsibleParty: row.obligation?.responsibleParty,
      packet: row.humanVerificationPacket,
    };
  }
  return { state: "none", blocksAcceptance: false, reason: "No human-specific verification path is active." };
}

function latestHumanVerificationPacketLink(
  evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>,
  ref: string,
): HumanVerificationPacketLink | undefined {
  for (const item of [...evidence].reverse()) {
    if (item.kind !== "artifact") continue;
    if (item.ref && item.ref !== ref) continue;
    if (item.payload.type !== "human_verification_packet" && item.payload.type !== "human_verification_result") continue;
    const markdownPath = stringValue(item.payload.markdownPath);
    const jsonPath = stringValue(item.payload.jsonPath);
    if (!markdownPath || !jsonPath) continue;
    const status = stringValue(item.payload.status);
    return {
      evidenceId: item.id,
      markdownPath,
      jsonPath,
      status:
        status === "human_verified" || status === "failed" || status === "needs_rework"
          ? status
          : "awaiting_human_verification",
      generatedAt: stringValue(item.payload.generatedAt) ?? item.createdAt,
    };
  }
  return undefined;
}

function hasHumanRequiredEscalation(row: CoverageRef): boolean {
  return row.activeEscalations?.some((item) => item.level === "human_required") ?? false;
}

function buildParentRequirementRollup(parent: CoverageRef, children: CoverageRef[]): RequirementRollup {
  const directStatus = parent.directStatus ?? parent.status;
  const directLedger = directLedgerStatus({ ...parent, status: directStatus });
  const childStatuses = children.map((child) => child.ledgerStatus ?? directLedgerStatus(child));
  const childRollupStatus = combineLedgerStatuses(childStatuses);
  const hasDirectContract = Boolean(parent.sliceId || parent.obligation?.status === "present");
  const rule: RequirementRollup["rule"] = hasDirectContract ? "direct_and_children" : "children";
  const status = hasDirectContract ? combineLedgerStatuses([directLedger, ...childStatuses]) : childRollupStatus;
  const childStatusCounts = countLedgerStatuses(childStatuses);
  return {
    rule,
    status,
    reason: parentRollupReason({
      parent,
      rule,
      directLedger,
      childRollupStatus,
      status,
      children,
      childStatusCounts,
    }),
    directStatus,
    directLedgerStatus: directLedger,
    childRefs: children.map((child) => child.ref).sort((a, b) => a.localeCompare(b)),
    childStatusCounts,
  };
}

function combineLedgerStatuses(statuses: RequirementLedgerStatus[]): RequirementLedgerStatus {
  if (statuses.length === 0) return "not_started";
  if (statuses.every((status) => status === "accepted" || status === "human_verified")) return "accepted";
  if (statuses.every((status) => ["accepted", "verified", "human_verified"].includes(status))) return "verified";
  if (statuses.every((status) => status === "not_started")) return "not_started";
  if (statuses.some((status) => status === "human_input_required")) return "human_input_required";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "blocked")) return "blocked";
  if (statuses.some((status) => status === "awaiting_human_verification")) return "awaiting_human_verification";
  if (statuses.some((status) => status === "implemented_unverified")) return "implemented_unverified";
  if (statuses.some((status) => status === "review_passed")) return "review_passed";
  if (statuses.some((status) => status === "in_progress")) return "in_progress";
  if (statuses.some((status) => status === "planned")) return "planned";
  if (statuses.some((status) => status === "not_started")) return "in_progress";
  return "in_progress";
}

function countLedgerStatuses(statuses: RequirementLedgerStatus[]): Record<RequirementLedgerStatus, number> {
  const counts = Object.fromEntries(LEDGER_STATUSES.map((status) => [status, 0])) as Record<RequirementLedgerStatus, number>;
  for (const status of statuses) counts[status] += 1;
  return counts;
}

function parentRollupReason(input: {
  parent: CoverageRef;
  rule: RequirementRollup["rule"];
  directLedger: RequirementLedgerStatus;
  childRollupStatus: RequirementLedgerStatus;
  status: RequirementLedgerStatus;
  children: CoverageRef[];
  childStatusCounts: Record<RequirementLedgerStatus, number>;
}): string {
  const childCount = input.children.length;
  if (input.rule === "children") {
    if (input.status === "accepted") {
      return `Parent FR is treated as a container and rolls up from ${childCount} accepted child AC refs.`;
    }
    return `Parent FR is treated as a container; child AC rollup is ${input.childRollupStatus} across ${childCount} refs.`;
  }
  if (input.status === "accepted") {
    return `Parent FR has direct evidence and ${childCount} child AC refs; all required direct and child statuses are accepted.`;
  }
  return `Parent FR combines direct status ${input.directLedger} with child AC rollup ${input.childRollupStatus}; overall status is ${input.status}.`;
}

function coverageStatusFromLedgerStatus(status: RequirementLedgerStatus): CoverageStatus {
  if (status === "accepted" || status === "verified" || status === "human_verified") return "done";
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "human_input_required") return "blocked";
  if (status === "not_started") return "not_started";
  return "in_progress";
}

function nextActionFromLedgerStatus(existing: CoverageRef["nextAction"], status: RequirementLedgerStatus): CoverageRef["nextAction"] {
  if (status === "accepted" || status === "verified" || status === "human_verified") return "none";
  if (status === "human_input_required" || status === "blocked") return "resolve_blocker";
  if (status === "awaiting_human_verification") return "await_verification";
  if (status === "failed") return "repair_or_review";
  if (status === "not_started") return existing === "wait_for_dependency" ? existing : "pull_slice";
  return existing;
}

export function buildRunObservability(store: SwarmStore, workspace: string): RunObservabilitySummary {
  const coverage = buildCoverage(store);
  const slices = store.listSlices();
  const heartbeats = store.listHeartbeats();
  const activeEscalations = store.listEscalations("active");
  const summary = readLiveRunSummary(workspace);
  const productReadiness = objectValue(summary?.productReadiness) ?? readProductReadiness(workspace);
  const scenario = stringValue(summary?.scenario) ??
    [...heartbeats, ...activeEscalations]
      .map((item) => item.entityId)
      .find((id) => typeof id === "string" && id.startsWith("scenario:"))
      ?.slice("scenario:".length);
  const sliceCounts = countValues(slices.map((slice) => slice.status));
  const accepted = numberFromCount(sliceCounts.accepted);
  const active = slices.filter((slice) => !["accepted", "closed"].includes(slice.status)).length;
  const blocked = numberFromCount(sliceCounts.blocked);
  const coverageIncomplete = coverage.totals.total - coverage.totals.done;
  const outcome = summarizeRunOutcome(summary);
  const readiness = summarizeReadiness(productReadiness, summary);
  const outcomeVsCoverage = compareOutcomeToCoverage(outcome, coverage, readiness);
  const warnings = buildRunObservabilityWarnings(outcome, coverage, readiness, activeEscalations.length);

  return {
    generatedAt: new Date().toISOString(),
    workspace,
    runMode: currentRunMode(store),
    scenario,
    outcome,
    coverage: {
      totals: coverage.totals,
      completionPercent: coverage.interpretation.completionPercent,
      complete: coverage.interpretation.state === "complete",
      incomplete: coverageIncomplete,
      state: coverage.interpretation.state,
      headline: coverage.interpretation.headline,
      warning: coverage.interpretation.warning,
      byDomain: coverage.byDomain,
      topIncompleteDomains: coverage.interpretation.topIncompleteDomains,
    },
    productReadiness: readiness,
    slices: {
      total: slices.length,
      accepted,
      active,
      blocked,
      byStatus: sliceCounts,
    },
    outcomeVsCoverage,
    warnings,
    uiHints: buildRunObservabilityUiHints(outcome, coverage, readiness, outcomeVsCoverage, warnings),
  };
}

function owningSliceForRef(slices: SliceRecord[], ref: string): SliceRecord | undefined {
  const owners = slices.filter((slice) => slice.frAcRefs.includes(ref));
  if (owners.length === 0) return undefined;
  // Most-advanced wins: accepted slices first, otherwise most recently updated.
  return owners.sort((a, b) => {
    const acceptedDiff = (b.status === "accepted" ? 1 : 0) - (a.status === "accepted" ? 1 : 0);
    return acceptedDiff || b.updatedAt.localeCompare(a.updatedAt);
  })[0];
}

function countCoverage(
  bucket: { done: number; inProgress: number; blocked: number; failed: number; notStarted: number },
  status: CoverageRef["status"],
): void {
  if (status === "done") bucket.done += 1;
  else if (status === "in_progress") bucket.inProgress += 1;
  else if (status === "blocked") bucket.blocked += 1;
  else if (status === "failed") bucket.failed += 1;
  else bucket.notStarted += 1;
}

function buildCoverageInterpretation(
  totals: CoverageSummary["totals"],
  byDomain: CoverageDomain[],
  refs: CoverageRef[],
): CoverageInterpretation {
  const completionPercent = percent(totals.done, totals.total);
  const incomplete = totals.total - totals.done;
  const state: CoverageInterpretation["state"] =
    totals.total === 0 ? "empty" : incomplete === 0 ? "complete" : "partial";
  const nextActionCounts = countValues(
    refs
      .filter((ref) => ref.status !== "done" && ref.nextAction !== "none")
      .map((ref) => ref.nextAction),
  );
  const nextActions = Object.entries(nextActionCounts)
    .map(([action, count]) => ({
      action: action as CoverageRef["nextAction"],
      count,
      label: actionLabel(action as CoverageRef["nextAction"]),
    }))
    .sort((left, right) => right.count - left.count || left.action.localeCompare(right.action));
  const topIncompleteDomains = byDomain
    .map((domain) => ({
      ...domain,
      incomplete: domain.total - domain.done,
      completionPercent: percent(domain.done, domain.total),
    }))
    .filter((domain) => domain.incomplete > 0)
    .sort((left, right) => right.incomplete - left.incomplete || left.domain.localeCompare(right.domain))
    .slice(0, 5);

  if (state === "empty") {
    return {
      completionPercent,
      state,
      headline: "No requirements indexed",
      detail: "The harness has no registered FR/AC refs to measure yet.",
      nextActions,
      topIncompleteDomains,
    };
  }
  if (state === "complete") {
    return {
      completionPercent,
      state,
      headline: `All ${totals.total} indexed requirements are done`,
      detail: "Every indexed FR/AC ref is owned by accepted work with verification evidence.",
      nextActions,
      topIncompleteDomains,
    };
  }
  return {
    completionPercent,
    state,
    headline: `${totals.done}/${totals.total} indexed requirements done`,
    detail: `${incomplete} indexed FR/AC refs are not done yet: ${totals.inProgress} in progress, ${totals.blocked} blocked, ${totals.failed} failed, ${totals.notStarted} not started.`,
    warning: "Coverage is partial even if a selected smoke run or readiness gate is accepted.",
    nextActions,
    topIncompleteDomains,
  };
}

function readLiveRunSummary(workspace: string): Record<string, unknown> | undefined {
  return safeReadWorkspaceJson(path.resolve(workspace), path.join(path.resolve(workspace), "live-agent-run-summary.json"));
}

function readProductReadiness(workspace: string): Record<string, unknown> | undefined {
  return safeReadWorkspaceJson(path.resolve(workspace), path.join(path.resolve(workspace), "live-agent-run-artifacts", "product-readiness.json"));
}

function safeReadWorkspaceJson(workspace: string, filePath: string): Record<string, unknown> | undefined {
  const root = path.resolve(workspace);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) return undefined;
  if (!fs.existsSync(resolved)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function summarizeRunOutcome(summary: Record<string, unknown> | undefined): RunObservabilitySummary["outcome"] {
  if (!summary) {
    return {
      available: false,
      source: "harness-state",
      accepted: false,
      classification: {
        code: "unknown",
        severity: "neutral",
        explanation: "No finalized live-agent run summary artifact exists in this workspace yet.",
      },
    };
  }
  const classification = objectValue(summary.outcomeClassification);
  const fault = objectValue(summary.fault);
  return {
    available: true,
    source: "live-summary",
    runId: stringValue(summary.runId),
    finalOutcome: stringValue(summary.finalOutcome),
    finalReason: stringValue(summary.finalReason),
    accepted: stringValue(summary.finalOutcome) === "accepted",
    classification: {
      code: stringValue(classification?.code),
      severity: stringValue(classification?.severity),
      explanation: stringValue(classification?.explanation),
    },
    generatedAt: stringValue(summary.generatedAt),
    phase: stringValue(summary.phase),
    faultMode: stringValue(fault?.mode),
    counts: numericRecord(objectValue(summary.counts)),
    artifacts: stringRecord(objectValue(summary.artifacts)),
  };
}

function summarizeReadiness(
  readiness: Record<string, unknown> | undefined,
  summary: Record<string, unknown> | undefined,
): RunObservabilitySummary["productReadiness"] {
  if (!readiness) {
    return {
      available: false,
      acceptedRefs: [],
      blockers: [],
      artifacts: stringRecord(objectValue(summary?.artifacts)),
    };
  }
  const dependencyGate = objectValue(readiness.dashboardDependencies);
  const checks = arrayValue(readiness.checks).map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item));
  const blockers = arrayValue(readiness.blockers).map(objectValue).filter((item): item is Record<string, unknown> => Boolean(item));
  const commandResults = objectValue(readiness.commandResults);
  const start = objectValue(commandResults?.start);
  const probes = objectValue(start?.probes);
  const uiProbe = objectValue(probes?.ui);
  const apiProbe = objectValue(probes?.api);
  const markPaidProbe = objectValue(probes?.markPaid);
  const productSlices = objectValue(readiness.productReadinessSlices);
  const productSliceIds = arrayValue(productSlices?.ids)
    .map(objectValue)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const acceptedRefs = unique(
    productSliceIds
      .filter((item) => stringValue(item.status) === "accepted")
      .flatMap((item) => stringArray(item.refs)),
  );
  return {
    available: true,
    passed: readiness.passed === true,
    productName: stringValue(readiness.productName),
    manualUrl: stringValue(objectValue(readiness.commands)?.manualUrl),
    acceptedRefs,
    dependencyGate: dependencyGate
      ? {
          satisfied: dependencyGate.satisfied === true,
          declaredRefs: stringArray(dependencyGate.dependsOn),
          acceptedRefs: stringArray(dependencyGate.acceptedRefs),
          missingRefs: stringArray(dependencyGate.missingRefs),
        }
      : undefined,
    checks: {
      total: checks.length,
      passed: checks.filter((check) => check.passed === true).length,
      failed: checks.filter((check) => check.passed !== true).length,
    },
    blockers: blockers.map((blocker) => ({
      id: stringValue(blocker.id),
      label: stringValue(blocker.label),
      message: stringValue(blocker.message),
      severity: stringValue(blocker.severity),
    })),
    probes: {
      ui: uiProbe?.passed === true,
      api: apiProbe?.passed === true,
      markPaid: markPaidProbe?.passed === true,
    },
    artifacts: stringRecord(objectValue(summary?.artifacts)),
  };
}

function compareOutcomeToCoverage(
  outcome: RunObservabilitySummary["outcome"],
  coverage: CoverageSummary,
  readiness: RunObservabilitySummary["productReadiness"],
): RunObservabilitySummary["outcomeVsCoverage"] {
  const coverageComplete = coverage.interpretation.state === "complete";
  const readinessState = readiness.available ? (readiness.passed ? "passed" : "not passed") : "unknown";
  if (!outcome.available) {
    return {
      state: "unknown",
      severity: "neutral",
      headline: "No finalized run outcome is available",
      detail: "The UI should show live harness state without implying the latest run has completed.",
      truthRows: truthRows(outcome, coverage, readinessState),
    };
  }
  if (outcome.accepted && coverageComplete) {
    return {
      state: "accepted_complete",
      severity: "success",
      headline: "Run accepted and indexed requirements are complete",
      detail: "The latest run outcome and full FR/AC coverage agree.",
      truthRows: truthRows(outcome, coverage, readinessState),
    };
  }
  if (outcome.accepted) {
    return {
      state: "accepted_partial",
      severity: "warning",
      headline: "Run accepted for selected scope; full requirement coverage is still partial",
      detail: `${coverage.totals.done}/${coverage.totals.total} indexed refs are done. Treat the accepted run as proof of its selected slices and readiness gate, not proof that every registered requirement is complete.`,
      truthRows: truthRows(outcome, coverage, readinessState),
    };
  }
  return {
    state: "not_accepted",
    severity: outcome.finalOutcome === "human_required" ? "danger" : "warning",
    headline: `Run outcome is ${outcome.finalOutcome ?? "not accepted"}`,
    detail: outcome.finalReason ?? outcome.classification?.explanation ?? "Inspect active blockers, review findings, and coverage gaps.",
    truthRows: truthRows(outcome, coverage, readinessState),
  };
}

function truthRows(
  outcome: RunObservabilitySummary["outcome"],
  coverage: CoverageSummary,
  readinessState: string,
): RunObservabilitySummary["outcomeVsCoverage"]["truthRows"] {
  const coverageComplete = coverage.interpretation.state === "complete";
  return [
    {
      label: "Run outcome",
      state: outcome.finalOutcome ?? "unknown",
      meaning: outcome.available
        ? "Outcome of the latest bounded smoke/harness run."
        : "No completed run artifact has been written for this workspace.",
      severity: outcome.accepted ? "success" : outcome.available ? "warning" : "neutral",
    },
    {
      label: "Requirement coverage",
      state: coverage.interpretation.state,
      meaning: `${coverage.totals.done}/${coverage.totals.total} indexed FR/AC refs are done.`,
      severity: coverageComplete ? "success" : "warning",
    },
    {
      label: "Product readiness",
      state: readinessState,
      meaning: "Final runnable-product gate: local start, test command, browser/API probe, and readiness blockers.",
      severity: readinessState === "passed" ? "success" : readinessState === "unknown" ? "neutral" : "warning",
    },
  ];
}

function buildRunObservabilityWarnings(
  outcome: RunObservabilitySummary["outcome"],
  coverage: CoverageSummary,
  readiness: RunObservabilitySummary["productReadiness"],
  activeEscalationCount: number,
): string[] {
  const warnings: string[] = [];
  if (outcome.accepted && coverage.interpretation.state === "partial") {
    warnings.push("Latest run is accepted, but indexed requirement coverage is partial.");
  }
  if (readiness.passed && coverage.interpretation.state === "partial") {
    warnings.push("Product readiness passed for the selected readiness refs; broader product/source refs remain not done.");
  }
  if (activeEscalationCount > 0) warnings.push(`${activeEscalationCount} active escalation(s) remain visible in harness state.`);
  if (!outcome.available) warnings.push("No finalized run summary artifact is available yet.");
  return warnings;
}

function buildRunObservabilityUiHints(
  outcome: RunObservabilitySummary["outcome"],
  coverage: CoverageSummary,
  readiness: RunObservabilitySummary["productReadiness"],
  outcomeVsCoverage: RunObservabilitySummary["outcomeVsCoverage"],
  warnings: string[],
): RunObservabilitySummary["uiHints"] {
  const badges: RunObservabilitySummary["uiHints"]["badges"] = [
    {
      label: "run",
      value: outcome.finalOutcome ?? "unknown",
      tone: outcome.accepted ? "success" : outcome.available ? "warning" : "neutral",
      tooltip: "Latest bounded run outcome from the run summary artifact.",
    },
    {
      label: "coverage",
      value: `${coverage.totals.done}/${coverage.totals.total}`,
      tone: coverage.interpretation.state === "complete" ? "success" : coverage.interpretation.state === "partial" ? "warning" : "neutral",
      tooltip: "Authoritative indexed FR/AC coverage across registered sources.",
    },
    {
      label: "readiness",
      value: readiness.available ? (readiness.passed ? "passed" : "not passed") : "unknown",
      tone: readiness.passed ? "success" : readiness.available ? "warning" : "neutral",
      tooltip: "Final runnable-product readiness gate.",
    },
  ];
  return {
    badges,
    callouts: [
      {
        tone: outcomeVsCoverage.severity,
        title: outcomeVsCoverage.headline,
        detail: outcomeVsCoverage.detail,
      },
      ...warnings.map((warning) => ({
        tone: "warning" as const,
        title: "Observability warning",
        detail: warning,
      })),
    ],
    recommendedPrimaryView: coverage.interpretation.state === "partial" ? "coverage" : outcome.available ? "history" : "bridge",
  };
}

function actionLabel(action: CoverageRef["nextAction"]): string {
  return action.replaceAll("_", " ");
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((100 * numerator) / denominator) : 0;
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function numberFromCount(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function numericRecord(value: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, numberValue(item)] as const)
      .filter((entry): entry is readonly [string, number] => typeof entry[1] === "number"),
  );
}

function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, stringValue(item)] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
  );
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => typeof item === "string");
}

function coverageStatusReason(input: {
  status: CoverageRef["status"];
  slice: SliceRecord;
  lease?: ReturnType<SwarmStore["listLeases"]>[number];
  frAcResult?: FrAcVerificationResult;
  reviewFinding?: ReviewResult["frAcFindings"][number];
  relatedEscalations: ReturnType<SwarmStore["listEscalations"]>;
}): string {
  const blocking = input.relatedEscalations.find((item) =>
    ["blocker", "human_required", "critical"].includes(item.level),
  );
  if (blocking) return `${blocking.level} escalation is active: ${blocking.message}`;
  if (input.frAcResult?.status === "passed") return `Passed deterministic verification: ${input.frAcResult.proof}`;
  if (input.frAcResult?.status === "failed") return `Failed deterministic verification: ${input.frAcResult.proof}`;
  if (input.reviewFinding?.status === "failed") return `Independent review failed: ${input.reviewFinding.finding}`;
  if (input.reviewFinding?.status === "missing_evidence") return `Independent review is missing evidence: ${input.reviewFinding.finding}`;
  if (input.slice.status === "accepted" && input.lease?.status === "completed") {
    return "Owning slice is accepted and the FR/AC lease is completed.";
  }
  if (input.slice.status === "blocked") return "Owning slice is blocked.";
  if (input.slice.status === "ready") return "Owning slice is ready and waiting for worker dispatch.";
  if (input.slice.status === "implementing") return "Owning slice is currently being implemented.";
  if (input.slice.status === "implemented" || input.slice.status === "ready_for_review") {
    return "Worker implementation is present and waiting for independent review or deterministic verification.";
  }
  if (input.slice.status === "repairing") return "Owning slice is in repair after review or verification feedback.";
  if (input.slice.status === "verifying") return "Owning slice is currently being verified.";
  return `Owning slice is ${input.slice.status}.`;
}

function coverageNextAction(input: {
  status: CoverageRef["status"];
  slice: SliceRecord;
  reviewResult?: ReviewResult;
  frAcResult?: FrAcVerificationResult;
  hasBlockingEscalation: boolean;
}): CoverageRef["nextAction"] {
  if (input.status === "done") return "none";
  if (input.status === "failed") return "repair_or_review";
  if (input.hasBlockingEscalation || input.slice.status === "blocked") return "resolve_blocker";
  if (input.slice.status === "ready" || input.slice.status === "candidate" || input.slice.status === "claimed") return "run_worker";
  if (input.slice.status === "implementing") return "await_worker_result";
  if (input.slice.status === "implemented" || input.slice.status === "ready_for_review") {
    if (!input.reviewResult) return "run_reviewer";
    if (input.reviewResult.status !== "accepted") return "repair_or_review";
    if (!input.frAcResult || input.frAcResult.status === "missing_evidence") return "run_verifier";
    return "inspect_accepted_state";
  }
  if (input.slice.status === "verifying") return "await_verification";
  if (input.slice.status === "repairing") return "repair_or_review";
  if (input.slice.status === "accepted") return "inspect_accepted_state";
  return "pull_slice";
}

function coverageActors(
  agentRuns: ReturnType<SwarmStore["listAgentRuns"]>,
  frAcResult?: FrAcVerificationResult,
): CoverageRef["actors"] {
  return {
    workers: unique(agentRuns.filter((item) => item.role === "worker").map((item) => item.actor)),
    reviewers: unique(agentRuns.filter((item) => item.role === "reviewer").map((item) => item.actor)),
    verifiers: unique([
      ...agentRuns.filter((item) => item.role === "verifier").map((item) => item.actor),
      ...(frAcResult?.verifiedBy ? [frAcResult.verifiedBy] : []),
    ]),
    overseers: unique(agentRuns.filter((item) => item.role === "overseer").map((item) => item.actor)),
  };
}

function coverageDependencies(
  store: SwarmStore,
  dependencies: ReturnType<SwarmStore["listDependencies"]>,
): CoverageRef["dependencies"] {
  return dependencies.map((item) => ({
    target: item.target,
    status: currentDependencyStatus(store, item),
    reason: item.reason,
    fromId: item.fromId,
  }));
}

function maxIso(values: Array<string | undefined>): string {
  const normalized = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (normalized.length === 0) return new Date(0).toISOString();
  return normalized.sort((a, b) => b.localeCompare(a))[0];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildObservabilitySnapshot(store: SwarmStore, workspace: string, eventCount: number) {
  const slices = store.listSlices();
  const leases = store.listLeases();
  const evidence = store.listEvidence();
  const heartbeats = store.listHeartbeats();
  const activeEscalations = store.listEscalations("active");
  const scenario = [...heartbeats, ...activeEscalations]
    .map((x) => x.entityId)
    .find((id) => typeof id === "string" && id.startsWith("scenario:"))
    ?.slice("scenario:".length);
  const snapshot = {
    workspace,
    runMode: currentRunMode(store),
    generatedAt: new Date().toISOString(),
    scenario,
    targets: store.listTargets(),
    sources: store.listSources(),
    domains: buildDomainSummaries(store),
    lanes: store.listLanes().map((lane) => ({
      ...lane,
      activeLeases: leases.filter((lease) => lease.laneId === lane.id && lease.status === "active").map((lease) => lease.frAcRef),
    })),
    slices: slices.map((slice) => ({
      ...slice,
      leases: leases.filter((lease) => lease.sliceId === slice.id),
      evidence: evidence.filter((item) => item.sliceId === slice.id),
      frAcResults: latestFrAcResults(evidence.filter((item) => item.sliceId === slice.id)),
      reviewResult: latestReviewResult(evidence.filter((item) => item.sliceId === slice.id)),
      agentRuns: store.listAgentRuns().filter((run) => run.sliceId === slice.id),
    })),
    dependencies: store.listDependencies().map((dependency) => ({
      ...dependency,
      status: currentDependencyStatus(store, dependency),
    })),
    agentRuns: store.listAgentRuns(),
    heartbeats,
    activeEscalations,
    checkpoints: store.listCheckpoints(),
    recentEvents: store.recentEvents(eventCount),
    runObservability: buildRunObservability(store, workspace),
  };
  // Focus queue (triage) — computed from the assembled snapshot's active slices.
  // Runs buildSliceFocusPacket for each active slice with the overseer's modest
  // limits; a focus failure must never break the snapshot, so default to [].
  let focusQueue: ReturnType<typeof buildOverseerFocusQueue> = [];
  let agentFocusQueue: ReturnType<typeof buildAgentFocusQueue> = [];
  try {
    focusQueue = buildOverseerFocusQueue({
      store,
      workspace,
      snapshot: { slices: snapshot.slices },
      cli: focusCli(),
    });
    agentFocusQueue = buildAgentFocusQueue({
      store,
      workspace,
      cli: focusCli(),
    });
  } catch {
    focusQueue = [];
    agentFocusQueue = [];
  }
  return { ...snapshot, focusQueue, agentFocusQueue };
}

function focusCli(): string {
  return `node "${process.argv[1] ?? "dist/cli.js"}"`;
}

export function findSource(store: SwarmStore, selector: string) {
  const raw = selector.toLowerCase();
  const normalized = path.resolve(selector).toLowerCase();
  return store.listSources().find(
    (source) =>
      source.id.toLowerCase() === raw ||
      source.title.toLowerCase() === raw ||
      source.uri.toLowerCase() === raw ||
      source.uri.toLowerCase() === normalized ||
      path.basename(source.uri).toLowerCase() === raw,
  );
}

export function searchSpecSections(
  store: SwarmStore,
  query: string,
  options: { domain?: string; tag?: string; source?: string; limit: number },
): Array<{
  source: ReturnType<SwarmStore["listSources"]>[number];
  section: ReturnType<typeof sourceSections>[number];
  score: number;
  snippet: string;
}> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return [];
  return store
    .listSources()
    .filter((source) => !options.domain || sourceDomain(source).toLowerCase() === options.domain.toLowerCase())
    .filter((source) => !options.tag || sourceTags(source).map((tag) => tag.toLowerCase()).includes(options.tag.toLowerCase()))
    .filter((source) => !options.source || sourceMatchesSelector(source, options.source))
    .flatMap((source) => {
      const text = readSourceText(source);
      const sections = sourceSections(source).length > 0 ? sourceSections(source) : extractMarkdownSections(text, source.id);
      return sections
        .map((section) => {
          const haystack = [
            source.title,
            sourceDomain(source),
            ...sourceTags(source),
            section.title,
            section.snippet,
            ...section.refs,
          ]
            .join(" ")
            .toLowerCase();
          const score = terms.reduce((total, term) => total + countOccurrences(haystack, term), 0);
          return {
            source,
            section,
            score,
            snippet: highlightSnippet(section.snippet || section.title, terms),
          };
        })
        .filter((match) => match.score > 0);
    })
    .sort((a, b) => b.score - a.score || sourcePriority(a.source) - sourcePriority(b.source))
    .slice(0, options.limit);
}

export function sourceMatchesSelector(source: ReturnType<SwarmStore["listSources"]>[number], selector: string): boolean {
  const raw = selector.toLowerCase();
  const normalized = path.resolve(selector).toLowerCase();
  return (
    source.id.toLowerCase() === raw ||
    source.title.toLowerCase() === raw ||
    source.uri.toLowerCase() === raw ||
    source.uri.toLowerCase() === normalized ||
    path.basename(source.uri).toLowerCase() === raw
  );
}

export function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

export function highlightSnippet(value: string, terms: string): string;
export function highlightSnippet(value: string, terms: string[]): string;
export function highlightSnippet(value: string, terms: string | string[]): string {
  const termList = Array.isArray(terms) ? terms : [terms];
  const lower = value.toLowerCase();
  const firstIndex = termList
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (firstIndex === undefined) return value.slice(0, 220);
  const start = Math.max(0, firstIndex - 80);
  return `${start > 0 ? "..." : ""}${value.slice(start, start + 220)}${start + 220 < value.length ? "..." : ""}`;
}

export function parseRunMode(value: string): RunMode {
  const allowed: RunMode[] = ["unspecified", "fixture", "scripted-codex", "live-agent-smoke"];
  if (!allowed.includes(value as RunMode)) {
    throw new Error(`Invalid run mode: ${value}. Expected ${allowed.join(", ")}.`);
  }
  return value as RunMode;
}

export function currentRunMode(store: SwarmStore): RunMode {
  const value = store.getMeta(RUN_MODE_META_KEY);
  return value ? parseRunMode(value) : DEFAULT_RUN_MODE;
}

export function latestReviewResult(evidence: Array<ReturnType<SwarmStore["listEvidence"]>[number]>): ReviewResult | undefined {
  const reviewEvidence = evidence
    .filter((item) => item.kind === "review_result" && item.payload.reviewResult)
    .at(-1);
  if (!reviewEvidence) return undefined;
  const parsed = reviewResultSchema.safeParse(reviewEvidence.payload.reviewResult);
  return parsed.success ? parsed.data : undefined;
}

export function buildTimeline(store: SwarmStore, entityId: string): {
  entityId: string;
  entityType?: string;
  items: Array<{
    timestamp: string;
    kind: string;
    label: string;
    actor?: string;
    detail?: string;
    payload?: Record<string, unknown>;
  }>;
} {
  const slices = store.listSlices();
  const lanes = store.listLanes();
  const leases = store.listLeases();
  const evidence = store.listEvidence();
  const heartbeats = store.listHeartbeats();
  const escalations = store.listEscalations();
  const dependencies = store.listDependencies();
  const relatedSliceIds = new Set<string>();
  const relatedLaneIds = new Set<string>();
  const relatedRefs = new Set<string>();

  const directSlice = slices.find((slice) => slice.id === entityId);
  const directLane = lanes.find((lane) => lane.id === entityId);
  if (directSlice) {
    relatedSliceIds.add(directSlice.id);
    relatedLaneIds.add(directSlice.laneId);
    for (const ref of directSlice.frAcRefs) relatedRefs.add(ref);
  } else if (directLane) {
    relatedLaneIds.add(directLane.id);
    for (const slice of slices.filter((item) => item.laneId === directLane.id)) {
      relatedSliceIds.add(slice.id);
      for (const ref of slice.frAcRefs) relatedRefs.add(ref);
    }
  } else {
    for (const lease of leases.filter((item) => item.frAcRef === entityId)) {
      relatedSliceIds.add(lease.sliceId);
      relatedLaneIds.add(lease.laneId);
      relatedRefs.add(lease.frAcRef);
    }
  }

  const items = [
    ...slices
      .filter((slice) => relatedSliceIds.has(slice.id))
      .flatMap((slice) => [
        {
          timestamp: slice.createdAt,
          kind: "slice",
          label: `${slice.id} created`,
          detail: `${slice.title} [${slice.status}]`,
        },
        {
          timestamp: slice.updatedAt,
          kind: "slice",
          label: `${slice.id} updated`,
          detail: `status ${slice.status}`,
        },
      ]),
    ...lanes
      .filter((lane) => relatedLaneIds.has(lane.id))
      .map((lane) => ({
        timestamp: lane.createdAt,
        kind: "lane",
        label: `${lane.id} ${lane.name}`,
        detail: `${lane.state}; ${lane.purpose}`,
      })),
    ...leases
      .filter((lease) => relatedSliceIds.has(lease.sliceId) || relatedRefs.has(lease.frAcRef))
      .map((lease) => ({
        timestamp: lease.updatedAt,
        kind: "lease",
        label: lease.frAcRef,
        detail: `${lease.status} via ${lease.sliceId}`,
      })),
    ...dependencies
      .filter((dependency) => relatedSliceIds.has(dependency.fromId) || relatedLaneIds.has(dependency.fromId) || dependency.target === entityId)
      .map((dependency) => ({
        timestamp: dependency.updatedAt,
        kind: "dependency",
        label: dependency.target,
        detail: `${dependency.status}; ${dependency.reason}`,
      })),
    ...evidence
      .filter((item) => relatedSliceIds.has(item.sliceId))
      .map((item) => ({
        timestamp: item.createdAt,
        kind: "evidence",
        label: `${item.kind} for ${item.sliceId}`,
        detail: item.summary,
        payload: item.payload,
      })),
    ...heartbeats
      .filter((heartbeat) => heartbeat.entityId && (heartbeat.entityId === entityId || relatedSliceIds.has(heartbeat.entityId) || relatedLaneIds.has(heartbeat.entityId)))
      .map((heartbeat) => ({
        timestamp: heartbeat.timestamp,
        kind: "heartbeat",
        actor: heartbeat.actor,
        label: heartbeat.state,
        detail: heartbeat.detail,
      })),
    ...escalations
      .filter((escalation) => escalation.entityId === entityId || relatedSliceIds.has(escalation.entityId) || relatedLaneIds.has(escalation.entityId))
      .map((escalation) => ({
        timestamp: escalation.updatedAt,
        kind: "escalation",
        actor: escalation.createdBy,
        label: `${escalation.level} ${escalation.status}`,
        detail: escalation.message,
      })),
    ...store
      .listEvents()
      .filter(
        (event) =>
          event.entityId === entityId ||
          relatedSliceIds.has(event.entityId) ||
          relatedLaneIds.has(event.entityId) ||
          relatedSliceIds.has(String(event.payload.sliceId ?? "")),
      )
      .map((event) => ({
        timestamp: event.timestamp,
        kind: "event",
        actor: event.actor,
        label: `${event.type} ${event.entityType}:${event.entityId}`,
        payload: event.payload,
      })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    entityId,
    entityType: directSlice ? "slice" : directLane ? "lane" : relatedRefs.has(entityId) ? "fr_ac_ref" : undefined,
    items,
  };
}

export function buildGraph(store: SwarmStore): {
  nodes: Array<{ id: string; type: string; label: string; status?: string }>;
  edges: Array<{ from: string; to: string; type: string; label?: string; status?: string }>;
} {
  const targets = store.listTargets();
  const sources = store.listSources();
  const lanes = store.listLanes();
  const slices = store.listSlices();
  const leases = store.listLeases();
  const dependencies = store.listDependencies();
  const evidence = store.listEvidence();
  const heartbeats = store.listHeartbeats();
  const events = store.listEvents();
  const nodes = new Map<string, { id: string; type: string; label: string; status?: string }>();
  const edges: Array<{ from: string; to: string; type: string; label?: string; status?: string }> = [];

  for (const target of targets) nodes.set(target.id, { id: target.id, type: "target", label: target.name });
  for (const source of sources) {
    const domainId = `domain:${sourceDomain(source)}`;
    nodes.set(domainId, { id: domainId, type: "domain", label: sourceDomain(source) });
    nodes.set(source.id, { id: source.id, type: "source", label: source.title });
    edges.push({ from: domainId, to: source.id, type: "domain_source", label: "contains" });
    for (const section of sourceSections(source)) {
      nodes.set(section.id, { id: section.id, type: "source_section", label: section.title });
      edges.push({ from: source.id, to: section.id, type: "source_section", label: `lines ${section.startLine}-${section.endLine}` });
      for (const ref of section.refs) {
        setFrAcNode(nodes, store, ref);
        edges.push({ from: section.id, to: ref, type: "section_ref", label: "defines" });
      }
    }
    for (const ref of sourceFrAcRefs(source)) {
      setFrAcNode(nodes, store, ref);
      edges.push({ from: source.id, to: ref, type: "source_ref", label: "indexes" });
    }
  }
  for (const lane of lanes) {
    nodes.set(lane.id, { id: lane.id, type: "lane", label: lane.name, status: lane.state });
    edges.push({ from: lane.targetId, to: lane.id, type: "target_lane", label: "hosts" });
  }
  for (const slice of slices) {
    nodes.set(slice.id, { id: slice.id, type: "slice", label: slice.title, status: slice.status });
    edges.push({ from: slice.laneId, to: slice.id, type: "lane_slice", label: "contains" });
    for (const sourceRef of slice.sourceRefs) {
      const source = sources.find((item) => item.uri === sourceRef.uri);
      if (source) edges.push({ from: source.id, to: slice.id, type: "source_slice", label: "served" });
    }
    for (const ref of slice.frAcRefs) {
      setFrAcNode(nodes, store, ref);
      edges.push({ from: ref, to: slice.id, type: "ref_slice", label: "leased" });
    }
  }
  for (const lease of leases) {
    setFrAcNode(nodes, store, lease.frAcRef);
    edges.push({ from: lease.sliceId, to: lease.frAcRef, type: "slice_ref_status", label: lease.status, status: lease.status });
  }
  for (const dependency of dependencies) {
    const status = currentDependencyStatus(store, dependency);
    if (!nodes.has(dependency.target)) {
      nodes.set(dependency.target, { id: dependency.target, type: "dependency_target", label: dependency.target, status });
    }
    edges.push({ from: dependency.target, to: dependency.fromId, type: "dependency", label: dependency.reason, status });
  }
  for (const item of evidence) {
    nodes.set(item.id, { id: item.id, type: "evidence", label: `${item.kind}: ${item.summary}` });
    edges.push({ from: item.sliceId, to: item.id, type: "evidence", label: item.kind });
  }
  for (const heartbeat of heartbeats) {
    nodes.set(heartbeat.id, { id: heartbeat.id, type: "heartbeat", label: `${heartbeat.actor}: ${heartbeat.state}`, status: heartbeat.state });
    if (heartbeat.entityId) edges.push({ from: heartbeat.id, to: heartbeat.entityId, type: "heartbeat_for", label: heartbeat.actor });
  }
  for (const event of events.filter((item) => item.type.includes("worker") || item.type.includes("verification") || item.type.includes("review") || item.type.includes("overseer"))) {
    const actorNode = `actor:${event.actor}`;
    nodes.set(actorNode, { id: actorNode, type: "actor", label: event.actor });
    if (!nodes.has(event.entityId)) nodes.set(event.entityId, { id: event.entityId, type: event.entityType, label: event.entityId });
    edges.push({ from: actorNode, to: event.entityId, type: "actor_event", label: event.type });
  }

  return { nodes: [...nodes.values()], edges };
}

export function setFrAcNode(
  nodes: Map<string, { id: string; type: string; label: string; status?: string }>,
  store: SwarmStore,
  ref: string,
): void {
  nodes.set(ref, { id: ref, type: "fr_ac", label: ref, status: store.latestLeaseFor(ref)?.status });
}

export function currentDependencyStatus(
  store: SwarmStore,
  dependency: ReturnType<SwarmStore["listDependencies"]>[number],
): "pending" | "satisfied" | "blocked" {
  const targetLease = store.latestLeaseFor(dependency.target);
  if (targetLease?.status === "completed") return "satisfied";
  return dependency.status;
}

export function renderDot(graph: ReturnType<typeof buildGraph>): string {
  const lines = ["digraph swarm {", "  rankdir=LR;"];
  for (const node of graph.nodes) {
    lines.push(`  ${dotId(node.id)} [label="${escapeDot(`${node.label}\\n${node.type}${node.status ? `:${node.status}` : ""}`)}"];`);
  }
  for (const edge of graph.edges) {
    const label = edge.label ?? edge.type;
    lines.push(`  ${dotId(edge.from)} -> ${dotId(edge.to)} [label="${escapeDot(label)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function dotId(value: string): string {
  return `"${escapeDot(value)}"`;
}

export function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
}
