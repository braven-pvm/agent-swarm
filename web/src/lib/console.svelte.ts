import type {
  SnapshotResponse, HarnessEvent, HeartbeatRecord, AgentActivity, SelectedEntity, CoverageSummary,
  AgentFocusItem, CheckpointRecord,
} from "~/lib/types";
import { groupEscalations, humanizeToken, cleanSliceTitle, type EscalationGroup } from "~/lib/format";
import type { HumanActionItem, HumanActionQueue } from "~/lib/human-actions";
import type { ControlCommand, DevServer } from "~/lib/control";
import { commandKindLabel } from "~/lib/control";
import { skillsOf } from "~/lib/skills";

// A transient toast for a GENUINELY NEW human action (an id present on a later poll that was not
// seen on any prior poll). Holds the id (dedupe + selectAction target) + the action itself (title
// + summary + severity for rendering). The Toaster owns the auto-dismiss timer; the store just
// holds the list and exposes dismissToast(id).
export interface ActionToast {
  id: string;
  action: HumanActionItem;
}

export interface AgentRosterRow {
  actor: string;
  role?: string;
  driver?: string;
  state: string;
  now: string;            // latest activity label
  nowTarget?: string;     // raw command target from the newest agent_event (for semantic summary)
  next?: string;          // next intended action (from checkpoint, matched by createdBy === actor)
  stallMs?: number;       // ms since last heartbeat when stale (> 5m), else undefined
  runtimeMs?: number;     // duration of the latest agent run for this actor
  latest: string;         // heartbeat timestamp
  runStatus?: string;
  sliceId?: string;       // id of the slice the latest run is bound to (undefined for slice-less actors, e.g. overseer)
  sliceTitle?: string;    // title of that bound slice
  frAcRefs?: string[];    // FR/AC refs that slice owns
  // Per-agent focus (engine triage): WHY this agent needs attention. Only set when a focus item
  // matched this actor in snapshot.agentFocusQueue (the highest-priority item for the actor).
  focusReason?: string;
  recommendedInterventions?: string[];
  focusPriority?: number;
  // Count of protocol skills bound to the LATEST run (skillsOf(latest)?.count). Undefined
  // when the latest run carries no skill binding (historical / pre-Phase-10D) → neutral.
  skillCount?: number;
}

export interface ProofChainRow {
  ref: string;
  leaseStatus?: string;
  verification?: { status: string; proof: string };
  reviewFinding?: { status: string; finding: string };
  citations: string[];
}

// ── Overseer loop log ───────────────────────────────────────────────────
// The overseer panel's recent-decisions list. We collapse the raw overseer event
// stream into a compact, newest-first list where CONSECUTIVE identical event types
// fold into one row carrying a ×N count (so three 'Command completed' in a row read
// as one 'Command completed ×3' line, not three equal chips). Decision events prefer
// the human-written decision summary from the matching checkpoint/payload.

export interface OverseerLogRow {
  id: string;          // newest event id in the run — the click target (onSelect)
  type: string;        // raw overseer.* event type (e.g. "overseer.command_completed")
  action: string;      // humanized action label ("Command completed")
  summary?: string;    // per-event detail: command subject + exit, decision summary, counts, next action
  ts: string;          // newest event timestamp in the run (ISO)
  count: number;       // how many consecutive same-type events folded in
}

// A non-heartbeat overseer event is a loop event (the heartbeat-activity stream,
// 'overseer.agent_event', is the per-agent feed shown elsewhere — not the loop log).
function isOverseerLoopEvent(e: HarnessEvent): boolean {
  return e.type.startsWith("overseer.") && e.type !== "overseer.agent_event";
}

