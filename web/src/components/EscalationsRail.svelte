<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (id: string) => void } = $props();
  const groups = $derived(store.escalationGroups);
  let expanded = $state<Record<string, boolean>>({});
  function onGroup(key: string, firstId: string, count: number) {
    if (count > 1) expanded = { ...expanded, [key]: !expanded[key] };  // toggle to reveal siblings
    else onSelect(firstId);
  }
</script>

<section class="rail rail-right">
  <h2 class="rail-title">Escalations</h2>
  {#each groups as g (g.key)}
    <button class="esc esc-{g.level}" onclick={() => onGroup(g.key, g.instances[0].id, g.count)}>
      <div class="esc-head">
        <span class="esc-level">{g.level}</span>
        {#if g.count > 1}<span class="esc-count">×{g.count} {expanded[g.key] ? "▾" : "▸"}</span>{/if}
      </div>
      <div class="esc-msg">{g.message}</div>
    </button>
    {#if expanded[g.key]}
      {#each g.instances as inst (inst.id)}
        <button class="esc-inst" onclick={() => onSelect(inst.id)}>#{inst.id.slice(-4)} · {inst.message}</button>
      {/each}
    {/if}
  {/each}
  {#if groups.length === 0}<p class="empty">No active escalations.</p>{/if}
</section>
