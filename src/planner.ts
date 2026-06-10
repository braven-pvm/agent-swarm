import path from "node:path";
import { refreshCheckpoint } from "./checkpoints.js";
import { createEvent } from "./events.js";
import { makeId } from "./ids.js";
import { readSourceText } from "./source-adapter.js";
import {
  extractFrAcRefs,
  matchesSourceFilters,
  sourceDomain,
  sourcePriority,
  sourceTags,
} from "./source-index.js";
import type { SwarmStore } from "./storage.js";
import type { DependencyEdge, LaneRecord, LeaseRecord, SliceRecord, SourceRecord, SourceRef } from "./types.js";

export interface PullSliceResult {
  lane: LaneRecord;
  slice: SliceRecord;
  leases: LeaseRecord[];
  dependencies: DependencyEdge[];
  reusedExistingLane: boolean;
}

export interface PullSliceOptions {
  target?: string;
  source?: string;
  domain?: string;
  tags?: string[];
  newLane?: boolean;
  laneName?: string;
  lanePurpose?: string;
  laneLabels?: string[];
  orchestrator?: string;
  batchSize?: number;
}

export function pullNextSlice(store: SwarmStore, options: PullSliceOptions = {}): PullSliceResult {
  const target = selectTarget(store, options.target);
  if (!target) {
    throw new Error("No target registered. Run `swarm target init <repo>` first.");
  }
  const source = selectSource(store, {
    selector: options.source,
    domain: options.domain,
    tags: options.tags,
  });
  if (!source) {
    throw new Error("No sources registered. Run `swarm sources add-file <path>` first.");
  }

  const text = readSourceText(source);
  const refs = extractFrAcRefs(text);
  const blockedDependencies = unsatisfiedDependencies(source, store);
  if (blockedDependencies.length > 0) {
    const now = new Date().toISOString();
    const dependencyEdges = blockedDependencies.map((dependency) => ({
      id: makeId("dependency"),
      fromType: "lane" as const,
      fromId: target.id,
      target: dependency,
      reason: `Source ${source.title} depends on completed backend capability ${dependency}.`,
      status: "blocked" as const,
      createdAt: now,
      updatedAt: now,
    }));
    store.insertDependencies(dependencyEdges);
    store.addEvent(
      createEvent({
        actor: options.orchestrator ?? "planning-agent",
        type: "slice.blocked_by_dependencies",
        entityType: "source",
        entityId: source.id,
        payload: {
          targetId: target.id,
          dependencies: blockedDependencies,
          reason: "Planner refused to serve a slice until declared dependencies are completed.",
        },
      }),
    );
    store.addEvent(
      createEvent({
        actor: options.orchestrator ?? "planning-agent",
        type: "planner.decision",
        entityType: "source",
        entityId: source.id,
        payload: {
          decisionType: "block_slice",
          deliveryQuestion: deliveryQuestionFor(source, []),
          selectedScope: [],
          sourceRefs: [source.id],
          dependenciesConsidered: blockedDependencies,
          readinessEvidence: [],
          protocolRules: ["frontend_requires_accepted_backend"],
          reason: "Planner refused to serve work because prerequisite FR/AC refs are not accepted.",
          rejectedAlternatives: [
            {
              action: "serve dependent slice",
              reason: `Missing accepted refs: ${blockedDependencies.join(", ")}`,
            },
          ],
          expectedNextAction: "Serve and verify backend prerequisite slices before retrying this source.",
        },
      }),
    );
    refreshCheckpoint({
      store,
      role: "planner",
      entityType: "source",
      entityId: source.id,
      actor: options.orchestrator ?? "planning-agent",
      reason: "Blocked dependency planning decision.",
    });
    throw new Error(`Source dependencies are not satisfied: ${blockedDependencies.join(", ")}`);
  }
  const availableRefs = refs.filter((ref) => {
    const lease = store.latestLeaseFor(ref);
    if (lease && lease.status !== "released") return false;
    return !isBroadFrSatisfiedByCompletedAcs(ref, refs, store);
  });
  if (availableRefs.length === 0) {
    throw new Error("No claimable FR/AC-like references are available from registered sources.");
  }

  const now = new Date().toISOString();
  const existingLane = options.newLane ? undefined : store.firstActiveLaneForTarget(target.id);
  const lane =
    existingLane ??
    createLane({
      targetId: target.id,
      targetPath: target.path,
      source,
      now,
      name: options.laneName,
      purpose: options.lanePurpose,
      labels: options.laneLabels,
      orchestrator: options.orchestrator,
    });

  if (!existingLane) {
    store.insertLane(lane);
    store.addEvent(
      createEvent({
        actor: "planning-agent",
        type: "lane.created",
        entityType: "lane",
        entityId: lane.id,
        payload: {
          reason: options.newLane
            ? "Planner created an explicitly requested lane for the selected source and target."
            : "Initial MVP planner lane for the selected source and target.",
          purpose: lane.purpose,
        },
      }),
    );
  }

  const selectedRefs = availableRefs.slice(0, options.batchSize ?? 3);
  const slice = createSlice({
    lane,
    targetId: target.id,
    source,
    selectedRefs,
    now,
  });
  store.insertSlice(slice);

  const leases = selectedRefs.map((frAcRef) => {
    const lease: LeaseRecord = {
      id: makeId("lease"),
      frAcRef,
      laneId: lane.id,
      sliceId: slice.id,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    store.insertLease(lease);
    return lease;
  });

  const dependencies = createDependencies(slice, now);
  for (const dependency of dependencies) {
    store.insertDependency(dependency);
  }

  store.addEvent(
    createEvent({
      actor: "planning-agent",
      type: "slice.created",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        reason: "MVP planner selected the next unleased FR/AC-like references from the first registered source.",
        frAcRefs: selectedRefs,
        laneId: lane.id,
      },
    }),
  );
  store.addEvent(
    createEvent({
      actor: options.orchestrator ?? "planning-agent",
      type: "planner.decision",
      entityType: "slice",
      entityId: slice.id,
      payload: {
        decisionType: "serve_slice",
        deliveryQuestion: slice.deliveryQuestion,
        workPackageType: slice.workPackageType,
        minimumMeaningfulOutcome: slice.minimumMeaningfulOutcome,
        acSizedExceptionReason: slice.acSizedExceptionReason,
        selectedScope: slice.frAcRefs,
        sourceRefs: [source.id],
        dependenciesConsidered: dependencies.map((dependency) => dependency.target),
        readinessEvidence: [],
        protocolRules: ["require_fr_ac_scope", "require_expected_evidence_before_dispatch"],
        reason: "Planner selected the next unleased FR/AC-like references and created an implementation slice.",
        rejectedAlternatives: [],
        expectedNextAction: "Dispatch a worker, then verify per-FR/AC evidence before acceptance.",
        laneId: lane.id,
      },
    }),
  );
  refreshCheckpoint({
    store,
    role: "planner",
    entityType: "slice",
    entityId: slice.id,
    actor: options.orchestrator ?? "planning-agent",
    reason: "Slice served by planner.",
  });
  refreshCheckpoint({
    store,
    role: "planner",
    entityType: "lane",
    entityId: lane.id,
    actor: options.orchestrator ?? "planning-agent",
    reason: "Lane planning state changed.",
  });

  return {
    lane,
    slice,
    leases,
    dependencies,
    reusedExistingLane: Boolean(existingLane),
  };
}

