import type {
  CoverageRef,
  CoverageSummary,
  RequirementLedgerEntry,
  RequirementLedgerStatus,
} from "./observability.js";
import type { SourceRef } from "./types.js";

export interface StatusSink {
  readonly kind: string;
  readonly displayName: string;
  connect(config: StatusSinkConfig): Promise<StatusSinkConnection>;
  updateStatus(update: StatusUpdate): Promise<StatusUpdateResult>;
}

export interface StatusSinkConfig {
  sinkId: string;
  settings: Record<string, unknown>;
}

export interface StatusSinkConnection {
  sinkId: string;
  capabilities: StatusSinkCapabilities;
}

export interface StatusSinkCapabilities {
  canWriteStatus: boolean;
  canAttachReportLink: boolean;
  canAttachPrLink: boolean;
  canWriteEvidenceSummary: boolean;
  canWriteLedgerSummary: boolean;
}

export interface StatusUpdate {
  sourceRefs: SourceRef[];
  sliceId?: string;
  status: string;
  summary: string;
  reportUrl?: string;
  prUrl?: string;
  evidenceSummary?: string;
  blocker?: string;
  ledger?: StatusSinkLedgerSummary;
}

export interface StatusUpdateResult {
  updated: boolean;
  nativeUrl?: string;
  message?: string;
}

export type StatusSinkLedgerState = "empty" | "complete" | "partial" | "human_attention" | "blocked";

export interface StatusSinkLedgerRef {
  ref: string;
  status: RequirementLedgerStatus;
  domain: string;
  reason: string;
  sourceTitle: string;
  sliceId?: string;
  nextAction?: CoverageRef["nextAction"];
  humanPath?: RequirementLedgerEntry["humanPath"]["state"];
  responsibleParty?: string;
}

export interface StatusSinkLedgerBucket {
  status: RequirementLedgerStatus;
  count: number;
  refs: string[];
}

