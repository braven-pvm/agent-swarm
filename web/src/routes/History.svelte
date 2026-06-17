<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "~/lib/api";
  import { shortAge } from "~/lib/format";
  import CompareResult from "~/components/CompareResult.svelte";
  import {
    type HistoryRun,
    type OutcomeFilter,
    outcomeTone,
    faultLabel,
    shortRunId,
    sortByStartedDesc,
    filterRuns,
    summarize,
    formatWhen,
  } from "~/lib/history";

  // ── Data load ────────────────────────────────────────────────────────────
  let runs = $state<HistoryRun[]>([]);
  let loading = $state(true);
  let loadError = $state(false);
  let now = $state(Date.now());

  onMount(async () => {
    try {
      const r = await api.historyRuns();
      runs = (r.runs as HistoryRun[]) ?? [];
    } catch {
      loadError = true;
    } finally {
      loading = false;
      now = Date.now();
    }
  });

  // ── Summary overview ───────────────────────────────────────────────────────
  const summary = $derived(summarize(runs));

  // ── Controls ───────────────────────────────────────────────────────────────
  let outcomeFilter = $state<OutcomeFilter>("all");
  let faultFilter = $state("all");
  let query = $state("");

  const OUTCOME_FACETS: Array<{ key: OutcomeFilter; label: string }> = [
    { key: "all", label: "All" },
    { key: "human_required", label: "Human required" },
    { key: "accepted", label: "Accepted" },
  ];
  // Fault-mode select options derived from the data (none first, then injected by count).
  const faultOptions = $derived(summary.byFault.map((f) => ({ value: f.fault, label: f.tone.label, count: f.count })));

  const filtered = $derived(
    sortByStartedDesc(filterRuns(runs, { outcome: outcomeFilter, fault: faultFilter, query })),
  );

  // ── Row cap (show first ~60, toggle to all) ────────────────────────────────
  const CAP = 60;
  let showAll = $state(false);
  // Resetting the cap whenever the filtered set changes keeps "Show all" honest.
  $effect(() => {
    void filtered.length;
    showAll = false;
  });
  const visible = $derived(showAll ? filtered : filtered.slice(0, CAP));

  // ── Inline detail expansion (one row at a time) ─────────────────────────────
  let expandedId = $state<string | null>(null);
  function toggleRow(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  // ── Compare set (max 2) ────────────────────────────────────────────────────
  let compareIds = $state<string[]>([]);
  let compareHint = $state("");
  let comparing = $state(false);
  let compareError = $state(false);
  let compareResult = $state<Record<string, unknown> | null>(null);

  function isPicked(id: string): boolean {
    return compareIds.includes(id);
  }
  function togglePick(id: string) {
    compareHint = "";
    if (compareIds.includes(id)) {
      compareIds = compareIds.filter((x) => x !== id);
      compareResult = null;
      return;
    }
    if (compareIds.length >= 2) {
      compareHint = "Two runs already picked — clear one first.";
      compareIds = [...compareIds]; // re-assert state so the rejected 3rd checkbox un-ticks
      return;
    }
    compareIds = [...compareIds, id];
    compareResult = null;
  }
  function clearPick(id: string) {
    compareIds = compareIds.filter((x) => x !== id);
    compareResult = null;
    compareHint = "";
  }
  function clearCompare() {
    compareIds = [];
    compareResult = null;
    compareError = false;
    compareHint = "";
  }
  function runFor(id: string): HistoryRun | undefined {
    return runs.find((r) => r.runId === id);
  }
  async function runCompare() {
    if (compareIds.length !== 2) return;
    comparing = true;
    compareError = false;
    compareResult = null;
    try {
      compareResult = await api.historyCompare(compareIds[0], compareIds[1]);
    } catch {
      compareError = true;
    } finally {
      comparing = false;
    }
  }

  // Compact picked-run descriptor for the compare bar: time + fault + outcome.
  function pickedLabel(run: HistoryRun): { time: string; fault: string; outcome: string } {
    const when = formatWhen(run.startedAt);
    return { time: when.time, fault: faultLabel(run.faultMode).label, outcome: outcomeTone(run).label };
  }
</script>

<section class="route history">
  {#if loading}
    <p class="empty">Loading run history…</p>
  {:else if loadError}
    <p class="empty hist-error">Could not load run history.</p>
  {:else}
    <!-- 1. SUMMARY OVERVIEW ─────────────────────────────────────────────── -->
    <header class="hist-head">
      <h2 class="hist-title">Run history <span class="count">({summary.total})</span></h2>
      <p class="hist-sub muted">Fault-injection sweep across {summary.byFault.length} fault modes.</p>
    </header>

    <div class="hist-summary">
      <div class="hist-outcomes">
        {#each summary.byOutcome as o (o.outcome)}
          <span class="cov-badge {o.tone.cls} hist-stat-chip" title={o.tone.attention ? "Needs attention" : "Clean"}>
            <span class="hist-stat-glyph">{o.tone.glyph}</span>
            <strong class="mono">{o.count}</strong> {o.tone.label}
          </span>
        {/each}
      </div>
      <div class="hist-faults" aria-label="Fault-mode distribution">
        {#each summary.byFault as f (f.fault)}
          <span class="hist-fault-chip {f.tone.cls}" class:hist-fault-injected={f.tone.injected}>
            {f.tone.label} <span class="mono">{f.count}</span>
          </span>
        {/each}
      </div>
    </div>

    <!-- 2. CONTROLS ──────────────────────────────────────────────────────── -->
    <div class="hist-controls">
      <div class="spec-facets hist-facets" role="group" aria-label="Filter by outcome">
        {#each OUTCOME_FACETS as facet (facet.key)}
          <button
            type="button"
            class="spec-facet"
            class:active={outcomeFilter === facet.key}
            aria-pressed={outcomeFilter === facet.key}
            onclick={() => (outcomeFilter = facet.key)}
          >{facet.label}</button>
        {/each}
      </div>

      <label class="sr-only" for="hist-fault">Filter by fault mode</label>
      <select id="hist-fault" class="hist-select" bind:value={faultFilter} aria-label="Filter by fault mode">
        <option value="all">All fault modes</option>
        {#each faultOptions as opt (opt.value)}
          <option value={opt.value}>{opt.label} ({opt.count})</option>
        {/each}
      </select>

      <label class="sr-only" for="hist-search">Search runs</label>
      <input
        id="hist-search"
        class="search hist-search"
        type="search"
        placeholder="Search run id / reason / slice…"
        bind:value={query}
      />

      <span class="muted hist-count-shown">{filtered.length} shown</span>
    </div>

    <!-- COMPARE BAR ──────────────────────────────────────────────────────── -->
    {#if compareIds.length || compareHint}
      <div class="hist-compare-bar" role="region" aria-label="Compare runs">
        <span class="col-title hist-compare-title">Compare</span>
        <div class="hist-compare-picks">
          {#each compareIds as id (id)}
            {@const run = runFor(id)}
            {#if run}
              {@const p = pickedLabel(run)}
              <span class="hist-pick">
                <span class="mono hist-pick-time">{p.time}</span>
                <span class="hist-pick-meta muted">{p.fault} · {p.outcome}</span>
                <button type="button" class="hist-pick-x" aria-label="Remove {shortRunId(id)} from compare" onclick={() => clearPick(id)}>✕</button>
              </span>
            {/if}
          {/each}
          {#if compareIds.length < 2}
            <span class="hist-pick hist-pick-empty muted">Pick {2 - compareIds.length} more</span>
          {/if}
        </div>
        {#if compareHint}<span class="hist-compare-hint muted">{compareHint}</span>{/if}
        <button type="button" class="hist-btn hist-btn-primary" disabled={compareIds.length !== 2 || comparing} onclick={runCompare}>
          {comparing ? "Comparing…" : "Compare"}
        </button>
        <button type="button" class="hist-btn" onclick={clearCompare}>Clear</button>
      </div>
    {/if}

    {#if compareError}
      <p class="empty hist-error">Could not compare these runs.</p>
    {/if}
    {#if compareResult}
      <CompareResult raw={compareResult} />
    {/if}

    <!-- 3. TABLE ─────────────────────────────────────────────────────────── -->
    {#if filtered.length === 0}
      <p class="empty hist-empty">No runs match these filters.</p>
    {:else}
      <div class="cov-table-scroll hist-table-scroll">
        <table class="cov-table hist-table">
          <thead>
            <tr>
              <th class="hist-th-pick" aria-label="Compare"></th>
              <th class="hist-th-caret" aria-label="Expand"></th>
              <th>When</th>
              <th>Outcome</th>
              <th>Fault</th>
              <th>Reason</th>
              <th>Signals</th>
              <th>Id</th>
            </tr>
          </thead>
          <tbody>
            {#each visible as run (run.runId)}
              {@const tone = outcomeTone(run)}
              {@const ft = faultLabel(run.faultMode)}
              {@const when = formatWhen(run.startedAt)}
              {@const expanded = expandedId === run.runId}
              {@const picked = isPicked(run.runId)}
              {@const esc = run.counts?.activeEscalations ?? 0}
              <tr
                class="cov-row hist-row"
                class:hist-row-attention={tone.attention}
                class:cov-row-expanded={expanded}
              >
                <td class="hist-pick-cell">
                  <input
                    type="checkbox"
                    class="hist-pick-box"
                    checked={picked}
                    aria-label="Add {shortRunId(run.runId)} to compare"
                    onchange={() => togglePick(run.runId)}
                  />
                </td>
                <td class="cov-caret-cell">
                  <button
                    type="button"
                    class="cov-obl-btn"
                    aria-expanded={expanded}
                    aria-label={expanded ? "Hide run detail" : "Show run detail"}
                    onclick={() => toggleRow(run.runId)}
                  >
                    <span class="cov-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                  </button>
                </td>
                <td class="hist-when">
                  <span class="hist-when-date">{when.date}</span>
                  <span class="mono hist-when-time">{when.time}</span>
                  <span class="muted hist-when-age">{shortAge(now - Date.parse(run.startedAt ?? ""))}</span>
                </td>
                <td>
                  <span class="cov-badge {tone.cls} hist-outcome-chip">
                    <span class="cov-ledger-glyph">{tone.glyph}</span>{tone.label}
                  </span>
                </td>
                <td>
                  <span class="hist-fault-chip {ft.cls}" class:hist-fault-injected={ft.injected}>{ft.label}</span>
                </td>
                <td class="hist-reason muted" title={run.finalReason ?? ""}>{run.finalReason ?? "—"}</td>
                <td class="hist-signals muted">
                  <span class="mono">{run.counts?.turns ?? 0}</span> turns ·
                  <span class="mono">{run.counts?.slices ?? 0}</span> slices
                  {#if esc > 0}<span class="hist-esc" title="{esc} active escalation(s)"> ⚠ {esc}</span>{/if}
                </td>
                <td class="mono muted hist-id" title={run.runId}>{shortRunId(run.runId)}</td>
              </tr>
              {#if expanded}
                <tr class="cov-obl-row hist-detail-row">
                  <td></td>
                  <td colspan="7">
                    <div class="hist-detail">
                      <p class="hist-detail-reason">{run.finalReason ?? "No reason recorded."}</p>
                      <div class="hist-detail-meta">
                        <span class="hist-dm"><span class="hist-dm-k">Phase</span><span class="hist-dm-v mono">{run.phase ?? "—"}</span></span>
                        <span class="hist-dm"><span class="hist-dm-k">Driver</span><span class="hist-dm-v mono">{run.driver ?? "—"}</span></span>
                        <span class="hist-dm"><span class="hist-dm-k">Slice</span><span class="hist-dm-v mono">{run.sliceId ?? "—"}</span></span>
                        <span class="hist-dm"><span class="hist-dm-k">Slice status</span><span class="hist-dm-v mono">{run.finalSliceStatus ?? "—"}</span></span>
                        <span class="hist-dm"><span class="hist-dm-k">Classification</span><span class="hist-dm-v mono">{run.classificationCode ?? "—"}</span></span>
                        <span class="hist-dm"><span class="hist-dm-k">Severity</span><span class="hist-dm-v mono">{run.classificationSeverity ?? "—"}</span></span>
                      </div>
                      <div class="hist-detail-counts">
                        {#each [
                          ["Turns", run.counts?.turns],
                          ["Verify runs", run.counts?.verifyRuns],
                          ["Slices", run.counts?.slices],
                          ["Agent runs", run.counts?.agentRuns],
                          ["Evidence", run.counts?.evidence],
                          ["Escalations", run.counts?.activeEscalations],
                          ["Graph nodes", run.counts?.graphNodes],
                          ["Timeline", run.counts?.timelineItems],
                        ] as [label, value] (label)}
                          <span class="hist-count-cell">
                            <span class="hist-count-num mono">{value ?? 0}</span>
                            <span class="hist-count-label muted">{label}</span>
                          </span>
                        {/each}
                      </div>
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>

      {#if !showAll && filtered.length > CAP}
        <button type="button" class="wb-more hist-show-all" onclick={() => (showAll = true)}>
          Show all ({filtered.length})
        </button>
      {/if}
    {/if}
  {/if}
</section>
