<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { HarnessEvent, AgentRunRecord, ReviewResult, SliceWithDetail } from "~/lib/types";
  import { activityVerb, prettifyTarget, tokenizeCommand, formatDuration, describeActivity, fmtClock, shortAge, livenessLevel } from "~/lib/format";
  import { api } from "~/lib/api";
  import Markdown from "~/components/Markdown.svelte";
  let { store }: { store: ConsoleStore } = $props();
  const sel = $derived(store.selected);
  const slice = $derived(sel?.kind === "slice" ? store.snapshot?.slices.find((s) => s.id === sel.id) : undefined);
  const chain = $derived(sel?.kind === "slice" ? store.proofChainFor(sel.id) : []);
  const checkpoint = $derived(
    sel?.kind === "agent" ? store.snapshot?.checkpoints.find((c) => c.payload && (c.payload as any).actor === sel.actor) : undefined,
  );
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
  // ---- A. RUNS: this agent's runs, newest first by startedAt. ----
  const agentRuns = $derived((() => {
    if (sel?.kind !== "agent") return [] as AgentRunRecord[];
    return (store.snapshot?.agentRuns ?? [])
      .filter((r) => r.actor === sel.actor)
      .slice()
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  })());
  function sliceById(id: string): SliceWithDetail | undefined {
    return store.snapshot?.slices.find((s) => s.id === id);
  }
  function runDuration(r: AgentRunRecord): number {
    return Date.parse(r.updatedAt) - Date.parse(r.startedAt);
  }

  // ---- B. RESULTS: per distinct slice this agent ran on, the structured result it produced. ----
  interface AgentResult {
    sliceId: string;
    title: string;
    role?: string;
    kind: "review" | "frac";
    headStatus: string;                                            // review status OR slice status
    review?: ReviewResult;
    fracResults?: SliceWithDetail["frAcResults"];
  }
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
  const agentResults = $derived((() => {
    if (sel?.kind !== "agent") return [] as AgentResult[];
    const out: AgentResult[] = [];
    const seen = new Set<string>();
    for (const run of agentRuns) {
      if (seen.has(run.sliceId)) continue;
      seen.add(run.sliceId);
      const slc = sliceById(run.sliceId);
      if (!slc) continue;
      const role = run.role;
      if (role === "reviewer") {
        const review = reviewForRun(run, slc);
        out.push({ sliceId: slc.id, title: slc.title, role, kind: "review", headStatus: review?.status ?? slc.status, review });
      } else {
        // worker / verifier / other: surface the slice's FR/AC verification results.
        out.push({ sliceId: slc.id, title: slc.title, role, kind: "frac", headStatus: slc.status, fracResults: slc.frAcResults });
      }
    }
    return out;
  })());

  // ---- C. ACTIVITY: full fetched history (not the rolling snapshot window). ----
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

  // Build action groups with timing from the FETCHED history: events WITH a target, sorted ASC by ts,
  // consecutive same-target grouped (startTs = first ts, endTs = last ts), reversed newest-first, capped ~60.
  interface ActGroup { id: string; state: string | undefined; target: string; startTs: string; endTs: string; }
  const agentActions = $derived((() => {
    if (sel?.kind !== "agent") return [] as ActGroup[];
    const events = agentHistory
      .filter((e) => e.type.endsWith("agent_event") && (e.payload?.activity as import("~/lib/types").AgentActivity | undefined)?.target);
    // Sort ASCENDING by timestamp.
    const sorted = [...events].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    // Group consecutive entries with the same target, tracking start/end timestamps.
    const groups: ActGroup[] = [];
    for (const ev of sorted) {
      const act = ev.payload?.activity as import("~/lib/types").AgentActivity | undefined;
      const target = act?.target as string;
      const state = act?.state;
      const last = groups[groups.length - 1];
      if (last && last.target === target) {
        last.endTs = ev.timestamp;
        continue;
      }
      groups.push({ id: ev.id, state, target, startTs: ev.timestamp, endTs: ev.timestamp });
    }
    // Newest first, capped at 60.
    return groups.reverse().slice(0, 60);
  })());

  // Lifecycle MARKERS from the fetched history (review/worker/verification/overseer milestones), newest first.
  interface ActMarker { id: string; ts: string; label: string; hint?: string; }
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
    // generic: "domain.some_action" → "some action"
    const tail = type.split(".").slice(1).join(" ").replace(/_/g, " ");
    return tail || type;
  }
  const MARKER_RE = /^(review|worker|verification|overseer)\.|completed$|escalation_raised$/;
  const agentMarkers = $derived((() => {
    if (sel?.kind !== "agent") return [] as ActMarker[];
    const out: ActMarker[] = [];
    for (const ev of agentHistory) {
      if (ev.type.endsWith("agent_event")) continue;             // those are the activity feed
      if (!MARKER_RE.test(ev.type)) continue;
      const p = ev.payload as Record<string, unknown> | undefined;
      const hint = (p?.status ?? p?.level ?? p?.recommendation) as string | undefined;
      out.push({ id: ev.id, ts: ev.timestamp, label: markerLabel(ev.type), hint: typeof hint === "string" ? hint : undefined });
    }
    // newest first.
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out.slice(0, 40);
  })());
  // Show the standalone "thinking" line only when the agent is thinking and has no in-flight action.
  const showCurrentThinking = $derived(currentState === "thinking" && !working);
  const escalation = $derived(
    sel?.kind === "escalation" ? store.snapshot?.activeEscalations.find((e) => e.id === sel.id) : undefined,
  );
  const overseerEvent = $derived(
    sel?.kind === "overseerTurn" ? store.snapshot?.recentEvents.find((e) => e.id === sel.eventId) : undefined,
  );
  let expandedCmds = $state(new Set<string>());
  function toggleCmd(id: string) {
    const n = new Set(expandedCmds);
    if (n.has(id)) n.delete(id); else n.add(id);
    expandedCmds = n;
  }
