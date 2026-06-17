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
  <!-- Identity group: brand + workspace -->
  <span class="sb-group sb-identity">
    <span class="brand">⛬ Command Bridge</span>
    <span class="sb-stat" title="workspace">workspace: {workspaceName}</span>
  </span>
  <!-- Run-context group: static run parameters, de-emphasised (plain text, no pill) -->
  <span class="sb-group sb-context">
    <span class="sb-stat">mode: {snap?.runMode ?? "—"}</span>
    <span class="sb-stat">scenario: {snap?.scenario ?? "—"}</span>
    <span class="sb-stat">phase: {snap?.phase ?? "—"}</span>
    <span class="sb-stat sb-turn" title="overseer turn">turn <strong>{snap?.turnCount ?? "—"}</strong></span>
  </span>
  <!-- Health group: live operational metrics, weighted up -->
  <span class="sb-group sb-health">
    <span class="chip">slices ▮ {accepted}/{total}</span>
    {#each store.snapshot?.runObservability?.uiHints?.badges ?? [] as b}
      <span class="ro-badge ro-{b.tone}" title={b.tooltip}>{b.label}: <strong>{b.value}</strong></span>
    {/each}
    {#if snap?.focusQueue?.length}
      <span class="chip focus-chip" title="slices needing attention">⚑ focus {snap.focusQueue.length}</span>
    {/if}
    <span class="sb-stat">uptime {uptime}</span>
  </span>
  <span class="spacer"></span>
  <span class="chip conn" class:on={store.connected} class:off={!store.connected}>
    {store.connected ? "● live" : "○ offline"}
  </span>
</header>
