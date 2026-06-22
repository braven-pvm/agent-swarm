<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import { formatDuration } from "~/lib/format";
  let { store, onOpenControl }: { store: ConsoleStore; onOpenControl?: () => void } = $props();
  const snap = $derived(store.snapshot);
  const accepted = $derived(snap ? snap.slices.filter((s) => s.status === "accepted").length : 0);
  const total = $derived(snap ? snap.slices.length : 0);
  const workspaceName = $derived(snap ? snap.workspace.replace(/\\/g, "/").split("/").pop() : "—");
  const uptime = $derived((() => {
    if (!snap || snap.agentRuns.length === 0) return "—";
    const earliest = snap.agentRuns.reduce((min, r) => (r.startedAt < min ? r.startedAt : min), snap.agentRuns[0].startedAt);
    return formatDuration(Date.now() - Date.parse(earliest));
  })());

  // Human Action queue chip: count + most-severe tone. Clicking opens the first (most-severe)
  // action — the server queue is sorted danger → warning → info, so actions[0] is the top one.
  const actionQueue = $derived(store.humanActions);
  const actionList = $derived(actionQueue?.actions ?? []);
  const actionCount = $derived(actionQueue?.totals?.total ?? actionList.length);
  const actionTone = $derived(actionList.some((a) => a.severity === "danger") ? "danger" : "warning");
  function openTopAction() {
    const first = actionList[0];
    if (first) store.selectAction(first.id);
  }

  // ── Local Control API indicators ─────────────────────────────────────────
  // "running N" when any background control command is in flight; opens the Control tab.
  const runningControl = $derived(store.runningControlCommands.length);
  // The run "looks stopped" when nothing is actively running AND the run reached a terminal/blocked
  // resting state: no agentRuns in "running", and either the observability outcome flags
  // human_required / a finalOutcome is present, or there simply are no live runs. We surface the
  // continue affordance only when there is a snapshot to act on (a scenario to continue).
  const anyRunActive = $derived((snap?.agentRuns ?? []).some((r) => r.status === "running"));
  const finalOutcome = $derived(snap?.runObservability?.outcome?.finalOutcome);
  const runStopped = $derived(
    !!snap && !anyRunActive && runningControl === 0 && (!!finalOutcome || (snap?.agentRuns?.length ?? 0) > 0),
  );

  // ── Read-only protocol settings strip ────────────────────────────────────
  // Calm, de-emphasised run-context indicators (plain muted text, no pill) sitting beside
  // mode/scenario/phase: the result-journal opt-in (default OFF; when ON it explains the run-card
  // "replayed" badge) and the SC-2 lane budget. Renders nothing until /api/settings lands.
  const settings = $derived(store.settings);
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
    {#if settings}
      <span
        class="sb-stat sb-setting sb-journal"
        class:on={settings.resultJournal}
        title={settings.resultJournal
          ? "Worker result journal is ON — matching worker leaves may be replayed from a prior stored result instead of re-spawned."
          : "Worker result journal is OFF — every worker leaf is freshly spawned."}
      >
        <span class="sb-setting-glyph" aria-hidden="true">{settings.resultJournal ? "●" : "○"}</span>
        result journal: {settings.resultJournal ? "on" : "off"}
      </span>
      <span class="sb-stat sb-setting" title="SC-2 lane budget — the maximum number of concurrently active lanes">
        lane budget: <strong>{settings.maxActiveLanes}</strong>
      </span>
    {/if}
  </span>
  <!-- Health group: live operational metrics, weighted up -->
  <span class="sb-group sb-health">
    <span class="chip">slices ▮ {accepted}/{total}</span>
    {#each store.snapshot?.runObservability?.uiHints?.badges ?? [] as b}
      <span class="ro-badge ro-{b.tone}" title={b.tooltip}>{b.label}: <strong>{b.value}</strong></span>
    {/each}
    {#if snap?.focusQueue?.length}
      <span class="chip focus-chip focus-chip-pulse" title="slices needing attention">⚑ focus {snap.focusQueue.length}</span>
    {/if}
    {#if actionCount > 0}
      <button class="chip ha-chip ha-chip-{actionTone} ha-chip-pulse" title="open the most urgent action" onclick={openTopAction}>
        <span class="ha-chip-flag" aria-hidden="true">⚑</span> {actionCount} action{actionCount === 1 ? "" : "s"}
      </button>
    {/if}
    {#if runningControl > 0}
      <button class="chip ctl-chip ctl-chip-running ctl-chip-pulse" title="background control commands in flight — open Control" onclick={onOpenControl}>
        <span class="ctl-chip-dot" aria-hidden="true">●</span> running {runningControl}
      </button>
    {:else if runStopped}
      <button class="chip ctl-chip ctl-chip-continue" title="the run looks stopped — open Control to continue it" onclick={onOpenControl}>
        <span class="ctl-chip-glyph" aria-hidden="true">▸</span> Continue run
      </button>
    {/if}
    <span class="sb-stat">uptime {uptime}</span>
  </span>
  <span class="spacer"></span>
  <span class="chip conn" class:on={store.connected} class:off={!store.connected}>
    {store.connected ? "● live" : "○ offline"}
  </span>
</header>
