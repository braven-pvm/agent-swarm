import path from "node:path";
import { createEvent } from "./events.js";
import { refreshCheckpoint } from "./checkpoints.js";
import { makeId } from "./ids.js";
import { artifactsDir } from "./paths.js";
import { buildCoverage, latestFrAcResults, stringValue, type CoverageRef, type RequirementLedgerEntry } from "./observability.js";
import { resolveReviewEnvironment } from "./review-target.js";
import { SwarmStore } from "./storage.js";
import type { EntityType, EscalationRecord, FrAcVerificationResult, SliceRecord } from "./types.js";

export type HumanVerificationDecision = "human_verified" | "failed" | "needs_rework";

export interface HumanActionLink {
  label: string;
  href: string;
}

export interface HumanActionCommand {
  kind: "clear_escalation" | "record_human_verification";
  method: "POST";
  path: string;
  bodyTemplate: Record<string, unknown>;
}

export interface HumanReviewTarget {
  targetId?: string;
  targetName?: string;
  targetPath?: string;
  targetPathRelative?: string;
  startCommand?: string;
  commandName?: string;
  commandSource?: string;
  startAvailable: boolean;
  startUnavailableReason?: string;
  suggestedUrl?: string;
  focusHref?: string;
  sourceHref?: string;
  packetHref?: string;
  requirementRef: string;
  requirementText?: string;
  requirementContext?: string;
  responsibleParty?: string;
  expectedOutcomes: string[];
  startAction?: {
    method: "POST";
    path: "/api/control/dev-server/start";
    bodyTemplate: Record<string, unknown>;
  };
  instructions: string[];
}

export interface HumanActionItem {
  id: string;
  kind:
    | "decision_required"
    | "clear_blocker"
    | "human_verification"
    | "human_verification_rework"
    | "blocked_requirement";
  severity: "info" | "warning" | "danger";
  title: string;
  summary: string;
  status: string;
  entityType: EntityType;
  entityId: string;
  ref?: string;
  sliceId?: string;
  domain?: string;
  source?: {
    id: string;
    title: string;
    uri: string;
  };
  packet?: RequirementLedgerEntry["humanPath"]["packet"];
  reviewTarget?: HumanReviewTarget;
  evidenceIds?: string[];
  links: HumanActionLink[];
  allowedActions: HumanActionCommand[];
  createdAt?: string;
  updatedAt?: string;
}

export interface HumanActionQueue {
  generatedAt: string;
  totals: {
    total: number;
    decisionRequired: number;
    humanVerification: number;
    blockers: number;
  };
  actions: HumanActionItem[];
}

export interface HumanVerificationRecordResult {
  sliceId: string;
  ref: string;
  status: HumanVerificationDecision;
  resultStatus: FrAcVerificationResult["status"];
  accepted: boolean;
  finalSliceStatus: SliceRecord["status"];
  packetId: string;
  packetEvidenceId: string;
  resultEvidenceId: string;
  commandEvidenceId: string;
  clearedEscalationIds: string[];
  frAcResults: FrAcVerificationResult[];
}

export function buildHumanActionQueue(store: SwarmStore, workspace?: string): HumanActionQueue {
  const generatedAt = new Date().toISOString();
  const coverage = buildCoverage(store);
  const activeEscalations = store.listEscalations("active");
  const actions: HumanActionItem[] = [];

  for (const escalation of activeEscalations) {
    if (!["blocker", "human_required", "critical"].includes(escalation.level)) continue;
    actions.push(humanEscalationAction(escalation));
  }

  for (const entry of coverage.ledger.entries) {
    if (entry.status === "awaiting_human_verification") {
      actions.push(humanVerificationAction(entry, store, workspace));
    } else if (entry.status === "failed" && entry.humanPath.state === "human_verification_required") {
      if (entry.sliceId && hasHumanRepairDecision(store, entry.sliceId, entry.ref)) continue;
      actions.push(humanVerificationReworkAction(entry, store, workspace));
    } else if (entry.status === "human_input_required") {
      actions.push(humanInputRequirementAction(entry, workspace));
    } else if (entry.status === "blocked" || entry.status === "failed") {
      actions.push(blockedRequirementAction(entry, workspace));
    }
  }

  actions.sort(compareHumanActions);
  return {
    generatedAt,
    totals: {
      total: actions.length,
      decisionRequired: actions.filter((action) => action.kind === "decision_required").length,
      humanVerification: actions.filter(countsAsHumanVerificationAction).length,
      blockers: actions.filter(countsAsBlockerAction).length,
    },
    actions,
  };
}

