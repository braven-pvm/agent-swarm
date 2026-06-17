<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { CoverageRef, ReviewFinding } from "~/lib/types";
  import { humanizeToken, ledgerTone, ledgerStatusLabel, statusLabel } from "~/lib/format";
  import RequirementDetail from "~/components/RequirementDetail.svelte";
  let { store, seed = "" }: { store: ConsoleStore; seed?: string } = $props();
  let q = $state(""); let statusFilter = $state("all"); let ledgerFilter = $state("all");
  // Reactive seed: follows `seed` on every navigation change (App sets it; manual
  // typing changes `q` not `seed`, so this never clobbers user input). An empty
  // seed (top-nav Coverage click) now correctly clears q even without a remount.
  $effect(() => { q = seed ?? ""; });
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

  const ledgerCards = $derived.by(() => {
    const totals = cov?.ledger?.totals;
    if (!totals) return [];
    const order = [
      "accepted",
      "verified",
      "human_verified",
      "awaiting_human_verification",
      "human_input_required",
      "blocked",
      "failed",
      "in_progress",
      "planned",
      "not_started",
    ];
    return order
      .map((status) => ({ status, count: Number((totals as Record<string, number>)[status] ?? 0), tone: ledgerTone(status) }))
      .filter((item) => item.count > 0);
  });

  const ledgerFacts = $derived.by(() => {
    const entries = cov?.ledger?.entries ?? [];
    return {
      total: cov?.ledger?.totals.total ?? entries.length,
      rollups: cov?.ledger?.rollups.length ?? 0,
      humanPending: entries.filter((e) => e.humanPath?.state === "human_verification_required" && e.humanPath.blocksAcceptance).length,
      humanSigned: entries.filter((e) => e.status === "human_verified" || e.humanPath?.packet?.status === "human_verified").length,
    };
  });

  const rows = $derived.by(() => {
    const list = cov?.refs ?? [];
    const ql = q.trim().toLowerCase();
    return list.filter((r) =>
      (statusFilter === "all" || r.status === statusFilter) &&
      (ledgerFilter === "all" || r.ledgerStatus === ledgerFilter) &&
      (!ql ||
        r.ref.toLowerCase().includes(ql) ||
        r.domain.toLowerCase().includes(ql) ||
        (r.sliceId ?? "").toLowerCase().includes(ql) ||
        (r.ledgerStatus ?? "").toLowerCase().includes(ql) ||
        (r.ledgerReason ?? "").toLowerCase().includes(ql) ||
        (r.nextAction ?? "").toLowerCase().includes(ql) ||
        (r.obligation?.mode ?? "").toLowerCase().includes(ql) ||
        (r.humanPath?.state ?? "").toLowerCase().includes(ql) ||
        (r.humanPath?.packet?.status ?? "").toLowerCase().includes(ql)),
    );
  });
  const STATUSES = ["all","done","in_progress","blocked","failed","not_started"];
  const LEDGER_STATUSES = ["all","accepted","verified","human_verified","awaiting_human_verification","human_input_required","blocked","failed","in_progress","planned","not_started"];
  const C = 2 * Math.PI * 46;

  // ── Per-row requirement disclosure (collapsed by default) ──────────────
  // Any ref with detail (proof OR evidence OR obligation OR a reviewer finding) gets
  // a caret in the first cell; expanding reveals the full expected-vs-actual picture
  // (RequirementDetail) in a detail row that spans the table.
  let expandedRef = $state<string | null>(null);
  function toggleRow(ref: string) {
    expandedRef = expandedRef === ref ? null : ref;
  }

  // A ref is expandable when it carries ANY detail worth a verdict/proof/evidence panel —
  // essentially every indexed (done) ref. Refs with nothing but a bare status are not.
  function hasDetail(r: CoverageRef): boolean {
    return !!(
      r.obligation ||
      r.proof ||
      (r.evidence?.length ?? 0) > 0 ||
      r.reviewStatus ||
      r.verification ||
      r.ledgerStatus ||
      r.rollup ||
      (r.humanPath && r.humanPath.state !== "none") ||
      findingFor(r)
    );
  }

  function obligationLabel(r: CoverageRef): string {
    if (!r.obligation) return "—";
    if (r.obligation.status === "missing") return "Missing";
    return r.obligation.mode ? humanizeToken(r.obligation.mode) : "Present";
  }

  function humanLabel(r: CoverageRef): string {
    const packet = r.humanPath?.packet ?? r.humanVerificationPacket;
    if (packet) return ledgerStatusLabel(packet.status);
    if (r.humanPath?.state && r.humanPath.state !== "none") return humanizeToken(r.humanPath.state);
    return "—";
  }

  // Resolve the richest per-AC reviewer finding for a ref: coverage row → owning slice
  // (via sliceId) → its reviewResult.frAcFindings, matched case-insensitively (findings
  // key on the UPPERCASE ref). Undefined when no slice / no review / no matching finding.
  function findingFor(r: CoverageRef): ReviewFinding | undefined {
    if (!r.sliceId) return undefined;
    const slice = store.snapshot?.slices.find((s) => s.id === r.sliceId);
    const want = r.ref.toUpperCase();
    return slice?.reviewResult?.frAcFindings.find((f) => f.ref.toUpperCase() === want);
  }
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

    <!-- E. Requirement ledger -->
    {#if cov.ledger}
      <div class="cov-panel cov-ledger-panel">
        <div class="cov-panel-head">
          <h3 class="cov-panel-title">Requirement ledger</h3>
          <span class="cov-ledger-origin">derived</span>
        </div>
        <div class="cov-ledger-facts">
          <span><strong>{ledgerFacts.total}</strong> refs</span>
          <span><strong>{ledgerFacts.rollups}</strong> rollups</span>
          <span><strong>{ledgerFacts.humanPending}</strong> human pending</span>
          <span><strong>{ledgerFacts.humanSigned}</strong> human signed</span>
        </div>
        {#if ledgerCards.length}
          <div class="cov-ledger-cards">
            {#each ledgerCards as item (item.status)}
              <span class="cov-badge {item.tone.cls}" title={item.status}>
                <span class="cov-ledger-glyph">{item.tone.glyph}</span>{item.count} {item.tone.label}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- F. Requirements table -->
    <div class="cov-panel cov-table-panel">
      <div class="cov-filters">
        <label class="sr-only" for="cov-filter">Filter requirements</label>
        <input id="cov-filter" class="search" placeholder="Filter refs / domain / slice / ledger…" bind:value={q} />
        <select bind:value={statusFilter} aria-label="Filter by direct status">{#each STATUSES as s}<option value={s}>{s === "all" ? "All direct" : statusLabel(s)}</option>{/each}</select>
        <select bind:value={ledgerFilter} aria-label="Filter by ledger status">{#each LEDGER_STATUSES as s}<option value={s}>{s === "all" ? "All ledger" : ledgerStatusLabel(s)}</option>{/each}</select>
        <span class="muted cov-count-shown">{rows.length} shown</span>
      </div>
      <div class="cov-table-scroll">
        <table class="cov-table">
          <thead><tr><th class="cov-th-caret" aria-label="Expand"></th><th>Requirement</th><th>Domain</th><th>Ledger</th><th>Direct</th><th>Obligation</th><th>Human</th><th>Slice</th><th>Verification</th><th>Next</th></tr></thead>
          <tbody>
            {#each rows as r (r.ref)}
              {@const detail = hasDetail(r)}
              {@const obl = r.obligation}
              {@const expanded = expandedRef === r.ref}
              {@const lt = ledgerTone(r.ledgerStatus)}
              <tr
                class="cov-row cov-{r.status}"
                class:cov-row-obl={detail}
                class:cov-row-expanded={expanded}
              >
                <td class="cov-caret-cell">
                  {#if detail}
                    <button
                      type="button"
                      class="cov-obl-btn"
                      aria-expanded={expanded}
                      title={expanded ? "Hide detail" : "Show detail"}
                      onclick={() => toggleRow(r.ref)}
                    >
                      <span
                        class="cov-obl-marker"
                        class:missing={obl?.status === "missing"}
                        aria-hidden="true"
                      ></span>
                      <span class="cov-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                    </button>
                  {/if}
                </td>
                <td class="mono">{r.ref}</td>
                <td>{r.domain}</td>
                <td>
                  <span class="cov-badge {lt.cls}" title={r.ledgerReason ?? lt.label}>
                    <span class="cov-ledger-glyph">{lt.glyph}</span>{lt.label}
                  </span>
                </td>
                <td><span class="cov-badge cov-badge-{r.directStatus ?? r.status}">{statusLabel(r.directStatus ?? r.status)}</span></td>
                <td class="muted">{obligationLabel(r)}</td>
                <td class="muted">{humanLabel(r)}</td>
                <td class="mono muted" title={r.sliceId ?? ""}>{r.sliceId ? r.sliceId.slice(-8) : "—"}</td>
                <td class="muted">{r.verification ?? r.reviewStatus ?? "—"}</td>
                <td class="muted">{humanizeToken(r.nextAction)}</td>
              </tr>
              {#if detail && expanded}
                <tr class="cov-obl-row">
                  <td></td>
                  <td colspan="9"><RequirementDetail ref={r} finding={findingFor(r)} /></td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</section>
