<script lang="ts">
  import { buildCompareView } from "~/lib/history";

  let { raw }: { raw: Record<string, unknown> | null | undefined } = $props();
  const view = $derived(buildCompareView(raw));
  let showRaw = $state(false);

  // A path's basename for a compact artifact reference (full path in title).
  function baseOf(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  }
</script>

<div class="hist-compare-result">
  <!-- Interpretation summary first -->
  {#if view.interpretation}
    <p class="hist-cmp-interp">{view.interpretation}</p>
  {/if}

  {#if !view.anyChange && view.pairs.every((p) => !p.changed)}
    <p class="empty hist-cmp-nochange">No material differences between these runs.</p>
  {/if}

  <!-- Field diff: outcome / classification / fault as left-vs-right rows -->
  {#if view.pairs.length}
    <div class="hist-cmp-pairs">
      {#each view.pairs as p (p.label)}
        <div class="hist-cmp-pair" class:hist-cmp-changed={p.changed}>
          <span class="hist-cmp-field">{p.label}</span>
          <span class="hist-cmp-val mono">{p.left || "—"}</span>
          <span class="hist-cmp-arrow" aria-hidden="true">→</span>
          <span class="hist-cmp-val mono" class:hist-cmp-val-changed={p.changed}>{p.right || "—"}</span>
          {#if p.changed}<span class="hist-cmp-flag">changed</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Count deltas: only the ones that moved -->
  {#if view.counts.length}
    <div class="hist-cmp-section">
      <span class="col-title">Count deltas</span>
      <div class="hist-cmp-counts">
        {#each view.counts as c (c.label)}
          <span class="hist-cmp-count" class:hist-cmp-up={c.delta > 0} class:hist-cmp-down={c.delta < 0}>
            <span class="hist-cmp-count-label">{c.label}</span>
            <span class="hist-cmp-count-delta mono">{c.delta > 0 ? "+" : ""}{c.delta}</span>
          </span>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Artifact references -->
  {#if view.artifacts.length}
    <div class="hist-cmp-section">
      <span class="col-title">Artifacts</span>
      <ul class="hist-cmp-artifacts">
        {#each view.artifacts as a (a.label)}
          <li class="hist-cmp-artifact">
            <span class="hist-cmp-artifact-label">{a.label}</span>
            <span class="hist-cmp-artifact-path mono" title={a.path}>{baseOf(a.path)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Power-user raw escape hatch -->
  <button type="button" class="hist-cmp-raw-toggle" aria-expanded={showRaw} onclick={() => (showRaw = !showRaw)}>
    {showRaw ? "▾" : "▸"} Raw payload
  </button>
  {#if showRaw}
    <pre class="json hist-cmp-raw">{JSON.stringify(raw, null, 2)}</pre>
  {/if}
</div>
