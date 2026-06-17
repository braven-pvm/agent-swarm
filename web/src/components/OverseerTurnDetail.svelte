<script lang="ts">
  import type { HarnessEvent } from "~/lib/types";
  import { humanizeToken, summarizeCommand, prettifyTarget, shortAge } from "~/lib/format";

  let { event }: { event: HarnessEvent } = $props();

  // ── Safe accessors (payload is Record<string, unknown>; fields may be missing or wrong-typed). ──
  // Mirrors the pick/asStr helpers used by the focus-packet rendering — never throws.
  function pick(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  }
  function asStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  }
  function asNum(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }
  function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }

  // A raw command → its present-tense semantic phrase ("running tests", "reading config.ts").
  function cmdPhrase(raw: unknown): string {
    const s = asStr(raw);
    if (!s) return "";
    const sum = summarizeCommand(s);
    return [sum.present, sum.target].filter(Boolean).join(" ");
  }

  // Derive the artifacts-relative path for a server stdout/stderr log so it can be fetched from
  // GET /api/artifacts/<rel>. The events carry the ABSOLUTE server path; the endpoint resolves
  // against <workspace>/.swarm/artifacts and rejects anything that escapes it — so we strip the
  // ".swarm/artifacts/" prefix (either slash style) and hand back only the tail. undefined when the
  // path doesn't sit under an artifacts dir (then we surface the reference only, never a broken fetch).
  function artifactRel(absPath: unknown): string | undefined {
    const s = asStr(absPath);
    if (!s) return undefined;
    const m = s.match(/[\\/]\.swarm[\\/]artifacts[\\/](.+)$/);
    if (!m) return undefined;
    const rel = m[1].replace(/\\/g, "/");
    return rel.length > 0 ? rel : undefined;
  }

  const payload = $derived(event.payload ?? {});
  const kind = $derived((event.type ?? "").replace(/^overseer\./, ""));
  const title = $derived(humanizeToken(kind) || event.type || "Overseer event");
  const runId = $derived(asStr(pick(payload, "runId")));
  const ageMs = $derived(Date.now() - Date.parse(event.timestamp));
  const relAge = $derived(Number.isFinite(ageMs) ? shortAge(ageMs) : undefined);

  const isCommand = $derived(kind === "command_started" || kind === "command_completed");
  const isCompletedCommand = $derived(kind === "command_completed");
  const isBatch = $derived(kind === "commands_completed" || kind === "completed");
  const isDecision = $derived(kind === "decision_recorded");
  const isStart = $derived(kind === "started");

  // ── One-line summary appropriate to the type. ──
  const summary = $derived((() => {
    if (isDecision) return asStr(pick(payload, "summary"));
    if (kind === "completed") return asStr(pick(payload, "nextAction"));
    if (isCommand) {
      const phrase = cmdPhrase(pick(payload, "command"));
      const role = asStr(pick(payload, "childRole"));
      const slice = asStr(pick(payload, "sliceId"));
      return [phrase, role && `(${role}${slice ? ` · ${slice}` : ""})`].filter(Boolean).join(" ");
    }
    if (kind === "commands_completed") {
      const ex = asNum(pick(payload, "executed")) ?? 0;
      const scenario = asStr(pick(payload, "scenario"));
      return `Ran ${ex} command${ex === 1 ? "" : "s"}${scenario ? ` for ${scenario}` : ""}.`;
    }
    if (isStart) {
      const scenario = asStr(pick(payload, "scenario"));
      const driver = asStr(pick(payload, "driver"));
      return [scenario && `Started ${scenario}`, driver && `via ${driver}`].filter(Boolean).join(" ") || undefined;
    }
    return undefined;
  })());

  // Command-event fields.
  const command = $derived(asStr(pick(payload, "command")));
  const exitCode = $derived(asNum(pick(payload, "exitCode")));
  const purpose = $derived(asStr(pick(payload, "purpose")));
  const expected = $derived(asStr(pick(payload, "expectedStateChange")));
  const commandKey = $derived(asStr(pick(payload, "commandKey")));
  const childRole = $derived(asStr(pick(payload, "childRole")));
  const sliceId = $derived(asStr(pick(payload, "sliceId")));
  const stdoutPath = $derived(asStr(pick(payload, "stdoutPath")));
  const stderrPath = $derived(asStr(pick(payload, "stderrPath")));

  // Batch stat chips + results.
  const executed = $derived(asNum(pick(payload, "executed")));
  const blocked = $derived(asNum(pick(payload, "blocked")));
  const failed = $derived(asNum(pick(payload, "failed")));
  const results = $derived(asArr(pick(payload, "results")).length > 0 ? asArr(pick(payload, "results")) : asArr(pick(payload, "commandResults")));
  const nextAction = $derived(asStr(pick(payload, "nextAction")));

  // Decision fields.
  const currentPriority = $derived(asStr(pick(payload, "currentPriority")));
  const stopCondition = $derived(asStr(pick(payload, "stopCondition")));
  const recommendedCommands = $derived(asArr(pick(payload, "recommendedCommands")));
  const lanePlan = $derived(asArr(pick(payload, "lanePlan")));
  const blockers = $derived(asArr(pick(payload, "blockers")).filter((b) => b != null && b !== ""));

  // Turn-start fields.
  const driver = $derived(asStr(pick(payload, "driver")));
  const attempt = $derived(asStr(pick(payload, "attempt")));
  const executeLimit = $derived(asStr(pick(payload, "executeLimit")));
  const manifestPath = $derived(asStr(pick(payload, "manifestPath")));
  const promptPath = $derived(asStr(pick(payload, "promptPath")));

  // Per-result status chip → exit-chip tone (green when exit 0 / executed, red otherwise).
  function resultBad(r: unknown): boolean {
    const ec = asNum(pick(r, "exitCode"));
    if (ec != null) return ec !== 0;
    const st = asStr(pick(r, "status"));
    return st != null && st !== "executed" && st !== "passed" && st !== "accepted";
  }
  function resultChip(r: unknown): string {
    const ec = asNum(pick(r, "exitCode"));
    if (ec != null) return `exit ${ec}`;
    return asStr(pick(r, "status")) ?? "—";
  }

  // ── Lazy per-log output fetch from /api/artifacts/<rel>. Keyed by the (full) log path so two logs
  // are tracked independently; a stale-guard drops responses for a path that's no longer requested. ──
  let openLog = $state<string | null>(null);
  let logText = $state<string | null>(null);
  let logLoading = $state(false);
  let logError = $state<string | undefined>(undefined);

  // Reset all log state whenever the event changes (the inspector reuses this component per selection).
  let lastEventId = $state<string | undefined>(undefined);
  $effect(() => {
    if (event.id === lastEventId) return;
    lastEventId = event.id;
    openLog = null; logText = null; logLoading = false; logError = undefined;
  });

  function toggleLog(absPath: string) {
    if (openLog === absPath) { openLog = null; return; }
    openLog = absPath;
    const rel = artifactRel(absPath);
    if (!rel) { logText = null; logError = "Log path is outside the artifacts directory."; logLoading = false; return; }
    logText = null; logError = undefined; logLoading = true;
    const requested = absPath;
    fetch(`/api/artifacts/${encodeURI(rel)}`)
      .then(async (res) => {
        if (openLog !== requested) return; // stale-guard: selection moved on
        if (!res.ok) { logError = `Could not load log (${res.status}).`; return; }
        const body = await res.text();
        if (openLog !== requested) return;
        // Show the tail (most recent output) — logs can be large.
        const lines = body.split("\n");
        logText = lines.length > 200 ? "…\n" + lines.slice(-200).join("\n") : body;
      })
      .catch((e) => { if (openLog === requested) logError = String(e?.message ?? e); })
      .finally(() => { if (openLog === requested) logLoading = false; });
  }

  let openRaw = $state(false);
