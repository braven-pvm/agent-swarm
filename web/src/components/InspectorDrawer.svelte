<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { activityVerb, prettifyTarget, tokenizeCommand, formatDuration, describeActivity, fmtClock, shortAge, livenessLevel } from "~/lib/format";
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
  // Build action groups with timing: events WITH a target, sorted ASC by ts, consecutive same-target grouped
  // (startTs = first ts, endTs = last ts), then reversed so newest first; capped ~40.
  interface ActGroup { id: string; state: string | undefined; target: string; startTs: string; endTs: string; }
  const agentActions = $derived((() => {
    if (sel?.kind !== "agent") return [] as ActGroup[];
    const events = (store.snapshot?.recentEvents ?? [])
      .filter((e) => e.actor === sel.actor && e.type.endsWith("agent_event") && (e.payload?.activity as import("~/lib/types").AgentActivity | undefined)?.target);
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
    // Newest first, capped at 40.
    return groups.reverse().slice(0, 40);
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
      <h4>Recent activity</h4>
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
