<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let {
    store,
    onGoCoverage,
    onGoControl = () => {},
  }: { store: ConsoleStore; onGoCoverage: () => void; onGoControl?: () => void } = $props();
  const ro = $derived(store.snapshot?.runObservability);
  const show = $derived(
    !!ro &&
    ro.outcomeVsCoverage.severity !== "success" &&
    ro.outcomeVsCoverage.severity !== "neutral",
  );

  // ── Dev-server readiness blocker (BUILD 3) ────────────────────────────────
  // A FAILED human-review dev server is a product-readiness blocker — the human can't visually verify
  // a target whose server won't start. Surface it next to the readiness state (not as a silent button
  // failure), with a link to the Control tab and direct stderr. Independent of the outcome callout
  // above: a run can read "accepted" yet still have a failed review server.
  const failedServers = $derived(store.devServers.filter((s) => s.status === "failed"));
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

<!-- Failed-dev-server readiness blocker — separate banner so it surfaces even when the outcome
     callout above is hidden (e.g. an otherwise-accepted run). One row per failed review server. -->
{#each failedServers as s (s.id)}
  <div class="obs-callout danger obs-devfail" role="alert">
    <span class="obs-glyph">✕</span>
    <span class="obs-headline">Dev server {s.targetName ?? s.targetPath ?? "target"} failed — product readiness blocked</span>
    <span class="obs-pills">
      <span class="truth-pill truth-danger" title="No human-review dev server means visual verification can't proceed">Human review: blocked</span>
    </span>
    {#if s.stderrHref}<a class="obs-link" href={s.stderrHref} target="_blank" rel="noopener">View stderr →</a>{/if}
    <button class="obs-link" onclick={onGoControl}>Open Control →</button>
  </div>
{/each}
