<script lang="ts">
  // Recovery controls for a single stalled/failed agent run — the InspectorDrawer's lifecycle
  // write surface. Rendered in BOTH the agent branch (the agent's latest run) and the focusRun
  // branch (the focused run). Gating (per docs/architecture/local-control-api.md):
  //
  //   recoverable  = run.status is "stale" | "failed", OR it is "running" but liveness is dead
  //                  (live but no signal → stalled). For the stalled-but-running case we offer
  //                  "Mark stale" (recovery/scan {markStale}) FIRST — there's nothing to revive
  //                  until the harness marks the run stale.
  //   revive       = recoverable AND driver is resumable (codex/claude) AND run.sessionId present.
  //                  No sessionId → revive is shown DISABLED with a hint to restart instead.
  //   restart      = recoverable AND run.role is "worker".
  //
  // A healthy running run renders NOTHING here (use the heartbeat + focus packet for peek-in).
  // Every write disables its button while in flight (no double-submit), surfaces errors inline,
  // and calls onRefresh() on success so the new background command appears in store.controlCommands
  // (Control tab) and the run/heartbeat state re-hydrates.
  import { postRecoveryScan, postRecoveryRevive, postRecoveryRestart } from "~/lib/control";

  let {
    runId,
    status,
    role,
    driver,
    sessionId,
    stalled = false,
    onRefresh = () => {},
  }: {
    runId: string | undefined;
    status: string | undefined;
    role: string | undefined;
    driver: string | undefined;
    sessionId: string | undefined;
    stalled?: boolean; // live run whose liveness has gone dead (no signal) — offer "Mark stale"
    onRefresh?: () => void;
  } = $props();

  // ── Gating ────────────────────────────────────────────────────────────────
  const RESUMABLE = new Set(["codex", "claude"]);
  const isStaleOrFailed = $derived(status === "stale" || status === "failed");
  // Stalled-but-running: a "running" run whose liveness is dead. Mark-stale comes first.
  const needsMarkStale = $derived(status === "running" && stalled);
  const recoverable = $derived(!!runId && (isStaleOrFailed || needsMarkStale));
  const driverResumable = $derived(!!driver && RESUMABLE.has(driver));
  const hasSession = $derived(!!sessionId);
  // Revive is OFFERED on a stale/failed run with a resumable driver; ENABLED only with a session.
  const reviveOffered = $derived(isStaleOrFailed && driverResumable);
  const reviveEnabled = $derived(reviveOffered && hasSession);
  const restartEnabled = $derived(isStaleOrFailed && role === "worker");

  // One muted line explaining WHY recovery is offered.
  const reason = $derived(
    needsMarkStale
      ? "This run is still marked running but has stopped signalling — mark it stale to recover it."
      : status === "failed"
        ? "This run failed — revive the same session or restart a fresh worker."
        : status === "stale"
          ? "This run is stale — revive the same session or restart a fresh worker."
          : "",
  );

  // ── Writes (one in-flight guard + inline error + success note per action) ──
  let marking = $state(false);
  let reviving = $state(false);
  let restarting = $state(false);
  let actionError = $state<string | undefined>(undefined);
  let started = $state<string | undefined>(undefined); // success note

  async function markStale() {
    if (marking) return;
    marking = true;
    actionError = undefined;
    started = undefined;
    const res = await postRecoveryScan({ markStale: true });
    if (res.ok) {
      started = "Marked stale — revive or restart now offered.";
      onRefresh();
    } else {
      actionError = res.error ?? "Mark stale failed.";
    }
    marking = false;
  }

  async function revive() {
    if (reviving || !runId) return;
    reviving = true;
    actionError = undefined;
    started = undefined;
    const res = await postRecoveryRevive({ runId, model: undefined });
    if (res.ok) {
      started = "Started — see Control tab.";
      onRefresh();
    } else {
      actionError = res.error ?? "Revive failed.";
    }
    reviving = false;
  }

  async function restart() {
    if (restarting || !runId) return;
    restarting = true;
    actionError = undefined;
    started = undefined;
    const res = await postRecoveryRestart({ runId, driver });
    if (res.ok) {
      started = "Started — see Control tab.";
      onRefresh();
    } else {
      actionError = res.error ?? "Restart failed.";
    }
    restarting = false;
  }
</script>

{#if recoverable}
  <section class="agent-section rec">
    <div class="run-subhead">Recovery</div>
    {#if reason}<p class="rec-reason muted">{reason}</p>{/if}

    {#if actionError}<p class="error rec-error" role="alert">{actionError}</p>{/if}

    <div class="rec-actions">
      {#if needsMarkStale}
        <button class="ha-primary rec-btn" type="button" disabled={marking} onclick={markStale}>
          {marking ? "Marking…" : "Mark stale"}
        </button>
      {:else}
        {#if reviveOffered}
          <button
            class="ha-primary rec-btn"
            type="button"
            disabled={reviving || !reviveEnabled}
            title={reviveEnabled ? "Resume the same captured session" : "No captured session — restart instead"}
            onclick={revive}
          >
            {reviving ? "Reviving…" : "Revive session"}
          </button>
          {#if !hasSession}
            <span class="rec-hint muted">No captured session — restart instead.</span>
          {/if}
        {/if}
        {#if restartEnabled}
          <button class="ctl-btn rec-btn" type="button" disabled={restarting} onclick={restart}>
            {restarting ? "Restarting…" : "Restart agent"}
          </button>
        {/if}
      {/if}
    </div>

    {#if started}
      <p class="rec-started" role="status">
        <span class="rec-started-glyph" aria-hidden="true">✓</span>{started}
      </p>
    {/if}
  </section>
{/if}
