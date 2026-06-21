import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  artifactsDir,
  sanitizeArtifactSegment,
  formatGitSafeDirectoryPath,
  trimOutput,
  summarizePromptPayload,
} from "./paths.js";
import { detectGlobalSkillReferences } from "./skill-isolation.js";
import { SwarmStore } from "./storage.js";
import type {
  AgentRunRecord,
  EscalationRecord,
  EvidenceRecord,
  HarnessEvent,
  HeartbeatRecord,
  SliceRecord,
} from "./types.js";

type AgentJsonlSummary = {
  lineNumber: number;
  type?: string;
  itemType?: string;
  status?: string;
  exitCode?: number;
  command?: string;
  outputTail?: string;
  message?: Record<string, unknown>;
  fileChanges?: Array<{ path?: string; kind?: string }>;
  parseError?: string;
};

export type RunFocusPacket = ReturnType<typeof buildRunFocusPacket>;
export type SliceFocusPacket = ReturnType<typeof buildSliceFocusPacket>;

export function buildRunFocusPacket(
  store: SwarmStore,
  workspace: string,
  runId: string,
  options: { eventLimit?: number } = {},
) {
  const run = store.listAgentRuns().find((item) => item.id === runId);
  if (!run) throw new Error(`Agent run not found: ${runId}`);
  const slice = store.listSlices().find((item) => item.id === run.sliceId);
  const target = slice ? store.targetById(slice.targetId) : undefined;
  const lane = slice ? store.listLanes().find((item) => item.id === slice.laneId) : undefined;
  const entityType = run.entityType ?? "slice";
  const entityId = run.entityId ?? run.sliceId;
  const heartbeat = findRunHeartbeat(store, run);
  const heartbeatAgeMs = heartbeat ? Date.now() - Date.parse(heartbeat.timestamp) : undefined;
  const promptPath = findPromptArtifactPath(store, workspace, run);
  const eventsPath = findRunEventsArtifactPath(store, workspace, run);
  const skillBinding = findSkillBindingForRun(store, run.id);
  const eventStream = summarizeAgentJsonlFile(eventsPath, options.eventLimit ?? 20);
  const resultArtifact = summarizeArtifact(run.resultPath);
  const stderrArtifact = summarizeArtifact(run.stderrPath, { tail: true });
  const promptArtifact = summarizeArtifact(promptPath);
  const relatedEscalations = relatedActiveEscalations(store, {
    run,
    sliceId: slice?.id,
    laneId: lane?.id,
  });
  const relatedHarnessEvents = store
    .listEvents()
    .filter(
      (event) =>
        event.entityId === run.id ||
        event.actor === run.actor ||
        event.entityId === entityId ||
        (slice && event.entityId === slice.id),
    )
    .slice(-20)
    .map(summarizeHarnessEventForFocus);
  const evidence = slice ? store.listEvidence(slice.id).slice(-8).map(summarizeEvidenceForFocus) : [];
  const gitStatus = target ? readTargetGitStatus(target.path) : undefined;
  const failureClasses = classifyRunFocus({
    run,
    heartbeatAgeMs,
    heartbeat,
    eventStream,
    resultArtifact,
    relatedEscalations,
  });

  return {
    kind: "run_focus",
    generatedAt: new Date().toISOString(),
    workspace,
    run: {
      id: run.id,
      role: run.role,
      actor: run.actor,
      driver: run.driver,
      status: run.status,
      sessionId: run.sessionId,
      attempt: run.attempt,
      entityType,
      entityId,
      sliceId: run.sliceId,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
    },
    slice: slice
      ? {
          id: slice.id,
          title: slice.title,
          status: slice.status,
          frAcRefs: slice.frAcRefs,
          deliveryQuestion: slice.deliveryQuestion,
          workPackageType: slice.workPackageType,
          minimumMeaningfulOutcome: slice.minimumMeaningfulOutcome,
        }
      : undefined,
    lane: lane ? { id: lane.id, name: lane.name, purpose: lane.purpose, targetId: lane.targetId, worktree: lane.worktree } : undefined,
    target: target ? { id: target.id, name: target.name, path: target.path } : undefined,
    heartbeat: heartbeat
      ? {
          actor: heartbeat.actor,
          state: heartbeat.state,
          detail: heartbeat.detail,
          timestamp: heartbeat.timestamp,
          ageMs: heartbeatAgeMs,
        }
      : undefined,
    artifacts: {
      prompt: promptArtifact,
      skillBinding: summarizeArtifact(skillBinding?.skillBindingPath),
      skillPacket: summarizeArtifact(skillBinding?.skillPacketPath),
      events: summarizeArtifact(eventsPath),
      result: resultArtifact,
      stderr: stderrArtifact,
    },
    skills: skillBinding?.skills,
    eventStream,
    latestSignals: {
      lastCommand: eventStream.lastCommand,
      lastAgentMessage: eventStream.lastAgentMessage,
      lastFileChanges: eventStream.lastFileChanges,
      gitStatus,
    },
    relatedEvidence: evidence,
    activeEscalations: relatedEscalations.map(summarizeEscalationForFocus),
    relatedHarnessEvents,
    diagnosis: {
      failureClasses,
      recommendedInterventions: recommendRunInterventions({ run, failureClasses, hasSession: Boolean(run.sessionId) }),
    },
    intervention: computeIntervention({
      run,
      failureClasses,
      resultArtifact,
      relatedEscalations,
      hasSession: Boolean(run.sessionId),
      retryCount: run.attempt,
    }),
  };
}