export function clearHumanEscalation(
  store: SwarmStore,
  escalationId: string,
  input: { actor?: string; reason: string },
): EscalationRecord {
  const actor = input.actor?.trim() || "human";
  const reason = input.reason.trim();
  if (!reason) throw new Error("A clearance reason is required.");
  const escalation = store.listEscalations("active").find((item) => item.id === escalationId);
  if (!escalation) throw new Error(`Active escalation not found: ${escalationId}`);

  store.clearEscalation(escalationId, { reason, clearedBy: actor });
  store.addEvent(
    createEvent({
      actor,
      type: "escalation.cleared",
      entityType: "escalation",
      entityId: escalationId,
      payload: { reason },
    }),
  );
  return {
    ...escalation,
    status: "cleared",
    reason,
    clearedBy: actor,
    updatedAt: new Date().toISOString(),
  };
}

export function recordHumanVerification(
  store: SwarmStore,
  input: { sliceId: string; ref: string; status: string; actor?: string; notes?: string },
): HumanVerificationRecordResult {
  const actor = input.actor?.trim() || "human";
  const notes = input.notes ?? "";
  const slice = store.listSlices().find((item) => item.id === input.sliceId);
  if (!slice) throw new Error(`Slice not found: ${input.sliceId}`);
  if (!slice.frAcRefs.includes(input.ref)) throw new Error(`Ref ${input.ref} is not in slice ${slice.id}`);
  const status = parseHumanVerificationDecision(input.status);
  const packetEvidence = latestHumanVerificationPacketEvidence(store, slice.id, input.ref);
  if (!packetEvidence) {
    throw new Error(`No human verification packet exists for ${input.ref} in ${slice.id}`);
  }
  const previousResults = latestFrAcResults(store.listEvidence(slice.id));
  const previousResult = previousResults.find((item) => item.ref === input.ref);
  if (!previousResult || !["awaiting_human_verification", "failed"].includes(previousResult.status)) {
    throw new Error(
      `Ref ${input.ref} is ${previousResult?.status ?? "missing"}; human verification requires an awaiting or failed human-verification result`,
    );
  }

  const recordedAt = new Date().toISOString();
  const resultEvidenceId = makeId("evidence");
  const commandEvidenceId = makeId("evidence");
  const packetId = stringValue(packetEvidence.payload.packetId) ?? packetEvidence.id;
  const markdownPath = stringValue(packetEvidence.payload.markdownPath);
  const jsonPath = stringValue(packetEvidence.payload.jsonPath);
  if (!markdownPath || !jsonPath) throw new Error(`Human verification packet ${packetEvidence.id} is missing packet paths`);
  const resultStatus: FrAcVerificationResult["status"] = status === "human_verified" ? "human_verified" : "failed";
  const clearedEscalationIds = clearResolvedHumanVerificationEscalations(store, {
    slice,
    ref: input.ref,
    actor,
    status,
    notes,
  });
  const proof = humanVerificationProof({
    ref: input.ref,
    status,
    actor,
    notes,
    packetId,
  });
  const frAcResults = updateHumanVerificationResults({
    slice,
    previousResults,
    ref: input.ref,
    resultStatus,
    proof,
    actor,
    resultEvidenceId,
    packetEvidenceId: packetEvidence.id,
  });
  const accepted = frAcResults.every((item) => ["passed", "human_verified", "overridden"].includes(item.status));
  const nextSliceStatus: SliceRecord["status"] = accepted ? "accepted" : status === "needs_rework" ? "repairing" : "blocked";

  store.insertEvidence({
    id: resultEvidenceId,
    sliceId: slice.id,
    kind: "artifact",
    ref: input.ref,
    summary: `Human verification ${status} for ${input.ref}`,
    payload: {
      type: "human_verification_result",
      packetId,
      packetEvidenceId: packetEvidence.id,
      ref: input.ref,
      status,
      resultStatus,
      actor,
      notes,
      markdownPath,
      jsonPath,
      generatedAt: recordedAt,
    },
    createdAt: recordedAt,
  });
  store.insertEvidence({
    id: commandEvidenceId,
    sliceId: slice.id,
    kind: "command",
    summary: `Human verification ${status} recorded for ${input.ref}`,
    payload: {
      command: "human-verify",
      passed: accepted,
      humanVerificationResult: {
        ref: input.ref,
        status,
        resultStatus,
        actor,
        notes,
        packetId,
        packetEvidenceId: packetEvidence.id,
        resultEvidenceId,
      },
      frAcResults,
      humanVerificationRefs: frAcResults.filter((item) => item.status === "awaiting_human_verification").map((item) => item.ref),
      humanVerifiedRefs: frAcResults.filter((item) => item.status === "human_verified").map((item) => item.ref),
      failedRefs: frAcResults.filter((item) => item.status === "failed").map((item) => item.ref),
    },
    createdAt: recordedAt,
  });
  store.updateSliceStatus(slice.id, nextSliceStatus);
  if (accepted) {
    store.completeLeasesForSlice(slice.id);
  }
  store.updateDependenciesFor("slice", slice.id, accepted ? "satisfied" : "blocked");
  store.upsertHeartbeat({
    id: `heartbeat:${actor}`,
    actor,
    state: accepted ? "idle" : "blocked",
    detail: `Human verification ${status} for ${input.ref}`,
    entityType: "slice",
    entityId: slice.id,
  });
  store.addEvent(
    createEvent({
      actor,
      type: "human_verification.recorded",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        ref: input.ref,
        status,
        resultStatus,
        accepted,
        packetId,
        packetEvidenceId: packetEvidence.id,
        resultEvidenceId,
        commandEvidenceId,
        clearedEscalationIds,
      },
    }),
  );
  refreshCheckpoint({
    store,
    role: "verifier",
    entityType: "slice",
    entityId: slice.id,
    actor,
    reason: "Human verification result recorded.",
  });

  return {
    sliceId: slice.id,
    ref: input.ref,
    status,
    resultStatus,
    accepted,
    finalSliceStatus: nextSliceStatus,
    packetId,
    packetEvidenceId: packetEvidence.id,
    resultEvidenceId,
    commandEvidenceId,
    clearedEscalationIds,
    frAcResults,
  };
}

