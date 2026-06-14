<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { activityVerb, prettifyTarget, tokenizeCommand, formatDuration } from "~/lib/format";
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
  // Build action history: only events WITH a target, sorted newest-first, consecutive same-target collapsed, capped at 40.
  const agentActions = $derived((() => {
    if (sel?.kind !== "agent") return [] as { id: string; state: string | undefined; target: string }[];
    const events = (store.snapshot?.recentEvents ?? [])
      .filter((e) => e.actor === sel.actor && e.type.endsWith("agent_event") && (e.payload?.activity as import("~/lib/types").AgentActivity | undefined)?.target);
    // Sort newest-first by timestamp.
    const sorted = [...events].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    // Collapse consecutive entries with the same target.
    const out: { id: string; state: string | undefined; target: string }[] = [];
    for (const ev of sorted) {
      const act = ev.payload?.activity as import("~/lib/types").AgentActivity | undefined;
      const target = act?.target as string;
      const state = act?.state;
      if (out.length > 0 && out[out.length - 1].target === target) continue;
      out.push({ id: ev.id, state, target });
      if (out.length >= 40) break;
    }
    return out;
  })());
  // True when the live state is a no-target (transient) state.
  const NO_TARGET_STATES = ["thinking", "idle", "waiting"];
  const showCurrentIdle = $derived(!!currentState && NO_TARGET_STATES.includes(currentState));
  const escalation = $derived(
    sel?.kind === "escalation" ? store.snapshot?.activeEscalations.find((e) => e.id === sel.id) : undefined,
  );
  const overseerEvent = $derived(
    sel?.kind === "overseerTurn" ? store.snapshot?.recentEvents.find((e) => e.id === sel.eventId) : undefined,
  );
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
            {#each row.citations as c}<div class="citation">▸ {c}</div>{/each}
          </div>
        {/each}
      </div>
    {:else if sel.kind === "agent"}
      {#if checkpoint}
        <div class="kv"><b>objective</b> {(checkpoint.payload as any).currentObjective ?? "—"}</div>
        <div class="kv"><b>last</b> {(checkpoint.payload as any).lastMeaningfulAction ?? "—"}</div>
        <div class="kv"><b>next</b> {(checkpoint.payload as any).nextIntendedAction ?? "—"}</div>
      {/if}
      <h4>Recent activity</h4>
      {#if showCurrentIdle}
        <div class="activity-idle current">
          {#if currentState !== "idle"}<span class="spinner" aria-hidden="true"></span>{:else}<span class="dot" aria-hidden="true"></span>{/if}
          <span class="idle-word">{activityVerb(currentState).toLowerCase()}</span>
        </div>
      {/if}
      {#each agentActions as item (item.id)}
        <div class="activity-line">
          <span class="verb verb-{item.state ?? 'idle'}">{activityVerb(item.state)}</span>
          <span class="cmd" title={item.target}>{#each tokenizeCommand(prettifyTarget(item.target)) as t}<span class="tok-{t.kind}">{t.text}</span>{" "}{/each}</span>
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