</script>

<div class="ovt">
  <!-- HEADER -->
  <div class="ovt-head">
    <h4 class="ovt-title">{title}</h4>
    <div class="ovt-head-meta">
      {#if runId}<code class="ovt-runid" title={runId}>{runId}</code>{/if}
      {#if relAge}<span class="muted ovt-age">{relAge}</span>{/if}
    </div>
  </div>

  <!-- SUMMARY (the meat) -->
  {#if summary}
    <p class="ovt-summary">{summary}</p>
  {/if}

  <!-- COMMAND events -->
  {#if isCommand && command}
    <div class="ovt-eyebrow">Command</div>
    <div class="ovt-cmd-line">
      <span class="ovt-cmd-phrase">{cmdPhrase(command) || "command"}</span>
      {#if isCompletedCommand && exitCode != null}
        <span class="exit" class:bad={exitCode !== 0}>exit {exitCode}</span>
      {/if}
    </div>
    <pre class="json ovt-cmd-raw" title={command}>{command}</pre>
    {#if commandKey || childRole || sliceId}
      <div class="ovt-kv">
        {#if commandKey}<div class="kv"><b>Command key</b><code>{commandKey}</code></div>{/if}
        {#if childRole}<div class="kv"><b>Role</b>{childRole}</div>{/if}
        {#if sliceId}<div class="kv"><b>Slice</b><code>{sliceId}</code></div>{/if}
      </div>
    {/if}
    {#if purpose}
      <div class="ovt-eyebrow">Purpose</div>
      <p class="ovt-para muted">{purpose}</p>
    {/if}
    {#if expected}
      <div class="ovt-eyebrow">Expected state change</div>
      <p class="ovt-para muted">{expected}</p>
    {/if}
    {#if stdoutPath || stderrPath}
      <div class="ovt-eyebrow">Logs</div>
      {#each [["stdout", stdoutPath], ["stderr", stderrPath]] as [label, p] (label)}
        {#if p}
          {@const rel = artifactRel(p)}
          <div class="ovt-log">
            <span class="ovt-log-label muted">{label}</span>
            {#if rel}
              <button class="ovt-log-btn" onclick={() => toggleLog(p)} title={p}>
                {openLog === p ? "▾" : "▸"} <code>{prettifyTarget(p)}</code>
              </button>
            {:else}
              <code class="ovt-log-ref" title={p}>{prettifyTarget(p)}</code>
            {/if}
          </div>
          {#if openLog === p}
            {#if logLoading}
              <p class="empty ovt-log-state">Loading…</p>
            {:else if logError}
              <p class="error ovt-log-state">{logError}</p>
            {:else if logText != null}
              {#if logText.trim().length > 0}
                <pre class="json ovt-log-out">{logText}</pre>
              {:else}
                <p class="empty ovt-log-state">Empty output.</p>
              {/if}
            {/if}
          {/if}
        {/if}
      {/each}
    {/if}
  {/if}

  <!-- BATCH events -->
  {#if isBatch}
    {#if executed != null || blocked != null || failed != null}
      <div class="ovt-stats">
        {#if executed != null}<span class="ovt-stat"><span class="ovt-stat-n">{executed}</span> executed</span>{/if}
        {#if blocked != null}<span class="ovt-stat"><span class="ovt-stat-n">{blocked}</span> blocked</span>{/if}
        {#if failed != null}
          <span class="ovt-stat" class:bad={failed > 0}>
            {#if failed > 0}<span class="ovt-stat-glyph" aria-hidden="true">✕</span>{/if}<span class="ovt-stat-n">{failed}</span> failed
          </span>
        {/if}
      </div>
    {/if}
    {#if results.length > 0}
      <div class="ovt-eyebrow">Commands</div>
      <div class="ovt-results">
        {#each results as r, i (i)}
          {@const rCmd = asStr(pick(r, "command"))}
          {@const rRole = asStr(pick(r, "childRole"))}
          {@const rSlice = asStr(pick(r, "sliceId"))}
          {@const rPurpose = asStr(pick(r, "purpose"))}
          <div class="ovt-result">
            <div class="ovt-result-head">
              <span class="ovt-cmd-phrase">{cmdPhrase(rCmd) || "command"}</span>
              <span class="exit" class:bad={resultBad(r)}>{resultChip(r)}</span>
            </div>
            {#if rCmd}<code class="ovt-result-cmd" title={rCmd}>{prettifyTarget(rCmd)}</code>{/if}
            {#if rRole || rSlice}
              <div class="ovt-result-meta muted">{[rRole, rSlice].filter(Boolean).join(" · ")}</div>
            {/if}
            {#if rPurpose}<div class="ovt-result-purpose muted">{rPurpose}</div>{/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if kind === "completed" && nextAction}
      <div class="ovt-eyebrow">Next action</div>
      <p class="ovt-para muted">{nextAction}</p>
    {/if}
  {/if}

  <!-- DECISION events -->
  {#if isDecision}
    {#if currentPriority}
      <div class="ovt-eyebrow">Current priority</div>
      <p class="ovt-para muted">{currentPriority}</p>
    {/if}
    {#if nextAction}
      <div class="ovt-eyebrow">Next action</div>
      <p class="ovt-para muted">{nextAction}</p>
    {/if}
    {#if stopCondition}
      <div class="ovt-eyebrow">Stop condition</div>
      <p class="ovt-para muted">{stopCondition}</p>
    {/if}
    {#if recommendedCommands.length > 0}
      <div class="ovt-eyebrow">Recommended commands</div>
      <div class="ovt-results">
        {#each recommendedCommands as rc, i (i)}
          {@const rcCmd = asStr(pick(rc, "command"))}
          {@const rcPurpose = asStr(pick(rc, "purpose"))}
          <div class="ovt-result">
            <div class="ovt-result-head">
              <span class="ovt-cmd-phrase">{cmdPhrase(rcCmd) || "command"}</span>
            </div>
            {#if rcCmd}<code class="ovt-result-cmd" title={rcCmd}>{prettifyTarget(rcCmd)}</code>{/if}
            {#if rcPurpose}<div class="ovt-result-purpose muted">{rcPurpose}</div>{/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if lanePlan.length > 0}
      <div class="ovt-eyebrow">Lane plan</div>
      <ul class="ovt-lanes">
        {#each lanePlan as lp, i (i)}
          {@const laneName = asStr(pick(lp, "laneName"))}
          {@const laneNext = asStr(pick(lp, "nextAction")) ?? asStr(pick(lp, "purpose"))}
          <li class="ovt-lane">
            {#if laneName}<code class="ovt-lane-name">{laneName}</code>{/if}
            {#if laneNext}<span class="muted"> — {laneNext}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if blockers.length > 0}
      <div class="ovt-eyebrow">Blockers</div>
      <ul class="ovt-blockers">
        {#each blockers as b, i (i)}
          <li><span class="ovt-blocker-glyph" aria-hidden="true">✕</span> {asStr(b) ?? asStr(pick(b, "message")) ?? asStr(pick(b, "reason")) ?? "Blocker"}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  <!-- TURN start -->
  {#if isStart}
    {#if attempt || executeLimit || driver}
      <div class="ovt-kv">
        {#if attempt}<div class="kv"><b>Attempt</b>{attempt}</div>{/if}
        {#if executeLimit}<div class="kv"><b>Execute limit</b>{executeLimit}</div>{/if}
        {#if driver}<div class="kv"><b>Driver</b><code>{driver}</code></div>{/if}
      </div>
    {/if}
    {#if manifestPath || promptPath}
      <div class="ovt-eyebrow">Files</div>
      {#if manifestPath}
        <div class="ovt-log"><span class="ovt-log-label muted">manifest</span><code class="ovt-log-ref" title={manifestPath}>{prettifyTarget(manifestPath)}</code></div>
      {/if}
      {#if promptPath}
        <div class="ovt-log"><span class="ovt-log-label muted">prompt</span><code class="ovt-log-ref" title={promptPath}>{prettifyTarget(promptPath)}</code></div>
      {/if}
    {/if}
  {/if}

  <!-- RAW PAYLOAD (collapsed by default; available for power users) -->
  <button class="run-act-toggle ovt-raw-toggle" onclick={() => (openRaw = !openRaw)}>
    {openRaw ? "▾" : "▸"} Raw payload
  </button>
  {#if openRaw}
    <pre class="json">{JSON.stringify(payload, null, 2)}</pre>
  {/if}
</div>
