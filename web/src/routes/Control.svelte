<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { ControlCommand, DevServer } from "~/lib/control";
  import {
    postContinue,
    postRecoveryScan,
    postDevServerStart,
    postDevServerStop,
    fetchControlCommands,
    fetchDevServers,
    statusTone,
  } from "~/lib/control";

  let { store, onRefresh }: { store: ConsoleStore; onRefresh: () => void } = $props();

  const snap = $derived(store.snapshot);
  const commands = $derived(store.controlCommandsNewestFirst);
  const devServers = $derived(store.devServers);
  // Registered targets from the snapshot — the start control offers these as datalist options so the
  // human can start a known target without typing its exact name.
  const targets = $derived(snap?.targets ?? []);

  // ── "Looks stopped" detection ────────────────────────────────────────────
  // The run is stopped when nothing is actively running (no agentRuns in "running", no in-flight
  // control command) and it has either reached human_required / a terminal outcome, or simply has
  // runs but none live. The Continue control is prominent in that case; otherwise it's a quieter
  // "the run is active" note (continue is still offered, but de-emphasised).
  const anyRunActive = $derived((snap?.agentRuns ?? []).some((r) => r.status === "running"));
  const anyControlRunning = $derived(store.runningControlCommands.length > 0);
  const outcome = $derived(snap?.runObservability?.outcome);
  const humanRequired = $derived(outcome?.finalOutcome === "human_required" || outcome?.finalReason === "human_required");
  const runStopped = $derived(!!snap && !anyRunActive && !anyControlRunning);

  // The scenario to continue — from the snapshot. Without one we can't safely POST continue.
  const scenario = $derived(snap?.scenario ?? snap?.runObservability?.scenario ?? "");
  const currentRunId = $derived(outcome?.runId);

  // ── Continue run ─────────────────────────────────────────────────────────
  let reset = $state(false);
  let resetAck = $state(false); // explicit confirmation gate for the destructive workspace reset
  let continuing = $state(false);
  let continueError = $state<string | undefined>(undefined);
  let lastStarted = $state<{ command: string; runId?: string; scenario?: string } | null>(null);
  // Unticking reset clears the confirmation, so re-enabling it requires confirming again.
  $effect(() => { if (!reset) resetAck = false; });

  async function continueRun() {
    if (continuing || !scenario) return; // no double-submit; need a scenario
    continuing = true;
    continueError = undefined;
    lastStarted = null;
    const res = await postContinue({ scenario, runId: currentRunId, reset });
    if (res.ok) {
      const d = res.data ?? {};
      const cmd = d.command as Record<string, unknown> | undefined;
      lastStarted = {
        command: assembleStarted(cmd, d),
        runId: typeof d.runId === "string" ? d.runId : undefined,
        scenario: typeof d.scenario === "string" ? d.scenario : undefined,
      };
      reset = false; resetAck = false; // a destructive toggle should not stick after firing
      // Pull the fresh command feed + the snapshot so the new background command appears at once.
      fetchControlCommands().then(store.setControlCommands).catch(() => {});
      onRefresh();
    } else {
      continueError = res.error ?? "Could not start the run.";
    }
    continuing = false;
  }

  // Render the started command line from the response `command` ({ command, args }) or a flat shape.
  function assembleStarted(cmd: Record<string, unknown> | undefined, d: Record<string, unknown>): string {
    const c = cmd ?? d;
    const head = typeof c.command === "string" ? c.command : "swarm";
    const args = Array.isArray(c.args) ? (c.args as unknown[]).map((a) => String(a)) : [];
    return [head, ...args].join(" ").trim() || "swarm smoke live-agent full";
  }

  // ── Recovery scan ────────────────────────────────────────────────────────
  let scanning = $state(false);
  let scanError = $state<string | undefined>(undefined);
  let scanResult = $state<{ summary: string; affected: number } | null>(null);

  async function recoveryScan() {
    if (scanning) return;
    scanning = true;
    scanError = undefined;
    scanResult = null;
    const res = await postRecoveryScan({ markStale: true });
    if (res.ok) {
      scanResult = summarizeScan(res.data ?? {});
      fetchControlCommands().then(store.setControlCommands).catch(() => {});
      onRefresh();
    } else {
      scanError = res.error ?? "Recovery scan failed.";
    }
    scanning = false;
  }

  // Best-effort scan summary. The server returns { ok, result }, where `result` is the captured
  // CLI command record (stdout/stderr/exitCode); affected-run counts may also appear at the top
  // level on richer responses. Count whichever list shape is present; else read the stdout tail.
  function summarizeScan(d: Record<string, unknown>): { summary: string; affected: number } {
    const scope = (d.result && typeof d.result === "object" ? (d.result as Record<string, unknown>) : d);
    const lists = ["affected", "runs", "staleRuns", "markedStale", "marked", "released"]
      .map((k) => (Array.isArray(scope[k]) ? (scope[k] as unknown[]).length : undefined))
      .filter((n): n is number => typeof n === "number");
    const affected =
      lists.length > 0 ? Math.max(...lists) : Number(scope.affectedCount ?? scope.count ?? 0) || 0;
    if (affected > 0) {
      return {
        summary: `Found ${affected} stale run${affected === 1 ? "" : "s"} and marked ${affected === 1 ? "it" : "them"} stale.`,
        affected,
      };
    }
    // No structured count — fall back to the command's stdout tail (or a clean "no stale runs").
    const stdout = typeof scope.stdout === "string" ? scope.stdout.trim() : "";
    const tail = stdout ? stdout.split("\n").filter(Boolean).slice(-1)[0] : "";
    return { summary: tail || "Scan complete — no stale runs found.", affected: 0 };
  }

  // ── Background command logs (lazy, per OverseerTurnDetail pattern) ─────────
  // Each command's stdout/stderr is fetched directly from its href (already "/api/artifacts/...").
  let openLog = $state<string | null>(null); // key: `${cmdId}:${stream}`
  let logText = $state<string | null>(null);
  let logLoading = $state(false);
  let logError = $state<string | undefined>(undefined);
  let openArgsId = $state<string | null>(null);

  function logKey(cmdId: string, stream: "stdout" | "stderr"): string {
    return `${cmdId}:${stream}`;
  }
  function toggleLog(cmdId: string, stream: "stdout" | "stderr", href: string | undefined) {
    const key = logKey(cmdId, stream);
    if (openLog === key) { openLog = null; return; }
    openLog = key;
    logText = null; logError = undefined; logLoading = true;
    if (!href) { logError = "No log artifact for this stream."; logLoading = false; return; }
    const requested = key;
    fetch(href)
      .then(async (res) => {
        if (openLog !== requested) return; // stale-guard: selection moved on
        if (!res.ok) { logError = `Could not load log (${res.status}).`; return; }
        const body = await res.text();
        if (openLog !== requested) return;
        const lines = body.split("\n");
        logText = lines.length > 200 ? "…\n" + lines.slice(-200).join("\n") : body;
      })
      .catch((e) => { if (openLog === requested) logError = String(e?.message ?? e); })
      .finally(() => { if (openLog === requested) logLoading = false; });
  }
  function toggleArgs(cmdId: string) {
    openArgsId = openArgsId === cmdId ? null : cmdId;
  }

  function kindLabel(c: ControlCommand): string {
    return store.commandKindLabel(c.kind);
  }

  // ── Dev servers (BUILD 3) ──────────────────────────────────────────────────
  // Human-review dev servers: start `npm run start` for a registered target and open the returned
  // localhost URL for visual verification. A target with no `start` script moves to "failed" and
  // exposes npm stderr via its href — we surface that as a blocker, never a silent button failure.
  function pullDevServers() {
    fetchDevServers().then(store.setDevServers).catch(() => {});
  }

  // Start control.
  let startTarget = $state("");
  let startPort = $state(""); // text input → optional number
  let starting = $state(false);
  let startError = $state<string | undefined>(undefined);
  let startResult = $state<{ targetName?: string; url?: string; status?: string; stderrHref?: string } | null>(null);

  const startTargetTrimmed = $derived(startTarget.trim());
  const portNumber = $derived(startPort.trim() === "" ? undefined : Number(startPort.trim()));
  const portInvalid = $derived(
    portNumber != null && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535),
  );

  async function startDevServer() {
    if (starting || !startTargetTrimmed || portInvalid) return; // no double-submit; need a target; valid port
    starting = true;
    startError = undefined;
    startResult = null;
    const res = await postDevServerStart({ targetName: startTargetTrimmed, port: portNumber });
    if (res.ok) {
      const s = (res.data?.server ?? res.data ?? {}) as Record<string, unknown>;
      startResult = {
        targetName: typeof s.targetName === "string" ? s.targetName : startTargetTrimmed,
        url: typeof s.url === "string" ? s.url : undefined,
        status: typeof s.status === "string" ? s.status : undefined,
        stderrHref: typeof s.stderrHref === "string" ? s.stderrHref : undefined,
      };
      startPort = "";
      pullDevServers();
      onRefresh();
    } else {
      // A server-side { ok:false } may still carry the failed record (e.g. no start script).
      const s = (res.data?.server ?? {}) as Record<string, unknown>;
      startResult = typeof s.stderrHref === "string"
        ? { targetName: typeof s.targetName === "string" ? s.targetName : startTargetTrimmed, status: "failed", stderrHref: s.stderrHref }
        : null;
      startError = res.error ?? "Could not start the dev server.";
      pullDevServers();
    }
    starting = false;
  }

  // Stop control (per-server in-flight guard).
  let stoppingId = $state<string | null>(null);
  let stopError = $state<string | undefined>(undefined);

  async function stopDevServer(id: string) {
    if (stoppingId) return;
    stoppingId = id;
    stopError = undefined;
    const res = await postDevServerStop(id);
    if (res.ok) {
      pullDevServers();
      onRefresh();
    } else {
      stopError = res.error ?? "Could not stop the dev server.";
    }
    stoppingId = null;
  }

  // Per-server stderr toggle (lazy fetch from stderrHref). Surfaces a failed start's npm stderr so a
  // "no start script" failure is visible, not silent. Keyed by server id.
  let openStderrId = $state<string | null>(null);
  let stderrText = $state<string | null>(null);
  let stderrLoading = $state(false);
  let stderrError = $state<string | undefined>(undefined);

  function toggleStderr(id: string, href: string | undefined) {
    if (openStderrId === id) { openStderrId = null; return; }
    openStderrId = id;
    stderrText = null; stderrError = undefined; stderrLoading = true;
    if (!href) { stderrError = "No stderr artifact for this server."; stderrLoading = false; return; }
    const requested = id;
    fetch(href)
      .then(async (res) => {
        if (openStderrId !== requested) return; // stale-guard
        if (!res.ok) { stderrError = `Could not load stderr (${res.status}).`; return; }
        const body = await res.text();
        if (openStderrId !== requested) return;
        const lines = body.split("\n");
        stderrText = lines.length > 200 ? "…\n" + lines.slice(-200).join("\n") : body;
      })
      .catch((e) => { if (openStderrId === requested) stderrError = String(e?.message ?? e); })
      .finally(() => { if (openStderrId === requested) stderrLoading = false; });
  }

  // A failed dev server gets a clear, human-readable reason. npm's "Missing script: start" is the
  // canonical "no start script" case — name it plainly; otherwise show the recorded error/status.
  function failureReason(s: DevServer): string {
    const err = (s as DevServer & { error?: string }).error;
    if (err && err.trim()) return err.trim();
    return "Failed — no start script (or the server exited non-zero). View stderr for details.";
  }
