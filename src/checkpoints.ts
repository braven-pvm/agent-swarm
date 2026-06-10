import { createEvent } from "./events.js";
import { makeId } from "./ids.js";
import type { SwarmStore } from "./storage.js";
import type { CheckpointRecord, CheckpointRole, EntityType, FrAcVerificationResult, SliceRecord } from "./types.js";

export function refreshCheckpoint(input: {
  store: SwarmStore;
  role: CheckpointRole;
  entityType: EntityType;
  entityId: string;
  actor: string;
  reason?: string;
}): CheckpointRecord {
  const now = new Date().toISOString();
  const checkpoint: CheckpointRecord = {
    id: makeId("checkpoint"),
    role: input.role,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: checkpointSummary(input.store, input.role, input.entityType, input.entityId),
    payload: buildCheckpointPayload(input.store, input.role, input.entityType, input.entityId),
    createdBy: input.actor,
    createdAt: now,
    updatedAt: now,
  };
  const saved = input.store.upsertCheckpoint(checkpoint);
  input.store.addEvent(
    createEvent({
      actor: input.actor,
      type: "checkpoint.refreshed",
      entityType: input.entityType,
      entityId: input.entityId,
      payload: {
        checkpointId: saved.id,
        role: input.role,
        reason: input.reason ?? "Checkpoint refreshed from harness state.",
      },
    }),
  );
  return saved;
}