export function buildSliceFocusPacket(
  store: SwarmStore,
  workspace: string,
  sliceId: string,
  options: { runLimit?: number; eventLimit?: number } = {},
) {
  const slice = store.listSlices().find((item) => item.id === sliceId);
  if (!slice) throw new Error(`Slice not found: ${sliceId}`);
  const lane = store.listLanes().find((item) => item.id === slice.laneId);
  const target = store.targetById(slice.targetId);
  const runs = store.listAgentRuns().filter((run) => run.sliceId === slice.id);
  const recentRuns = runs.slice(-(options.runLimit ?? 5));
  const latestRun = runs.at(-1);
  const activeEscalations = relatedActiveEscalations(store, { sliceId: slice.id, laneId: lane?.id });
  const evidence = store.listEvidence(slice.id);
  const leases = store.listLeases().filter((lease) => lease.sliceId === slice.id);
  const latestRunFocus = latestRun
    ? buildRunFocusPacket(store, workspace, latestRun.id, { eventLimit: options.eventLimit ?? 12 })
    : undefined;
  const sliceRetries = sliceRetryCount(runs);
  const sliceBlocked =
    slice.status === "blocked" ||
    activeEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level));
  const sliceHumanRequired = activeEscalations.some((item) => item.level === "human_required");
  const sliceIntervention: FocusIntervention =
    latestRunFocus?.intervention ?? computeSliceLevelIntervention({
      slice,
      retryCount: sliceRetries,
      blocked: sliceBlocked,
      humanRequired: sliceHumanRequired,
      activeEscalations,
    });
  return {
    kind: "slice_focus",
    generatedAt: new Date().toISOString(),
    workspace,
    slice: {
      id: slice.id,
      title: slice.title,
      status: slice.status,
      frAcRefs: slice.frAcRefs,
      deliveryQuestion: slice.deliveryQuestion,
      workPackageType: slice.workPackageType,
      minimumMeaningfulOutcome: slice.minimumMeaningfulOutcome,
      sourceRefs: slice.sourceRefs,
      scope: slice.scope,
      outOfScope: slice.outOfScope,
      expectedEvidence: slice.expectedEvidence,
      verificationRequirements: slice.verificationRequirements,
      createdAt: slice.createdAt,
      updatedAt: slice.updatedAt,
    },
    lane: lane ? { id: lane.id, name: lane.name, purpose: lane.purpose, targetId: lane.targetId, worktree: lane.worktree } : undefined,
    target: target ? { id: target.id, name: target.name, path: target.path } : undefined,
    leases: leases.map((lease) => ({ ref: lease.frAcRef, status: lease.status, updatedAt: lease.updatedAt })),
    evidence: evidence.map(summarizeEvidenceForFocus),
    activeEscalations: activeEscalations.map(summarizeEscalationForFocus),
    runs: recentRuns.map((run) => ({
      id: run.id,
      role: run.role,
      actor: run.actor,
      driver: run.driver,
      status: run.status,
      attempt: run.attempt,
      sessionId: run.sessionId,
      promptPath: findPromptArtifactPath(store, workspace, run),
      eventsPath: findRunEventsArtifactPath(store, workspace, run),
      resultPath: run.resultPath,
      stderrPath: run.stderrPath,
      updatedAt: run.updatedAt,
    })),
    latestRunFocus,
    diagnosis: {
      status: slice.status,
      blocked: sliceBlocked,
      retryCount: sliceRetries,
      recommendedInterventions: recommendSliceInterventions(slice, runs, activeEscalations),
    },
    intervention: sliceIntervention,
  };
}

function computeSliceLevelIntervention(input: {
  slice: SliceRecord;
  retryCount: number;
  blocked: boolean;
  humanRequired: boolean;
  activeEscalations: EscalationRecord[];
}): FocusIntervention {
  const evidence = input.activeEscalations.map((item) => item.id);
  if (input.humanRequired) {
    return {
      classification: "human_verification_failed",
      confidence: "high",
      recommendedAction: "escalate_human",
      reason: "Slice has an active human_required escalation; human verification/decision is needed.",
      evidence,
      risk: INTERVENTION_RISK.human_verification_failed,
    };
  }
  if (input.retryCount >= 5 && !["accepted", "closed"].includes(input.slice.status)) {
    return {
      classification: "retry_budget_pressure",
      confidence: "high",
      recommendedAction: "escalate_human",
      reason: "Slice retry budget is exhausted (attempt >= 5); escalate for diagnosis before another attempt.",
      evidence,
      risk: INTERVENTION_RISK.retry_budget_pressure,
    };
  }
  if (input.blocked) {
    return {
      classification: "review_blocker",
      confidence: "medium",
      recommendedAction: "dispatch_targeted_repair",
      reason: "Slice is blocked by an active blocker/critical escalation; resolve before accepting.",
      evidence,
      risk: INTERVENTION_RISK.review_blocker,
    };
  }
  return {
    classification: "none",
    confidence: "low",
    recommendedAction: "observe",
    reason: "No slice-level intervention signal; continue the normal slice lifecycle.",
    evidence,
    risk: INTERVENTION_RISK.none,
  };
}

