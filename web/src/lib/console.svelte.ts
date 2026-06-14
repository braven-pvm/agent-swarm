import type {
  SnapshotResponse, HarnessEvent, HeartbeatRecord, AgentActivity, SelectedEntity,
} from "~/lib/types";
import { groupEscalations, type EscalationGroup } from "~/lib/format";

export interface AgentRosterRow {
  actor: string;
  role?: string;
  driver?: string;
  state: string;
  now: string;            // latest activity label
  next?: string;          // next intended action (from checkpoint, matched by createdBy === actor)
  stallMs?: number;       // ms since last heartbeat when stale (> 5m), else undefined
  latest: string;         // heartbeat timestamp
  runStatus?: string;
}

export interface ProofChainRow {
  ref: string;
  leaseStatus?: string;
  verification?: { status: string; proof: string };
  reviewFinding?: { status: string; finding: string };
  citations: string[];
}

const MAX_EVENTS = 200;

export function createConsoleStore() {
  let snapshot = $state<SnapshotResponse | null>(null);
  let connected = $state(false);
  let selected = $state<SelectedEntity | null>(null);

  const escalationGroups = $derived<EscalationGroup[]>(snapshot ? groupEscalations(snapshot.activeEscalations) : []);

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
    for (let i = snapshot.recentEvents.length - 1; i >= 0; i -= 1) {
      const ev = snapshot.recentEvents[i];
      if (!ev.type.endsWith("agent_event")) continue;
      const activity = ev.payload?.activity as AgentActivity | undefined;
      const row = byActor.get(ev.actor);
      if (row && activity && ev.timestamp >= row.latest) { row.now = activity.label; row.state = activity.state; }
    }
    // enrich: next-action from checkpoint (matched by createdBy), stall if heartbeat is old
    const nowMs = Date.now();
    for (const row of byActor.values()) {
      const cp = snapshot.checkpoints.find((c) => c.createdBy === row.actor);
      if (cp) row.next = (cp.payload as Record<string, unknown>).nextIntendedAction as string | undefined;
      const ageMs = nowMs - Date.parse(row.latest);
      if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) row.stallMs = ageMs;
    }
    return Array.from(byActor.values()).sort((a, b) => a.actor.localeCompare(b.actor));
  });

  return {
    get snapshot() { return snapshot; },
    get connected() { return connected; },
    get selected() { return selected; },
    get escalationGroups() { return escalationGroups; },
    get agents() { return agents; },
    hydrate(s: SnapshotResponse) { snapshot = s; },
    setConnected(v: boolean) { connected = v; },
    select(entity: SelectedEntity | null) { selected = entity; },
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
