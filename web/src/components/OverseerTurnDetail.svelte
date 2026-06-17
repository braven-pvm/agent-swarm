<script lang="ts">
  import type { HarnessEvent } from "~/lib/types";
  import { humanizeToken, summarizeCommand, prettifyTarget, shortAge } from "~/lib/format";
  import Markdown from "~/components/Markdown.svelte";

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
        // Logs: show the tail (most recent output). Prompts/manifests: show the full content from
        // the start (head-capped) — the beginning is what matters there.
        const lines = body.split("\n");
        const isLog = /\.log$/i.test(rel);
        logText = isLog
          ? (lines.length > 200 ? "…\n" + lines.slice(-200).join("\n") : body)
          : (lines.length > 1000 ? lines.slice(0, 1000).join("\n") + "\n…" : body);
      })
      .catch((e) => { if (openLog === requested) logError = String(e?.message ?? e); })
      .finally(() => { if (openLog === requested) logLoading = false; });
  }

  let openRaw = $state(false);
</script>

<div class="ovt">
  <!-- A loadable artifact reference (logs / prompt / manifest): a toggle that lazily fetches the
       file and renders it — markdown via <Markdown>, everything else as a mono inset. -->
  {#snippet artifact(label: string, absPath: string)}
    {@const rel = artifactRel(absPath)}
    <div class="ovt-log">
      <span class="ovt-log-label muted">{label}</span>
      {#if rel}
        <button class="ovt-log-btn" onclick={() => toggleLog(absPath)} title={absPath}>
          {openLog === absPath ? "▾" : "▸"} <code>{prettifyTarget(absPath)}</code>
        </button>
      {:else}
        <code class="ovt-log-ref" title={absPath}>{prettifyTarget(absPath)}</code>
      {/if}
    </div>
    {#if openLog === absPath}
      {#if logLoading}
        <p class="empty ovt-log-state">Loading…</p>
      {:else if logError}
        <p class="error ovt-log-state">{logError}</p>
      {:else if logText != null}
        {#if logText.trim().length > 0}
          {#if /\.(md|markdown)$/i.test(absPath)}
            <div class="ovt-prompt"><Markdown md={logText} /></div>
          {:else}
            <pre class="json ovt-log-out">{logText}</pre>
          {/if}
        {:else}
          <p class="empty ovt-log-state">Empty.</p>
        {/if}
      {/if}
    {/if}
  {/snippet}

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
    <pre class="json ovt-cmd-raw" title={command}>{command}</pre>
    {#if isCompletedCommand && exitCode != null}
      <div class="ovt-result-meta"><span class="exit" class:bad={exitCode !== 0}>exit {exitCode}</span></div>
    {/if}
    {#if commandKey || childRole || sliceId}
      <div class="ovt-kv">
        {#if commandKey}<div class="kv"><b>Command key</b><code>{commandKey}</code></div>{/if}
        {#if childRole}<div class="kv"><b>Role</b><span class="ovt-kv-v">{childRole}</span></div>{/if}
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
      {#if stdoutPath}{@render artifact("stdout", stdoutPath)}{/if}
      {#if stderrPath}{@render artifact("stderr", stderrPath)}{/if}
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
            {#if rCmd}<pre class="json ovt-cmd-raw" title={rCmd}>{rCmd}</pre>{/if}
            <div class="ovt-result-meta">
              <span class="exit" class:bad={resultBad(r)}>{resultChip(r)}</span>
              {#if rRole || rSlice}<span class="muted">{[rRole, rSlice].filter(Boolean).join(" · ")}</span>{/if}
            </div>
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
            {#if rcCmd}<pre class="json ovt-cmd-raw" title={rcCmd}>{rcCmd}</pre>{/if}
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
      {#if promptPath}{@render artifact("prompt", promptPath)}{/if}
      {#if manifestPath}{@render artifact("manifest", manifestPath)}{/if}
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