// Resolve a decision summary for a decision event: prefer an explicit summary on the
// event payload, else fall back to the overseer checkpoint nearest in time (same actor),
// else the most recent overseer checkpoint summary.
function decisionSummary(ev: HarnessEvent, checkpoints: CheckpointRecord[]): string | undefined {
  const p = ev.payload as Record<string, unknown> | undefined;
  const inline = (p?.summary ?? p?.decision ?? p?.nextIntendedAction) as string | undefined;
  if (typeof inline === "string" && inline.trim()) return inline.trim();
  const overseerCps = checkpoints
    .filter((c) => c.role === "overseer" || c.createdBy === ev.actor)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  // nearest checkpoint at or before the event, else the most recent overseer checkpoint
  const at = overseerCps.find((c) => c.updatedAt <= ev.timestamp) ?? overseerCps[0];
  const s = at?.summary?.trim();
  return s || undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
// Concise "meat" for a loop event — WHAT command/decision/turn it actually was, pulled
// from the event payload, so "Command completed" reads "review SLICE-… (reviewer) · exit 0"
// and "Completed" reads its chosen next action instead of a bare label.
function eventDetail(ev: HarnessEvent, checkpoints: CheckpointRecord[]): string | undefined {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "overseer.decision_recorded":
      return decisionSummary(ev, checkpoints);
    case "overseer.command_started":
    case "overseer.command_completed": {
      let label = [asStr(p.commandKey), asStr(p.sliceId)].filter(Boolean).join(" ");
      const role = asStr(p.childRole);
      if (role) label = label ? `${label} (${role})` : role;
      if (ev.type === "overseer.command_completed" && p.exitCode != null) label += `${label ? " · " : ""}exit ${p.exitCode}`;
      return label || asStr(p.purpose);
    }
    case "overseer.commands_completed": {
      const ex = Number(p.executed ?? 0), bl = Number(p.blocked ?? 0), fa = Number(p.failed ?? 0);
      const parts = [`${ex} executed`];
      if (bl) parts.push(`${bl} blocked`);
      if (fa) parts.push(`${fa} failed`);
      return parts.join(", ");
    }
    case "overseer.completed":
      return asStr(p.nextAction) ?? asStr(p.status);
    case "overseer.started":
      return p.attempt != null ? `attempt ${p.attempt}` : undefined;
    default:
      return undefined;
  }
}

/**
 * Build the overseer loop log from the raw event stream (ASC by timestamp) and the
 * checkpoints. Each row carries concise per-event detail (command subject + exit code,
 * decision summary, executed counts, next action). Only TRULY identical consecutive rows
 * (same type AND same detail) fold into one ×N row. Returned NEWEST-FIRST. Pure.
 */
export function buildOverseerLog(
  events: HarnessEvent[],
  checkpoints: CheckpointRecord[],
  humanize: (s: string) => string,
): OverseerLogRow[] {
  const loop = events.filter(isOverseerLoopEvent);
  const rows: OverseerLogRow[] = [];
  for (const ev of loop) {
    const detail = eventDetail(ev, checkpoints);
    const last = rows[rows.length - 1];
    // Fold only TRUE repeats (same type AND same detail) so distinct commands keep their meat.
    if (last && last.type === ev.type && last.summary === detail) {
      last.count += 1;
      last.id = ev.id;
      last.ts = ev.timestamp;
      continue;
    }
    const bare = ev.type.replace("overseer.", "");
    rows.push({ id: ev.id, type: ev.type, action: humanize(bare) || bare, summary: detail, ts: ev.timestamp, count: 1 });
  }
  return rows.reverse(); // newest-first
}

const MAX_EVENTS = 200;

