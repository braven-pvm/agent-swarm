import fs from "node:fs";
import path from "node:path";
import { buildDomainSummaries } from "./domains.js";
import { buildOverseerFocusQueue } from "./focus.js";
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
      };
    }
    const lease = leases
      .filter((item) => item.sliceId === owning.id && item.frAcRef === ref)
      .at(-1);
    const { evidence, frAcResults, reviewResult } = sliceEvidence(owning.id);
    const frAcResult = frAcResults.find((item) => item.ref === ref);
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
    if (!hasBlockingEscalation && (frAcResult?.status === "passed" || (lease?.status === "completed" && owning.status === "accepted"))) {
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

  return { generatedAt: new Date().toISOString(), totals, byDomain, refs };
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
  };
  // Focus queue (triage) — computed from the assembled snapshot's active slices.
  // Runs buildSliceFocusPacket for each active slice with the overseer's modest
  // limits; a focus failure must never break the snapshot, so default to [].
  let focusQueue: ReturnType<typeof buildOverseerFocusQueue> = [];
  try {
    focusQueue = buildOverseerFocusQueue({
      store,
      workspace,
      snapshot: { slices: snapshot.slices },
      cli: focusCli(),
    });
  } catch {
    focusQueue = [];
  }
  return { ...snapshot, focusQueue };
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