export interface StatusSinkLedgerSummary {
  origin: "derived";
  canonicalDetail: {
    apiPath: "/api/coverage";
    payloadPath: "ledger";
  };
  generatedAt: string;
  state: StatusSinkLedgerState;
  completion: {
    total: number;
    accepted: number;
    verifiedNotAccepted: number;
    incomplete: number;
    completionPercent: number;
  };
  totals: CoverageSummary["ledger"]["totals"];
  attention: {
    blocked: number;
    failed: number;
    humanInputRequired: number;
    awaitingHumanVerification: number;
    refs: StatusSinkLedgerRef[];
  };
  human: {
    awaitingVerification: number;
    signed: number;
  };
  rollups: {
    total: number;
    incomplete: number;
  };
  buckets: StatusSinkLedgerBucket[];
  nextRefs: StatusSinkLedgerRef[];
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

const ATTENTION_STATUSES = new Set<RequirementLedgerStatus>([
  "human_input_required",
  "failed",
  "blocked",
  "awaiting_human_verification",
]);

const NEXT_REF_PRIORITY: Record<RequirementLedgerStatus, number> = {
  human_input_required: 0,
  failed: 1,
  blocked: 2,
  awaiting_human_verification: 3,
  implemented_unverified: 4,
  review_passed: 5,
  in_progress: 6,
  planned: 7,
  not_started: 8,
  verified: 9,
  human_verified: 10,
  accepted: 99,
};

export function buildStatusSinkLedgerSummary(
  coverage: CoverageSummary,
  options: { maxRefsPerBucket?: number; maxNextRefs?: number } = {},
): StatusSinkLedgerSummary {
  const maxRefsPerBucket = options.maxRefsPerBucket ?? 8;
  const maxNextRefs = options.maxNextRefs ?? 12;
  const entries = coverage.ledger.entries;
  const refsByRef = new Map(coverage.refs.map((row) => [row.ref.toUpperCase(), row]));
  const totals = coverage.ledger.totals;
  const accepted = totals.accepted ?? 0;
  const total = totals.total ?? entries.length;
  const verifiedNotAccepted = (totals.verified ?? 0) + (totals.human_verified ?? 0);
  const incomplete = Math.max(0, total - accepted);
  const attentionRefs = entries
    .filter((entry) => ATTENTION_STATUSES.has(entry.status))
    .sort(compareLedgerEntries)
    .slice(0, maxNextRefs)
    .map((entry) => statusSinkLedgerRef(entry, refsByRef));
  const nextRefs = entries
    .filter((entry) => entry.status !== "accepted")
    .sort(compareLedgerEntries)
    .slice(0, maxNextRefs)
    .map((entry) => statusSinkLedgerRef(entry, refsByRef));

  return {
    origin: "derived",
    canonicalDetail: {
      apiPath: "/api/coverage",
      payloadPath: "ledger",
    },
    generatedAt: coverage.ledger.generatedAt,
    state: ledgerState({ total, accepted, totals }),
    completion: {
      total,
      accepted,
      verifiedNotAccepted,
      incomplete,
      completionPercent: total === 0 ? 0 : Math.round((accepted / total) * 100),
    },
    totals,
    attention: {
      blocked: totals.blocked ?? 0,
      failed: totals.failed ?? 0,
      humanInputRequired: totals.human_input_required ?? 0,
      awaitingHumanVerification: totals.awaiting_human_verification ?? 0,
      refs: attentionRefs,
    },
    human: {
      awaitingVerification: totals.awaiting_human_verification ?? 0,
      signed: (totals.human_verified ?? 0) + acceptedHumanRefs(entries),
    },
    rollups: {
      total: coverage.ledger.rollups.length,
      incomplete: coverage.ledger.rollups.filter((rollup) => rollup.status !== "accepted").length,
    },
    buckets: LEDGER_STATUSES.map((status) => ({
      status,
      count: totals[status] ?? 0,
      refs: entries
        .filter((entry) => entry.status === status)
        .map((entry) => entry.ref)
        .slice(0, maxRefsPerBucket),
    })).filter((bucket) => bucket.count > 0),
    nextRefs,
  };
}

function ledgerState(input: {
  total: number;
  accepted: number;
  totals: CoverageSummary["ledger"]["totals"];
}): StatusSinkLedgerState {
  if (input.total === 0) return "empty";
  if (input.accepted === input.total) return "complete";
  if ((input.totals.human_input_required ?? 0) > 0 || (input.totals.failed ?? 0) > 0 || (input.totals.blocked ?? 0) > 0) {
    return "blocked";
  }
  if ((input.totals.awaiting_human_verification ?? 0) > 0) return "human_attention";
  return "partial";
}

function compareLedgerEntries(left: RequirementLedgerEntry, right: RequirementLedgerEntry): number {
  return (
    (NEXT_REF_PRIORITY[left.status] ?? 50) - (NEXT_REF_PRIORITY[right.status] ?? 50) ||
    left.domain.localeCompare(right.domain) ||
    left.ref.localeCompare(right.ref)
  );
}

function statusSinkLedgerRef(
  entry: RequirementLedgerEntry,
  refsByRef: Map<string, CoverageRef>,
): StatusSinkLedgerRef {
  const coverageRef = refsByRef.get(entry.ref.toUpperCase());
  return {
    ref: entry.ref,
    status: entry.status,
    domain: entry.domain,
    reason: entry.reason,
    sourceTitle: entry.sourceTitle,
    sliceId: entry.sliceId,
    nextAction: coverageRef?.nextAction,
    humanPath: entry.humanPath.state,
    responsibleParty: entry.humanPath.responsibleParty ?? entry.obligation?.responsibleParty,
  };
}

function acceptedHumanRefs(entries: RequirementLedgerEntry[]): number {
  return entries.filter(
    (entry) => entry.status === "accepted" && entry.humanPath.state === "human_verification_required",
  ).length;
}