function humanEscalationAction(escalation: EscalationRecord): HumanActionItem {
  const danger = escalation.level === "human_required" || escalation.level === "critical";
  return {
    id: `escalation:${escalation.id}`,
    kind: escalation.level === "human_required" || escalation.level === "critical" ? "decision_required" : "clear_blocker",
    severity: danger ? "danger" : "warning",
    title: `${labelForEscalationLevel(escalation.level)}: ${escalation.entityType}:${escalation.entityId}`,
    summary: escalation.message,
    status: escalation.level,
    entityType: escalation.entityType,
    entityId: escalation.entityId,
    sliceId: escalation.entityType === "slice" ? escalation.entityId : undefined,
    links: focusLinks(escalation.entityType, escalation.entityId),
    allowedActions: [
      {
        kind: "clear_escalation",
        method: "POST",
        path: `/api/escalations/${encodeURIComponent(escalation.id)}/clear`,
        bodyTemplate: { actor: "human", reason: "" },
      },
    ],
    createdAt: escalation.createdAt,
    updatedAt: escalation.updatedAt,
  };
}

function humanVerificationAction(entry: RequirementLedgerEntry, store: SwarmStore, workspace?: string): HumanActionItem {
  return {
    id: `human-verification:${entry.sliceId ?? "unknown"}:${entry.ref}`,
    kind: "human_verification",
    severity: "danger",
    title: `Human verification required: ${entry.ref}`,
    summary: entry.reason,
    status: entry.status,
    ...entryContext(entry),
    packet: entry.humanPath.packet,
    reviewTarget: humanReviewTarget(entry, store, workspace),
    links: requirementLinks(entry, workspace),
    allowedActions: entry.sliceId
      ? [
          {
            kind: "record_human_verification",
            method: "POST",
            path: "/api/human-verify",
            bodyTemplate: { sliceId: entry.sliceId, ref: entry.ref, status: "human_verified", actor: "human", notes: "" },
          },
        ]
      : [],
    updatedAt: entry.lastChangedAt,
  };
}

