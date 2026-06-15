<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { formatDuration } from "~/lib/format";
  let { store }: { store: ConsoleStore } = $props();
  const snap = $derived(store.snapshot);
  const accepted = $derived(snap ? snap.slices.filter((s) => s.status === "accepted").length : 0);
  const total = $derived(snap ? snap.slices.length : 0);
  const workspaceName = $derived(snap ? snap.workspace.replace(/\\/g, "/").split("/").pop() : "—");
  const uptime = $derived((() => {
    if (!snap || snap.agentRuns.length === 0) return "—";
    const earliest = snap.agentRuns.reduce((min, r) => (r.startedAt < min ? r.startedAt : min), snap.agentRuns[0].startedAt);
    return formatDuration(Date.now() - Date.parse(earliest));
  })());
</script>

<header class="statusbar">
  <span class="brand">⛬ Command Bridge</span>
  <span class="chip">workspace: {workspaceName}</span>
  <span class="chip">mode: {snap?.runMode ?? "—"}</span>
  <span class="chip">scenario: {snap?.scenario ?? "—"}</span>
  <span class="chip">phase: {snap?.phase ?? "—"}</span>
  <span class="chip">turn {snap?.turnCount ?? "—"}</span>
  <span class="chip">slices ▮ {accepted}/{total}</span>
  {#if store.coverage}
    {@const c = store.coverage.totals}
    <span class="chip cov" title="FR/AC requirements implemented">reqs ▮ {c.done}/{c.total} · {c.total ? Math.round(100 * c.done / c.total) : 0}%</span>
  {/if}
  <span class="chip">uptime {uptime}</span>
  {#if snap?.focusQueue?.length}
    <span class="chip focus-chip" title="slices needing attention">⚑ focus {snap.focusQueue.length}</span>
  {/if}
  <span class="spacer"></span>
  <span class="chip conn" class:on={store.connected} class:off={!store.connected}>
    {store.connected ? "● live" : "○ offline"}
  </span>
</header>