export function buildResumePacket(input: {
  store: SwarmStore;
  role: CheckpointRole;
  entityType: EntityType;
  entityId: string;
}): string {
  const checkpoint = input.store.latestCheckpoint({
    role: input.role,
    entityType: input.entityType,
    entityId: input.entityId,
  });
  const payload = buildCheckpointPayload(input.store, input.role, input.entityType, input.entityId);
  const recentEvents = input.store
    .listEvents()
    .filter((event) => event.entityId === input.entityId || event.payload.sliceId === input.entityId || event.payload.laneId === input.entityId)
    .slice(-12);
  const lines = [
    `# Resume Packet: ${input.role} ${input.entityType}:${input.entityId}`,
    "",
    checkpoint
      ? `Checkpoint: ${checkpoint.id} refreshed ${checkpoint.updatedAt}`
      : "Checkpoint: missing; generated directly from current harness state.",
    "",
    "## Objective",
    textValue(payload.currentObjective),
    "",
    "## Delivery Question",
    textValue(payload.deliveryQuestion),
    "",
    "## Current State",
    `- Entity: ${input.entityType}:${input.entityId}`,
    `- Lifecycle: ${textValue(payload.lifecycleState)}`,
    `- Last meaningful action: ${textValue(payload.lastMeaningfulAction)}`,
    `- Next intended action: ${textValue(payload.nextIntendedAction)}`,
    "",
    "## FR/AC Scope",
    ...listLines(payload.frAcRefs),
    "",
    "## Evidence Status",
    ...evidenceLines(payload.evidenceStatus),
    "",
    "## Active Blockers",
    ...listLines(payload.activeBlockers),
    "",
    "## Artifacts",
    ...listLines(payload.artifactPaths),
    "",
    ...roleSpecificLines(input.role, payload),
    "",
    "## Recent Events",
    ...(recentEvents.length > 0
      ? recentEvents.map((event) => `- ${event.timestamp} ${event.actor} ${event.type} ${event.entityType}:${event.entityId}`)
      : ["- none"]),
    "",
    "## Guardrails",
    "- Do not mutate immutable source specs.",
    "- Keep FR/AC scope explicit and leased.",
    "- Do not accept work without per-FR/AC evidence.",
    "- Prefer harness state over chat memory if they disagree.",
    "- Record blockers and decisions as structured harness state.",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildCheckpointPayload(
  store: SwarmStore,
  role: CheckpointRole,
  entityType: EntityType,
  entityId: string,
): Record<string, unknown> {
  const slices = store.listSlices();
  const lanes = store.listLanes();
  const runs = store.listAgentRuns();
  const evidence = store.listEvidence();
  const escalations = store.listEscalations("active");
  const dependencies = store.listDependencies();
  const events = store.listEvents();
  const heartbeats = store.listHeartbeats();

  const directSlice =
    entityType === "slice"
      ? slices.find((slice) => slice.id === entityId)
      : entityType === "agent_run"
        ? slices.find((slice) => slice.id === runs.find((run) => run.id === entityId)?.sliceId)
        : undefined;
  const directLane =
    entityType === "lane"
      ? lanes.find((lane) => lane.id === entityId)
      : directSlice
        ? lanes.find((lane) => lane.id === directSlice.laneId)
        : undefined;
  const directRun = entityType === "agent_run" ? runs.find((run) => run.id === entityId) : undefined;
  const relatedSlices = directSlice
    ? [directSlice]
    : directLane
      ? slices.filter((slice) => slice.laneId === directLane.id)
      : [];
  const primarySlice = directSlice ?? relatedSlices.find((slice) => !["accepted", "closed"].includes(slice.status)) ?? relatedSlices.at(-1);
  const frAcRefs = unique(relatedSlices.flatMap((slice) => slice.frAcRefs));
  const activeBlockers = escalations
    .filter((escalation) => escalation.entityId === entityId || relatedSlices.some((slice) => slice.id === escalation.entityId))
    .map((escalation) => `${escalation.level}: ${escalation.message}`);
  const artifactPaths = unique(
    runs
      .filter((run) => relatedSlices.some((slice) => slice.id === run.sliceId) || run.id === entityId)
      .flatMap((run) => [run.eventsPath, run.resultPath, run.stderrPath].filter(Boolean) as string[]),
  );
  const latestEvent = events
    .filter((event) => event.entityId === entityId || relatedSlices.some((slice) => slice.id === event.entityId))
    .at(-1);
  const relatedDependencies = dependencies.filter(
    (dependency) =>
      relatedSlices.some((slice) => dependency.fromType === "slice" && dependency.fromId === slice.id) ||
      (directLane && dependency.fromType === "lane" && dependency.fromId === directLane.id),
  );
  const heartbeat = heartbeats.find(
    (item) => item.entityId === entityId || (primarySlice && item.entityId === primarySlice.id) || (directRun && item.actor === directRun.actor),
  );

  return {
    role,
    entityType,
    entityId,
    currentObjective: objectiveFor(role, directLane, primarySlice, directRun),
    deliveryQuestion: primarySlice?.deliveryQuestion ?? directLane?.purpose ?? "No delivery question is available yet.",
    frAcRefs,
    lifecycleState: directRun?.status ?? primarySlice?.status ?? directLane?.state ?? "unknown",
    lastMeaningfulAction: latestEvent ? `${latestEvent.actor} ${latestEvent.type}` : "No prior event found.",
    nextIntendedAction: nextActionFor(role, primarySlice, directRun, activeBlockers),
    decisions: events
      .filter((event) => event.type === "planner.decision" && relatedSlices.some((slice) => slice.id === event.entityId))
      .slice(-5)
      .map((event) => event.payload),
    activeBlockers,
    evidenceStatus: relatedSlices.flatMap((slice) => evidenceStatusForSlice(slice, evidence)),
    missingEvidence: relatedSlices
      .flatMap((slice) => evidenceStatusForSlice(slice, evidence))
      .filter((item) => item.status === "missing_evidence" || item.status === "failed")
      .map((item) => `${item.ref}: ${item.status} - ${item.proof}`),
    dependencies: relatedDependencies.map((dependency) => ({
      target: dependency.target,
      status: dependency.status,
      reason: dependency.reason,
    })),
    lane: directLane,
    slices: relatedSlices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      status: slice.status,
      workPackageType: slice.workPackageType,
      minimumMeaningfulOutcome: slice.minimumMeaningfulOutcome,
      deliveryQuestion: slice.deliveryQuestion,
      frAcRefs: slice.frAcRefs,
      unblockTargets: slice.unblockTargets,
    })),
    acceptedSlices: relatedSlices.filter((slice) => slice.status === "accepted").map((slice) => slice.id),
    blockedSlices: relatedSlices.filter((slice) => slice.status === "blocked").map((slice) => slice.id),
    activeSlices: relatedSlices.filter((slice) => !["accepted", "closed"].includes(slice.status)).map((slice) => slice.id),
    workerClaims: evidence
      .filter((item) => relatedSlices.some((slice) => slice.id === item.sliceId) && item.kind === "worker_result")
      .map((item) => ({ evidenceId: item.id, ref: item.ref, summary: item.summary })),
    commandEvidence: evidence
      .filter((item) => relatedSlices.some((slice) => slice.id === item.sliceId) && item.kind === "command")
      .map((item) => ({
        evidenceId: item.id,
        summary: item.summary,
        passed: item.payload.passed,
        command: item.payload.command,
      })),
    agentRun: directRun,
    reviveRecommendation:
      directRun?.status === "stale"
        ? directRun.sessionId
          ? "Revive same Codex session first."
          : "No session id captured; restart task or release according to protocol."
        : "No recovery action required unless run becomes stale or failed.",
    heartbeat,
    artifactPaths,
    sourceRefs: unique(relatedSlices.flatMap((slice) => slice.sourceRefs.map((source) => `${source.title ?? source.uri} ${source.hash ?? ""}`))),
    doNotRedo: ["Do not repeat accepted work unless a verifier or human requests repair."],
    doNotMutate: ["Do not mutate immutable source specs.", "Do not change FR/AC meaning inside implementation work."],
  };
}

