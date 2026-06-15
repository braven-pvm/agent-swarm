<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onGoCoverage }: { store: ConsoleStore; onGoCoverage: () => void } = $props();
  const ro = $derived(store.snapshot?.runObservability);
  const show = $derived(
    !!ro &&
    ro.outcomeVsCoverage.severity !== "success" &&
    ro.outcomeVsCoverage.severity !== "neutral",
  );
</script>

{#if show && ro}
  <div class="obs-callout {ro.outcomeVsCoverage.severity}" title={ro.outcomeVsCoverage.detail}>
    <span class="obs-glyph">{ro.outcomeVsCoverage.severity === "danger" ? "✕" : "⚠"}</span>
    <span class="obs-headline">{ro.outcomeVsCoverage.headline}</span>
    <span class="obs-pills">
      {#each ro.outcomeVsCoverage.truthRows as row}
        <span class="truth-pill truth-{row.severity}" title={row.meaning}>{row.label}: {row.state}</span>
      {/each}
    </span>
    <button class="obs-link" onclick={onGoCoverage}>View coverage →</button>
  </div>
{/if}
