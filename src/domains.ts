import { sourceDomain, sourceFrAcRefs, sourcePriority, sourceTags } from "./source-index.js";
import type { SwarmStore } from "./storage.js";
import type { SourceRecord } from "./types.js";

export interface DomainSummary {
  domain: string;
  sources: number;
  refs: number;
  available: number;
  active: number;
  blocked: number;
  completed: number;
  acceptedSlices: number;
  activeSlices: number;
  blockedSlices: number;
  sourceIds: string[];
  tags: string[];
  highestPriority: number;
}

export interface DomainDetail extends DomainSummary {
  sourceDetails: Array<{
    id: string;
    title: string;
    uri: string;
    hash: string;
    priority: number;
    tags: string[];
    refs: string[];
  }>;
  refStatuses: Array<{ ref: string; status: "available" | "active" | "blocked" | "completed"; sliceId?: string }>;
}

export function buildDomainSummaries(store: SwarmStore): DomainSummary[] {
  return groupSourcesByDomain(store.listSources()).map(([domain, sources]) => summarizeDomain(store, domain, sources));
}

export function buildDomainDetail(store: SwarmStore, domain: string): DomainDetail | undefined {
  const sources = store.listSources().filter((source) => sourceDomain(source).toLowerCase() === domain.toLowerCase());
  if (sources.length === 0) return undefined;
  const summary = summarizeDomain(store, sourceDomain(sources[0]), sources);
  return {
    ...summary,
    sourceDetails: sources
      .slice()
      .sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.title.localeCompare(b.title))
      .map((source) => ({
        id: source.id,
        title: source.title,
        uri: source.uri,
        hash: source.hash,
        priority: sourcePriority(source),
        tags: sourceTags(source),
        refs: sourceFrAcRefs(source),
      })),
    refStatuses: refsForSources(sources).map((ref) => ({ ref, ...statusForRef(store, ref) })),
  };
}

function summarizeDomain(store: SwarmStore, domain: string, sources: SourceRecord[]): DomainSummary {
  const refs = refsForSources(sources);
  const statuses = refs.map((ref) => statusForRef(store, ref).status);
  const slices = store.listSlices().filter((slice) =>
    slice.sourceRefs.some((sourceRef) => sources.some((source) => source.uri === sourceRef.uri)),
  );
  return {
    domain,
    sources: sources.length,
    refs: refs.length,
    available: statuses.filter((status) => status === "available").length,
    active: statuses.filter((status) => status === "active").length,
    blocked: statuses.filter((status) => status === "blocked").length,
    completed: statuses.filter((status) => status === "completed").length,
    acceptedSlices: slices.filter((slice) => slice.status === "accepted").length,
    activeSlices: slices.filter((slice) => !["accepted", "closed"].includes(slice.status)).length,
    blockedSlices: slices.filter((slice) => slice.status === "blocked").length,
    sourceIds: sources.map((source) => source.id),
    tags: [...new Set(sources.flatMap((source) => sourceTags(source)))].sort(),
    highestPriority: Math.min(...sources.map((source) => sourcePriority(source))),
  };
}

function groupSourcesByDomain(sources: SourceRecord[]): Array<[string, SourceRecord[]]> {
  const groups = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    const domain = sourceDomain(source);
    groups.set(domain, [...(groups.get(domain) ?? []), source]);
  }
  return [...groups.entries()].sort((a, b) => {
    const priorityDiff = Math.min(...a[1].map(sourcePriority)) - Math.min(...b[1].map(sourcePriority));
    return priorityDiff || a[0].localeCompare(b[0]);
  });
}

function refsForSources(sources: SourceRecord[]): string[] {
  return [...new Set(sources.flatMap((source) => sourceFrAcRefs(source)))];
}

function statusForRef(
  store: SwarmStore,
  ref: string,
): { status: "available" | "active" | "blocked" | "completed"; sliceId?: string } {
  const lease = store.latestLeaseFor(ref);
  if (!lease || lease.status === "released") return { status: "available" };
  if (lease.status === "completed") return { status: "completed", sliceId: lease.sliceId };
  const slice = store.listSlices().find((item) => item.id === lease.sliceId);
  if (slice?.status === "blocked") return { status: "blocked", sliceId: lease.sliceId };
  return { status: "active", sliceId: lease.sliceId };
}