function humanVerificationReworkAction(entry: RequirementLedgerEntry, store: SwarmStore, workspace?: string): HumanActionItem {
  const latestHumanStatus = entry.sliceId ? latestHumanVerificationDecision(store, entry.sliceId, entry.ref) : undefined;
  const repairRequested = latestHumanStatus === "failed" || latestHumanStatus === "needs_rework";
  const repairLabel = latestHumanStatus === "needs_rework" ? "needs rework" : "failed";
  return {
    id: `human-verification-rework:${entry.sliceId ?? "unknown"}:${entry.ref}`,
    kind: "human_verification_rework",
    severity: "danger",
    title: repairRequested
      ? `Agent repair required from human verification: ${entry.ref}`
      : `Human verification unresolved: ${entry.ref}`,
    summary: repairRequested
      ? `Human recorded ${repairLabel} for this ref. Continue the run so agents can repair the slice and produce fresh verification evidence; this is no longer waiting for another human click. ${entry.reason}`
      : entry.reason,
    status: repairRequested ? "repair_requested" : entry.status,
    ...entryContext(entry),
    packet: entry.humanPath.packet,
    reviewTarget: humanReviewTarget(entry, store, workspace),
    links: requirementLinks(entry, workspace),
    allowedActions: !repairRequested && entry.sliceId
      ? [
          {
            kind: "record_human_verification",
            method: "POST",
            path: "/api/human-verify",
            bodyTemplate: { sliceId: entry.sliceId, ref: entry.ref, status: "needs_rework", actor: "human", notes: "" },
          },
        ]
      : [],
    updatedAt: entry.lastChangedAt,
  };
}

function humanInputRequirementAction(entry: RequirementLedgerEntry, workspace?: string): HumanActionItem {
  return {
    id: `human-input:${entry.sliceId ?? entry.sourceId}:${entry.ref}`,
    kind: "decision_required",
    severity: "danger",
    title: `Human input required: ${entry.ref}`,
    summary: entry.reason,
    status: entry.status,
    ...entryContext(entry),
    links: requirementLinks(entry, workspace),
    allowedActions: [],
    updatedAt: entry.lastChangedAt,
  };
}

function blockedRequirementAction(entry: RequirementLedgerEntry, workspace?: string): HumanActionItem {
  return {
    id: `blocked-requirement:${entry.sliceId ?? entry.sourceId}:${entry.ref}`,
    kind: "blocked_requirement",
    severity: entry.status === "failed" ? "danger" : "warning",
    title: `Requirement ${entry.status}: ${entry.ref}`,
    summary: entry.reason,
    status: entry.status,
    ...entryContext(entry),
    links: requirementLinks(entry, workspace),
    allowedActions: [],
    updatedAt: entry.lastChangedAt,
  };
}

function entryContext(entry: RequirementLedgerEntry): Pick<
  HumanActionItem,
  "entityType" | "entityId" | "ref" | "sliceId" | "domain" | "source" | "evidenceIds"
> {
  return {
    entityType: entry.sliceId ? "slice" : "source",
    entityId: entry.sliceId ?? entry.sourceId,
    ref: entry.ref,
    sliceId: entry.sliceId,
    domain: entry.domain,
    source: {
      id: entry.sourceId,
      title: entry.sourceTitle,
      uri: entry.sourceUri,
    },
    evidenceIds: entry.evidenceIds,
  };
}

