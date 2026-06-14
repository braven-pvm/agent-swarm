<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { prettifyTarget } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (actor: string) => void } = $props();
  const rows = $derived(store.agents);
</script>

<section class="rail rail-left">
  <h2 class="rail-title">Agents</h2>
  {#each rows as row (row.actor)}
    <button class="agent" onclick={() => onSelect(row.actor)}>
      <div class="agent-head">
        <span class="agent-name">{row.actor}</span>
        {#if row.role}<span class="agent-role">{row.role}</span>{/if}
        <span class="state state-{row.state}">{row.state}</span>
      </div>
      <div class="agent-now" title={row.now}>{prettifyTarget(row.now)}</div>
      {#if row.next}<div class="agent-next">next: {row.next}</div>{/if}
      {#if row.stallMs}<div class="stall">⚠ idle {Math.round(row.stallMs / 60000)}m</div>{/if}
    </button>
  {/each}
  {#if rows.length === 0}<p class="empty">No agents yet.</p>{/if}
</section>