function findRunHeartbeat(store: SwarmStore, run: AgentRunRecord): HeartbeatRecord | undefined {
  const entityId = run.entityId ?? run.sliceId;
  return (
    store.listHeartbeats().find((item) => item.actor === run.actor && item.entityId === entityId) ??
    store.listHeartbeats().find((item) => item.actor === run.actor)
  );
}

function findPromptArtifactPath(store: SwarmStore, workspace: string, run: AgentRunRecord): string | undefined {
  const eventPrompt = store
    .listEvents()
    .slice()
    .reverse()
    .find((event) => event.payload.runId === run.id && typeof event.payload.promptPath === "string")?.payload.promptPath;
  if (typeof eventPrompt === "string") return eventPrompt;

  const candidates: string[] = [];
  if (run.sliceId) {
    const sliceDir = path.join(artifactsDir(workspace), run.sliceId);
    candidates.push(
      path.join(sliceDir, `worker-prompt-${run.id}.md`),
      path.join(sliceDir, `worker-revive-prompt-${run.id}.md`),
      path.join(sliceDir, `review-prompt-${run.id}.md`),
    );
  }
  if (run.entityId) {
    const entityDir = path.join(artifactsDir(workspace), sanitizeArtifactSegment(run.entityId));
    candidates.push(path.join(entityDir, `overseer-prompt-${run.id}.md`));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function findRunEventsArtifactPath(store: SwarmStore, workspace: string, run: AgentRunRecord): string | undefined {
  if (run.eventsPath) return run.eventsPath;

  const eventPath = store
    .listEvents()
    .slice()
    .reverse()
    .map((event) => {
      if (event.payload.runId !== run.id && event.payload.previousRunId !== run.id) return undefined;
      if (typeof event.payload.eventsPath === "string") return event.payload.eventsPath;
      if (typeof event.payload.jsonlPath === "string") return event.payload.jsonlPath;
      return undefined;
    })
    .find((candidate): candidate is string => Boolean(candidate));
  if (eventPath) return eventPath;

  const candidates: string[] = [];
  if (run.sliceId) {
    const sliceDir = path.join(artifactsDir(workspace), run.sliceId);
    candidates.push(
      path.join(sliceDir, `worker-events-${run.id}.jsonl`),
      path.join(sliceDir, `worker-revive-${run.id}.jsonl`),
      path.join(sliceDir, `review-events-${run.id}.jsonl`),
      path.join(sliceDir, "worker-events.jsonl"),
    );
  }
  if (run.entityId) {
    const entityDir = path.join(artifactsDir(workspace), sanitizeArtifactSegment(run.entityId));
    candidates.push(path.join(entityDir, `overseer-events-${run.id}.jsonl`));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function findSkillBindingForRun(
  store: SwarmStore,
  runId: string,
): { skills?: unknown; skillBindingPath?: string; skillPacketPath?: string } | undefined {
  return store
    .listEvents()
    .slice()
    .reverse()
    .map((event) => {
      if (event.payload.runId !== runId) return undefined;
      const skillBindingPath = typeof event.payload.skillBindingPath === "string" ? event.payload.skillBindingPath : undefined;
      const skillPacketPath = typeof event.payload.skillPacketPath === "string" ? event.payload.skillPacketPath : undefined;
      if (!event.payload.skills && !skillBindingPath && !skillPacketPath) return undefined;
      return {
        skills: event.payload.skills,
        skillBindingPath,
        skillPacketPath,
      };
    })
    .find((candidate): candidate is { skills: unknown; skillBindingPath: string | undefined; skillPacketPath: string | undefined } =>
      Boolean(candidate),
    );
}

function summarizeArtifact(filePath: string | undefined, options: { tail?: boolean } = {}) {
  if (!filePath) return { path: undefined, exists: false };
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false };
  const stat = fs.statSync(filePath);
  const content = options.tail ? readTextTail(filePath, 2000) : undefined;
  let parsed: Record<string, unknown> | undefined;
  if (!options.tail && stat.size <= 200000) {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    parsedSummary: parsed ? summarizeResultObject(parsed) : undefined,
    tail: content,
  };
}

function summarizeAgentJsonlFile(filePath: string | undefined, eventLimit: number) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath, exists: false, lineCount: 0, parseErrorCount: 0, tail: [] as AgentJsonlSummary[], globalSkillReferences: [] };
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const summaries = lines.map((line, index) => summarizeAgentJsonlLine(line, index + 1));
  const commands = summaries.filter((item) => item.command);
  const messages = summaries.filter((item) => item.message);
  const fileChanges = summaries.filter((item) => item.fileChanges && item.fileChanges.length > 0);
  const globalSkillReferences = lines.flatMap((line, index) => detectGlobalSkillReferencesInJsonlLine(line, index + 1));
  return {
    path: filePath,
    exists: true,
    lineCount: lines.length,
    parseErrorCount: summaries.filter((item) => item.parseError).length,
    globalSkillReferences,
    tail: summaries.slice(-eventLimit),
    lastCommand: commands.at(-1),
    lastAgentMessage: messages.at(-1),
    lastFileChanges: fileChanges.at(-1)?.fileChanges ?? [],
  };
}

function detectGlobalSkillReferencesInJsonlLine(line: string, lineNumber: number) {
  try {
    return detectGlobalSkillReferences(JSON.parse(line) as unknown, { lineNumber });
  } catch {
    return detectGlobalSkillReferences(line, { lineNumber });
  }
}

function summarizeAgentJsonlLine(line: string, lineNumber: number): AgentJsonlSummary {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { lineNumber, parseError: "JSONL event is not an object." };
    const event = parsed as Record<string, unknown>;
    const item = event.item && typeof event.item === "object" && !Array.isArray(event.item) ? (event.item as Record<string, unknown>) : undefined;
    const message = summarizeAgentMessage(item);
    const command = typeof item?.command === "string" ? item.command.replace(/\s+/g, " ").slice(0, 1000) : undefined;
    const output = typeof item?.aggregated_output === "string" ? trimOutput(item.aggregated_output, 1200) : undefined;
    return {
      lineNumber,
      type: typeof event.type === "string" ? event.type : undefined,
      itemType: typeof item?.type === "string" ? item.type : undefined,
      status: typeof item?.status === "string" ? item.status : undefined,
      exitCode: typeof item?.exit_code === "number" ? item.exit_code : undefined,
      command,
      outputTail: output,
      message,
      fileChanges: summarizeFileChanges(item),
    };
  } catch (error) {
    return { lineNumber, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeAgentMessage(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item || item.type !== "agent_message" || typeof item.text !== "string") return undefined;
  try {
    const parsed = JSON.parse(item.text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        status: record.status,
        summary: record.summary,
        nextRecommendation: record.nextRecommendation,
        risks: record.risks,
      };
    }
  } catch {
    // Plain agent text is still useful, but keep it compact.
  }
  return { text: item.text.slice(0, 1000) };
}

function summarizeFileChanges(item: Record<string, unknown> | undefined): Array<{ path?: string; kind?: string }> | undefined {
  if (!item || !Array.isArray(item.changes)) return undefined;
  return item.changes.slice(0, 20).map((change) => {
    const record = change && typeof change === "object" && !Array.isArray(change) ? (change as Record<string, unknown>) : {};
    return {
      path: typeof record.path === "string" ? record.path : undefined,
      kind: typeof record.kind === "string" ? record.kind : undefined,
    };
  });
}

function summarizeResultObject(result: Record<string, unknown>): Record<string, unknown> {
  return {
    status: result.status,
    summary: result.summary,
    recommendation: result.recommendation,
    nextRecommendation: result.nextRecommendation,
    frAcCoverageCount: Array.isArray(result.frAcCoverage) ? result.frAcCoverage.length : undefined,
    findingCount: Array.isArray(result.findings) ? result.findings.length : undefined,
  };
}

function summarizeHarnessEventForFocus(event: HarnessEvent): Record<string, unknown> {
  return {
    timestamp: event.timestamp,
    actor: event.actor,
    type: event.type,
    entityType: event.entityType,
    entityId: event.entityId,
    payloadSummary: summarizePromptPayload(event.payload),
  };
}

function summarizeEvidenceForFocus(evidence: EvidenceRecord): Record<string, unknown> {
  return {
    id: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    ref: evidence.ref,
    createdAt: evidence.createdAt,
  };
}

function summarizeEscalationForFocus(escalation: EscalationRecord): Record<string, unknown> {
  return {
    id: escalation.id,
    level: escalation.level,
    status: escalation.status,
    entityType: escalation.entityType,
    entityId: escalation.entityId,
    message: escalation.message,
    reason: escalation.reason,
    updatedAt: escalation.updatedAt,
  };
}

function relatedActiveEscalations(
  store: SwarmStore,
  input: { run?: AgentRunRecord; sliceId?: string; laneId?: string },
): EscalationRecord[] {
  const ids = new Set<string>();
  if (input.run) {
    ids.add(input.run.id);
    ids.add(input.run.entityId ?? input.run.sliceId);
    ids.add(input.run.sliceId);
  }
  if (input.sliceId) ids.add(input.sliceId);
  if (input.laneId) ids.add(input.laneId);
  return store.listEscalations("active").filter((item) => ids.has(item.entityId));
}

export function classifyRunFocus(input: {
  run: AgentRunRecord;
  heartbeatAgeMs?: number;
  heartbeat?: HeartbeatRecord;
  eventStream: ReturnType<typeof summarizeAgentJsonlFile>;
  resultArtifact: ReturnType<typeof summarizeArtifact>;
  relatedEscalations: EscalationRecord[];
}): string[] {
  const classes = new Set<string>();
  if (!input.eventStream.exists || input.eventStream.lineCount === 0) classes.add("no_event_stream");
  if (input.eventStream.parseErrorCount > 0) classes.add("agent_event_parse_errors");
  if (input.eventStream.globalSkillReferences.length > 0) classes.add("global_skill_leak");
  if (input.run.status === "running" && input.heartbeatAgeMs !== undefined && input.heartbeatAgeMs > 120000 && input.eventStream.lineCount <= 2) {
    classes.add("quiet_before_first_action");
  }
  if (input.run.status === "running" && input.heartbeatAgeMs !== undefined && input.heartbeatAgeMs > 300000) classes.add("quiet_running_agent");
  if (
    input.run.status === "running" &&
    input.heartbeat?.state === "blocked" &&
    /idle timeout|produced no output|supervised recovery/i.test(input.heartbeat.detail ?? "")
  ) {
    classes.add("child_idle_timeout");
  }
  if (input.run.status !== "running" && !input.resultArtifact.exists && ["worker", "reviewer"].includes(input.run.role ?? "")) {
    classes.add("missing_structured_result");
  }
  if (input.eventStream.lastCommand?.exitCode !== undefined && input.eventStream.lastCommand.exitCode !== 0) classes.add("command_failed");
  if (input.eventStream.lastCommand?.status === "failed") classes.add("command_failed");
  if (input.relatedEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level))) classes.add("active_blocker");
  if (input.run.status === "failed") classes.add("run_failed");
  if (input.run.status === "stale") classes.add("run_stale");
  return [...classes];
}

