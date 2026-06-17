<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { HarnessEvent, AgentRunRecord, ReviewResult, SliceWithDetail, AgentActivity, CoverageRef } from "~/lib/types";
  import { formatDuration, describeActivity, fmtClock, shortAge, livenessLevel, groupRunActivity, summarizeCommand, prettifyTarget, refTone, statusLabel, cleanSliceTitle, type ActivityGroup } from "~/lib/format";
  import { api } from "~/lib/api";
  import Markdown from "~/components/Markdown.svelte";
  import OverseerTurnDetail from "~/components/OverseerTurnDetail.svelte";
  import HumanActionDetail from "~/components/HumanActionDetail.svelte";
  let { store, onResolved = () => {} }: { store: ConsoleStore; onResolved?: () => void } = $props();
  const sel = $derived(store.selected);
  // A queue action open for resolution takes priority over any entity 'sel' branch below.
  const selectedAction = $derived(store.selectedAction);
  const slice = $derived(sel?.kind === "slice" ? store.snapshot?.slices.find((s) => s.id === sel.id) : undefined);
  const chain = $derived(sel?.kind === "slice" ? store.proofChainFor(sel.id) : []);
  // Current heartbeat state for the selected agent.
  const heartbeat = $derived(sel?.kind === "agent" ? store.snapshot?.heartbeats.find((h) => h.actor === sel.actor) : undefined);
  const currentState = $derived(heartbeat?.state);
  const working = $derived(["reading", "testing", "editing", "verifying"].includes(currentState ?? ""));
  // Latest run status for the selected actor (latest run by startedAt).
  const runStatus = $derived((() => {
    if (sel?.kind !== "agent") return undefined;
    const runs = (store.snapshot?.agentRuns ?? []).filter((r) => r.actor === sel.actor);
    if (runs.length === 0) return undefined;
    return runs.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b)).status;
  })());
  // Last-signal age + liveness for the selected agent.
  const sigAge = $derived(heartbeat ? Date.now() - Date.parse(heartbeat.timestamp) : Infinity);
  const level = $derived(livenessLevel(runStatus, sigAge));
  // Per-agent focus triage: the highest-priority agentFocusQueue item for the selected actor (the
  // reason it needs attention + recommended interventions). undefined when the queue has no match.
  const agentFocus = $derived((() => {
    if (sel?.kind !== "agent") return undefined;
    const items = (store.snapshot?.agentFocusQueue ?? []).filter((f) => f.actor === sel.actor);
    if (items.length === 0) return undefined;
    return items.reduce((a, b) => (a.focusPriority >= b.focusPriority ? a : b));
  })());

  function sliceById(id: string): SliceWithDetail | undefined {
    return store.snapshot?.slices.find((s) => s.id === id);
  }
  function runDuration(r: AgentRunRecord): number {
    return Date.parse(r.updatedAt) - Date.parse(r.startedAt);
  }
  function shortTitle(t: string, n = 48): string {
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }
  function truncate(s: string, n: number): string {
    const clean = s.replace(/\s+/g, " ").trim();
    return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
  }
  // Human op label per role.
  function opLabel(role?: string): string {
    if (role === "reviewer") return "Review";
    if (role === "worker") return "Work";
    if (role === "verifier") return "Verify";
    return role ?? "Run";
  }

  // ---- Full fetched event history for the selected agent (newest-first from server). ----
  let agentHistory = $state<HarnessEvent[]>([]);
  let historyLoading = $state(false);
  $effect(() => {
    if (sel?.kind !== "agent") { agentHistory = []; historyLoading = false; return; }
    const actor = sel.actor;
    historyLoading = true;
    agentHistory = [];
    let cancelled = false;
    api.agentEvents(actor)
      .then((res) => {
        if (cancelled || sel?.kind !== "agent" || sel.actor !== actor) return;
        agentHistory = res.events ?? [];
      })
      .catch(() => { if (!cancelled && sel?.kind === "agent" && sel.actor === actor) agentHistory = []; })
      .finally(() => { if (!cancelled && sel?.kind === "agent" && sel.actor === actor) historyLoading = false; });
    return () => { cancelled = true; };
  });

  // ---- RUNS: this agent's runs, newest first by startedAt. ----
  const agentRuns = $derived((() => {
    if (sel?.kind !== "agent") return [] as AgentRunRecord[];
    return (store.snapshot?.agentRuns ?? [])
      .filter((r) => r.actor === sel.actor)
      .slice()
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  })());

  // ---- "Working on": the slice the agent's latest/current run is bound to. ----
  // Latest run by startedAt → its slice. Skipped (undefined) when no resolvable slice (e.g. overseer).
  const workingSlice = $derived((() => {
    if (sel?.kind !== "agent") return undefined;
    const latest = agentRuns[0]; // agentRuns is sorted newest-first by startedAt
    return latest ? sliceById(latest.sliceId) : undefined;
  })());
  // Coverage lookup to color the working-slice refs + name the spec/domain. Empty when coverage is null.
  const covByRef = $derived.by(() => {
    const map = new Map<string, CoverageRef>();
    for (const r of store.coverage?.refs ?? []) map.set(r.ref.toUpperCase(), r);
    return map;
  });
  const workingSpec = $derived((() => {
    for (const ref of workingSlice?.frAcRefs ?? []) {
      const cr = covByRef.get(ref.toUpperCase());
      if (cr) return cr.domain || cr.sourceTitle || undefined;
    }
    return undefined;
  })());

  // Resolve the review_result THIS run produced (match by resultPath), else the slice's latest review.
  function reviewForRun(run: AgentRunRecord, slc: SliceWithDetail): ReviewResult | undefined {
    if (run.resultPath) {
      for (const ev of slc.evidence) {
        if (ev.kind !== "review_result") continue;
        const p = ev.payload as { path?: string; reviewResult?: ReviewResult } | undefined;
        if (p?.path && p.path === run.resultPath && p.reviewResult) return p.reviewResult;
      }
    }
    return slc.reviewResult;
  }

  // A resolved run: the run + its slice + verdict + the structured result it produced.
  interface ResolvedRun {
    run: AgentRunRecord;
    slice?: SliceWithDetail;
    op: string;
    verdict: string;                                        // review status OR slice status
    review?: ReviewResult;                                  // reviewer runs
    fracResults?: SliceWithDetail["frAcResults"];           // worker/verifier runs
    activity: ActivityGroup[];                              // run-scoped, grouped
    markers: Array<{ id: string; ts: string; label: string; hint?: string }>;
    actionCount: number;
  }

  // Lifecycle marker labels for inline run markers.
  const MARKER_LABELS: Record<string, string> = {
    "review.started": "started review",
    "review.completed": "completed review",
    "review.escalation_raised": "raised escalation",
    "worker.completed": "completed work",
    "verification.completed": "completed verification",
  };
  function markerLabel(type: string): string {
    if (MARKER_LABELS[type]) return MARKER_LABELS[type];
    if (type.startsWith("overseer.") && type.endsWith("completed")) return "overseer completed";
    const tail = type.split(".").slice(1).join(" ").replace(/_/g, " ");
    return tail || type;
  }
  const MARKER_RE = /^(review|worker|verification|overseer)\.|completed$|escalation_raised$/;

  // Extract activity entries (agent_events with a target) from a slice of history.
  function activityEntries(events: HarnessEvent[]) {
    return events
      .filter((e) => e.type.endsWith("agent_event"))
      .map((e) => ({ act: e.payload?.activity as AgentActivity | undefined, ts: e.timestamp }))
      .filter((x) => x.act?.target)
      .map((x) => ({ state: x.act!.state, target: x.act!.target, ts: x.ts }));
  }
  // Extract lifecycle markers from a slice of history (non-agent_event milestone types).
  function markerRows(events: HarnessEvent[]) {
    const out: Array<{ id: string; ts: string; label: string; hint?: string }> = [];
    for (const ev of events) {
      if (ev.type.endsWith("agent_event")) continue;
      if (!MARKER_RE.test(ev.type)) continue;
      const p = ev.payload as Record<string, unknown> | undefined;
      const hint = (p?.status ?? p?.level ?? p?.recommendation) as string | undefined;
      out.push({ id: ev.id, ts: ev.timestamp, label: markerLabel(ev.type), hint: typeof hint === "string" ? hint : undefined });
    }
    return out;
  }

  // Resolve every run with its result + verdict + run-scoped activity window.
  const resolvedRuns = $derived((() => {
    if (sel?.kind !== "agent") return [] as ResolvedRun[];
    return agentRuns.map((run): ResolvedRun => {
      const slc = sliceById(run.sliceId);
      let verdict: string;
      let review: ReviewResult | undefined;
      let fracResults: SliceWithDetail["frAcResults"] | undefined;
      if (run.role === "reviewer" && slc) {
        review = reviewForRun(run, slc);
        verdict = review?.status ?? slc.status;
      } else {
        verdict = slc?.status ?? run.status;
        fracResults = slc?.frAcResults;
      }
      // Window: [startedAt, updatedAt]. Gather this run's activity + markers from history.
      const startMs = Date.parse(run.startedAt);
      const endMs = Date.parse(run.updatedAt);
      const inWindow = agentHistory.filter((e) => {
        const t = Date.parse(e.timestamp);
        return t >= startMs && t <= endMs;
      });
      const entries = activityEntries(inWindow);
      const activity = groupRunActivity(entries);
      const markers = markerRows(inWindow).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      return { run, slice: slc, op: opLabel(run.role), verdict, review, fracResults, activity, markers, actionCount: entries.length };
    });
  })());

  // ---- Identity-card stats. ----
  // Verdict tally across runs, e.g. "3 accepted · 1 blocked".
  function verdictKey(v: string): string {
    if (v === "accepted" || v === "closed") return "accepted";
    if (v === "blocked" || v === "human_required") return "blocked";
    if (v === "repair_required" || v === "repairing") return "repair";
    return v;
  }
  const outcomeSummary = $derived((() => {
    const counts = new Map<string, number>();
    for (const r of resolvedRuns) {
      const k = verdictKey(r.verdict);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(" · ");
  })());
  const totalActive = $derived(formatDuration(agentRuns.reduce((sum, r) => sum + Math.max(0, runDuration(r)), 0)));
  // Escalation markers across the full history.
  const escalationCount = $derived(agentHistory.filter((e) => /escalation_raised$/.test(e.type)).length);
  const role = $derived(agentRuns[0]?.role);
  const driver = $derived(agentRuns[0]?.driver);

  // ---- "Now" line. ----
  // Newest agent_event WITH a target across the whole history (history is newest-first from server).
  const newestActivity = $derived((() => {
    for (const e of agentHistory) {
      if (!e.type.endsWith("agent_event")) continue;
      const act = e.payload?.activity as AgentActivity | undefined;
      if (act?.target) return { state: act.state, target: act.target, ts: e.timestamp };
    }
    return undefined;
  })());
  const nowLine = $derived((() => {
    if (working && newestActivity) {
      const d = describeActivity({ state: newestActivity.state, target: newestActivity.target });
      return { mode: "working" as const, verb: d.present, target: d.target };
    }
    if (newestActivity) {
      const d = describeActivity({ state: newestActivity.state, target: newestActivity.target });
      return { mode: "idle" as const, verb: d.past, target: d.target, ts: newestActivity.ts };
    }
    return { mode: "idle" as const, verb: undefined, target: undefined, ts: undefined };
  })());

  // ---- For agents with NO runs (e.g. overseer): full grouped activity + markers. ----
  const noRunActivity = $derived(resolvedRuns.length === 0 ? groupRunActivity(activityEntries(agentHistory)) : []);
  const noRunMarkers = $derived(
    resolvedRuns.length === 0
      ? markerRows(agentHistory).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, 40)
      : [],
  );

  // ---- Open/closed state (Svelte runes). Default-open the newest run. ----
  let openRuns = $state(new Set<string>());
  let openFindings = $state(new Set<string>());      // keyed `${runId}:${ref}`
  let openActivity = $state(new Set<string>());       // keyed by run.id
  let openTestNotes = $state(new Set<string>());      // keyed by run.id (full testAssessment)
  let noRunActOpen = $state(false);
  let lastActor = $state<string | undefined>(undefined);
  // Reset + default-open newest run whenever the selected agent changes.
  $effect(() => {
    const actor = sel?.kind === "agent" ? sel.actor : undefined;
    if (actor === lastActor) return;
    lastActor = actor;
    openFindings = new Set();
    openActivity = new Set();
    openTestNotes = new Set();
    noRunActOpen = false;
    const first = agentRuns[0]?.id;
    openRuns = new Set(first ? [first] : []);
  });
  function toggle(set: Set<string>, key: string): Set<string> {
    const n = new Set(set);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  }
  const toggleRun = (id: string) => (openRuns = toggle(openRuns, id));
  const toggleFinding = (key: string) => (openFindings = toggle(openFindings, key));
  const toggleActivity = (id: string) => (openActivity = toggle(openActivity, id));
  const toggleTestNotes = (id: string) => (openTestNotes = toggle(openTestNotes, id));

  function refStatusClass(status: string): string {
    if (status === "passed" || status === "accepted") return "passed";
    if (status === "uncertain" || status === "missing_evidence") return "missing_evidence";
    return "failed";
  }
  function verdictClass(v: string): string {
    const k = verdictKey(v);
    if (k === "accepted") return "accepted";
    if (k === "blocked") return "blocked";
    if (k === "repair") return "repair_required";
    return "other";
  }
  // One-line collapsed summary for a run card.
  function runSubLine(r: ResolvedRun): string {
    if (r.review?.recommendation) return truncate(r.review.recommendation, 90);
    if (r.fracResults && r.fracResults.length > 0) {
      return r.fracResults.map((f) => `${f.ref} ${f.status}`).join(" · ");
    }
    return r.slice ? `${r.slice.status}` : r.run.status;
  }

  const escalation = $derived(
    sel?.kind === "escalation" ? store.snapshot?.activeEscalations.find((e) => e.id === sel.id) : undefined,
  );
  const overseerEvent = $derived(
    sel?.kind === "overseerTurn" ? store.snapshot?.recentEvents.find((e) => e.id === sel.eventId) : undefined,
  );

  // ---- Focus packets: lazy-fetched deep diagnostic packets for slice/run zoom. ----
  let focusPacket = $state<Record<string, unknown> | null>(null);
  let focusLoading = $state(false);
  let focusError = $state<string | undefined>(undefined);
  let openRawPacket = $state(false);
  $effect(() => {
    if (sel?.kind !== "focusSlice" && sel?.kind !== "focusRun") {
      focusPacket = null; focusLoading = false; focusError = undefined; return;
    }
    const kind = sel.kind;
    const id = sel.id;
    focusPacket = null; focusError = undefined; focusLoading = true; openRawPacket = false;
    let cancelled = false;
    const p = kind === "focusSlice" ? api.focusSlice(id) : api.focusRun(id);
    p.then((res) => {
        if (cancelled || sel?.kind !== kind || sel.id !== id) return;
        focusPacket = res;
      })
      .catch((e) => { if (!cancelled && sel?.kind === kind && sel.id === id) focusError = String(e?.message ?? e); })
      .finally(() => { if (!cancelled && sel?.kind === kind && sel.id === id) focusLoading = false; });
    return () => { cancelled = true; };
  });

  // ---- Slice report: lazy-fetched markdown for the selected slice. ----
  // Fetched on first open of the collapsible "Report" section (not on every slice click), with a
  // stale-guard keyed to the selected slice id so switching slices mid-fetch never renders a stale
  // report. States: idle (unopened), loading, error, ok (markdown, possibly empty → "no report").
  let reportOpen = $state(false);
  let reportMd = $state<string | null>(null);
  let reportLoading = $state(false);
  let reportError = $state(false);
  let reportFetchedFor = $state<string | undefined>(undefined);
  // Reset the report whenever the selected slice changes (or selection leaves a slice). Keyed to the
  // slice id so re-renders for the SAME slice don't wipe an already-loaded report.
  $effect(() => {
    const id = sel?.kind === "slice" ? sel.id : undefined;
    if (id === reportFetchedFor) return;
    reportFetchedFor = id;
    reportOpen = false;
    reportMd = null;
    reportLoading = false;
    reportError = false;
  });
  function loadReport(sliceId: string) {
    reportLoading = true;
    reportError = false;
    reportMd = null;
    api.report(sliceId)
      .then((md) => { if (sel?.kind === "slice" && sel.id === sliceId) reportMd = md; })
      .catch(() => { if (sel?.kind === "slice" && sel.id === sliceId) reportError = true; })
      .finally(() => { if (sel?.kind === "slice" && sel.id === sliceId) reportLoading = false; });
  }
  function toggleReport(sliceId: string) {
    reportOpen = !reportOpen;
    // Fetch on first open only (markdown not yet loaded and not currently loading).
    if (reportOpen && reportMd === null && !reportLoading) loadReport(sliceId);
  }

  // Defensive accessors over the nested packet (shape is server-owned).
  function pick(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  }
  function asStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  }
  function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }
  function strArr(v: unknown): string[] {
    return asArr(v).filter((x): x is string => typeof x === "string");
  }
  function joinKv(...pairs: Array<[string, unknown]>): string {
    return pairs
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k} ${asStr(v) ?? ""}`)
      .join(" · ");
  }
</script>

{#if sel || selectedAction}
  <aside class="inspector">
    <div class="inspector-head">
      <strong>
        {#if selectedAction}Action required
        {:else if sel}{sel.kind}{slice ? ` · ${slice.id}` : sel.kind === "agent" ? ` · ${sel.actor}` : sel.kind === "focusSlice" || sel.kind === "focusRun" ? ` · ${sel.id}` : ""}{/if}
      </strong>
      <!-- store.select(null) clears BOTH selections (it nulls selectedActionId per the store). -->
      <button class="close" onclick={() => store.select(null)}>✕</button>
    </div>

    {#if selectedAction}
      <HumanActionDetail {store} action={selectedAction} {onResolved} />
    {:else if sel?.kind === "slice" && slice}
      <h4>{cleanSliceTitle(slice.title)} · {slice.status}<span class="muted"> · {formatDuration((["accepted","closed"].includes(slice.status) ? Date.parse(slice.updatedAt) : Date.now()) - Date.parse(slice.createdAt))}</span></h4>
      <div class="proof">
        {#each chain as row (row.ref)}
          <div class="proof-ref">
            <div class="proof-ref-head">
              <span class="ref ref-{row.verification?.status ?? 'missing_evidence'}">{row.ref}</span>
              <span class="muted">lease: {row.leaseStatus ?? "—"}</span>
              {#if row.reviewFinding}<span class="muted">review: {row.reviewFinding.status}</span>{/if}
            </div>
            {#each row.citations as c}<div class="citation">▸ <Markdown md={c} inline /></div>{/each}
          </div>
        {/each}
      </div>

      <!-- Report — human-readable slice report, lazily fetched on first open. -->
      <section class="agent-section">
        <button class="run-act-toggle" onclick={() => toggleReport(slice.id)}>
          {reportOpen ? "▾" : "▸"} Report
        </button>
        {#if reportOpen}
          {#if reportLoading}
            <p class="empty">Loading…</p>
          {:else if reportError}
            <p class="error">Could not load report</p>
          {:else if reportMd && reportMd.trim().length > 0}
            <div class="sl-report"><Markdown md={reportMd} /></div>
          {:else}
            <p class="empty">No report available</p>
          {/if}
        {/if}
      </section>
    {:else if sel?.kind === "agent"}
      <!-- 0. "Working on" — the slice this agent's latest run is bound to. Skipped when no slice. -->
      {#if workingSlice}
        <div class="ag-working">
          <div class="ag-working-head">
            <span class="ag-working-eyebrow">Working on</span>
            <button class="ag-working-title" title="Open slice {workingSlice.id}" onclick={() => store.select({ kind: "slice", id: workingSlice.id })}>
              {cleanSliceTitle(workingSlice.title)}
            </button>
            <span class="verdict verdict-{verdictClass(workingSlice.status)}">{workingSlice.status}</span>
          </div>
          {#if workingSpec}<div class="ag-working-spec muted">{workingSpec}</div>{/if}
          {#if workingSlice.frAcRefs.length > 0}
            <div class="ag-working-refs">
              {#each workingSlice.frAcRefs as ref (ref)}
                {@const tone = refTone(covByRef.get(ref.toUpperCase())?.status)}
                <span class="ag-working-ref {tone.cls}" title="{ref} · {statusLabel(covByRef.get(ref.toUpperCase())?.status ?? '')}">
                  <span class="ag-ref-glyph" aria-hidden="true">{tone.glyph}</span>{ref}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- 1. Identity / status card — always visible, compact. -->
      <div class="ag-card">
        <div class="agent-liveness">
          <span class="live-dot live-{level}"></span>
          <span class="liveness-word">{level === "done" ? "done" : level === "dead" ? "no signal" : "live"}</span>
          <span class="muted"> · last signal {shortAge(sigAge)}</span>
        </div>
        <div class="ag-stats">
          {#if role}<span>{role}</span>{/if}
          {#if driver}<span class="muted"> · {driver}</span>{/if}
          <span class="muted"> · {agentRuns.length} run{agentRuns.length === 1 ? "" : "s"}</span>
          {#if outcomeSummary}<span class="muted"> · {outcomeSummary}</span>{/if}
          {#if escalationCount > 0}<span class="ag-esc"> · {escalationCount} escalation{escalationCount === 1 ? "" : "s"}</span>{/if}
          {#if totalActive}<span class="muted"> · {totalActive} active</span>{/if}
        </div>
      </div>

      <!-- 2. "Now" line — what it's DOING. -->
      <div class="ag-now">
        {#if nowLine.mode === "working"}
          <span class="spinner" aria-hidden="true"></span>
          <span class="ag-now-verb">now: {nowLine.verb}</span>
          {#if nowLine.target}<code class="now-target">{nowLine.target}</code>{/if}
        {:else if nowLine.verb}
          <span class="muted">idle — last: {nowLine.verb}</span>
          {#if nowLine.target}<code class="now-target">{nowLine.target}</code>{/if}
          {#if nowLine.ts}<span class="muted"> · {fmtClock(nowLine.ts)}</span>{/if}
        {:else}
          <span class="muted">idle</span>
        {/if}
      </div>

      <!-- 2b. Focus — the engine's per-agent triage. Rendered only when this agent has a focus item. -->
      {#if agentFocus}
        {@const lastCmd = agentFocus.lastCommand}
        <section class="agent-section ag-focus">
          <h4>Focus</h4>
          <div class="ag-focus-reason">
            <span class="agent-focus-pill">⚑</span>
            <span>{agentFocus.reason}</span>
            <span class="verdict verdict-other ag-focus-status">{agentFocus.status}</span>
          </div>
          {#if agentFocus.recommendedInterventions.length > 0}
            <div class="run-subhead">Recommended interventions</div>
            <ul class="run-fixes">{#each agentFocus.recommendedInterventions as fix}<li>{fix}</li>{/each}</ul>
          {/if}
          {#if lastCmd}
            <div class="run-subhead">Last command</div>
            <div class="focus-cmd">
              <code title={lastCmd.command}>{prettifyTarget(lastCmd.command)}</code>
              {#if lastCmd.status != null}
                <span class="exit">{lastCmd.status}</span>
              {/if}
              {#if lastCmd.exitCode != null}
                <span class="exit" class:bad={lastCmd.exitCode !== 0}>exit {lastCmd.exitCode}</span>
              {/if}
            </div>
            {#if lastCmd.outputTail}
              <pre class="json" style="max-height:160px">{lastCmd.outputTail}</pre>
            {/if}
          {/if}
        </section>
      {/if}

      <!-- 3. Runs — what it HAS DONE. Collapsible per-run cards, newest first. -->
      {#if historyLoading && resolvedRuns.length === 0}
        <p class="empty">Loading…</p>
      {:else if resolvedRuns.length > 0}
        <section class="agent-section">
          <h4>Runs</h4>
          {#each resolvedRuns as r (r.run.id)}
            {@const open = openRuns.has(r.run.id)}
            <div class="run-card">
              <button class="run-card-head" onclick={() => toggleRun(r.run.id)}>
                <span class="run-toggle">{open ? "▾" : "▸"}</span>
                <span class="run-op">{r.op}</span>
                <span class="run-slice">{r.slice ? `${r.slice.id} · ${shortTitle(r.slice.title)}` : r.run.sliceId}</span>
                <span class="verdict verdict-{verdictClass(r.verdict)}">{r.verdict}</span>
                <span class="muted run-when"> · {fmtClock(r.run.startedAt)} · {formatDuration(runDuration(r.run))}</span>
              </button>
              <div class="run-sub">{runSubLine(r)} <span class="muted">· {r.actionCount} action{r.actionCount === 1 ? "" : "s"}</span></div>

              {#if open}
                <div class="run-body">
                  {#if r.review}
                    {#if r.review.recommendation}
                      <div class="run-rec"><Markdown md={r.review.recommendation} inline /></div>
                    {/if}
                    <div class="run-meta">
                      <span class="muted">risk: {r.review.stubOrHardcodeRisk}</span>
                      <span class="muted"> · quality: {r.review.qualityGate.status}</span>
                      <span class="muted"> · source-mutation: {r.review.sourceMutationDetected ? "yes" : "no"}</span>
                      {#if r.review.testAssessment}
                        <button class="run-act-toggle" onclick={() => toggleTestNotes(r.run.id)} title="toggle full test assessment">
                          {openTestNotes.has(r.run.id) ? "▾" : "▸"} {openTestNotes.has(r.run.id) ? "tests" : truncate(r.review.testAssessment, 120)}
                        </button>
                      {/if}
                    </div>
                    {#if r.review.testAssessment && openTestNotes.has(r.run.id)}
                      <div class="run-testnote muted">{r.review.testAssessment}</div>
                    {/if}
                    {#if r.review.qualityGate.summary || r.review.qualityGate.blockingConcerns.length > 0 || r.review.qualityGate.residualRisks.length > 0}
                      <div class="run-testnote muted">
                        quality: {r.review.qualityGate.summary}
                        {#if r.review.qualityGate.blockingConcerns.length > 0}
                          · blockers: {r.review.qualityGate.blockingConcerns.join("; ")}
                        {/if}
                        {#if r.review.qualityGate.residualRisks.length > 0}
                          · residual: {r.review.qualityGate.residualRisks.join("; ")}
                        {/if}
                      </div>
                    {/if}

                    {#if r.review.frAcFindings.length > 0}
                      <div class="run-subhead">Findings ({r.review.frAcFindings.length})</div>
                      {#each r.review.frAcFindings as f (f.ref)}
                        {@const fkey = `${r.run.id}:${f.ref}`}
                        <div class="finding">
                          <button class="finding-row" onclick={() => toggleFinding(fkey)}>
                            <span class="ref ref-{refStatusClass(f.status)}">{f.ref}</span>
                            <span class="muted">{f.status}</span>
                            {#if f.finding}<span class="finding-text"> — {truncate(f.finding, 80)}</span>{/if}
                          </button>
                          {#if openFindings.has(fkey)}
                            <div class="finding-ev">
                              {#if f.finding}<div class="citation"><Markdown md={f.finding} inline /></div>{/if}
                              {#each f.evidence as c}<div class="citation">▸ <Markdown md={c} inline /></div>{/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    {/if}

                    {#if r.review.requiredFixes.length > 0}
                      <div class="run-subhead">Required fixes</div>
                      <ul class="run-fixes">
                        {#each r.review.requiredFixes as fix}<li>{fix}</li>{/each}
                      </ul>
                    {/if}
                    {#if r.review.escalations.length > 0}
                      <div class="run-subhead">Escalations</div>
                      <ul class="run-esc">
                        {#each r.review.escalations as esc}<li><b>{esc.level}</b> {esc.message}</li>{/each}
                      </ul>
                    {/if}
                  {:else if r.fracResults && r.fracResults.length > 0}
                    <div class="run-subhead">Findings ({r.fracResults.length})</div>
                    {#each r.fracResults as fr (fr.ref)}
                      {@const fkey = `${r.run.id}:${fr.ref}`}
                      <div class="finding">
                        <button class="finding-row" onclick={() => toggleFinding(fkey)}>
                          <span class="ref ref-{refStatusClass(fr.status)}">{fr.ref}</span>
                          <span class="muted">{fr.status}</span>
                          {#if fr.proof}<span class="finding-text"> — {truncate(fr.proof, 80)}</span>{/if}
                        </button>
                        {#if openFindings.has(fkey) && fr.proof}
                          <div class="finding-ev"><div class="citation">▸ <Markdown md={fr.proof} inline /></div></div>
                        {/if}
                      </div>
                    {/each}
                  {/if}

                  <!-- Run-scoped, grouped activity (collapsed by default). -->
                  {#if r.activity.length > 0 || r.markers.length > 0}
                    {@const actOpen = openActivity.has(r.run.id)}
                    <button class="run-act-toggle" onclick={() => toggleActivity(r.run.id)}>
                      {actOpen ? "▾" : "▸"} {r.actionCount} action{r.actionCount === 1 ? "" : "s"}
                    </button>
                    {#if actOpen}
                      <div class="run-activity">
                        {#each r.activity as g (g.startTs + g.verb)}
                          <div class="act-group">
                            <span class="act-time" title={g.startTs}>{fmtClock(g.startTs)}</span>
                            <span class="act-verb">{g.verb}</span>
                            {#if g.targets.length > 0}<span class="targets">{g.targets.join(", ")}</span>{/if}
                          </div>
                        {/each}
                        {#each r.markers as m (m.id)}
                          <div class="act-group act-marker-row">
                            <span class="act-time" title={m.ts}>{fmtClock(m.ts)}</span>
                            <span class="muted">{m.label}{m.hint ? ` · ${m.hint}` : ""}</span>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </section>
      {:else}
        <!-- 4. Agents with no slice runs (e.g. overseer): full grouped activity + markers. -->
        <section class="agent-section">
          {#if historyLoading}
            <p class="empty">Loading activity…</p>
          {:else if noRunActivity.length === 0 && noRunMarkers.length === 0}
            <p class="empty">No recorded activity for this agent.</p>
          {:else}
            <button class="run-act-toggle" onclick={() => (noRunActOpen = !noRunActOpen)}>
              {noRunActOpen ? "▾" : "▸"} Activity ({noRunActivity.reduce((n, g) => n + g.count, 0)} action{noRunActivity.reduce((n, g) => n + g.count, 0) === 1 ? "" : "s"})
            </button>
            {#if noRunActOpen}
              <div class="run-activity">
                {#each [...noRunActivity].reverse() as g (g.startTs + g.verb)}
                  <div class="act-group">
                    <span class="act-time" title={g.startTs}>{fmtClock(g.startTs)}</span>
                    <span class="act-verb">{g.verb}</span>
                    {#if g.targets.length > 0}<span class="targets">{g.targets.join(", ")}</span>{/if}
                  </div>
                {/each}
                {#each noRunMarkers as m (m.id)}
                  <div class="act-group act-marker-row">
                    <span class="act-time" title={m.ts}>{fmtClock(m.ts)}</span>
                    <span class="muted">{m.label}{m.hint ? ` · ${m.hint}` : ""}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </section>
      {/if}
    {:else if sel?.kind === "escalation" && escalation}
      <div class="esc-level esc-{escalation.level}">{escalation.level}</div>
      <p>{escalation.message}</p>
      {#if escalation.reason}<p class="muted">{escalation.reason}</p>{/if}
    {:else if sel?.kind === "overseerTurn" && overseerEvent}
      <OverseerTurnDetail event={overseerEvent} />
    {:else if sel?.kind === "focusSlice"}
      <div class="focus-packet">
        {#if focusLoading}
          <p class="empty">Loading…</p>
        {:else if focusError}
          <p class="error">Failed to load focus packet — {focusError}</p>
        {:else if focusPacket}
          {@const sliceObj = pick(focusPacket, "slice")}
          {@const sliceTitle = asStr(pick(sliceObj, "title")) ?? asStr(pick(focusPacket, "slice.title")) ?? sel.id}
          {@const sliceStatus = asStr(pick(sliceObj, "status")) ?? asStr(pick(focusPacket, "slice.status")) ?? "—"}
          {@const diag = pick(focusPacket, "diagnosis")}
          {@const diagStatus = asStr(pick(diag, "status"))}
          {@const diagBlocked = pick(diag, "blocked")}
          {@const diagRetry = pick(diag, "retryCount")}
          {@const recs = strArr(pick(diag, "recommendedInterventions"))}
          {@const escalations = asArr(pick(focusPacket, "activeEscalations"))}
          {@const leases = asArr(pick(focusPacket, "leases"))}
          {@const evidence = asArr(pick(focusPacket, "evidence"))}
          {@const runs = asArr(pick(focusPacket, "runs"))}
          {@const latestRunFocus = pick(focusPacket, "latestRunFocus")}
          {@const lrfRun = pick(latestRunFocus, "run")}
          {@const lrfDiag = pick(latestRunFocus, "diagnosis")}
          {@const lrfFailureClasses = strArr(pick(lrfDiag, "failureClasses"))}
          {@const lrfLastCmd = pick(latestRunFocus, "latestSignals.lastCommand")}
          {@const lrfRunId = asStr(pick(lrfRun, "id"))}

          <h4 class="focus-pk-title">Focus · SLICE-{sel.id} · {sliceTitle} <span class="verdict verdict-other" style="font-size:10px">{sliceStatus}</span></h4>

          <!-- Diagnosis -->
          <div class="run-subhead">Diagnosis</div>
          <div class="focus-pk-meta muted">
            {#if diagStatus}status: {diagStatus}{/if}
            {#if diagBlocked != null} · blocked: {String(diagBlocked)}{/if}
            {#if diagRetry != null} · retries: {String(diagRetry)}{/if}
            {#if !diagStatus && diagBlocked == null && diagRetry == null}—{/if}
          </div>

          {#if recs.length > 0}
            <div class="run-subhead">Recommended interventions</div>
            <ul class="run-fixes">{#each recs as r}<li>{r}</li>{/each}</ul>
          {/if}

          <!-- Active escalations -->
          {#if escalations.length > 0}
            <div class="run-subhead">Active escalations</div>
            <ul class="run-esc" style="list-style:none;padding:0">
              {#each escalations as e}
                {@const lvl = asStr(pick(e, "level")) ?? "—"}
                {@const msg = asStr(pick(e, "message")) ?? ""}
                <li class:reason-red={lvl === "critical" || lvl === "human_required"} class:reason-amber={lvl === "warning"} style="margin-bottom:3px">
                  <b>{lvl}</b>: {msg}
                </li>
              {/each}
            </ul>
          {/if}

          <!-- Latest run summary -->
          {#if latestRunFocus && lrfRun}
            <div class="run-subhead">Latest run</div>
            <div class="focus-pk-meta">
              <span>{asStr(pick(lrfRun, "role")) ?? "—"} {asStr(pick(lrfRun, "actor")) ?? ""}</span>
              <span class="verdict verdict-other" style="font-size:10px;margin-left:4px">{asStr(pick(lrfRun, "status")) ?? "—"}</span>
            </div>
            {#if lrfFailureClasses.length > 0}
              <div class="focus-pk-chips">
                {#each lrfFailureClasses as fc}<span class="focus-reason reason-red">{fc}</span>{/each}
              </div>
            {:else}
              <div class="focus-pk-meta muted">No failure classes</div>
            {/if}
            {#if lrfLastCmd}
              {@const lrfCmdRaw = asStr(pick(lrfLastCmd, "command"))}
              {@const lrfExitCode = pick(lrfLastCmd, "exitCode")}
              <div class="focus-cmd">
                {#if lrfCmdRaw}<code>{prettifyTarget(lrfCmdRaw)}</code>{/if}
                {#if lrfExitCode != null}
                  <span class="exit" class:bad={lrfExitCode !== 0}>exit {asStr(lrfExitCode)}</span>
                {/if}
              </div>
            {/if}
            {#if lrfRunId}
              <button class="run-act-toggle" style="margin-top:4px;color:var(--blue)"
                onclick={() => store.select({ kind: "focusRun", id: lrfRunId })}>
                zoom into run →
              </button>
            {/if}
          {/if}

          <!-- Counts -->
          <div class="focus-pk-meta muted" style="margin-top:8px">
            {leases.length} leases · {evidence.length} evidence · {runs.length} runs
          </div>

          <button class="run-act-toggle" onclick={() => (openRawPacket = !openRawPacket)}>
            {openRawPacket ? "▾" : "▸"} raw packet
          </button>
          {#if openRawPacket}<pre class="json">{JSON.stringify(focusPacket, null, 2)}</pre>{/if}
        {:else}
          <p class="empty">No packet.</p>
        {/if}
      </div>
    {:else if sel?.kind === "focusRun"}
      <div class="focus-packet">
        {#if focusLoading}
          <p class="empty">Loading…</p>
        {:else if focusError}
          <p class="error">Failed to load focus packet — {focusError}</p>
        {:else if focusPacket}
          {@const run = pick(focusPacket, "run")}
          {@const runRole = asStr(pick(run, "role")) ?? "—"}
          {@const runActor = asStr(pick(run, "actor")) ?? "—"}
          {@const runStatus = asStr(pick(run, "status")) ?? "—"}
          {@const runAttempt = pick(run, "attempt")}
          {@const runDriver = asStr(pick(run, "driver"))}
          {@const runStartedAt = asStr(pick(run, "startedAt"))}
          {@const hb = pick(focusPacket, "heartbeat")}
          {@const diag = pick(focusPacket, "diagnosis")}
          {@const failureClasses = strArr(pick(diag, "failureClasses"))}
          {@const recs = strArr(pick(diag, "recommendedInterventions"))}
          {@const lastCommand = pick(focusPacket, "latestSignals.lastCommand")}
          {@const eventStream = pick(focusPacket, "eventStream")}
          {@const artifacts = pick(focusPacket, "artifacts")}

          <!-- Header -->
          <h4 class="focus-pk-title">
            Focus · RUN-{sel.id} · {runRole} {runActor}
            <span class="verdict verdict-other" style="font-size:10px;margin-left:4px">{runStatus}</span>
          </h4>

          <!-- Run meta line -->
          <div class="focus-pk-meta muted">
            attempt {asStr(runAttempt) ?? "—"}
            {#if runDriver} · {runDriver}{/if}
            {#if runStartedAt} · started {fmtClock(runStartedAt)}{/if}
          </div>

          <!-- Heartbeat -->
          {#if hb}
            <div class="focus-pk-meta" style="margin-top:4px">
              <span>{asStr(pick(hb, "state")) ?? "—"}</span>
              {#if asStr(pick(hb, "detail"))} · <span class="muted">{asStr(pick(hb, "detail"))}</span>{/if}
              {#if pick(hb, "ageMs") != null}
                <span class="muted"> · {shortAge(pick(hb, "ageMs") as number)}</span>
              {/if}
            </div>
          {/if}

          <!-- Failure classes -->
          <div class="run-subhead">Failure classes</div>
          {#if failureClasses.length > 0}
            <div class="focus-pk-chips">
              {#each failureClasses as fc}<span class="focus-reason reason-red">{fc}</span>{/each}
            </div>
          {:else}
            <div class="focus-pk-meta muted">No failure classes</div>
          {/if}

          <!-- Recommended interventions -->
          {#if recs.length > 0}
            <div class="run-subhead">Recommended interventions</div>
            <ul class="run-fixes" style="color:var(--muted)">{#each recs as r}<li>{r}</li>{/each}</ul>
          {/if}

          <!-- Last command -->
          {#if lastCommand}
            {@const cmdRaw = asStr(pick(lastCommand, "command"))}
            {@const exitCode = pick(lastCommand, "exitCode")}
            {@const outputTail = asStr(pick(lastCommand, "outputTail"))}
            <div class="run-subhead">Last command</div>
            <div class="focus-cmd">
              {#if cmdRaw}<code>{prettifyTarget(cmdRaw)}</code>{/if}
              {#if exitCode != null}
                <span class="exit" class:bad={exitCode !== 0}>exit {asStr(exitCode)}</span>
              {/if}
            </div>
            {#if outputTail}
              <pre class="json" style="max-height:160px">{outputTail}</pre>
            {/if}
          {/if}

          <!-- Event stream -->
          {#if eventStream}
            {@const lineCount = pick(eventStream, "lineCount")}
            {@const parseErrCount = pick(eventStream, "parseErrorCount")}
            {@const evExists = pick(eventStream, "exists")}
            <div class="run-subhead">Event stream</div>
            <div class="focus-pk-meta muted">
              {asStr(lineCount) ?? "—"} events
              {#if parseErrCount != null}
                · <span class:bad-parse={Number(parseErrCount) > 0} style={Number(parseErrCount) > 0 ? "color:var(--red)" : ""}>{asStr(parseErrCount)} parse errors</span>
              {/if}
              · {evExists ? "exists" : "missing"}
            </div>
          {/if}

          <!-- Artifacts -->
          {#if artifacts}
            <div class="run-subhead">Artifacts</div>
            <div class="focus-pk-meta muted">
              {#each [["prompt", pick(artifacts, "prompt")], ["events", pick(artifacts, "events")], ["result", pick(artifacts, "result")], ["stderr", pick(artifacts, "stderr")]] as [name, art]}
                {@const artExists = pick(art, "exists")}
                {@const artSize = pick(art, "size")}
                <span style="margin-right:8px">
                  {name}
                  {#if artExists}{artSize != null ? `✓ (${asStr(artSize)}b)` : "✓"}{:else}—{/if}
                </span>
              {/each}
            </div>
          {/if}

          <button class="run-act-toggle" onclick={() => (openRawPacket = !openRawPacket)}>
            {openRawPacket ? "▾" : "▸"} raw packet
          </button>
          {#if openRawPacket}<pre class="json">{JSON.stringify(focusPacket, null, 2)}</pre>{/if}
        {:else}
          <p class="empty">No packet.</p>
        {/if}
      </div>
    {/if}
  </aside>
{/if}
