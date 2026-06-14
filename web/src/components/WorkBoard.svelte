<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { SliceStatus } from "~/lib/types";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (sliceId: string) => void } = $props();
  const COLUMNS: { key: SliceStatus[]; label: string }[] = [
    { key: ["candidate", "ready", "claimed"], label: "Queued" },
    { key: ["implementing", "implemented", "repairing"], label: "Implementing" },
    { key: ["verifying", "ready_for_review"], label: "Review" },
    { key: ["accepted", "closed"], label: "Accepted" },
    { key: ["blocked"], label: "Blocked" },
  ];
  const slices = $derived(store.snapshot?.slices ?? []);
  function inColumn(statuses: SliceStatus[]) { return slices.filter((s) => statuses.includes(s.status)); }
  function agentActors(slice: (typeof slices)[number]): string[] { return [...new Set(slice.agentRuns.map((r) => r.actor.split("-")[0]))]; }
</script>

<section class="board">
  {#each COLUMNS as col (col.label)}
    <div class="board-col">
      <h3 class="col-title">{col.label} <span class="count">{inColumn(col.key).length}</span></h3>
      {#each inColumn(col.key) as slice (slice.id)}
        <button class="slice-card" onclick={() => onSelect(slice.id)}>
          <div class="slice-id">{slice.id}</div>
          <div class="slice-title">{slice.title}</div>
          <div class="refs">
            {#each slice.frAcResults as r (r.ref)}<span class="ref ref-{r.status}">{r.ref}</span>{/each}
          </div>
          <div class="card-meta">
            <span class="evidence">evidence: {slice.evidence.length}</span>
            {#each agentActors(slice) as a}<span class="agent-chip">{a}</span>{/each}
          </div>
        </button>
      {/each}
    </div>
  {/each}
</section>
