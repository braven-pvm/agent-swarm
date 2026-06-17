<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { describeActivity, livenessLevel, livenessLabel, shortAge } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (eventId: string) => void } = $props();

  // PERSISTENT 'Overseer now' header: the resolved overseer agent row (role 'overseer').
  const overseer = $derived(store.overseer);
  // The newest-first, deduped loop log (see buildOverseerLog).
  const log = $derived(store.overseerLog);

  // Cap the loop log to a glanceable head; the long tail collapses behind 'Show more'.
  const LOG_CAP = 8;
  let expanded = $state(false);
  const shown = $derived(expanded ? log : log.slice(0, LOG_CAP));

  // A small category icon for a loop row so the subtext reads at a glance.
  function rowIcon(type: string): { glyph: string; cls: string } {
    if (type === "overseer.decision_recorded") return { glyph: "◆", cls: "ov-ic-decision" };
    if (type === "overseer.command_started" || type === "overseer.command_completed") return { glyph: "›", cls: "ov-ic-cmd" };
    if (type === "overseer.commands_completed") return { glyph: "✓", cls: "ov-ic-batch" };
    return { glyph: "•", cls: "ov-ic-turn" }; // started / completed turn lifecycle
  }
</script>

<section class="overseer">
  <h3 class="col-title">Overseer loop</h3>

  <!-- 'What is the overseer doing atm' — always visible, even when the loop log is empty. -->
  <div class="ov-now">
    {#if overseer}
      {@const age = Date.now() - Date.parse(overseer.latest)}
      {@const level = livenessLevel(overseer.runStatus, age)}
      {@const state = livenessLabel(level)}
      {@const d = describeActivity({ state: overseer.state, target: overseer.nowTarget })}
      <div class="ov-now-head">
        <span class="live-dot live-{level}" title="{shortAge(age)} since last signal"></span>
        <span class="ov-now-who">Overseer</span>
        <span class="ov-now-state lv-{state}">{state}</span>
      </div>
      <div class="ov-now-activity" title={overseer.nowTarget ?? overseer.now}>
        {d.present}{#if d.target} <code class="now-target">{d.target}</code>{/if}
      </div>
      {#if overseer.next}<div class="ov-now-next" title={overseer.next}><span class="ov-now-next-label">Next</span>{overseer.next}</div>{/if}
    {:else if store.overseerCheckpointSummary}
      <!-- No overseer agent online — fall back to its latest recorded checkpoint summary. -->
      <div class="ov-now-head">
        <span class="live-dot live-done" title="no live overseer run"></span>
        <span class="ov-now-who">Overseer</span>
        <span class="ov-now-state lv-idle">idle</span>
      </div>
      <div class="ov-now-activity" title={store.overseerCheckpointSummary}>{store.overseerCheckpointSummary}</div>
    {:else}
      <div class="ov-now-head">
        <span class="live-dot live-done" title="no overseer signal"></span>
        <span class="ov-now-who">Overseer</span>
        <span class="ov-now-state lv-idle">offline</span>
      </div>
      <div class="ov-now-activity muted">No overseer signal yet.</div>
    {/if}
  </div>

  <!-- Recent decisions: a tidy newest-first list (time + action + optional summary), NOT chip soup. -->
  <ol class="ov-log">
    {#each shown as row (row.id)}
      {@const age = Date.now() - Date.parse(row.ts)}
      <li>
        <button class="ov-row" class:ov-row-decision={row.type === "overseer.decision_recorded"} title={row.type} onclick={() => onSelect(row.id)}>
          <span class="ov-row-time" title="time since this event">{shortAge(age)}</span>
          <span class="ov-row-body">
            <span class="ov-row-action">
              {row.action}{#if row.count > 1}<span class="ov-row-count" title="{row.count} consecutive">×{row.count}</span>{/if}
            </span>
            {#if row.summary}{@const ic = rowIcon(row.type)}<span class="ov-row-summary"><span class="ov-row-ic {ic.cls}" aria-hidden="true">{ic.glyph}</span>{row.summary}</span>{/if}
          </span>
        </button>
      </li>
    {/each}
  </ol>
  {#if log.length > LOG_CAP}
    <button class="ov-more" onclick={() => (expanded = !expanded)}>
      {expanded ? "Show fewer" : `Show more (${log.length})`}
    </button>
  {/if}
  {#if log.length === 0}<p class="empty">No overseer activity yet.</p>{/if}
</section>