function requirementLinks(entry: RequirementLedgerEntry, workspace?: string): HumanActionLink[] {
  const packetArtifactHref = artifactHref(entry.humanPath.packet?.markdownPath, workspace);
  return [
    entry.sliceId ? { label: "slice focus", href: `/api/focus/slice/${encodeURIComponent(entry.sliceId)}` } : undefined,
    { label: "source", href: `/api/source/${encodeURIComponent(entry.sourceId)}` },
    packetArtifactHref ? { label: "human packet", href: packetArtifactHref } : undefined,
  ].filter((item): item is HumanActionLink => Boolean(item));
}

function humanReviewTarget(entry: RequirementLedgerEntry, store: SwarmStore, workspace?: string): HumanReviewTarget | undefined {
  if (!entry.sliceId) return undefined;
  const slice = store.listSlices().find((item) => item.id === entry.sliceId);
  if (!slice) return undefined;
  const target = store.targetById(slice.targetId);
  if (!target) return undefined;

  const reviewEnvironment = resolveReviewEnvironment(target, workspace);
  const startAvailable = reviewEnvironment.commandAvailable;
  const packetHref = artifactHref(entry.humanPath.packet?.markdownPath, workspace);
  const focusHref = `/api/focus/slice/${encodeURIComponent(entry.sliceId)}`;
  const sourceHref = `/api/source/${encodeURIComponent(entry.sourceId)}`;
  const expectedOutcomes = entry.obligation?.expectedOutcomes ?? [];
  return {
    targetId: target.id,
    targetName: target.name,
    targetPath: target.path,
    targetPathRelative: workspace ? path.relative(workspace, target.path).replace(/\\/g, "/") : undefined,
    startCommand: reviewEnvironment.command,
    commandName: reviewEnvironment.commandName,
    commandSource: reviewEnvironment.commandSource,
    startAvailable,
    startUnavailableReason: reviewEnvironment.unavailableReason,
    suggestedUrl: reviewEnvironment.suggestedUrl,
    focusHref,
    sourceHref,
    packetHref,
    requirementRef: entry.ref,
    requirementText: sourceTextForEntry(entry, slice),
    requirementContext: sourceContextForEntry(entry, slice),
    responsibleParty: entry.obligation?.responsibleParty,
    expectedOutcomes,
    startAction: startAvailable
      ? {
          method: "POST",
          path: "/api/control/dev-server/start",
          bodyTemplate: { targetName: target.name, commandName: reviewEnvironment.commandName },
        }
      : undefined,
    instructions: humanReviewInstructions(entry, startAvailable, reviewEnvironment.command),
  };
}

function sourceTextForEntry(entry: RequirementLedgerEntry, slice: SliceRecord): string | undefined {
  return slice.verificationObligations.find((item) => item.ref === entry.ref)?.sourceText;
}

function sourceContextForEntry(entry: RequirementLedgerEntry, slice: SliceRecord): string | undefined {
  return slice.verificationObligations.find((item) => item.ref === entry.ref)?.sourceContext;
}

function humanReviewInstructions(entry: RequirementLedgerEntry, startAvailable: boolean, startCommand?: string): string[] {
  const outcomes = entry.obligation?.expectedOutcomes ?? [];
  return [
    "Open the human packet before recording a result.",
    startAvailable
      ? `Start the review target through /api/control/dev-server/start (${startCommand}) and open the URL only after the server reports running.`
      : "Do not sign off visually until a runnable review target is available.",
    "Compare the visible product/component behavior against the immutable FR/AC criteria.",
    ...outcomes.map((outcome) => `Expected: ${outcome}`),
    "Record human_verified only when the criteria are actually visible and acceptable; otherwise record failed or needs_rework with notes.",
  ];
}

