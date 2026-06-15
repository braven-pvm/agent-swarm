import fs from "node:fs";
import path from "node:path";
import { buildDomainSummaries } from "./domains.js";
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
  status: "done" | "in_progress" | "blocked" | "failed" | "not_started";
  sliceId?: string;
  sliceStatus?: string;
  verification?: "passed" | "failed" | "missing_evidence" | "overridden";
  reviewStatus?: "passed" | "failed" | "missing_evidence" | "uncertain";
  proof?: string;
  evidenceIds?: string[];
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

  // 1. Inventory (denominator): de-duplicated map of every indexed FR/AC ref.
  //    First occurrence wins for domain/sourceId attribution — matches the
  //    `refsForSources` de-dupe semantics used by buildDomainSummaries.
  const inventory = new Map<string, { domain: string; sourceId: string }>();
  for (const source of store.listSources()) {
    const domain = sourceDomain(source);
    for (const ref of sourceFrAcRefs(source)) {
      if (!inventory.has(ref)) inventory.set(ref, { domain, sourceId: source.id });
    }
  }

  // Cache the most-advanced owning slice per ref, plus that slice's evidence-derived
  // verification/review results (loaded once per slice, not once per ref).
  const evidenceCache = new Map<string, { frAcResults: FrAcVerificationResult[]; reviewResult: ReviewResult | undefined }>();
  const sliceEvidence = (sliceId: string) => {
    let cached = evidenceCache.get(sliceId);
    if (!cached) {
      const evidence = store.listEvidence(sliceId);
      cached = { frAcResults: latestFrAcResults(evidence), reviewResult: latestReviewResult(evidence) };
      evidenceCache.set(sliceId, cached);
    }
    return cached;
  };

  const refs: CoverageRef[] = [...inventory.entries()].map(([ref, attribution]) => {
    const owning = owningSliceForRef(slices, ref);
    if (!owning) {
      return { ref, domain: attribution.domain, sourceId: attribution.sourceId, status: "not_started" as const };
    }
    const lease = leases
      .filter((item) => item.sliceId === owning.id && item.frAcRef === ref)
      .at(-1);
    const { frAcResults, reviewResult } = sliceEvidence(owning.id);
    const frAcResult = frAcResults.find((item) => item.ref === ref);
    const reviewFinding = reviewResult?.frAcFindings.find((item) => item.ref === ref);

    let status: CoverageRef["status"];
    if (frAcResult?.status === "passed" || (lease?.status === "completed" && owning.status === "accepted")) {
      status = "done";
    } else if (frAcResult?.status === "failed" || reviewFinding?.status === "failed") {
      status = "failed";
    } else if (owning.status === "blocked") {
      status = "blocked";
    } else {
      status = "in_progress";
    }

    const coverageRef: CoverageRef = {
      ref,
      domain: attribution.domain,
      sourceId: attribution.sourceId,
      status,
      sliceId: owning.id,
      sliceStatus: owning.status,
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
  return {
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
