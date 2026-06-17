<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { HumanActionItem, HumanActionKind, HumanActionSeverity } from "~/lib/human-actions";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (id: string) => void } = $props();

  const queue = $derived(store.humanActions);
  const actions = $derived(queue?.actions ?? []);
  // Tolerate a partial/unset queue: derive the count from totals when present, else the list length.
  const total = $derived(queue?.totals?.total ?? actions.length);

  // Group by severity (danger → warning → info); within a group keep the server's order, which is
  // already sorted by severity → kind → recency. We just bucket so each severity reads as a band.
  const SEVERITY_ORDER: HumanActionSeverity[] = ["danger", "warning", "info"];
  const groups = $derived.by(() =>
    SEVERITY_ORDER
      .map((severity) => ({ severity, items: actions.filter((a) => a.severity === severity) }))
      .filter((g) => g.items.length > 0),
  );

  // The kind glyph never carries meaning alone — it pairs with the severity-toned colour AND the
  // humanized kind text on each card, so colour-blind / squint reading still works.
  const KIND_GLYPH: Record<HumanActionKind, string> = {
    decision_required: "?",
    clear_blocker: "✕",
    blocked_requirement: "✕",
    human_verification: "☐",
    human_verification_rework: "↻",
  };
  const KIND_LABEL: Record<HumanActionKind, string> = {
    decision_required: "Decision required",
    clear_blocker: "Clear blocker",
    blocked_requirement: "Blocked requirement",
    human_verification: "Human verification",
    human_verification_rework: "Verification rework",
  };
  const kindGlyph = (a: HumanActionItem) => KIND_GLYPH[a.kind] ?? "•";
  const kindLabel = (a: HumanActionItem) => KIND_LABEL[a.kind] ?? a.kind;
</script>

<section class="rail rail-actions">
  <h2 class="rail-title">
    Action required
    {#if total > 0}<span class="ha-count">{total}</span>{/if}
  </h2>

  {#if total === 0}
    <p class="empty ha-empty">Nothing needs you right now.</p>
  {:else}
    {#each groups as g (g.severity)}
      {#each g.items as a (a.id)}
        <button class="ha-card ha-{a.severity}" onclick={() => onSelect(a.id)}>
          <div class="ha-head">
            <span class="ha-glyph" aria-hidden="true">{kindGlyph(a)}</span>
            <span class="ha-kind">{kindLabel(a)}</span>
          </div>
          <div class="ha-title">{a.title}</div>
          {#if a.summary}<div class="ha-summary">{a.summary}</div>{/if}
          {#if a.ref || a.sliceId}
            <div class="ha-meta">
              {#if a.ref}<code class="ha-ref">{a.ref}</code>{/if}
              {#if a.sliceId}<code class="ha-ref">{a.sliceId}</code>{/if}
            </div>
          {/if}
        </button>
      {/each}
    {/each}
  {/if}
</section>