export function createConsoleStore() {
  let snapshot = $state<SnapshotResponse | null>(null);
  let connected = $state(false);
  let selected = $state<SelectedEntity | null>(null);
  let coverage = $state<CoverageSummary | null>(null);
  // Human Action queue — the operator's write surface. Polled alongside snapshot/coverage and
  // replaced wholesale after every write (the server returns the refreshed queue).
  let humanActions = $state<HumanActionQueue | null>(null);
  // A SEPARATE selection channel for queue actions, kept OUT of the SelectedEntity union so we
  // never touch user-owned types.ts. selectAction(id) opens an action in the inspector and clears
  // the entity selection; select(entity) clears this; either way only one thing is selected.
  let selectedActionId = $state<string | null>(null);

  // ── Local Control API state ──────────────────────────────────────────────
  // Background control commands (continue/revive/restart/scan) + human-review dev servers, polled
  // alongside the snapshot in App.refresh() and replaced wholesale (the server order is preserved).
  let controlCommands = $state<ControlCommand[]>([]);
  let devServers = $state<DevServer[]>([]);

  // ── New-action toasts ──────────────────────────────────────────────────
  // Toasts fire only for GENUINELY NEW action ids — ids seen on a later poll that were never seen
  // before. The FIRST setHumanActions call marks the whole backlog as already-seen and emits NO
  // toasts (we don't yell about pre-existing work on page load). `seenActionIds` is the running
  // set of every id ever observed; `hadFirstLoad` gates the initial silent seed.
  const seenActionIds = new Set<string>();
  let hadFirstLoad = false;
  let toasts = $state<ActionToast[]>([]);

  const escalationGroups = $derived<EscalationGroup[]>(snapshot ? groupEscalations(snapshot.activeEscalations) : []);

  // The action currently open in the inspector, resolved from the live queue by id. Returns null
  // when nothing is selected OR when a resolved action has dropped out of the refreshed queue.
  const selectedAction = $derived(humanActions?.actions?.find((a) => a.id === selectedActionId) ?? null);

  const agents = $derived.by<AgentRosterRow[]>(() => {
    if (!snapshot) return [];
    const byActor = new Map<string, AgentRosterRow>();
    for (const run of snapshot.agentRuns) {
      if (!byActor.has(run.actor)) byActor.set(run.actor, { actor: run.actor, role: run.role, driver: run.driver, state: "idle", now: "—", latest: run.updatedAt, runStatus: run.status });
    }
    for (const hb of snapshot.heartbeats) {
      const row = byActor.get(hb.actor) ?? { actor: hb.actor, state: hb.state, now: hb.detail ?? "—", latest: hb.timestamp };
      row.state = hb.state;
      row.now = hb.detail ?? row.now;
      row.latest = hb.timestamp;
      byActor.set(hb.actor, row);
    }
    // newest agent_event per actor refines the "now:" narrative
    const seenActor = new Set<string>();
    for (let i = snapshot.recentEvents.length - 1; i >= 0; i -= 1) {
      const ev = snapshot.recentEvents[i];
      if (!ev.type.endsWith("agent_event") || seenActor.has(ev.actor)) continue;
      seenActor.add(ev.actor); // first hit per actor = newest agent_event for that actor
      const activity = ev.payload?.activity as AgentActivity | undefined;
      const row = byActor.get(ev.actor);
      if (row && activity && ev.timestamp >= row.latest) {
        row.now = activity.label;
        row.state = activity.state;
        row.nowTarget = activity.target ?? undefined;
      }
    }
    // Per-agent focus triage: keep the highest-focusPriority item per actor (the engine's reason
    // this agent needs attention). Empty queue / no match for an actor → no focus on that row.
    const focusByActor = new Map<string, AgentFocusItem>();
    for (const item of snapshot.agentFocusQueue ?? []) {
      const prev = focusByActor.get(item.actor);
      if (!prev || item.focusPriority > prev.focusPriority) focusByActor.set(item.actor, item);
    }
    // enrich: next-action from checkpoint (matched by createdBy), stall if heartbeat is old
    const nowMs = Date.now();
    for (const row of byActor.values()) {
      const cp = snapshot.checkpoints.find((c) => c.createdBy === row.actor);
      if (cp) row.next = (cp.payload as Record<string, unknown>).nextIntendedAction as string | undefined;
      const ageMs = nowMs - Date.parse(row.latest);
      // per-actor runtime + canonical status: the LATEST run by startedAt (not the first seen).
      const actorRuns = snapshot.agentRuns.filter((r) => r.actor === row.actor);
      if (actorRuns.length > 0) {
        const latest = actorRuns.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b));
        row.runStatus = latest.status;
        // Protocol skills bound to this latest run (additive/optional on the run record;
        // read via skillsOf so we never touch the shared AgentRunRecord type). Undefined
        // when the run has no binding → the roster renders no skill chip (neutral).
        row.skillCount = skillsOf(latest)?.count;
        const endMs = latest.status === "running" ? nowMs : Date.parse(latest.updatedAt);
        const rt = endMs - Date.parse(latest.startedAt);
        if (Number.isFinite(rt)) row.runtimeMs = rt;
        // Bind the work: the slice this latest run belongs to. Guard — overseer / heartbeat-only
        // verifiers may reference no real slice, so only set when a matching slice exists.
        const slc = snapshot.slices.find((s) => s.id === latest.sliceId);
        if (slc) {
          row.sliceId = slc.id;
          row.sliceTitle = cleanSliceTitle(slc.title);
          row.frAcRefs = slc.frAcRefs;
        }
      }
      // Attach per-agent focus (if any) — the reason + recommended interventions for this actor.
      const focus = focusByActor.get(row.actor);
      if (focus) {
        row.focusReason = focus.reason;
        row.recommendedInterventions = focus.recommendedInterventions;
        row.focusPriority = focus.focusPriority;
      }
      // Stall only matters for a live run that has gone silent — a finished/absent run that hasn't
      // signalled in a while is idle, not stalled.
      if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000 && row.runStatus === "running") row.stallMs = ageMs;
    }
    return Array.from(byActor.values()).sort((a, b) => a.actor.localeCompare(b.actor));
  });

  // The overseer agent row (role 'overseer'; normally exactly one, actor like 'live-overseer').
  // Drives the persistent 'Overseer now' header — null when no overseer agent is present.
  const overseer = $derived<AgentRosterRow | null>(agents.find((r) => r.role === "overseer") ?? null);

  // Latest overseer checkpoint summary — the fallback 'now' line when no overseer agent exists.
  const overseerCheckpointSummary = $derived.by<string | null>(() => {
    const cps = (snapshot?.checkpoints ?? []).filter((c) => c.role === "overseer");
    if (cps.length === 0) return null;
    const latest = cps.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
    return latest.summary?.trim() || null;
  });

  // The compact, deduped, newest-first overseer loop log (see buildOverseerLog).
  const overseerLog = $derived.by<OverseerLogRow[]>(() =>
    snapshot ? buildOverseerLog(snapshot.recentEvents, snapshot.checkpoints, humanizeToken) : [],
  );

  return {
    get snapshot() { return snapshot; },
    get connected() { return connected; },
    get selected() { return selected; },
    get escalationGroups() { return escalationGroups; },
    get agents() { return agents; },
    get overseer() { return overseer; },
    get overseerCheckpointSummary() { return overseerCheckpointSummary; },
    get overseerLog() { return overseerLog; },
    get coverage() { return coverage; },
    get humanActions() { return humanActions; },
    get selectedAction() { return selectedAction; },
    get toasts() { return toasts; },
    get controlCommands() { return controlCommands; },
    get devServers() { return devServers; },
    // Newest-first view of the control feed, regardless of server order (id/startedAt may both be
    // present; prefer startedAt, fall back to a stable tail-first reverse).
    get controlCommandsNewestFirst() {
      const byStart = controlCommands.every((c) => c.startedAt);
      if (byStart) return [...controlCommands].sort((a, b) => (a.startedAt! < b.startedAt! ? 1 : a.startedAt! > b.startedAt! ? -1 : 0));
      return [...controlCommands].reverse();
    },
    get runningControlCommands() { return controlCommands.filter((c) => c.status === "running"); },
    commandKindLabel(kind: string | undefined) { return commandKindLabel(kind); },
    hydrate(s: SnapshotResponse) { snapshot = s; },
    setConnected(v: boolean) { connected = v; },
    // Selecting an entity clears any open action, so only one inspector body shows at a time.
    select(entity: SelectedEntity | null) { selected = entity; selectedActionId = null; },
    // Selecting an action clears the entity selection (same mutual-exclusion rule).
    selectAction(id: string | null) { selectedActionId = id; selected = null; },
    setCoverage(c: CoverageSummary) { coverage = c; },
    setControlCommands(c: ControlCommand[]) { controlCommands = Array.isArray(c) ? c : []; },
    setDevServers(s: DevServer[]) { devServers = Array.isArray(s) ? s : []; },
    setHumanActions(q: HumanActionQueue) {
      humanActions = q;
      const actions = q?.actions ?? [];
      if (!hadFirstLoad) {
        // First load: seed the seen-set silently so the initial backlog never toasts.
        for (const a of actions) seenActionIds.add(a.id);
        hadFirstLoad = true;
        return;
      }
      // Later polls: any id we've never seen is genuinely new → push a toast (newest first).
      const fresh: ActionToast[] = [];
      for (const a of actions) {
        if (seenActionIds.has(a.id)) continue;
        seenActionIds.add(a.id);
        fresh.push({ id: a.id, action: a });
      }
      if (fresh.length > 0) toasts = [...fresh, ...toasts];
    },
    dismissToast(id: string) {
      toasts = toasts.filter((t) => t.id !== id);
    },
    invalidate() { /* App re-fetches snapshot and calls hydrate(); see App.svelte */ },
    applyEvent(event: HarnessEvent) {
      if (!snapshot) return;
      const next = [...snapshot.recentEvents, event];
      snapshot = { ...snapshot, recentEvents: next.slice(-MAX_EVENTS) };
    },
    applyHeartbeat(hb: HeartbeatRecord) {
      if (!snapshot) return;
      const heartbeats = [...snapshot.heartbeats];
      const idx = heartbeats.findIndex((h) => h.id === hb.id);
      if (idx >= 0) { if (hb.timestamp >= heartbeats[idx].timestamp) heartbeats[idx] = hb; }
      else heartbeats.push(hb);
      snapshot = { ...snapshot, heartbeats };
    },
    proofChainFor(sliceId: string): ProofChainRow[] {
      const slice = snapshot?.slices.find((s) => s.id === sliceId);
      if (!slice) return [];
      return slice.frAcRefs.map((ref) => {
        const lease = slice.leases.find((l) => l.frAcRef === ref);
        const verification = slice.frAcResults.find((r) => r.ref === ref);
        const finding = slice.reviewResult?.frAcFindings.find((f) => f.ref === ref);
        return {
          ref,
          leaseStatus: lease?.status,
          verification: verification ? { status: verification.status, proof: verification.proof } : undefined,
          reviewFinding: finding ? { status: finding.status, finding: finding.finding } : undefined,
          citations: finding?.evidence ?? [],
        };
      });
    },
  };
}

export type ConsoleStore = ReturnType<typeof createConsoleStore>;
