<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { prettifyTarget, formatDuration, summarizeCommand } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (actor: string) => void } = $props();
  const rows = $derived(store.agents);
</script>

<section class="rail rail-left">
  <h2 class="rail-title">Agents</h2>
  {#each rows as row (row.actor)}
    <button
      class="agent"
      class:active={row.state !== "idle" && row.state !== "waiting" && row.state !== "blocked"}
      class:blocked={row.state === "blocked"}
      onclick={() => onSelect(row.actor)}
    >
      <div class="agent-head">
        <span class="agent-name">{row.actor}</span>
        {#if row.role}<span class="agent-role">{row.role}</span>{/if}
        {#if row.runtimeMs}<span class="runtime" title="agent runtime">{formatDuration(row.runtimeMs)}</span>{/if}
        <span class="state state-{row.state}">{row.state}</span>
      </div>
      {#if row.nowTarget}
        {@const sum = summarizeCommand(row.nowTarget)}
        <div class="agent-now" title={row.nowTarget}>{sum.action}{#if sum.target} <code class="now-target">{sum.target}</code>{/if}</div>
      {:else}
        <div class="agent-now" title={row.now}>{prettifyTarget(row.now)}</div>
      {/if}
      {#if row.next}<div class="agent-next" title={row.next}>next: {row.next}</div>{/if}
      {#if row.stallMs}<div class="stall">⚠ idle {Math.round(row.stallMs / 60000)}m</div>{/if}
    </button>
  {/each}
  {#if rows.length === 0}<p class="empty">No agents yet.</p>{/if}
</section>