function artifactHref(artifactPath: string | undefined, workspace: string | undefined): string | undefined {
  if (!artifactPath) return undefined;
  if (!workspace) return undefined;
  const root = path.resolve(artifactsDir(workspace));
  const resolved = path.resolve(artifactPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `/api/artifacts/${encodeURIComponent(relative.replace(/\\/g, "/"))}`;
}

function focusLinks(entityType: EntityType, entityId: string): HumanActionLink[] {
  if (entityType === "slice") return [{ label: "slice focus", href: `/api/focus/slice/${encodeURIComponent(entityId)}` }];
  if (entityType === "agent_run") return [{ label: "run focus", href: `/api/focus/run/${encodeURIComponent(entityId)}` }];
  return [];
}

function compareHumanActions(left: HumanActionItem, right: HumanActionItem): number {
  const severityOrder = { danger: 0, warning: 1, info: 2 };
  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    humanActionOrder(left) - humanActionOrder(right) ||
    (left.updatedAt ?? left.createdAt ?? "").localeCompare(right.updatedAt ?? right.createdAt ?? "") ||
    left.id.localeCompare(right.id)
  );
}

function humanActionOrder(action: HumanActionItem): number {
  if (action.status === "repair_requested") return 3;
  const kindOrder: Record<HumanActionItem["kind"], number> = {
    decision_required: 0,
    human_verification: 1,
    human_verification_rework: 2,
    clear_blocker: 3,
    blocked_requirement: 4,
  };
  return kindOrder[action.kind];
}

function countsAsHumanVerificationAction(action: HumanActionItem): boolean {
  return action.kind === "human_verification" || (action.kind === "human_verification_rework" && action.status !== "repair_requested");
}

function countsAsBlockerAction(action: HumanActionItem): boolean {
  return action.kind === "clear_blocker" || action.kind === "blocked_requirement" || action.status === "repair_requested";
}

function hasHumanRepairDecision(store: SwarmStore, sliceId: string, ref: string): boolean {
  const latest = latestHumanVerificationDecision(store, sliceId, ref);
  return latest === "failed" || latest === "needs_rework";
}

function clearResolvedHumanVerificationEscalations(
  store: SwarmStore,
  input: { slice: SliceRecord; ref: string; actor: string; status: HumanVerificationDecision; notes: string },
): string[] {
  const cleared: string[] = [];
  const clearReason = humanVerificationEscalationClearReason(input);
  for (const escalation of store.listEscalations("active")) {
    if (escalation.level !== "human_required") continue;
    if (!isResolvedHumanVerificationEscalation(escalation, input.slice, input.ref)) continue;
    store.clearEscalation(escalation.id, { reason: clearReason, clearedBy: input.actor });
    cleared.push(escalation.id);
    store.addEvent(
      createEvent({
        actor: input.actor,
        type: "escalation.cleared",
        entityType: "escalation",
        entityId: escalation.id,
        payload: {
          reason: clearReason,
          sliceId: input.slice.id,
          ref: input.ref,
          clearedAfterHumanVerificationRecorded: true,
          humanVerificationStatus: input.status,
        },
      }),
    );
  }
  if (cleared.length > 0) {
    store.addEvent(
      createEvent({
        actor: input.actor,
        type: "human_verification.escalations_cleared",
        entityType: "slice",
        entityId: input.slice.id,
        payload: {
          ref: input.ref,
          status: input.status,
          escalationIds: cleared,
        },
      }),
    );
  }
  return cleared;
}

function isResolvedHumanVerificationEscalation(escalation: EscalationRecord, slice: SliceRecord, ref: string): boolean {
  const sameSlice = escalation.entityType === "slice" && escalation.entityId === slice.id;
  const haystack = `${escalation.message ?? ""} ${escalation.reason ?? ""} ${escalation.createdBy ?? ""}`.toLowerCase();
  const mentionsRef = haystack.includes(ref.toLowerCase());
  const mentionsHumanVerification = /human[-_ ]verification|human sign[- ]off|awaiting human|visual qa|human qa/.test(haystack);
  return (sameSlice && mentionsHumanVerification) || mentionsRef;
}