function roleSpecificLines(role: CheckpointRole, payload: Record<string, unknown>): string[] {
  if (role === "planner" || role === "overseer") return plannerLines(payload);
  if (role === "worker") return workerLines(payload);
  if (role === "verifier") return verifierLines(payload);
  if (role === "reviewer") return reviewerLines(payload);
  if (role === "recovery") return recoveryLines(payload);
  return [];
}

function plannerLines(payload: Record<string, unknown>): string[] {
  return [
    "## Planner / Overseer Focus",
    `- Lane: ${textValue(payload.lane)}`,
    `- Active slices: ${csvValue(payload.activeSlices)}`,
    `- Accepted slices: ${csvValue(payload.acceptedSlices)}`,
    `- Blocked slices: ${csvValue(payload.blockedSlices)}`,
    "- Dependencies:",
    ...dependencyLines(payload.dependencies),
    "- Recent planner decisions:",
    ...listLines(payload.decisions),
    "- Next planning decision:",
    `  - ${textValue(payload.nextIntendedAction)}`,
  ];
}

function workerLines(payload: Record<string, unknown>): string[] {
  return [
    "## Worker Focus",
    `- Work package slices: ${csvValue(payload.slices)}`,
    "- Missing or failed FR/AC proof:",
    ...listLines(payload.missingEvidence),
    "- Commands already evidenced:",
    ...commandEvidenceLines(payload.commandEvidence),
    "- Do not redo:",
    ...listLines(payload.doNotRedo),
    "- Do not mutate:",
    ...listLines(payload.doNotMutate),
  ];
}

function verifierLines(payload: Record<string, unknown>): string[] {
  return [
    "## Verifier Focus",
    "- Worker claims:",
    ...listLines(payload.workerClaims),
    "- Per-FR/AC checklist:",
    ...evidenceLines(payload.evidenceStatus),
    "- Missing or failed evidence:",
    ...listLines(payload.missingEvidence),
    "- Command evidence:",
    ...commandEvidenceLines(payload.commandEvidence),
    "- Block acceptance unless every in-scope FR/AC has passing or overridden evidence.",
  ];
}

function reviewerLines(payload: Record<string, unknown>): string[] {
  return [
    "## Reviewer / Sleuth Focus",
    "- Check whether the stated delivery question was actually answered.",
    "- Look for hollow tests, fake-only behavior, scope drift, missing runtime path, and weak proof claims.",
    "- Worker claims:",
    ...listLines(payload.workerClaims),
    "- Evidence status:",
    ...evidenceLines(payload.evidenceStatus),
  ];
}

function recoveryLines(payload: Record<string, unknown>): string[] {
  return [
    "## Recovery Focus",
    `- Agent run: ${textValue(payload.agentRun)}`,
    `- Revive/restart recommendation: ${textValue(payload.reviveRecommendation)}`,
    "- Artifact paths:",
    ...listLines(payload.artifactPaths),
    "- Heartbeat:",
    `  - ${textValue(payload.heartbeat)}`,
  ];
}

