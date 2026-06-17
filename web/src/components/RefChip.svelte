<script lang="ts">
  import { refTone } from "~/lib/format";
  import type { CoverageRef } from "~/lib/types";

  let {
    ref,
    record = null,
    onOpenRef,
    dim = false,
    hit = false,
  }: {
    ref: string;
    record?: CoverageRef | null;
    onOpenRef?: (ref: string) => void;
    dim?: boolean;
    hit?: boolean;
  } = $props();

  const tone = $derived(refTone(record?.status));
  const unindexed = $derived(!record);

  // Hover context: status reason + owning slice / lane when we have a coverage record.
  const title = $derived.by(() => {
    if (!record) return `${ref} — not indexed in coverage`;
    const parts = [`${ref} — ${tone.label}`];
    if (record.statusReason) parts.push(record.statusReason);
    const where: string[] = [];
    if (record.sliceId) where.push(`slice ${record.sliceId.slice(-8)}`);
    if (record.laneName) where.push(record.laneName);
    if (where.length) parts.push(where.join(" · "));
    return parts.join("\n");
  });

  function click() {
    if (unindexed) return;
    onOpenRef?.(ref);
  }
</script>

{#if unindexed}
  <!-- Unindexed refs are not navigable: render as a non-interactive span so they
       leave the tab order instead of being a dead disabled button. -->
  <span class="spec-ref {tone.cls}" class:dim class:find-hit={hit} data-ref={ref} {title}>
    <span class="spec-ref-glyph">{tone.glyph}</span>{ref}
  </span>
{:else}
  <button
    type="button"
    class="spec-ref {tone.cls}"
    class:dim
    class:find-hit={hit}
    data-ref={ref}
    {title}
    onclick={click}
  >
    <span class="spec-ref-glyph">{tone.glyph}</span>{ref}
  </button>
{/if}
