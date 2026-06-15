<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store }: { store: ConsoleStore } = $props();
  let q = $state(""); let statusFilter = $state("all");
  const cov = $derived(store.coverage);
  const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
  const rows = $derived.by(() => {
    const list = cov?.refs ?? [];
    const ql = q.trim().toLowerCase();
    return list.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (!ql || r.ref.toLowerCase().includes(ql) || r.domain.toLowerCase().includes(ql) || (r.sliceId ?? "").toLowerCase().includes(ql)),
    );
  });
  const STATUSES = ["all","done","in_progress","blocked","failed","not_started"];
</script>
<section class="route coverage">
  {#if !cov}
    <p class="empty">Loading coverage…</p>
  {:else}
    <div class="cov-head"><h2>Coverage</h2><div class="cov-overall">{cov.totals.done} / {cov.totals.total} requirements done · <strong>{pct(cov.totals.done, cov.totals.total)}%</strong></div></div>
    <div class="cov-bar" title="done / in-progress / blocked / failed / not-started">
      <span class="seg seg-done" style="width:{pct(cov.totals.done,cov.totals.total)}%"></span>
      <span class="seg seg-inprog" style="width:{pct(cov.totals.inProgress,cov.totals.total)}%"></span>
      <span class="seg seg-blocked" style="width:{pct(cov.totals.blocked,cov.totals.total)}%"></span>
      <span class="seg seg-failed" style="width:{pct(cov.totals.failed,cov.totals.total)}%"></span>
      <span class="seg seg-notstarted" style="width:{pct(cov.totals.notStarted,cov.totals.total)}%"></span>
    </div>
    <div class="cov-domains">
      {#each cov.byDomain as d (d.domain)}
        <div class="cov-domain">
          <div class="cov-domain-head"><span class="cov-domain-name">{d.domain}</span><span class="muted">{d.done}/{d.total} · {pct(d.done,d.total)}%</span></div>
          <div class="cov-bar">
            <span class="seg seg-done" style="width:{pct(d.done,d.total)}%"></span>
            <span class="seg seg-inprog" style="width:{pct(d.inProgress,d.total)}%"></span>
            <span class="seg seg-blocked" style="width:{pct(d.blocked,d.total)}%"></span>
            <span class="seg seg-failed" style="width:{pct(d.failed,d.total)}%"></span>
            <span class="seg seg-notstarted" style="width:{pct(d.notStarted,d.total)}%"></span>
          </div>
        </div>
      {/each}
    </div>
    <div class="cov-filters">
      <input class="search" placeholder="Filter refs / domain / slice…" bind:value={q} />
      <select bind:value={statusFilter}>{#each STATUSES as s}<option value={s}>{s}</option>{/each}</select>
      <span class="muted">{rows.length} shown</span>
    </div>
    <table class="cov-table">
      <thead><tr><th>Requirement</th><th>Domain</th><th>Status</th><th>Slice</th><th>Verification</th></tr></thead>
      <tbody>
        {#each rows as r (r.ref)}
          <tr class="cov-row cov-{r.status}">
            <td class="mono">{r.ref}</td>
            <td>{r.domain}</td>
            <td><span class="cov-badge cov-badge-{r.status}">{r.status.replace("_"," ")}</span></td>
            <td class="mono muted" title={r.sliceId ?? ""}>{r.sliceId ? r.sliceId.slice(-8) : "—"}</td>
            <td class="muted">{r.verification ?? r.reviewStatus ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
