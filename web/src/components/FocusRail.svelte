<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { FocusItem } from "~/lib/types";
  import { humanizeToken } from "~/lib/format";

  let {
    store,
    onZoomSlice,
    onZoomRun,
  }: {
    store: ConsoleStore;
    onZoomSlice: (id: string) => void;
    onZoomRun: (id: string) => void;
  } = $props();

  // Server delivers this priority-sorted desc; sort defensively anyway.
  const items = $derived(
    [...(store.snapshot?.focusQueue ?? [])].sort((a, b) => b.focusPriority - a.focusPriority),
  );

  const RED = new Set(["blocked", "command_failed", "run_failed", "run_stale", "active_blocker"]);
  const AMBER = new Set(["quiet_running_agent", "high_retry"]);
  function reasonClass(r: string): string {
    if (RED.has(r)) return "reason-red";
    if (AMBER.has(r)) return "reason-amber";
    return "reason-muted";
  }
  function reasonChips(reason: string): string[] {
    if (!reason || reason === "none") return [];
    return reason.split(",").map((r) => r.trim()).filter(Boolean);
  }
  function shortId(id: string): string {
    return id.length > 8 ? "…" + id.slice(-6) : id;
  }
  function truncate(s: string, n: number): string {
    const clean = (s ?? "").replace(/\s+/g, " ").trim();
    return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
  }
  function priorityClass(p: number): string {
    if (p >= 80) return "prio-red";
    if (p >= 40) return "prio-amber";
    return "prio-muted";
  }
</script>

<section class="rail rail-right focus-rail">
  <h2 class="rail-title">Focus</h2>
  {#each items as item (item.sliceId)}
    {@const chips = reasonChips(item.reason)}
    <div class="focus-card">
      <button class="focus-card-head" onclick={() => onZoomSlice(item.sliceId)} title="zoom slice focus">
        <span class="prio-dot {priorityClass(item.focusPriority)}" title="priority {item.focusPriority}"></span>
        <span class="focus-title">{truncate(item.title || item.sliceId, 40)}</span>
        <span class="focus-id muted">SLICE-{shortId(item.sliceId)}</span>
        <span class="focus-status muted">{humanizeToken(item.status)}</span>
      </button>

      {#if chips.length > 0 || item.retryCount > 1}
        <div class="focus-reasons">
          {#each chips as c}
            <span class="focus-reason {reasonClass(c)}">{humanizeToken(c)}</span>
          {/each}
          {#if item.retryCount > 1}
            <span class="focus-reason reason-amber">↻ {item.retryCount}</span>
          {/if}
        </div>
      {/if}

      {#if item.latestRun}
        {@const run = item.latestRun}
        <button class="focus-run" onclick={() => onZoomRun(run.id)} title="zoom run focus">
          <span class="focus-run-line">
            {run.role ? `${run.role} ` : ""}{run.actor} · {humanizeToken(run.status)}
            {#if run.heartbeatAgeMs != null}
              <span class="muted"> · {Math.round(run.heartbeatAgeMs / 1000)}s</span>
            {/if}
          </span>
          {#if run.lastCommand}
            <span class="focus-cmd">
              last: <code>{truncate(run.lastCommand.command, 48)}</code>
              {#if run.lastCommand.exitCode != null}
                <span class="exit" class:bad={run.lastCommand.exitCode !== 0}>exit {run.lastCommand.exitCode}</span>
              {/if}
            </span>
          {/if}
        </button>
      {/if}

      {#if item.recommendedInterventions?.length}
        {#each item.recommendedInterventions.slice(0, 2) as rec}
          <div class="focus-rec">▸ {truncate(rec, 72)}</div>
        {/each}
      {/if}
    </div>
  {/each}
  {#if items.length === 0}<p class="empty">✓ nothing needs attention</p>{/if}
</section>
