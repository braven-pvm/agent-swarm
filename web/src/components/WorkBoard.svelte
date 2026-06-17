<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { FrAcVerificationResult } from "~/lib/types";
  import {
    formatDuration, isTerminalSlice, sortActiveSlices, sliceStatusChip,
    statusOverviewCounts,
  } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (sliceId: string) => void } = $props();

  const slices = $derived(store.snapshot?.slices ?? []);
  const overview = $derived(statusOverviewCounts(slices));
  // Active = non-terminal, urgency-sorted (blocked > review > implementing > queued; newest first).
  const active = $derived(sortActiveSlices(slices.filter((s) => !isTerminalSlice(s.status))));
  const accepted = $derived(slices.filter((s) => isTerminalSlice(s.status)));

  // Progressive disclosure: cap each grid, reveal the long tail on demand.
  const ACTIVE_CAP = 8;
  const ACCEPTED_CAP = 12;
  let activeExpanded = $state(false);
  let acceptedOpen = $state(false);        // Accepted section collapsed by default (done work)
  let acceptedExpanded = $state(false);
  const shownActive = $derived(activeExpanded ? active : active.slice(0, ACTIVE_CAP));
  const shownAccepted = $derived(acceptedExpanded ? accepted : accepted.slice(0, ACCEPTED_CAP));

  function agentActors(slice: (typeof slices)[number]): string[] { return [...new Set(slice.agentRuns.map((r) => r.actor.split("-")[0]))]; }
  function sliceDur(slice: (typeof slices)[number]): string {
    return formatDuration((isTerminalSlice(slice.status) ? Date.parse(slice.updatedAt) : Date.now()) - Date.parse(slice.createdAt));
  }
  // Drop a leading "Implement " verb so the title reads as the deliverable, not the task.
  function displayTitle(title: string): string {
    return title.replace(/^Implement\s+/i, "");
  }
  // Short, monospace slice id — strip a redundant leading "SLICE-" so we render it once.
  function shortSliceId(id: string): string {
    return id.replace(/^SLICE-/i, "");
  }
  // Map an FR/AC verification status to a calm dot colour class.
  function dotClass(status: FrAcVerificationResult["status"]): string {
    if (status === "passed" || status === "overridden") return "dot-pass";
    if (status === "failed") return "dot-fail";
    return "dot-warn"; // missing_evidence + anything unexpected
  }
  const MAX_DOTS = 8;
  function coverage(results: FrAcVerificationResult[]) {
    const total = results.length;
    const passed = results.filter((r) => r.status === "passed" || r.status === "overridden").length;
    const anyFail = results.some((r) => r.status === "failed");
    return { total, passed, anyFail, dots: results.slice(0, MAX_DOTS), overflow: Math.max(0, total - MAX_DOTS) };
  }
  // The most descriptive single domain/target label we can show as quiet metadata.
  function metaTarget(slice: (typeof slices)[number]): string | undefined {
    const t = store.snapshot?.targets.find((x) => x.id === slice.targetId);
    return t?.name ?? agentActors(slice)[0];
  }
</script>

{#snippet sliceCard(slice: (typeof slices)[number])}
  {@const cov = coverage(slice.frAcResults)}
  {@const target = metaTarget(slice)}
  {@const chip = sliceStatusChip(slice.status)}
  <button class="slice-card" onclick={() => onSelect(slice.id)}>
    <div class="slice-card-head">
      <span class="slice-title">{displayTitle(slice.title)}</span>
      <span class="wb-chip {chip.cls}"><span class="wb-chip-glyph">{chip.glyph}</span>{chip.label}</span>
    </div>
    <div class="slice-id">SLICE-{shortSliceId(slice.id)}</div>
    {#if cov.total > 0}
      <div class="cov-summary" class:cov-ok={!cov.anyFail && cov.passed === cov.total} class:cov-bad={cov.anyFail}>
        <span class="cov-count">{cov.passed}/{cov.total}</span>
        <span class="cov-label">AC</span>
        <span class="cov-dots">
          {#each cov.dots as r (r.ref)}<span class="cov-dot {dotClass(r.status)}" title="{r.ref}: {r.status}"></span>{/each}
          {#if cov.overflow > 0}<span class="cov-more">+{cov.overflow}</span>{/if}
        </span>
      </div>
    {/if}
    <div class="slice-foot">
      {slice.evidence.length} evidence{#if target} · {target}{/if} · <span class="slice-dur" title={isTerminalSlice(slice.status) ? "total time" : "open for"}>{sliceDur(slice)}</span>
    </div>
  </button>
{/snippet}

<section class="board">
  <!-- Status overview: the distribution at a glance, no five columns needed. -->
  <div class="wb-overview" aria-label="Slice status overview">
    {#each overview as o (o.group)}
      {#if o.group === "accepted"}
        <span class="wb-stat wb-stat-accepted" class:acc-done={o.count > 0}><span class="wb-stat-glyph">✓</span>{o.label} <span class="wb-stat-n">{o.count}</span></span>
      {:else}
        <span class="wb-stat" class:wb-stat-on={o.count > 0} class:wb-stat-blocked={o.group === "blocked" && o.count > 0}>{o.label} <span class="wb-stat-n">{o.count}</span></span>
      {/if}
    {/each}
  </div>

  <!-- Active work: urgency-sorted responsive grid filling the wide centre. -->
  <div class="wb-section">
    <h3 class="col-title">Active work <span class="count">{active.length}</span></h3>
    {#if active.length === 0}
      <p class="wb-empty empty">No active work — all {slices.length} slices accepted.</p>
    {:else}
      <div class="wb-grid">
        {#each shownActive as slice (slice.id)}{@render sliceCard(slice)}{/each}
      </div>
      {#if active.length > ACTIVE_CAP}
        <button class="wb-more" onclick={() => (activeExpanded = !activeExpanded)}>
          {activeExpanded ? "Show fewer" : `Show all active (${active.length})`}
        </button>
      {/if}
    {/if}
  </div>

  <!-- Accepted: collapsed by default, quieter — done work. -->
  {#if accepted.length > 0}
    <div class="wb-section wb-accepted">
      <button class="wb-accepted-head" aria-expanded={acceptedOpen} onclick={() => (acceptedOpen = !acceptedOpen)}>
        <span class="wb-caret">{acceptedOpen ? "▾" : "▸"}</span>
        <span class="wb-accepted-glyph">✓</span>
        <span class="wb-accepted-label">Accepted</span>
        <span class="count">{accepted.length}</span>
      </button>
      {#if acceptedOpen}
        <div class="wb-grid">
          {#each shownAccepted as slice (slice.id)}{@render sliceCard(slice)}{/each}
        </div>
        {#if accepted.length > ACCEPTED_CAP}
          <button class="wb-more" onclick={() => (acceptedExpanded = !acceptedExpanded)}>
            {acceptedExpanded ? "Show fewer" : `Show all (${accepted.length})`}
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</section>
