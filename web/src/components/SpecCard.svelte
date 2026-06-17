<script lang="ts">
  import { prettifyTarget, domainTint, refTone, type RefCounts } from "~/lib/format";

  let {
    title,
    domain,
    uri,
    priority,
    tags = [],
    counts,
    worst,
    selected = false,
    onSelect,
  }: {
    title: string;
    domain?: string;
    uri: string;
    priority?: number;
    tags?: string[];
    counts: RefCounts;
    worst?: string;
    selected?: boolean;
    onSelect: () => void;
  } = $props();

  const spine = $derived(domainTint(domain));
  const pct = (n: number) => (counts.total ? (100 * n) / counts.total : 0);

  // Worst-status roll-up pill. No indexed refs → neutral "not indexed".
  const worstTone = $derived(refTone(worst));
  const allDone = $derived(counts.indexed > 0 && counts.done === counts.indexed);

  const shownTags = $derived(tags.slice(0, 2));
  const overflowTags = $derived(Math.max(0, tags.length - 2));
</script>

<button class="spec-card" class:selected onclick={onSelect}>
  <span class="spec-spine" style="background:{selected ? 'var(--accent)' : spine}"></span>

  <span class="spec-card-head">
    <span class="slice-title">{title}</span>
    {#if priority !== undefined}
      <span class="spec-prio mono" class:high={priority <= 1} title="Priority {priority}">P{priority}</span>
    {/if}
  </span>

  <span class="spec-card-meta">
    <span class="spec-dot" style="background:{spine}"></span>
    <span class="spec-domain">{domain ?? "no domain"}</span>
    <span class="spec-uri mono faint">{prettifyTarget(uri)}</span>
    {#each shownTags as t}
      <span class="spec-tag">{t}</span>
    {/each}
    {#if overflowTags > 0}
      <span class="spec-tag spec-tag-more">+{overflowTags}</span>
    {/if}
  </span>

  <span class="spec-cov">
    <span
      class="cov-domain-bar spec-cov-bar"
      title="{counts.done} done, {counts.inProgress} in progress, {counts.blockedFailed} blocked/failed, {counts.notStarted + (counts.total - counts.indexed)} remaining"
    >
      {#if counts.total > 0}
        <span class="spec-seg seg-done" style="width:{pct(counts.done)}%"></span>
        <span class="spec-seg seg-inprog" style="width:{pct(counts.inProgress)}%"></span>
        <span class="spec-seg seg-bad" style="width:{pct(counts.blockedFailed)}%"></span>
        <span class="spec-seg seg-none" style="width:{pct(counts.notStarted + (counts.total - counts.indexed))}%"></span>
      {/if}
    </span>
    <span class="cov-count" class:cov-muted={counts.total === 0}>
      <span class="cov-count-done" class:cov-ok={allDone}>{counts.done}</span>/{counts.total}
    </span>
    <span class="spec-worst cov-badge {worst ? worstTone.cls : 'spec-ref-unindexed'}">
      <span class="spec-ref-glyph">{worst ? worstTone.glyph : "◌"}</span>{worst ? worstTone.label : "Not indexed"}
    </span>
  </span>
</button>