function humanVerificationEscalationClearReason(input: {
  ref: string;
  status: HumanVerificationDecision;
  notes: string;
}): string {
  const label =
    input.status === "human_verified"
      ? "verified"
      : input.status === "needs_rework"
        ? "marked needs rework"
        : "marked failed";
  const notes = input.notes.trim();
  return `Human verification ${label} for ${input.ref}.${notes ? ` Notes: ${notes}` : ""}`;
}

function labelForEscalationLevel(level: EscalationRecord["level"]): string {
  if (level === "human_required") return "Human decision";
  if (level === "critical") return "Critical";
  if (level === "blocker") return "Blocker";
  if (level === "warning") return "Warning";
  return "Info";
}

function parseHumanVerificationDecision(raw: string): HumanVerificationDecision {
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "passed" || normalized === "pass" || normalized === "human_verified") return "human_verified";
  if (normalized === "failed" || normalized === "fail") return "failed";
  if (normalized === "needs_rework" || normalized === "needs_repair" || normalized === "rework") return "needs_rework";
  throw new Error(`Invalid human verification status: ${raw}. Expected human_verified, failed, or needs_rework.`);
}

function latestHumanVerificationPacketEvidence(
  store: SwarmStore,
  sliceId: string,
  ref: string,
): ReturnType<SwarmStore["listEvidence"]>[number] | undefined {
  return store
    .listEvidence(sliceId)
    .filter((item) => item.kind === "artifact" && item.ref === ref && item.payload.type === "human_verification_packet")
    .at(-1);
}

function latestHumanVerificationDecision(
  store: SwarmStore,
  sliceId: string,
  ref: string,
): HumanVerificationDecision | undefined {
  for (const item of [...store.listEvidence(sliceId)].reverse()) {
    if (item.kind !== "artifact" || item.ref !== ref) continue;
    if (item.payload.type !== "human_verification_result") continue;
    const status = stringValue(item.payload.status);
    if (status === "human_verified" || status === "failed" || status === "needs_rework") return status;
  }
  return undefined;
}

function updateHumanVerificationResults(input: {
  slice: SliceRecord;
  previousResults: FrAcVerificationResult[];
  ref: string;
  resultStatus: FrAcVerificationResult["status"];
  proof: string;
  actor: string;
  resultEvidenceId: string;
  packetEvidenceId: string;
}): FrAcVerificationResult[] {
  const previousByRef = new Map(input.previousResults.map((result) => [result.ref, result]));
  return input.slice.frAcRefs.map((ref) => {
    const previous = previousByRef.get(ref) ?? {
      ref,
      status: "missing_evidence" as const,
      evidenceIds: [],
      proof: "No previous verification result existed for this ref.",
      verifiedBy: "harness",
    };
    if (ref !== input.ref) return previous;
    return attachCriterionResults(input.slice, {
      ref,
      status: input.resultStatus,
      evidenceIds: [...new Set([...previous.evidenceIds, input.packetEvidenceId, input.resultEvidenceId])],
      proof: input.proof,
      verifiedBy: input.actor,
    });
  });
}

function humanVerificationProof(input: {
  ref: string;
  status: HumanVerificationDecision;
  actor: string;
  notes: string;
  packetId: string;
}): string {
  const label =
    input.status === "human_verified"
      ? "Human verification passed"
      : input.status === "needs_rework"
        ? "Human verification needs rework"
        : "Human verification failed";
  return [
    `${label} for ${input.ref}.`,
    `Packet: ${input.packetId}.`,
    `Recorded by: ${input.actor}.`,
    input.notes.trim() ? `Notes: ${input.notes.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function attachCriterionResults(slice: SliceRecord, result: FrAcVerificationResult): FrAcVerificationResult {
  const obligation = slice.verificationObligations.find((item) => item.ref === result.ref);
  if (!obligation || obligation.criteria.length === 0) return result;
  return {
    ...result,
    criteriaResults: obligation.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: result.status,
      expectedOutcome: criterion.expectedOutcome,
      actualOutcome: result.proof,
      evidenceIds: result.evidenceIds,
    })),
  };
}