function recommendRunInterventions(input: { run: AgentRunRecord; failureClasses: string[]; hasSession: boolean }): string[] {
  const classes = new Set(input.failureClasses);
  const recommendations: string[] = [];
  if (classes.has("child_idle_timeout")) recommendations.push("Treat the child as stalled: inspect the event tail, then revive by session id or restart with the focus packet.");
  if (classes.has("quiet_before_first_action")) recommendations.push("Inspect the prompt and event stream; the agent has been quiet before any visible command or structured status.");
  if (classes.has("quiet_running_agent")) recommendations.push("Send a structured status-poke before killing or restarting the child session.");
  if (classes.has("command_failed")) recommendations.push("Coach the agent with the last command output and ask for one simpler retry strategy.");
  if (classes.has("global_skill_leak")) recommendations.push("Inspect the referenced global skill path and re-run or coach the agent to use only harness-managed skill packets.");
  if (classes.has("missing_structured_result") && input.hasSession) recommendations.push("Try same-session revive with this focus packet and require a final structured result or exact blocker.");
  if (classes.has("missing_structured_result") && !input.hasSession) recommendations.push("Restart with a generated resume packet because no resumable session id is available.");
  if (classes.has("no_event_stream")) recommendations.push("Inspect driver launch and stdout JSONL capture before blaming implementation work.");
  if (classes.has("active_blocker")) recommendations.push("Resolve or reclassify active blockers before accepting or dispatching downstream work.");
  if (classes.has("run_failed") && !classes.has("command_failed")) recommendations.push("Inspect stderr and result artifact state before retrying.");
  if (recommendations.length === 0 && input.run.status === "completed") recommendations.push("Continue normal lifecycle: review or deterministic verification as appropriate.");
  if (recommendations.length === 0) recommendations.push("Inspect the latest event tail and decide whether to continue, coach, revive, or restart.");
  return recommendations;
}

