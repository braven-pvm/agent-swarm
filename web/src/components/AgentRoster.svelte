<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { CoverageRef } from "~/lib/types";
  import { describeActivity, livenessLevel, livenessLabel, shortAge, formatDuration, refTone } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (actor: string) => void } = $props();
  const rows = $derived(store.agents);

  // Coverage lookup: ref (upper) → CoverageRef. Colors the task refs by status and names the
  // owning spec/domain. Degrades gracefully to an empty map when coverage is null.
  const covByRef = $derived.by(() => {
    const map = new Map<string, CoverageRef>();
    for (const r of store.coverage?.refs ?? []) map.set(r.ref.toUpperCase(), r);
    return map;
  });

  const MAX_REFS = 4;
  // Spec/domain suffix for the task line: first matched ref's domain (else its source title).
  function specSuffix(refs: string[] | undefined): string | undefined {
    for (const ref of refs ?? []) {
      const cr = covByRef.get(ref.toUpperCase());
      if (cr) return cr.domain || cr.sourceTitle || undefined;
    }
    return undefined;
  }
</script>

<section class="rail rail-left">
  <h2 class="rail-title">Agents</h2>
  {#each rows as row (row.actor)}
    {@const age = Date.now() - Date.parse(row.latest)}
    {@const level = livenessLevel(row.runStatus, age)}
    {@const state = livenessLabel(level)}
    {@const working = ["reading", "testing", "editing", "verifying"].includes(row.state)}
    {@const d = describeActivity({ state: row.state, target: row.nowTarget })}
    <button
      class="agent"
      class:active={state === "active"}
      class:stalled={state === "stalled"}
      class:idle={state === "idle"}
      onclick={() => onSelect(row.actor)}
    >
      <div class="agent-head">
        <span class="live-dot live-{level}" title="{shortAge(age)} since last signal"></span>
        <span class="agent-name">{row.actor}</span>
        {#if row.role}<span class="agent-role">{row.role}</span>{/if}
        <span class="spacer"></span>
        <span class="agent-state lv-{state}">{state}</span>
        {#if row.runtimeMs}<span class="runtime" title="agent runtime">{formatDuration(row.runtimeMs)}</span>{/if}
        <span class="agent-age age-{level}" title="last signal age">{shortAge(age)}</span>
      </div>
      <div class="agent-now" title={row.nowTarget ?? row.now}>{working ? d.present : d.past}{#if d.target} <code class="now-target">{d.target}</code>{/if}</div>
      {#if row.sliceTitle}
        {@const suffix = specSuffix(row.frAcRefs)}
        <div class="agent-task" title={row.sliceTitle}>
          <span class="agent-task-glyph" aria-hidden="true">◇</span>
          <span class="agent-task-title">{row.sliceTitle}</span>
          {#if suffix}<span class="agent-task-spec muted"> · {suffix}</span>{/if}
        </div>
        {#if row.frAcRefs && row.frAcRefs.length > 0}
          {@const refs = row.frAcRefs}
          <div class="agent-refs">
            {#each refs.slice(0, MAX_REFS) as ref (ref)}
              {@const tone = refTone(covByRef.get(ref.toUpperCase())?.status)}
              <span class="agent-ref {tone.cls}" title="{ref} · {tone.label}">
                <span class="agent-ref-glyph" aria-hidden="true">{tone.glyph}</span>{ref}
              </span>
            {/each}
            {#if refs.length > MAX_REFS}<span class="agent-ref agent-ref-more">+{refs.length - MAX_REFS}</span>{/if}
          </div>
        {/if}
      {/if}
      {#if row.next}<div class="agent-next" title={row.next}>next: {row.next}</div>{/if}
      {#if state === "stalled"}<div class="dead-warn" title="A live run has not emitted a signal recently — the process may be stalled.">⚠ live run silent {shortAge(age)} — may be stalled</div>{/if}
    </button>
  {/each}
  {#if rows.length === 0}<p class="empty">No agents yet.</p>{/if}
</section>
