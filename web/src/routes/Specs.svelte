<script lang="ts">
  import { api } from "~/lib/api";
  import { countRefStatuses, worstStatus, type RefCounts } from "~/lib/format";
  import type { SourceRecord, CoverageRef } from "~/lib/types";
  import type { ConsoleStore } from "~/lib/console.svelte";
  import SpecCard from "~/components/SpecCard.svelte";
  import SpecDetail from "~/components/SpecDetail.svelte";

  let { store, onOpenRef }: { store: ConsoleStore; onOpenRef?: (ref: string) => void } = $props();

  // The list is driven live from the store snapshot (App polls every 2.5s); the
  // detail markdown is still fetched on demand via api.source(id).
  const sources = $derived<SourceRecord[]>(store.snapshot?.sources ?? []);
  const loading = $derived(store.snapshot === null);

  let q = $state("");
  let facet = $state<"any" | "blocked" | "incomplete" | "done">("any");

  let selectedId = $state<string | null>(null);
  let detailLoading = $state(false);
  let detailSource = $state<SourceRecord | null>(null);
  let detailMarkdown = $state<string | null>(null);
  let detailError = $state<string | null>(null);

  // ── The shared join: coverage.refs grouped by owning sourceId ──────────
  // Robust when coverage === null (empty map → every chip "not indexed").
  const refsBySource = $derived.by(() => {
    const map = new Map<string, Map<string, CoverageRef>>();
    for (const r of store.coverage?.refs ?? []) {
      let inner = map.get(r.sourceId);
      if (!inner) {
        inner = new Map();
        map.set(r.sourceId, inner);
      }
      inner.set(r.ref.toUpperCase(), r);
    }
    return map;
  });

  function refMapFor(id: string): Map<string, CoverageRef> {
    return refsBySource.get(id) ?? new Map();
  }

  // Per-source card model, computed once per snapshot/coverage change. We extract
  // the source's refs from its title/metadata-less listing by joining the coverage
  // refs that point at this source (authoritative) AND, when not yet indexed, fall
  // back to an empty set — the detail view re-extracts from full markdown on open.
  interface CardModel {
    src: SourceRecord;
    domain?: string;
    tags: string[];
    priority?: number;
    refs: string[];
    counts: RefCounts;
    worst?: string;
  }

  const cards = $derived.by<CardModel[]>(() => {
    return sources.map((src) => {
      const refMap = refMapFor(src.id);
      const refs = Array.from(refMap.keys());
      const counts = countRefStatuses(refs, refMap);
      const worst = worstStatus(refs.map((r) => refMap.get(r)?.status));
      return {
        src,
        domain: src.metadata?.domain as string | undefined,
        tags: (src.metadata?.tags as string[] | undefined) ?? [],
        priority: src.metadata?.priority as number | undefined,
        refs,
        counts,
        worst,
      };
    });
  });

  function passesFacet(c: CardModel): boolean {
    if (facet === "any") return true;
    if (facet === "blocked") return c.worst === "blocked" || c.worst === "failed";
    if (facet === "done") return c.counts.indexed > 0 && c.counts.done === c.counts.indexed;
    if (facet === "incomplete") return c.counts.indexed === 0 || c.counts.done < c.counts.indexed;
    return true;
  }

  const filtered = $derived.by(() => {
    const lq = q.trim().toLowerCase();
    return cards.filter((c) => {
      if (!passesFacet(c)) return false;
      if (!lq) return true;
      const domain = c.domain ?? "";
      return (
        c.src.title.toLowerCase().includes(lq) ||
        c.src.uri.toLowerCase().includes(lq) ||
        domain.toLowerCase().includes(lq) ||
        c.tags.some((t) => t.toLowerCase().includes(lq)) ||
        c.refs.some((r) => r.toLowerCase().includes(lq))
      );
    });
  });

  // Detail refMap re-derived from full markdown extraction joined to coverage, so
  // chips for refs present in the body but absent from coverage render "not indexed".
  const detailRefMap = $derived(detailSource ? refMapFor(detailSource.id) : new Map<string, CoverageRef>());

  async function selectSource(id: string) {
    if (selectedId === id) return;
    selectedId = id;
    detailSource = null;
    detailMarkdown = null;
    detailError = null;
    detailLoading = true;
    try {
      const result = await api.source(id);
      detailSource = result.source as SourceRecord;
      detailMarkdown = result.markdown;
    } catch (e) {
      detailError = e instanceof Error ? e.message : String(e);
    } finally {
      detailLoading = false;
    }
  }

  const FACETS: Array<{ key: typeof facet; label: string }> = [
    { key: "any", label: "Any" },
    { key: "blocked", label: "Has blocked" },
    { key: "incomplete", label: "Incomplete" },
    { key: "done", label: "Done" },
  ];
</script>

<section class="route specs-route">
  <h2 class="spec-page-title">Specs</h2>
  <div class="specs-layout">
    <div class="specs-sidebar">
      <input class="search" placeholder="Find title, domain, uri, tag, or ref…" bind:value={q} />
      <div class="spec-facets">
        {#each FACETS as f}
          <button type="button" class="spec-facet" class:active={facet === f.key} onclick={() => (facet = f.key)}>{f.label}</button>
        {/each}
      </div>

      {#if loading}
        <div class="spec-skeleton">
          <span class="spec-skel-row"></span>
          <span class="spec-skel-row"></span>
          <span class="spec-skel-row"></span>
        </div>
      {:else if sources.length === 0}
        <div class="empty">No specs registered.</div>
      {:else if filtered.length === 0}
        <div class="empty">No matches.</div>
      {:else}
        <ul class="spec-list">
          {#each filtered as c (c.src.id)}
            <li>
              <SpecCard
                title={c.src.title}
                domain={c.domain}
                uri={c.src.uri}
                priority={c.priority}
                tags={c.tags}
                counts={c.counts}
                worst={c.worst}
                selected={selectedId === c.src.id}
                onSelect={() => selectSource(c.src.id)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="spec-detail">
      {#if !selectedId}
        <div class="spec-detail-hint empty">Select a spec to view its requirements and coverage.</div>
      {:else if detailLoading}
        <div class="empty">Loading…</div>
      {:else if detailError}
        <div class="error">{detailError}</div>
      {:else if detailSource && detailMarkdown !== null}
        <SpecDetail source={detailSource} markdown={detailMarkdown} refMap={detailRefMap} {onOpenRef} />
      {/if}
    </div>
  </div>
</section>