export type InterventionClassification =
  | "valid_artifact_hung_child"
  | "schema_failure"
  | "missing_result"
  | "stale_running_agent"
  | "review_blocker"
  | "human_verification_failed"
  | "retry_budget_pressure"
  | "none";

export type InterventionConfidence = "low" | "medium" | "high";

export type InterventionRecommendedAction =
  | "observe"
  | "coach_same_session"
  | "reask_structured_result"
  | "accept_valid_artifact"
  | "revive_same_session"
  | "restart_fresh"
  | "dispatch_targeted_repair"
  | "escalate_human";

export type FocusIntervention = {
  classification: InterventionClassification;
  confidence: InterventionConfidence;
  recommendedAction: InterventionRecommendedAction;
  reason: string;
  evidence: string[];
  risk: string;
};

const INTERVENTION_RISK: Record<InterventionClassification, string> = {
  valid_artifact_hung_child: "Restart would discard a valid produced artifact; prefer accepting it.",
  schema_failure: "Re-asking may loop if the structured-result contract is still misunderstood.",
  missing_result: "Reviving/restarting without the prior result risks redoing completed work.",
  stale_running_agent: "Killing the child loses in-progress state; revive same session when possible.",
  review_blocker: "Accepting before the blocker is resolved would let unverified work through.",
  human_verification_failed: "Proceeding without a human decision violates human_verification_required.",
  retry_budget_pressure: "Another blind attempt burns budget without diagnosing the root cause.",
  none: "Low risk; continue the normal lifecycle.",
};

