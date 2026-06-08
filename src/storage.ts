import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { artifactsDir, stateDbPath, swarmDir } from "./paths.js";
import type {
  DependencyEdge,
  EscalationRecord,
  EvidenceRecord,
  HarnessEvent,
  HeartbeatRecord,
  LaneRecord,
  LeaseRecord,
  SliceRecord,
  SourceRecord,
} from "./types.js";

type Row = Record<string, unknown>;

export class SwarmStore {
  private readonly db: Database.Database;

  constructor(readonly workspace: string) {
    const dbPath = stateDbPath(workspace);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  init(): void {
    fs.mkdirSync(swarmDir(this.workspace), { recursive: true });
    fs.mkdirSync(artifactsDir(this.workspace), { recursive: true });
    this.db.exec(`
      create table if not exists meta (
        key text primary key,
        value text not null
      );

      create table if not exists targets (
        id text primary key,
        path text not null unique,
        name text not null,
        config_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists sources (
        id text primary key,
        adapter_id text not null,
        kind text not null,
        uri text not null unique,
        title text not null,
        hash text not null,
        metadata_json text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists lanes (
        id text primary key,
        name text not null,
        purpose text not null,
        focus_labels_json text not null,
        target_id text not null,
        orchestrator text not null,
        worktree text not null,
        state text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists slices (
        id text primary key,
        lane_id text not null,
        target_id text not null,
        title text not null,
        status text not null,
        source_refs_json text not null,
        fr_ac_refs_json text not null,
        scope_json text not null,
        out_of_scope_json text not null,
        verification_requirements_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists leases (
        id text primary key,
        fr_ac_ref text not null,
        slice_id text not null,
        lane_id text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create unique index if not exists active_lease_idx
        on leases(fr_ac_ref)
        where status = 'active';

      create table if not exists dependencies (
        id text primary key,
        from_type text not null,
        from_id text not null,
        target text not null,
        reason text not null,
        status text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists events (
        id text primary key,
        timestamp text not null,
        actor text not null,
        type text not null,
        entity_type text not null,
        entity_id text not null,
        payload_json text not null
      );

      create table if not exists heartbeats (
        id text primary key,
        actor text not null,
        state text not null,
        detail text,
        entity_type text,
        entity_id text,
        timestamp text not null
      );

      create table if not exists evidence (
        id text primary key,
        slice_id text not null,
        kind text not null,
        summary text not null,
        ref text,
        payload_json text not null,
        created_at text not null
      );

      create table if not exists escalations (
        id text primary key,
        level text not null,
        status text not null,
        entity_type text not null,
        entity_id text not null,
        message text not null,
        reason text,
        created_by text not null,
        cleared_by text,
        created_at text not null,
        updated_at text not null
      );
    `);
    this.setMeta("schema_version", "1");
    this.ensureColumn("sources", "metadata_json", "text");
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("insert or replace into meta (key, value) values (?, ?)")
      .run(key, value);
  }

  addEvent(event: HarnessEvent): void {
    this.db
      .prepare(
        `insert into events (id, timestamp, actor, type, entity_type, entity_id, payload_json)
         values (@id, @timestamp, @actor, @type, @entityType, @entityId, @payloadJson)`,
      )
      .run({ ...event, payloadJson: JSON.stringify(event.payload) });
  }

  addOrUpdateTarget(input: {
    id: string;
    path: string;
    name: string;
    config: unknown;
    now: string;
  }): void {
    this.db
      .prepare(
        `insert into targets (id, path, name, config_json, created_at, updated_at)
         values (@id, @path, @name, @configJson, @now, @now)
         on conflict(path) do update set
           name = excluded.name,
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run({ ...input, configJson: JSON.stringify(input.config) });
  }

  addOrUpdateSource(source: SourceRecord): void {
    this.db
      .prepare(
        `insert into sources (id, adapter_id, kind, uri, title, hash, metadata_json, created_at, updated_at)
         values (@id, @adapterId, @kind, @uri, @title, @hash, @metadataJson, @createdAt, @updatedAt)
         on conflict(uri) do update set
           title = excluded.title,
           hash = excluded.hash,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run({ ...source, metadataJson: JSON.stringify(source.metadata ?? {}) });
  }

  listSources(): SourceRecord[] {
    return this.db
      .prepare("select * from sources order by created_at asc")
      .all()
      .map((row) => mapSource(row as Row));
  }

  listTargets(): Array<{ id: string; path: string; name: string }> {
    return this.db
      .prepare("select id, path, name from targets order by created_at asc")
      .all() as Array<{ id: string; path: string; name: string }>;
  }

  targetById(id: string): { id: string; path: string; name: string } | undefined {
    return this.db
      .prepare("select id, path, name from targets where id = ?")
      .get(id) as { id: string; path: string; name: string } | undefined;
  }

  firstTarget(): { id: string; path: string; name: string } | undefined {
    return this.db
      .prepare("select id, path, name from targets order by created_at asc limit 1")
      .get() as { id: string; path: string; name: string } | undefined;
  }

  activeLeaseFor(frAcRef: string): LeaseRecord | undefined {
    const row = this.db
      .prepare("select * from leases where fr_ac_ref = ? and status = 'active'")
      .get(frAcRef) as Row | undefined;
    return row ? mapLease(row) : undefined;
  }

  latestLeaseFor(frAcRef: string): LeaseRecord | undefined {
    const row = this.db
      .prepare(
        `select * from leases
         where fr_ac_ref = ?
         order by
           case status when 'active' then 0 when 'completed' then 1 else 2 end,
           updated_at desc
         limit 1`,
      )
      .get(frAcRef) as Row | undefined;
    return row ? mapLease(row) : undefined;
  }

  insertLane(lane: LaneRecord): void {
    this.db
      .prepare(
        `insert into lanes (id, name, purpose, focus_labels_json, target_id, orchestrator, worktree, state, created_at, updated_at)
         values (@id, @name, @purpose, @focusLabelsJson, @targetId, @orchestrator, @worktree, @state, @createdAt, @updatedAt)`,
      )
      .run({ ...lane, focusLabelsJson: JSON.stringify(lane.focusLabels) });
  }

  firstActiveLaneForTarget(targetId: string): LaneRecord | undefined {
    const row = this.db
      .prepare("select * from lanes where target_id = ? and state = 'active' order by created_at asc limit 1")
      .get(targetId) as Row | undefined;
    return row ? mapLane(row) : undefined;
  }

  updateLaneState(id: string, state: LaneRecord["state"]): void {
    this.db
      .prepare("update lanes set state = ?, updated_at = ? where id = ?")
      .run(state, new Date().toISOString(), id);
  }

  insertSlice(slice: SliceRecord): void {
    this.db
      .prepare(
        `insert into slices (id, lane_id, target_id, title, status, source_refs_json, fr_ac_refs_json, scope_json, out_of_scope_json, verification_requirements_json, created_at, updated_at)
         values (@id, @laneId, @targetId, @title, @status, @sourceRefsJson, @frAcRefsJson, @scopeJson, @outOfScopeJson, @verificationRequirementsJson, @createdAt, @updatedAt)`,
      )
      .run({
        ...slice,
        sourceRefsJson: JSON.stringify(slice.sourceRefs),
        frAcRefsJson: JSON.stringify(slice.frAcRefs),
        scopeJson: JSON.stringify(slice.scope),
        outOfScopeJson: JSON.stringify(slice.outOfScope),
        verificationRequirementsJson: JSON.stringify(slice.verificationRequirements),
      });
  }

  insertLease(lease: LeaseRecord): void {
    this.db
      .prepare(
        `insert into leases (id, fr_ac_ref, slice_id, lane_id, status, created_at, updated_at)
         values (@id, @frAcRef, @sliceId, @laneId, @status, @createdAt, @updatedAt)`,
      )
      .run(lease);
  }

  insertDependency(edge: DependencyEdge): void {
    this.db
      .prepare(
        `insert into dependencies (id, from_type, from_id, target, reason, status, created_at, updated_at)
         values (@id, @fromType, @fromId, @target, @reason, @status, @createdAt, @updatedAt)`,
      )
      .run(edge);
  }

  insertDependencies(edges: DependencyEdge[]): void {
    const insert = this.db.prepare(
      `insert into dependencies (id, from_type, from_id, target, reason, status, created_at, updated_at)
       values (@id, @fromType, @fromId, @target, @reason, @status, @createdAt, @updatedAt)`,
    );
    const transaction = this.db.transaction((items: DependencyEdge[]) => {
      for (const item of items) insert.run(item);
    });
    transaction(edges);
  }

  deleteDependenciesFor(fromType: DependencyEdge["fromType"], fromId: string): void {
    this.db.prepare("delete from dependencies where from_type = ? and from_id = ?").run(fromType, fromId);
  }

  updateDependenciesFor(fromType: DependencyEdge["fromType"], fromId: string, status: DependencyEdge["status"]): void {
    this.db
      .prepare("update dependencies set status = ?, updated_at = ? where from_type = ? and from_id = ?")
      .run(status, new Date().toISOString(), fromType, fromId);
  }

  listDependencies(): DependencyEdge[] {
    return this.db
      .prepare("select * from dependencies order by created_at asc")
      .all()
      .map((row) => mapDependency(row as Row));
  }

  listLanes(): LaneRecord[] {
    return this.db
      .prepare("select * from lanes order by created_at asc")
      .all()
      .map((row) => mapLane(row as Row));
  }

  listSlices(): SliceRecord[] {
    return this.db
      .prepare("select * from slices order by created_at asc")
      .all()
      .map((row) => mapSlice(row as Row));
  }

  updateSliceStatus(id: string, status: SliceRecord["status"]): void {
    this.db
      .prepare("update slices set status = ?, updated_at = ? where id = ?")
      .run(status, new Date().toISOString(), id);
  }

  completeLeasesForSlice(sliceId: string): void {
    this.db
      .prepare("update leases set status = 'completed', updated_at = ? where slice_id = ? and status = 'active'")
      .run(new Date().toISOString(), sliceId);
  }

  releaseLeasesForSlice(sliceId: string): void {
    this.db
      .prepare("update leases set status = 'released', updated_at = ? where slice_id = ? and status = 'active'")
      .run(new Date().toISOString(), sliceId);
  }

  listLeases(): LeaseRecord[] {
    return this.db
      .prepare("select * from leases order by created_at asc")
      .all()
      .map((row) => mapLease(row as Row));
  }

  upsertHeartbeat(input: Omit<HeartbeatRecord, "id" | "timestamp"> & { id?: string; timestamp?: string }): HeartbeatRecord {
    const heartbeat: HeartbeatRecord = {
      id: input.id ?? `heartbeat:${input.actor}`,
      actor: input.actor,
      state: input.state,
      detail: input.detail,
      entityType: input.entityType,
      entityId: input.entityId,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `insert into heartbeats (id, actor, state, detail, entity_type, entity_id, timestamp)
         values (@id, @actor, @state, @detail, @entityType, @entityId, @timestamp)
         on conflict(id) do update set
           state = excluded.state,
           detail = excluded.detail,
           entity_type = excluded.entity_type,
           entity_id = excluded.entity_id,
           timestamp = excluded.timestamp`,
      )
      .run({
        ...heartbeat,
        detail: heartbeat.detail ?? null,
        entityType: heartbeat.entityType ?? null,
        entityId: heartbeat.entityId ?? null,
      });
    return heartbeat;
  }

  listHeartbeats(): HeartbeatRecord[] {
    return this.db
      .prepare("select * from heartbeats order by timestamp desc")
      .all()
      .map((row) => mapHeartbeat(row as Row));
  }

  insertEvidence(evidence: EvidenceRecord): void {
    this.db
      .prepare(
        `insert into evidence (id, slice_id, kind, summary, ref, payload_json, created_at)
         values (@id, @sliceId, @kind, @summary, @ref, @payloadJson, @createdAt)`,
      )
      .run({ ...evidence, ref: evidence.ref ?? null, payloadJson: JSON.stringify(evidence.payload) });
  }

  listEvidence(sliceId?: string): EvidenceRecord[] {
    const rows = sliceId
      ? this.db.prepare("select * from evidence where slice_id = ? order by created_at asc").all(sliceId)
      : this.db.prepare("select * from evidence order by created_at asc").all();
    return rows.map((row) => mapEvidence(row as Row));
  }

  insertEscalation(escalation: EscalationRecord): void {
    this.db
      .prepare(
        `insert into escalations (id, level, status, entity_type, entity_id, message, reason, created_by, cleared_by, created_at, updated_at)
         values (@id, @level, @status, @entityType, @entityId, @message, @reason, @createdBy, @clearedBy, @createdAt, @updatedAt)`,
      )
      .run({ ...escalation, reason: escalation.reason ?? null, clearedBy: escalation.clearedBy ?? null });
  }

  clearEscalation(id: string, input: { reason: string; clearedBy: string }): void {
    this.db
      .prepare(
        `update escalations
         set status = 'cleared', reason = ?, cleared_by = ?, updated_at = ?
         where id = ? and status = 'active'`,
      )
      .run(input.reason, input.clearedBy, new Date().toISOString(), id);
  }

  listEscalations(status?: EscalationRecord["status"]): EscalationRecord[] {
    const rows = status
      ? this.db.prepare("select * from escalations where status = ? order by created_at asc").all(status)
      : this.db.prepare("select * from escalations order by created_at asc").all();
    return rows.map((row) => mapEscalation(row as Row));
  }

  recentEvents(limit = 10): HarnessEvent[] {
    return this.db
      .prepare("select * from events order by timestamp desc limit ?")
      .all(limit)
      .map((row) => mapEvent(row as Row));
  }

  listEvents(): HarnessEvent[] {
    return this.db
      .prepare("select * from events order by timestamp asc")
      .all()
      .map((row) => mapEvent(row as Row));
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`alter table ${table} add column ${column} ${type}`);
  }
}

function mapSource(row: Row): SourceRecord {
  return {
    id: String(row.id),
    adapterId: String(row.adapter_id),
    kind: String(row.kind),
    uri: String(row.uri),
    title: String(row.title),
    hash: String(row.hash),
    metadata: row.metadata_json ? (JSON.parse(String(row.metadata_json)) as Record<string, unknown>) : {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapLane(row: Row): LaneRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    purpose: String(row.purpose),
    focusLabels: JSON.parse(String(row.focus_labels_json)) as string[],
    targetId: String(row.target_id),
    orchestrator: String(row.orchestrator),
    worktree: String(row.worktree),
    state: row.state as LaneRecord["state"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSlice(row: Row): SliceRecord {
  return {
    id: String(row.id),
    laneId: String(row.lane_id),
    targetId: String(row.target_id),
    title: String(row.title),
    status: row.status as SliceRecord["status"],
    sourceRefs: JSON.parse(String(row.source_refs_json)),
    frAcRefs: JSON.parse(String(row.fr_ac_refs_json)),
    scope: JSON.parse(String(row.scope_json)),
    outOfScope: JSON.parse(String(row.out_of_scope_json)),
    verificationRequirements: JSON.parse(String(row.verification_requirements_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapLease(row: Row): LeaseRecord {
  return {
    id: String(row.id),
    frAcRef: String(row.fr_ac_ref),
    sliceId: String(row.slice_id),
    laneId: String(row.lane_id),
    status: row.status as LeaseRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvent(row: Row): HarnessEvent {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    actor: String(row.actor),
    type: String(row.type),
    entityType: row.entity_type as HarnessEvent["entityType"],
    entityId: String(row.entity_id),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
  };
}

function mapDependency(row: Row): DependencyEdge {
  return {
    id: String(row.id),
    fromType: row.from_type as DependencyEdge["fromType"],
    fromId: String(row.from_id),
    target: String(row.target),
    reason: String(row.reason),
    status: row.status as DependencyEdge["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapHeartbeat(row: Row): HeartbeatRecord {
  return {
    id: String(row.id),
    actor: String(row.actor),
    state: row.state as HeartbeatRecord["state"],
    detail: row.detail === null || row.detail === undefined ? undefined : String(row.detail),
    entityType: row.entity_type === null || row.entity_type === undefined ? undefined : (row.entity_type as HeartbeatRecord["entityType"]),
    entityId: row.entity_id === null || row.entity_id === undefined ? undefined : String(row.entity_id),
    timestamp: String(row.timestamp),
  };
}

function mapEvidence(row: Row): EvidenceRecord {
  return {
    id: String(row.id),
    sliceId: String(row.slice_id),
    kind: row.kind as EvidenceRecord["kind"],
    summary: String(row.summary),
    ref: row.ref === null || row.ref === undefined ? undefined : String(row.ref),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function mapEscalation(row: Row): EscalationRecord {
  return {
    id: String(row.id),
    level: row.level as EscalationRecord["level"],
    status: row.status as EscalationRecord["status"],
    entityType: row.entity_type as EscalationRecord["entityType"],
    entityId: String(row.entity_id),
    message: String(row.message),
    reason: row.reason === null || row.reason === undefined ? undefined : String(row.reason),
    createdBy: String(row.created_by),
    clearedBy: row.cleared_by === null || row.cleared_by === undefined ? undefined : String(row.cleared_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
