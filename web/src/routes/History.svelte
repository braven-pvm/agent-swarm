<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "~/lib/api";
  let runs = $state<any[]>([]);
  let left = $state(""); let right = $state(""); let comparison = $state<any>(null);
  onMount(async () => { const r = await api.historyRuns(); runs = (r.runs as any[]) ?? []; });
  async function compare() { if (left && right) comparison = await api.historyCompare(left, right); }
</script>
<section class="route">
  <h2>Run history <span class="muted">({runs.length})</span></h2>
  <div class="compare-bar">
    <select bind:value={left}><option value="">left…</option>{#each runs as r}<option value={r.runId}>{r.runId}</option>{/each}</select>
    <select bind:value={right}><option value="">right…</option>{#each runs as r}<option value={r.runId}>{r.runId}</option>{/each}</select>
    <button onclick={compare} disabled={!left || !right}>Compare</button>
  </div>
  {#if comparison}<pre class="json">{JSON.stringify(comparison.interpretation ?? comparison, null, 2)}</pre>{/if}
  <table class="runs">
    <thead><tr><th>Run</th><th>Outcome</th><th>Classifier</th><th>Fault</th></tr></thead>
    <tbody>
      {#each runs as run}
        <tr><td>{run.runId}</td><td>{run.finalOutcome}</td><td>{run.classificationCode}</td><td>{run.faultMode ?? "none"}</td></tr>
      {/each}
    </tbody>
  </table>
</section>