function mapClassificationToAction(
  classification: InterventionClassification,
  context: { hasSession: boolean; humanRequired: boolean; resultExists: boolean },
): InterventionRecommendedAction {
  switch (classification) {
    case "valid_artifact_hung_child":
      return "accept_valid_artifact";
    case "schema_failure":
      return "reask_structured_result";
    case "missing_result":
      return context.hasSession ? "revive_same_session" : "restart_fresh";
    case "stale_running_agent":
      return context.hasSession ? "revive_same_session" : "restart_fresh";
    case "review_blocker":
      return context.humanRequired ? "escalate_human" : "dispatch_targeted_repair";
    case "human_verification_failed":
      return "escalate_human";
    case "retry_budget_pressure":
      return "escalate_human";
    case "none":
    default:
      return "observe";
  }
}

function computeIntervention(input: {
  run: AgentRunRecord;
  failureClasses: string[];
  resultArtifact: ReturnType<typeof summarizeArtifact>;
  relatedEscalations: EscalationRecord[];
  hasSession: boolean;
  retryCount?: number;
}): FocusIntervention {
  const classes = new Set(input.failureClasses);
  const resultExists = Boolean(input.resultArtifact.exists);
  const humanRequired = input.relatedEscalations.some((item) => item.level === "human_required");
  const hasArtifactOrEscalationSignal =
    resultExists ||
    input.relatedEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level));

  const priority = focusPriority({
    blocked: input.relatedEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level)),
    highRetry: (input.retryCount ?? input.run.attempt ?? 1) >= 5,
    latestRunFailed: ["failed", "stale"].includes(input.run.status),
    failureClasses: input.failureClasses,
  });

  // First-match-wins priority order. valid_artifact_hung_child must win over generic
  // stale/missing classes so a recoverable artifact is never downgraded to restart churn.
  let classification: InterventionClassification = "none";
  let reason = "";
  if (classes.has("child_idle_timeout") && resultExists) {
    classification = "valid_artifact_hung_child";
    reason = "Child idle-timed-out but a valid structured result artifact already exists; accept it rather than restarting.";
  } else if (classes.has("child_idle_timeout")) {
    classification = "stale_running_agent";
    reason = "Child idle-timed-out with no result artifact produced; the agent is stalled.";
  } else if (classes.has("agent_event_parse_errors")) {
    classification = "schema_failure";
    reason = "Agent event stream contains parse errors; the structured-result contract was not honoured.";
  } else if (classes.has("missing_structured_result") && !resultExists) {
    classification = "missing_result";
    reason = "Run ended without a structured result artifact; re-ask or revive for a final structured result.";
  } else if (classes.has("quiet_running_agent") || classes.has("run_stale")) {
    classification = "stale_running_agent";
    reason = "Agent appears quiet/stale with no recent progress signals.";
  } else if (humanRequired) {
    classification = "human_verification_failed";
    reason = "A human_required escalation is active; human verification/decision is needed before proceeding.";
  } else if (classes.has("active_blocker")) {
    classification = "review_blocker";
    reason = "An active blocker/critical escalation is open against this work; resolve it before accepting.";
  } else if (classes.has("run_failed") && classes.has("command_failed")) {
    classification = resultExists ? "none" : "missing_result";
    reason = resultExists
      ? "Run failed on a command but a result artifact exists; coach in-session on the failing command."
      : "Run failed on a command and produced no result artifact; coach in-session on the failing command.";
  } else if ((input.retryCount ?? input.run.attempt ?? 1) >= 5) {
    classification = "retry_budget_pressure";
    reason = "Retry budget is exhausted (attempt >= 5); escalate for diagnosis before another attempt.";
  } else if (input.failureClasses.length === 0 && input.run.status === "completed") {
    classification = "none";
    reason = "Run completed with no failure classes; observe and continue the normal lifecycle.";
  } else if (input.failureClasses.length === 0) {
    classification = "none";
    reason = "No failure classes detected.";
  } else {
    classification = "missing_result";
    reason = "Unclassified failure signals present; treat as missing/incomplete result.";
  }

  let recommendedAction = mapClassificationToAction(classification, {
    hasSession: input.hasSession,
    humanRequired,
    resultExists,
  });
  // run_failed + command_failed but artifact present: coach in-session rather than churn.
  if (classes.has("run_failed") && classes.has("command_failed") && classification !== "valid_artifact_hung_child") {
    recommendedAction = "coach_same_session";
  }

  let confidence: InterventionConfidence;
  if (classification === "none") {
    confidence = input.run.status === "completed" ? "high" : "low";
  } else if (hasArtifactOrEscalationSignal && priority >= 25) {
    confidence = "high";
  } else if (priority > 0) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  const evidence: string[] = [];
  evidence.push(input.run.id);
  if (input.run.resultPath) evidence.push(input.run.resultPath);
  if (input.run.eventsPath) evidence.push(input.run.eventsPath);
  for (const escalation of input.relatedEscalations) evidence.push(escalation.id);

  return {
    classification,
    confidence,
    recommendedAction,
    reason,
    evidence: [...new Set(evidence)],
    risk: INTERVENTION_RISK[classification],
  };
}

