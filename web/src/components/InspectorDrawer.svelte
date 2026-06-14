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
  const agentActivity = $derived(
    sel?.kind === "agent"
      ? (store.snapshot?.recentEvents ?? []).filter((e) => e.actor === sel.actor && e.type.endsWith("agent_event")).slice(-30)
      : [],
  );
  // Collapse consecutive no-target lines with the same state into a single entry.
  const displayActivity = $derived((() => {
    type DisplayItem = { id: string; state: string | undefined; target: string | undefined };
    const out: DisplayItem[] = [];
    for (const ev of agentActivity) {
      const act = ev.payload?.activity as import("~/lib/types").AgentActivity | undefined;
      const state = act?.state;
      const target = act?.target;
      if (!target) {
        const prev = out[out.length - 1];
        if (prev && !prev.target && prev.state === state) continue;
      }
      out.push({ id: ev.id, state, target });
    }
    return out;
  })());
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
      {#each displayActivity as item (item.id)}
        {#if item.target}
          <div class="activity-line">
            <span class="verb verb-{item.state ?? 'idle'}">{activityVerb(item.state)}</span>
            <span class="cmd" title={item.target}>{#each tokenizeCommand(prettifyTarget(item.target)) as t}<span class="tok-{t.kind}">{t.text}</span>{" "}{/each}</span>
          </div>
        {:else}
          <div class="activity-idle">
            {#if item.state && item.state !== "idle"}<span class="spinner" aria-hidden="true"></span>{:else}<span class="dot" aria-hidden="true"></span>{/if}
            <span class="idle-word">{activityVerb(item.state).toLowerCase()}</span>
          </div>
        {/if}
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
