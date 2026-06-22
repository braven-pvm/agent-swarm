<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (id: string) => void } = $props();
  const groups = $derived(store.escalationGroups);
  let expanded = $state<Record<string, boolean>>({});
  function onGroup(key: string, firstId: string, count: number) {
    if (count > 1) expanded = { ...expanded, [key]: !expanded[key] };  // toggle to reveal siblings
    else onSelect(firstId);
  }
  // Severity glyph so the warning-vs-blocker distinction is never carried by the
  // coloured left border alone (matches the ObservabilityCallout ⚠ / ✕ pattern).
  // Agent-resolvable concerns use a calm "retry" glyph (↻) — NOT the blocker ✕ — because the
  // agent will repair them itself; they are a concern, not a human-resolve danger.
  const levelGlyph = (g: { level: string; agentResolvable: boolean }) =>
    g.agentResolvable ? "↻" : g.level === "warning" ? "⚠" : "✕";
</script>

<section class="rail rail-right">
  <h2 class="rail-title">Escalations</h2>
  {#each groups as g (g.key)}
    <button class="esc esc-{g.level}" class:esc-agent-resolvable={g.agentResolvable} onclick={() => onGroup(g.key, g.instances[0].id, g.count)}>
      <div class="esc-head">
        <span class="esc-glyph" aria-hidden="true">{levelGlyph(g)}</span>
        <span class="esc-level">{g.agentResolvable ? "concern" : g.level}</span>
        {#if g.agentResolvable}
          <span class="esc-tag" title="The agent will retry — targeted repair, no human action needed">↻ targeted repair · agent will retry</span>
        {/if}
        {#if g.count > 1}<span class="esc-count">×{g.count} {expanded[g.key] ? "▾" : "▸"}</span>{/if}
      </div>
      <div class="esc-msg">{g.message}</div>
      {#if g.agentResolvable && g.reason}<div class="esc-reason muted">{g.reason}</div>{/if}
    </button>
    {#if expanded[g.key]}
      {#each g.instances as inst (inst.id)}
        <button class="esc-inst" onclick={() => onSelect(inst.id)}>#{inst.id.slice(-4)} · {inst.message}</button>
      {/each}
    {/if}
  {/each}
  {#if groups.length === 0}<p class="empty">No active escalations.</p>{/if}
</section>
