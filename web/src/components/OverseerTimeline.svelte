<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (eventId: string) => void } = $props();
  const turns = $derived(
    (store.snapshot?.recentEvents ?? []).filter(
      (e) => e.type.startsWith("overseer.") && e.type !== "overseer.agent_event",
    ),
  );
</script>

<section class="overseer">
  <h3 class="col-title">Overseer loop</h3>
  <div class="turn-strip">
    {#each turns as ev (ev.id)}
      <button class="turn turn-{ev.type.split('.')[1]}" title={ev.type} onclick={() => onSelect(ev.id)}>
        {ev.type.replace("overseer.", "")}
      </button>
    {/each}
    {#if turns.length === 0}<span class="empty">No overseer activity yet.</span>{/if}
  </div>
</section>