function checkpointSummary(store: SwarmStore, role: CheckpointRole, entityType: EntityType, entityId: string): string {
  const payload = buildCheckpointPayload(store, role, entityType, entityId);
  return `${textValue(payload.currentObjective)} Next: ${textValue(payload.nextIntendedAction)}`;
}

function evidenceStatusForSlice(slice: SliceRecord, evidence: ReturnType<SwarmStore["listEvidence"]>): FrAcVerificationResult[] {
  const commandEvidence = evidence
    .filter((item) => item.sliceId === slice.id && item.kind === "command" && Array.isArray(item.payload.frAcResults))
    .at(-1);
  if (commandEvidence) return commandEvidence.payload.frAcResults as unknown as FrAcVerificationResult[];
  return slice.frAcRefs.map((ref) => ({
    ref,
    status: "missing_evidence",
    evidenceIds: [],
    proof: "No verification evidence recorded yet.",
    verifiedBy: "harness",
  }));
}

function objectiveFor(
  role: CheckpointRole,
  lane: ReturnType<SwarmStore["listLanes"]>[number] | undefined,
  slice: SliceRecord | undefined,
  run: ReturnType<SwarmStore["listAgentRuns"]>[number] | undefined,
): string {
  if (role === "planner" || role === "overseer") return lane ? `Coordinate lane ${lane.name}.` : "Coordinate the current harness work.";
  if (role === "worker") return slice ? `Implement ${slice.title}.` : "Continue implementation work.";
  if (role === "verifier") return slice ? `Verify ${slice.title} against FR/AC evidence.` : "Verify current slice work.";
  if (role === "reviewer") return slice ? `Review ${slice.title} for drift, runtime proof, and risk.` : "Review current work.";
  if (role === "recovery") return run ? `Recover agent run ${run.id}.` : "Recover stalled work.";
  return "Resume harness work.";
}

function nextActionFor(
  role: CheckpointRole,
  slice: SliceRecord | undefined,
  run: ReturnType<SwarmStore["listAgentRuns"]>[number] | undefined,
  blockers: string[],
): string {
  if (blockers.length > 0) return "Resolve or escalate active blockers before progressing affected scope.";
  if (role === "recovery" && run?.status === "stale") return "Attempt revive if session id exists; otherwise restart or release according to protocol.";
  if (!slice) return "Snapshot state and choose the next unblocked scope.";
  if (slice.status === "ready") return "Dispatch worker for the slice.";
  if (slice.status === "implementing") return "Continue worker run or inspect heartbeat/events for progress.";
  if (slice.status === "implemented") return "Run verifier and attach per-FR/AC evidence.";
  if (slice.status === "blocked") return "Inspect blockers, missing evidence, or failed commands and choose repair/release/escalation.";
  if (slice.status === "accepted") return "Use accepted FR/ACs to unblock downstream planning.";
  return "Inspect timeline and determine the next lifecycle action.";
}

function listLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["- none"];
  return value.map((item) => `- ${textValue(item)}`);
}

function evidenceLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["- none"];
  return value.map((item) => {
    const result = item as Partial<FrAcVerificationResult>;
    return `- ${result.ref ?? "unknown"}: ${result.status ?? "unknown"} - ${result.proof ?? ""}`.trim();
  });
}

function dependencyLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["- none"];
  return value.map((item) => {
    const dependency = item as { target?: unknown; status?: unknown; reason?: unknown };
    return `- ${textValue(dependency.target)}: ${textValue(dependency.status)} - ${textValue(dependency.reason)}`;
  });
}

function commandEvidenceLines(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["- none"];
  return value.map((item) => {
    const evidence = item as { evidenceId?: unknown; command?: unknown; passed?: unknown; summary?: unknown };
    return `- ${textValue(evidence.evidenceId)} ${textValue(evidence.command ?? evidence.summary)} passed:${textValue(evidence.passed)}`;
  });
}

function csvValue(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "none";
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item) return String((item as { id: unknown }).id);
      return textValue(item);
    })
    .join(", ");
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