function createLane(input: {
  targetId: string;
  targetPath: string;
  source: SourceRecord;
  now: string;
  name?: string;
  purpose?: string;
  labels?: string[];
  orchestrator?: string;
}): LaneRecord {
  return {
    id: makeId("lane"),
    name: input.name ?? `Lane: ${input.source.title}`,
    purpose: input.purpose ?? `Implement first coherent batch from ${input.source.title}`,
    focusLabels: input.labels?.length
      ? input.labels
      : ["mvp", "file-source", input.source.kind, `domain:${sourceDomain(input.source)}`, ...sourceTags(input.source)],
    targetId: input.targetId,
    orchestrator: input.orchestrator ?? "planning-agent",
    worktree: input.targetPath,
    state: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function createSlice(input: {
  lane: LaneRecord;
  targetId: string;
  source: SourceRecord;
  selectedRefs: string[];
  now: string;
}): SliceRecord {
  const sourceRef: SourceRef = {
    adapterId: input.source.adapterId,
    kind: input.source.kind,
    uri: input.source.uri,
    title: input.source.title,
    hash: input.source.hash,
  };
  const expectedEvidence = input.selectedRefs.map((ref) => `Behavior evidence proving ${ref}.`);
  const meaningfulWork = inferMeaningfulWork(input.source, input.selectedRefs);
  return {
    id: makeId("slice"),
    laneId: input.lane.id,
    targetId: input.targetId,
    title: `Implement ${input.selectedRefs.join(", ")}`,
    status: "ready",
    sourceRefs: [sourceRef],
    frAcRefs: input.selectedRefs,
    deliveryQuestion: deliveryQuestionFor(input.source, input.selectedRefs),
    workPackageType: meaningfulWork.workPackageType,
    minimumMeaningfulOutcome: meaningfulWork.minimumMeaningfulOutcome,
    acSizedExceptionReason: meaningfulWork.acSizedExceptionReason,
    scope: input.selectedRefs.map((ref) => `Implement behavior required by ${ref}.`),
    outOfScope: ["Do not mutate source specs.", "Do not implement unrelated FR/ACs."],
    expectedEvidence,
    unblockTargets: inferUnblockTargets(input.source, input.selectedRefs),
    verificationRequirements: [
      "Run the target test command if configured.",
      "Provide behavior evidence for each included FR/AC-like reference.",
    ],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function inferMeaningfulWork(
  source: SourceRecord,
  refs: string[],
): Pick<SliceRecord, "workPackageType" | "minimumMeaningfulOutcome" | "acSizedExceptionReason"> {
  if (isUiSource(source)) {
    return {
      workPackageType: "component_pack",
      minimumMeaningfulOutcome: "enables_downstream_lane",
    };
  }
  if (/backend|api/i.test(source.title)) {
    return {
      workPackageType: "runtime_capability",
      minimumMeaningfulOutcome: "changes_runtime_path",
    };
  }
  if (/cutover|readiness|coexist|staging|migration/i.test(source.title)) {
    return {
      workPackageType: "proof_pack",
      minimumMeaningfulOutcome: "proves_cutover_or_readiness",
    };
  }
  return {
    workPackageType: "proof_pack",
    minimumMeaningfulOutcome: "proves_cutover_or_readiness",
    acSizedExceptionReason:
      refs.length === 1 ? "Planner served a single-ref diagnostic proof slice from a generic source." : undefined,
  };
}

function deliveryQuestionFor(source: SourceRecord, refs: string[]): string {
  const domain = sourceDomain(source);
  if (isUiSource(source)) {
    return refs.length > 0
      ? `Can verified backend capabilities support real ${domain} dashboard work for ${refs.join(", ")}?`
      : "Can this downstream UI slice be served against accepted backend capabilities?";
  }
  if (/backend|api/i.test(source.title)) {
    return refs.length > 0
      ? `Can backend behavior for ${refs.join(", ")} be implemented and verified so downstream work can rely on it?`
      : "Can backend prerequisites be verified for downstream implementation?";
  }
  return refs.length > 0
    ? `Can ${refs.join(", ")} be implemented and verified against the approved ${domain} source?`
    : `Can the next slice from ${source.title} be safely served?`;
}

function inferUnblockTargets(source: SourceRecord, refs: string[]): string[] {
  if (/backend|api/i.test(source.title)) return refs.map((ref) => `downstream:${ref}`);
  if (isUiSource(source)) return ["delivery:frontend-ready"];
  return [];
}

function isUiSource(source: SourceRecord): boolean {
  return /(?:dashboard|frontend|\bui\b)/i.test(source.title);
}

function createDependencies(slice: SliceRecord, now: string): DependencyEdge[] {
  return [
    {
      id: makeId("dependency"),
      fromType: "slice",
      fromId: slice.id,
      target: "target test command",
      reason: "MVP slices require at least one behavior-oriented verification command where available.",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export { extractFrAcRefs };

function isBroadFrSatisfiedByCompletedAcs(ref: string, refs: string[], store: SwarmStore): boolean {
  const match = /^FR-(.+)-([0-9]+)$/i.exec(ref);
  if (!match) return false;
  const acPrefix = `AC-${match[1]}-${match[2]}.`.toUpperCase();
  const childAcs = refs.filter((candidate) => candidate.toUpperCase().startsWith(acPrefix));
  if (childAcs.length === 0) return false;
  return childAcs.every((candidate) => store.latestLeaseFor(candidate)?.status === "completed");
}

function unsatisfiedDependencies(source: SourceRecord, store: SwarmStore): string[] {
  const raw = source.metadata?.dependsOn;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item).toUpperCase())
    .filter((ref) => store.latestLeaseFor(ref)?.status !== "completed");
}

function selectTarget(store: SwarmStore, selector?: string): { id: string; path: string; name: string } | undefined {
  const targets = store.listTargets();
  if (!selector) return store.firstTarget();
  const normalized = selector.toLowerCase();
  return targets.find(
    (target) =>
      target.id.toLowerCase() === normalized ||
      target.name.toLowerCase() === normalized ||
      target.path.toLowerCase() === normalized ||
      path.basename(target.path).toLowerCase() === normalized,
  );
}

function selectSource(
  store: SwarmStore,
  input: { selector?: string; domain?: string; tags?: string[] } = {},
): SourceRecord | undefined {
  const sources = store
    .listSources()
    .filter((source) => matchesSourceFilters(source, { domain: input.domain, tags: input.tags }))
    .sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.createdAt.localeCompare(b.createdAt));
  if (!input.selector) return sources[0];
  const normalized = path.resolve(input.selector).toLowerCase();
  const raw = input.selector.toLowerCase();
  return sources.find(
    (source) =>
      source.id.toLowerCase() === raw ||
      source.title.toLowerCase() === raw ||
      source.uri.toLowerCase() === raw ||
      source.uri.toLowerCase() === normalized ||
      path.basename(source.uri).toLowerCase() === raw,
  );
}
