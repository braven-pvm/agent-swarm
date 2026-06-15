<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { describeActivity, livenessLevel, shortAge, formatDuration } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (actor: string) => void } = $props();
  const rows = $derived(store.agents);
</script>

<section class="rail rail-left">
  <h2 class="rail-title">Agents</h2>
  {#each rows as row (row.actor)}
    {@const age = Date.now() - Date.parse(row.latest)}
    {@const level = livenessLevel(row.runStatus, age)}
    {@const working = ["reading", "testing", "editing", "verifying"].includes(row.state)}
    {@const d = describeActivity({ state: row.state, target: row.nowTarget })}
    <button
      class="agent"
      class:active={row.state !== "idle" && row.state !== "waiting" && row.state !== "blocked"}
      class:blocked={row.state === "blocked"}
      onclick={() => onSelect(row.actor)}
    >
      <div class="agent-head">
        <span class="live-dot live-{level}" title="{shortAge(age)} since last signal"></span>
        <span class="agent-name">{row.actor}</span>
        {#if row.role}<span class="agent-role">{row.role}</span>{/if}
        <span class="spacer"></span>
        {#if row.runtimeMs}<span class="runtime" title="agent runtime">{formatDuration(row.runtimeMs)}</span>{/if}
        <span class="agent-age age-{level}" title="last signal age">{shortAge(age)}</span>
      </div>
      <div class="agent-now" title={row.nowTarget ?? row.now}>{working ? d.present : d.past}{#if d.target} <code class="now-target">{d.target}</code>{/if}</div>
      {#if row.next}<div class="agent-next" title={row.next}>next: {row.next}</div>{/if}
      {#if level === "dead"}<div class="dead-warn">⚠ no signal {shortAge(age)} — process may be stalled</div>{/if}
    </button>
  {/each}
  {#if rows.length === 0}<p class="empty">No agents yet.</p>{/if}
</section>