function recommendSliceInterventions(slice: SliceRecord, runs: AgentRunRecord[], activeEscalations: EscalationRecord[]): string[] {
  const recommendations: string[] = [];
  const latestRun = runs.at(-1);
  const retryCount = sliceRetryCount(runs);
  if (activeEscalations.some((item) => ["blocker", "human_required", "critical"].includes(item.level))) {
    recommendations.push("Resolve scoped blockers before accepting or feeding dependent lanes.");
  }
  if (!latestRun && ["ready", "claimed", "candidate"].includes(slice.status)) recommendations.push("Dispatch the worker for the ready slice.");
  if (latestRun?.status === "failed" || latestRun?.status === "stale") recommendations.push("Inspect the latest failed/stale run focus packet before revive or restart.");
  if (retryCount >= 5 && !["accepted", "closed"].includes(slice.status)) recommendations.push("Highlight this slice as high-retry and require overseer diagnosis before another attempt.");
  if (slice.status === "implemented" || slice.status === "ready_for_review") recommendations.push("Dispatch independent review if no review is already running.");
  if (recommendations.length === 0) recommendations.push("Continue the normal slice lifecycle.");
  return recommendations;
}

function sliceRetryCount(runs: AgentRunRecord[]): number {
  return runs.reduce((highest, run) => Math.max(highest, run.attempt ?? 1), runs.length);
}

function readTargetGitStatus(targetPath: string): Record<string, unknown> {
  const safePath = formatGitSafeDirectoryPath(targetPath);
  const args = ["-c", `safe.directory=${safePath}`, "-C", targetPath, "status", "--short"];
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 10000 });
  return {
    command: `git -c safe.directory=${safePath} -C ${targetPath} status --short`,
    exitCode: result.status,
    stdout: trimOutput(result.stdout ?? "", 2000),
    stderr: trimOutput(result.stderr ?? "", 2000),
  };
}

function readTextTail(filePath: string, maxLength: number): string {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.length <= maxLength) return content;
  return content.slice(content.length - maxLength);
}