</script>

{#if sel}
  <aside class="inspector">
    <div class="inspector-head">
      <strong>{sel.kind}{slice ? ` · ${slice.id}` : sel.kind === "agent" ? ` · ${sel.actor}` : ""}</strong>
      <button class="close" onclick={() => store.select(null)}>✕</button>
    </div>

    {#if sel.kind === "slice" && slice}
      <h4>{slice.title} · {slice.status}<span class="muted"> · {formatDuration((["accepted","closed"].includes(slice.status) ? Date.parse(slice.updatedAt) : Date.now()) - Date.parse(slice.createdAt))}</span></h4>
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
    {:else if sel.kind === "agent"}
      <div class="agent-liveness">
        <span class="live-dot live-{level}"></span>
        <span class="liveness-word">{level === "done" ? "done" : level === "dead" ? "no signal" : "live"}</span>
        <span class="muted"> · last signal {shortAge(sigAge)}</span>
        {#if working && heartbeat?.detail}<span class="liveness-target" title={heartbeat.detail}> · {heartbeat.detail}</span>{/if}
      </div>
      {#if checkpoint}
        <div class="kv"><b>objective</b> {(checkpoint.payload as any).currentObjective ?? "—"}</div>
        <div class="kv"><b>last</b> {(checkpoint.payload as any).lastMeaningfulAction ?? "—"}</div>
        <div class="kv"><b>next</b> {(checkpoint.payload as any).nextIntendedAction ?? "—"}</div>
      {/if}

      {#if agentRuns.length > 0}
        <section class="agent-section">
          <h4>Runs</h4>
          {#each agentRuns as r (r.id)}
            {@const slc = sliceById(r.sliceId)}
            <div class="run-row">
              <span class="run-role">{r.role ?? "—"}</span>
              <span>· {r.status}</span>
              <span class="run-slice">· {slc ? `${slc.id} ${slc.title}` : r.sliceId}</span>
              <span class="muted">· {fmtClock(r.startedAt)}</span>
              <span class="muted">· {formatDuration(runDuration(r))}</span>
              <span class="muted">· attempt {r.attempt}</span>
              {#if r.resultPath}<span class="muted" title={r.resultPath}>· result</span>{/if}
            </div>
          {/each}
        </section>
      {/if}

      {#if agentResults.length > 0}
        <section class="agent-section">
          <h4>Results</h4>
          {#each agentResults as res (res.sliceId)}
            <div class="result-block">
              {#if res.kind === "review"}
                <div class="result-head">
                  <strong>Review of {res.sliceId}</strong>
                  <span class="ref ref-{res.headStatus === 'accepted' ? 'passed' : 'failed'}">{res.headStatus}</span>
                </div>
                {#if res.review}
                  {#if res.review.recommendation}<div class="result-rec"><Markdown md={res.review.recommendation} inline /></div>{/if}
                  <div class="kv"><b>stub/hardcode risk</b> {res.review.stubOrHardcodeRisk}</div>
                  <div class="kv"><b>source mutation</b> {res.review.sourceMutationDetected ? "yes" : "no"}</div>
                  {#if res.review.testAssessment}<div class="kv"><b>tests</b> {res.review.testAssessment}</div>{/if}
                  {#if res.review.requiredFixes.length > 0}
                    <ul class="result-fixes">
                      {#each res.review.requiredFixes as fix}<li>{fix}</li>{/each}
                    </ul>
                  {/if}
                  {#if res.review.escalations.length > 0}
                    <ul class="result-esc">
                      {#each res.review.escalations as esc}<li><b>{esc.level}</b> {esc.message}</li>{/each}
                    </ul>
                  {/if}
                  {#each res.review.frAcFindings as f (f.ref)}
                    <div class="proof-ref">
                      <div class="proof-ref-head">
                        <span class="ref ref-{f.status === 'passed' ? 'passed' : 'failed'}">{f.ref}</span>
                        <span class="muted">{f.status}</span>
                      </div>
                      {#if f.finding}<div class="citation">{f.finding}</div>{/if}
                      {#each f.evidence as c}<div class="citation">▸ <Markdown md={c} inline /></div>{/each}
                    </div>
                  {/each}
                {:else}
                  <p class="empty">No review result recorded yet.</p>
                {/if}
              {:else}
                <div class="result-head">
                  <strong>Work on {res.sliceId}</strong>
                  <span class="muted">{res.headStatus}</span>
                </div>
                {#if res.fracResults && res.fracResults.length > 0}
                  {#each res.fracResults as fr (fr.ref)}
                    <div class="proof-ref">
                      <div class="proof-ref-head">
                        <span class="ref ref-{fr.status}">{fr.ref}</span>
                        <span class="muted">{fr.status}</span>
                      </div>
                      {#if fr.proof}<div class="citation">▸ <Markdown md={fr.proof} inline /></div>{/if}
                    </div>
                  {/each}
                {:else}
                  <p class="empty">No FR/AC results recorded yet.</p>
                {/if}
              {/if}
            </div>
          {/each}
        </section>
      {/if}

      <section class="agent-section">
        <h4>Activity</h4>
        {#if historyLoading}
          <p class="empty">loading activity…</p>
        {:else if agentActions.length === 0 && agentMarkers.length === 0}
          <p class="empty">no recorded activity for this agent.</p>
        {:else}
          {#if showCurrentThinking}
            <div class="activity-idle current">
              <span class="spinner" aria-hidden="true"></span>
              <span class="idle-word">{activityVerb(currentState).toLowerCase()}</span>
            </div>
          {/if}
          {#each agentActions as g, i (g.id)}
            {@const cur = i === 0 && working}
            {@const d = describeActivity({ state: g.state, target: g.target })}
            {@const dur = Date.parse(g.endTs) - Date.parse(g.startTs)}
            <div class="act" class:act-current={cur}>
              <span class="act-time" title={g.startTs}>{fmtClock(g.startTs)}</span>
              {#if cur}<span class="spinner" aria-hidden="true"></span>{/if}
              <span class="act-verb">{cur ? d.present : d.past}</span>
              {#if d.target}<button class="act-target" class:cmd-expanded={expandedCmds.has(g.id)} title={g.target} onclick={() => toggleCmd(g.id)}>{#if expandedCmds.has(g.id)}{#each tokenizeCommand(prettifyTarget(g.target)) as t}<span class="tok-{t.kind}">{t.text}</span>{" "}{/each}{:else}<code class="now-target">{d.target}</code>{/if}</button>{/if}
              {#if dur > 1500 && !cur}<span class="act-dur" title="duration">{formatDuration(dur)}</span>{/if}
            </div>
          {/each}
          {#if agentMarkers.length > 0}
            <h4>Milestones</h4>
            {#each agentMarkers as m (m.id)}
              <div class="act-marker">
                <span class="act-time" title={m.ts}>{fmtClock(m.ts)}</span>
                <span>{m.label}</span>
                {#if m.hint}<span class="muted">· {m.hint}</span>{/if}
              </div>
            {/each}
          {/if}
        {/if}
      </section>
    {:else if sel.kind === "escalation" && escalation}
      <div class="esc-level esc-{escalation.level}">{escalation.level}</div>
      <p>{escalation.message}</p>
      {#if escalation.reason}<p class="muted">{escalation.reason}</p>{/if}
    {:else if sel.kind === "overseerTurn" && overseerEvent}
      <h4>{overseerEvent.type}</h4>
      <pre class="json">{JSON.stringify(overseerEvent.payload, null, 2)}</pre>
    {/if}
  </aside>
{/if}