</script>

<section class="route control">
  <header class="ctl-head">
    <h2 class="ctl-title">Control</h2>
    <p class="ctl-sub muted">Local lifecycle controls — continue a stopped run, recover stale agents, and manage review dev servers. These are trusted local write actions.</p>
  </header>

  <!-- 1. CONTINUE RUN ─────────────────────────────────────────────────────── -->
  <section class="ctl-panel" aria-labelledby="ctl-continue-h">
    <div class="run-subhead ctl-panel-head" id="ctl-continue-h">Continue run</div>
    {#if !snap}
      <p class="empty">Waiting for the run snapshot…</p>
    {:else}
      <p class="ctl-panel-lede">
        {#if runStopped}
          The run looks stopped{#if humanRequired} — it is waiting for a human decision{/if}. Continue it to resume <code class="mono">swarm smoke live-agent full</code>.
        {:else}
          A run is active. You can still continue against the current workspace if you need to push it forward.
        {/if}
      </p>
      <div class="ctl-continue-meta">
        <span class="ctl-kv"><span class="ctl-kv-k">Scenario</span><span class="ctl-kv-v mono">{scenario || "—"}</span></span>
        {#if currentRunId}<span class="ctl-kv"><span class="ctl-kv-k">Run</span><span class="ctl-kv-v mono">{currentRunId}</span></span>{/if}
      </div>

      <label class="ctl-reset">
        <input type="checkbox" bind:checked={reset} disabled={continuing} />
        <span class="ctl-reset-text">Reset workspace first</span>
      </label>
      {#if reset}
        <p class="ctl-warn" role="alert">
          <span class="ctl-warn-glyph" aria-hidden="true">⚠</span>
          Reset discards the current workspace state before continuing — uncommitted agent work in the workspace is lost.
        </p>
        <label class="ctl-reset ctl-reset-ack">
          <input type="checkbox" bind:checked={resetAck} disabled={continuing} />
          <span class="ctl-reset-text">I understand — discard the workspace state and start fresh.</span>
        </label>
      {/if}

      {#if continueError}<p class="error ctl-error" role="alert">{continueError}</p>{/if}

      <button class="ha-primary ctl-continue-btn" type="button" disabled={continuing || !scenario || (reset && !resetAck)} onclick={continueRun}>
        {continuing ? "Starting…" : reset ? "Reset & continue run" : "Continue run"}
      </button>
      {#if !scenario}
        <p class="empty ctl-hint">No scenario in the snapshot yet — nothing to continue.</p>
      {/if}

      {#if lastStarted}
        <div class="ctl-started" role="status">
          <span class="run-subhead ctl-started-head">Started</span>
          <pre class="json ctl-started-cmd">{lastStarted.command}</pre>
          <div class="ctl-started-meta muted">
            {#if lastStarted.scenario}<span class="mono">{lastStarted.scenario}</span>{/if}
            {#if lastStarted.runId}<span class="mono">{lastStarted.runId}</span>{/if}
          </div>
        </div>
      {/if}
    {/if}
  </section>

  <!-- 2. RECOVERY SCAN ────────────────────────────────────────────────────── -->
  <section class="ctl-panel" aria-labelledby="ctl-scan-h">
    <div class="run-subhead ctl-panel-head" id="ctl-scan-h">Recovery scan</div>
    <p class="ctl-panel-lede">Scan for running agents whose liveness has stalled and mark them stale, so they become recoverable (revive same-session, or restart fresh).</p>
    {#if scanError}<p class="error ctl-error" role="alert">{scanError}</p>{/if}
    <button class="ctl-btn" type="button" disabled={scanning} onclick={recoveryScan}>
      {scanning ? "Scanning…" : "Scan for stale runs"}
    </button>
    {#if scanResult}
      <p class="ctl-scan-result" class:ctl-scan-hit={scanResult.affected > 0} role="status">
        <span class="ctl-scan-glyph" aria-hidden="true">{scanResult.affected > 0 ? "⚠" : "✓"}</span>
        {scanResult.summary}
      </p>
    {/if}
  </section>

  <!-- 3. BACKGROUND COMMANDS ──────────────────────────────────────────────── -->
  <section class="ctl-panel" aria-labelledby="ctl-cmds-h">
    <div class="run-subhead ctl-panel-head" id="ctl-cmds-h">Background commands <span class="count">({commands.length})</span></div>
    {#if commands.length === 0}
      <p class="empty">No control commands yet. Continue a run or scan for stale agents to start one.</p>
    {:else}
      <div class="cov-table-scroll ctl-table-scroll">
        <table class="cov-table ctl-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Status</th>
              <th>Pid</th>
              <th>Run</th>
              <th class="ctl-th-logs">Logs</th>
            </tr>
          </thead>
          <tbody>
            {#each commands as c (c.id)}
              {@const tone = statusTone(c.status)}
              {@const showStdout = openLog === logKey(c.id, "stdout")}
              {@const showStderr = openLog === logKey(c.id, "stderr")}
              {@const showArgs = openArgsId === c.id}
              <tr class="cov-row ctl-row">
                <td class="ctl-kind">{kindLabel(c)}</td>
                <td>
                  <span class="cov-badge {tone.cls} ctl-status-chip" class:ctl-status-pulse={tone.pulse}>
                    <span class="ctl-status-glyph" aria-hidden="true">{tone.glyph}</span>{tone.label}
                  </span>
                  {#if c.exitCode != null}<span class="exit" class:bad={c.exitCode !== 0} title="exit code">exit {c.exitCode}</span>{/if}
                </td>
                <td class="mono muted ctl-pid">{c.pid ?? "—"}</td>
                <td class="mono muted ctl-runid" title={c.runId ?? ""}>{c.runId ?? "—"}</td>
                <td class="ctl-logs-cell">
                  <button class="ctl-log-toggle" type="button" disabled={!c.stdoutHref} aria-pressed={showStdout} onclick={() => toggleLog(c.id, "stdout", c.stdoutHref)}>
                    {showStdout ? "▾" : "▸"} stdout
                  </button>
                  <button class="ctl-log-toggle" type="button" disabled={!c.stderrHref} aria-pressed={showStderr} onclick={() => toggleLog(c.id, "stderr", c.stderrHref)}>
                    {showStderr ? "▾" : "▸"} stderr
                  </button>
                  <button class="ctl-log-toggle" type="button" aria-pressed={showArgs} onclick={() => toggleArgs(c.id)}>
                    {showArgs ? "▾" : "▸"} args
                  </button>
                </td>
              </tr>
              {#if showStdout || showStderr}
                <tr class="ctl-detail-row">
                  <td colspan="5">
                    {#if logLoading}
                      <p class="empty ctl-log-state">Loading…</p>
                    {:else if logError}
                      <p class="error ctl-log-state">{logError}</p>
                    {:else if logText != null}
                      {#if logText.trim().length > 0}
                        <pre class="json ctl-log-out">{logText}</pre>
                      {:else}
                        <p class="empty ctl-log-state">Empty.</p>
                      {/if}
                    {/if}
                  </td>
                </tr>
              {/if}
              {#if showArgs}
                <tr class="ctl-detail-row">
                  <td colspan="5">
                    <pre class="json ctl-args-out">{[c.command, ...(c.args ?? [])].join(" ")}</pre>
                    {#if c.cwd}<p class="muted ctl-args-cwd">cwd: <code>{c.cwd}</code></p>{/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <!-- 4. DEV SERVERS — human-review dev-server start/stop + URL (BUILD 3). ─────── -->
  <section class="ctl-panel" aria-labelledby="ctl-dev-h">
    <div class="run-subhead ctl-panel-head" id="ctl-dev-h">Dev servers <span class="count">({devServers.length})</span></div>
    <p class="ctl-panel-lede">Start a human-review dev server for a registered target, then open its localhost URL to verify the product visually. A target with no <code class="mono">start</code> script fails and blocks readiness — its stderr is shown here, not hidden.</p>

    <!-- Start control -->
    <div class="ctl-dev-start">
      <div class="ctl-dev-fields">
        <label class="ctl-dev-field">
          <span class="ctl-dev-flabel">Target</span>
          <input
            class="ctl-dev-input mono"
            type="text"
            list="ctl-dev-targets"
            placeholder="support-ui"
            bind:value={startTarget}
            disabled={starting}
            aria-label="Target name"
          />
          <datalist id="ctl-dev-targets">
            {#each targets as t (t.id)}<option value={t.name}></option>{/each}
          </datalist>
        </label>
        <label class="ctl-dev-field ctl-dev-field-port">
          <span class="ctl-dev-flabel">Port <span class="ctl-dev-opt">(optional)</span></span>
          <input
            class="ctl-dev-input mono"
            type="text"
            inputmode="numeric"
            placeholder="auto"
            bind:value={startPort}
            disabled={starting}
            aria-label="Port (optional)"
          />
        </label>
        <button class="ha-primary ctl-dev-start-btn" type="button" disabled={starting || !startTargetTrimmed || portInvalid} onclick={startDevServer}>
          {starting ? "Starting…" : "Start dev server"}
        </button>
      </div>
      {#if portInvalid}<p class="ctl-error" role="alert">Port must be a whole number between 1 and 65535.</p>{/if}
      {#if startError}<p class="error ctl-error" role="alert">{startError}</p>{/if}
      {#if startResult}
        {#if startResult.status === "failed"}
          <p class="ctl-dev-startres ctl-dev-startres-fail" role="status">
            <span class="ctl-dev-glyph" aria-hidden="true">✕</span>
            <span><span class="mono">{startResult.targetName}</span> failed to start.{#if startResult.stderrHref} <a class="ctl-dev-link" href={startResult.stderrHref} target="_blank" rel="noopener">View stderr →</a>{/if}</span>
          </p>
        {:else if startResult.url}
          <p class="ctl-dev-startres ctl-dev-startres-ok" role="status">
            <span class="ctl-dev-glyph" aria-hidden="true">✓</span>
            <span>Started <span class="mono">{startResult.targetName}</span> — <a class="ctl-dev-link mono" href={startResult.url} target="_blank" rel="noopener">{startResult.url}</a></span>
          </p>
        {/if}
      {/if}
    </div>

    {#if stopError}<p class="error ctl-error" role="alert">{stopError}</p>{/if}

    <!-- Server list -->
    {#if devServers.length === 0}
      <p class="empty">No dev servers yet. Start one above to verify a target in the browser.</p>
    {:else}
      <ul class="ctl-dev-list">
        {#each devServers as s (s.id)}
          {@const tone = statusTone(s.status)}
          {@const stderrOpen = openStderrId === s.id}
          <li class="ctl-dev-item" class:ctl-dev-item-fail={s.status === "failed"}>
            <div class="ctl-dev-row">
              <span class="ctl-dev-target mono">{s.targetName ?? s.targetPath ?? "—"}</span>
              {#if s.status === "running" && s.url}
                <a class="cov-badge {tone.cls} ctl-status-chip ctl-dev-urlchip" class:ctl-status-pulse={tone.pulse} href={s.url} target="_blank" rel="noopener" title="Open {s.url} in a new tab">
                  <span class="ctl-status-glyph" aria-hidden="true">{tone.glyph}</span><span class="mono">{s.url}</span>
                </a>
              {:else}
                <span class="cov-badge {tone.cls} ctl-status-chip" class:ctl-dev-chip-muted={s.status === "stopped"}>
                  <span class="ctl-status-glyph" aria-hidden="true">{tone.glyph}</span>{tone.label}
                </span>
              {/if}
              <span class="ctl-dev-meta muted">
                {#if s.port != null}port {s.port}{/if}
                {#if s.pid != null} · pid {s.pid}{/if}
              </span>
              <span class="ctl-dev-actions">
                {#if s.status === "running"}
                  <button class="ctl-btn ctl-dev-stop" type="button" disabled={stoppingId === s.id} onclick={() => stopDevServer(s.id)}>
                    {stoppingId === s.id ? "Stopping…" : "Stop"}
                  </button>
                {/if}
                {#if s.status === "failed" || s.stderrHref}
                  <button class="ctl-log-toggle" type="button" disabled={!s.stderrHref} aria-pressed={stderrOpen} onclick={() => toggleStderr(s.id, s.stderrHref)}>
                    {stderrOpen ? "▾" : "▸"} view stderr
                  </button>
                {/if}
              </span>
            </div>
            {#if s.status === "failed"}
              <p class="ctl-dev-fail-msg" role="alert">
                <span class="ctl-dev-glyph" aria-hidden="true">✕</span>{failureReason(s)}
              </p>
            {/if}
            {#if stderrOpen}
              <div class="ctl-dev-stderr">
                {#if stderrLoading}
                  <p class="empty ctl-log-state">Loading…</p>
                {:else if stderrError}
                  <p class="error ctl-log-state">{stderrError}</p>
                {:else if stderrText != null}
                  {#if stderrText.trim().length > 0}
                    <pre class="json ctl-log-out">{stderrText}</pre>
                  {:else}
                    <p class="empty ctl-log-state">Empty.</p>
                  {/if}
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