export function buildOverseerFocusQueue(input: {
  store: SwarmStore;
  workspace: string;
  snapshot: { slices: Array<{ id: string; title: string; status: string }> };
  cli: string;
}) {
  const activeSlices = input.snapshot.slices.filter((slice) => !["accepted", "closed"].includes(slice.status));
  return activeSlices
    .map((slice) => {
      try {
        return summarizeSliceFocusForPrompt(buildSliceFocusPacket(input.store, input.workspace, slice.id, { runLimit: 5, eventLimit: 8 }), input.cli);
      } catch (error) {
        return {
          needsFocus: true,
          priority: 90,
          reason: "focus_packet_error",
          sliceId: slice.id,
          title: slice.title,
          status: slice.status,
          inspectSliceCommand: `${input.cli} inspect slice ${slice.id}`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .filter((item) => item.needsFocus)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 5)
    .map(({ needsFocus, priority, ...item }) => ({ ...item, focusPriority: priority }));
}

export function buildAgentFocusQueue(input: { store: SwarmStore; workspace: string; cli: string }) {
  return input.store
    .listAgentRuns()
    .filter((run) => ["running", "failed", "stale"].includes(run.status))
    .map((run) => {
      try {
        return summarizeRunFocusForPrompt(buildRunFocusPacket(input.store, input.workspace, run.id, { eventLimit: 8 }), input.cli);
      } catch (error) {
        return {
          needsFocus: true,
          priority: 90,
          reason: "run_focus_packet_error",
          runId: run.id,
          actor: run.actor,
          role: run.role,
          status: run.status,
          inspectRunCommand: `${input.cli} inspect run ${run.id}`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .filter((item) => item.needsFocus)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 8)
    .map(({ needsFocus, priority, ...item }) => ({ ...item, focusPriority: priority }));
}

export function summarizeRunFocusForPrompt(packet: RunFocusPacket, cli: string) {
  const failureClasses = packet.diagnosis.failureClasses ?? [];
  const latestRunFailed = ["failed", "stale"].includes(packet.run.status);
  const needsFocus = latestRunFailed || failureClasses.length > 0;
  const lastCommand = packet.latestSignals.lastCommand;
  const reasons = [latestRunFailed ? `run_${packet.run.status}` : undefined, ...failureClasses].filter((item): item is string =>
    Boolean(item),
  );

  return {
    needsFocus,
    priority: focusPriority({ blocked: false, highRetry: false, latestRunFailed, failureClasses }),
    reason: reasons.join(", ") || "none",
    runId: packet.run.id,
    actor: packet.run.actor,
    role: packet.run.role,
    status: packet.run.status,
    entityType: packet.run.entityType,
    entityId: packet.run.entityId,
    sliceId: packet.run.sliceId,
    inspectRunCommand: `${cli} inspect run ${packet.run.id}`,
    heartbeatState: packet.heartbeat?.state,
    heartbeatAgeMs: packet.heartbeat?.ageMs,
    promptPath: packet.artifacts.prompt.path,
    resultExists: packet.artifacts.result.exists,
    stderrExists: packet.artifacts.stderr.exists,
    eventStreamExists: packet.eventStream.exists,
    eventLineCount: packet.eventStream.lineCount,
    lastCommand: lastCommand
      ? {
          command: clipText(lastCommand.command ?? "", 260),
          status: lastCommand.status,
          exitCode: lastCommand.exitCode,
          outputTail: clipText(lastCommand.outputTail ?? "", 500),
        }
      : undefined,
    recommendedInterventions: [...new Set(packet.diagnosis.recommendedInterventions)].slice(0, 6),
  };
}

export function summarizeSliceFocusForPrompt(packet: SliceFocusPacket, cli: string) {
  const latest = packet.latestRunFocus;
  const failureClasses = latest?.diagnosis.failureClasses ?? [];
  const latestRunFailed = latest ? ["failed", "stale"].includes(latest.run.status) : false;
  const highRetry = packet.diagnosis.retryCount >= 5;
  const blocked = packet.diagnosis.blocked;
  const quiet = failureClasses.includes("quiet_running_agent");
  const needsFocus = blocked || highRetry || latestRunFailed || failureClasses.length > 0 || quiet;
  const reasons = [
    blocked ? "blocked" : undefined,
    highRetry ? "high_retry" : undefined,
    latestRunFailed ? `latest_run_${latest?.run.status}` : undefined,
    ...failureClasses,
  ].filter((item): item is string => Boolean(item));
  const lastCommand = latest?.latestSignals.lastCommand;
  const recommendations = [
    ...packet.diagnosis.recommendedInterventions,
    ...(latest?.diagnosis.recommendedInterventions ?? []),
  ];

  return {
    needsFocus,
    priority: focusPriority({ blocked, highRetry, latestRunFailed, failureClasses }),
    reason: reasons.join(", ") || "none",
    sliceId: packet.slice.id,
    title: packet.slice.title,
    status: packet.slice.status,
    laneName: packet.lane?.name,
    targetName: packet.target?.name,
    retryCount: packet.diagnosis.retryCount,
    inspectSliceCommand: `${cli} inspect slice ${packet.slice.id}`,
    inspectRunCommand: latest ? `${cli} inspect run ${latest.run.id}` : undefined,
    latestRun: latest
      ? {
          id: latest.run.id,
          role: latest.run.role,
          actor: latest.run.actor,
          status: latest.run.status,
          attempt: latest.run.attempt,
          sessionIdCaptured: Boolean(latest.run.sessionId),
          heartbeatState: latest.heartbeat?.state,
          heartbeatAgeMs: latest.heartbeat?.ageMs,
          promptPath: latest.artifacts.prompt.path,
          resultExists: latest.artifacts.result.exists,
          stderrExists: latest.artifacts.stderr.exists,
          eventStreamExists: latest.eventStream.exists,
          eventLineCount: latest.eventStream.lineCount,
          lastCommand: lastCommand
            ? {
                command: clipText(lastCommand.command ?? "", 260),
                status: lastCommand.status,
                exitCode: lastCommand.exitCode,
                outputTail: clipText(lastCommand.outputTail ?? "", 500),
              }
            : undefined,
        }
      : undefined,
    activeEscalations: packet.activeEscalations.slice(0, 5),
    recommendedInterventions: [...new Set(recommendations)].slice(0, 6),
  };
}

export function focusPriority(input: {
  blocked: boolean;
  highRetry: boolean;
  latestRunFailed: boolean;
  failureClasses: string[];
}): number {
  let priority = 0;
  if (input.blocked) priority += 40;
  if (input.latestRunFailed) priority += 30;
  if (input.highRetry) priority += 20;
  if (input.failureClasses.includes("missing_structured_result")) priority += 18;
  if (input.failureClasses.includes("command_failed")) priority += 16;
  if (input.failureClasses.includes("child_idle_timeout")) priority += 25;
  if (input.failureClasses.includes("quiet_before_first_action")) priority += 14;
  if (input.failureClasses.includes("quiet_running_agent")) priority += 12;
  if (input.failureClasses.includes("active_blocker")) priority += 10;
  if (input.failureClasses.includes("run_stale")) priority += 10;
  return priority;
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
