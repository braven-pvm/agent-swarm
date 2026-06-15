<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store }: { store: ConsoleStore } = $props();
  let q = $state(""); let statusFilter = $state("all");
  const cov = $derived(store.coverage);
  const ro = $derived(store.snapshot?.runObservability);
  const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

  // Ring fallback state when interpretation is absent.
  const ringState = $derived.by(() => {
    if (cov?.interpretation) return cov.interpretation.state;
    const t = cov?.totals;
    if (!t || t.total === 0) return "empty";
    return t.done === t.total ? "complete" : "partial";
  });
  const ringPct = $derived(cov?.interpretation?.completionPercent ?? pct(cov?.totals.done ?? 0, cov?.totals.total ?? 0));

  // All domains, sorted worst-completion first.
  const domains = $derived.by(() => {
    const list = cov?.byDomain ?? [];
    return [...list]
      .map((d) => ({ ...d, completionPercent: pct(d.done, d.total), bad: d.blocked + d.failed }))
      .sort((a, b) => a.completionPercent - b.completionPercent || b.total - a.total);
  });

  const truthRows = $derived(ro?.outcomeVsCoverage.truthRows ?? []);
  const truthGlyph = (sev: string) => (sev === "success" ? "✓" : sev === "danger" ? "✕" : sev === "warning" ? "⚠" : "•");

  const KPIS = $derived.by(() => {
    const t = cov?.totals;
    if (!t) return [];
    return [
      { key: "done", label: "Done", value: t.done, tone: "done" },
      { key: "inProgress", label: "In progress", value: t.inProgress, tone: "inprog" },
      { key: "blocked", label: "Blocked", value: t.blocked, tone: "bad" },
      { key: "failed", label: "Failed", value: t.failed, tone: "bad" },
      { key: "notStarted", label: "Not started", value: t.notStarted, tone: "muted" },
    ];
  });

  const rows = $derived.by(() => {
    const list = cov?.refs ?? [];
    const ql = q.trim().toLowerCase();
    return list.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (!ql || r.ref.toLowerCase().includes(ql) || r.domain.toLowerCase().includes(ql) || (r.sliceId ?? "").toLowerCase().includes(ql)),
    );
  });
  const STATUSES = ["all","done","in_progress","blocked","failed","not_started"];
  const C = 2 * Math.PI * 46;
</script>
<section class="route coverage">
  {#if !cov}
    <p class="empty">Loading coverage…</p>
  {:else}
    <h2 class="cov-page-title">Coverage</h2>

    <!-- A. Hero row: completion ring + truth tiles -->
    <div class="cov-hero">
      <div class="cov-ring-card">
        <svg class="cov-ring" viewBox="0 0 120 120" width="118" height="118" role="img"
          aria-label="{ringPct}% complete, {cov.totals.done} of {cov.totals.total} requirements done">
          <circle class="ring-track" cx="60" cy="60" r="46" />
          <circle class="ring-arc ring-{ringState}" cx="60" cy="60" r="46"
            stroke-dasharray={C} stroke-dashoffset={C * (1 - (ringPct ?? 0) / 100)}
            transform="rotate(-90 60 60)" />
          <text class="ring-pct" x="60" y="58" text-anchor="middle">{ringPct}%</text>
          <text class="ring-sub" x="60" y="78" text-anchor="middle">{cov.totals.done}/{cov.totals.total}</text>
        </svg>
        {#if cov.interpretation}
          <div class="cov-ring-meta">
            <span class="cov-state-chip cov-state-{cov.interpretation.state}">{cov.interpretation.state}</span>
            <p class="cov-headline">{cov.interpretation.headline}</p>
          </div>
        {/if}
      </div>

      {#if truthRows.length}
        <div class="truth-tiles">
          {#each truthRows as row}
            <div class="truth-tile truth-tile-{row.severity}" title={row.meaning}>
              <span class="truth-label">{row.label}</span>
              <span class="truth-state">
                <span class="truth-glyph">{truthGlyph(row.severity)}</span>{row.state}
              </span>
              <span class="truth-meaning">{row.meaning}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- B. KPI stat tiles -->
    <div class="cov-kpis">
      {#each KPIS as k}
        <div class="kpi kpi-{k.tone}">
          <span class="kpi-num">{k.value}</span>
          <span class="kpi-label">{k.label}</span>
        </div>
      {/each}
    </div>

    <!-- C. Warning + next actions -->
    {#if cov.interpretation?.warning}
      <div class="cov-warning">⚠ {cov.interpretation.warning}</div>
    {/if}
    {#if cov.interpretation?.nextActions?.length}
      <div class="cov-nextactions">
        {#each cov.interpretation.nextActions as na}
          <span class="cov-nextaction" title={na.action}>{na.count} to {na.label}</span>
        {/each}
      </div>
    {/if}

    <!-- D. Coverage by domain -->
    {#if domains.length}
      <div class="cov-panel">
        <h3 class="cov-panel-title">Coverage by domain</h3>
        <div class="cov-domain-list">
          {#each domains as d (d.domain)}
            <div class="cov-domain-row">
              <span class="cov-domain-name">{d.domain}</span>
              <span class="cov-domain-bar" title="{d.done}/{d.total} done{d.bad ? `, ${d.bad} blocked/failed` : ''}">
                <span class="cov-domain-fill" style="width:{d.completionPercent}%"></span>
                {#if d.bad}
                  <span class="cov-domain-bad" style="width:{pct(d.bad, d.total)}%"></span>
                {/if}
              </span>
              <span class="cov-domain-stat mono">{d.done}/{d.total}</span>
              <span class="cov-domain-pct mono">{d.completionPercent}%</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- E. Requirements table -->
    <div class="cov-panel cov-table-panel">
      <div class="cov-filters">
        <input class="search" placeholder="Filter refs / domain / slice…" bind:value={q} />
        <select bind:value={statusFilter}>{#each STATUSES as s}<option value={s}>{s.replace("_"," ")}</option>{/each}</select>
        <span class="muted cov-count-shown">{rows.length} shown</span>
      </div>
      <div class="cov-table-scroll">
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
      </div>
    </div>
  {/if}
</section>
