<script lang="ts">
  // "Start dev server to verify" — a human-review affordance for a record_human_verification action.
  // It starts `npm run start` for the action's slice target and, on success, shows the localhost URL
  // to open for visual verification BEFORE the human records sign-off. If the target has no start
  // script the failure is shown inline (with stderr) — it does NOT block the manual sign-off form,
  // which stays available either way (per docs/architecture/local-control-api.md, "intended UI flow").
  import { postDevServerStart } from "~/lib/control";

  let {
    targetName,
    commandName,
    startAvailable = true,
    unavailableReason,
    startCommand,
  }: {
    targetName: string | undefined;
    commandName?: string;
    startAvailable?: boolean;
    unavailableReason?: string;
    startCommand?: string;
  } = $props();

  let starting = $state(false);
  let error = $state<string | undefined>(undefined);
  let result = $state<{ targetName?: string; url?: string; status?: string; stderrHref?: string } | null>(null);

  async function start() {
    if (starting || !targetName || !startAvailable) return; // no double-submit; need a runnable target
    starting = true;
    error = undefined;
    result = null;
    const res = await postDevServerStart({ targetName, commandName });
    if (res.ok) {
      const s = (res.data?.server ?? res.data ?? {}) as Record<string, unknown>;
      result = {
        targetName: typeof s.targetName === "string" ? s.targetName : targetName,
        url: typeof s.url === "string" ? s.url : undefined,
        status: typeof s.status === "string" ? s.status : undefined,
        stderrHref: typeof s.stderrHref === "string" ? s.stderrHref : undefined,
      };
    } else {
      // A server-side { ok:false } may still carry the failed record (e.g. no start script) — keep
      // its stderr link so the failure isn't silent. Either way the sign-off form below stays usable.
      const s = (res.data?.server ?? {}) as Record<string, unknown>;
      result = typeof s.stderrHref === "string"
        ? { targetName: typeof s.targetName === "string" ? s.targetName : targetName, status: "failed", stderrHref: s.stderrHref }
        : null;
      error = res.error ?? "Could not start the dev server.";
    }
    starting = false;
  }
</script>

<div class="ha-verify-server">
  <div class="run-subhead">Verify visually</div>
  <p class="ha-verify-lede muted">
    Start the review dev server{#if targetName} for <code class="mono">{targetName}</code>{/if} and open it in a new tab to check the product before recording sign-off.
    {#if startCommand}<br /><span>Command: <code class="mono">{startCommand}</code></span>{/if}
  </p>
  <button class="ctl-btn ha-verify-btn" type="button" disabled={starting || !targetName || !startAvailable} onclick={start}>
    {starting ? "Starting…" : "Start dev server to verify"}
  </button>
  {#if !targetName}
    <p class="empty ha-verify-hint">No resolvable target for this action — verify against the running product directly.</p>
  {:else if !startAvailable}
    <p class="empty ha-verify-hint">{unavailableReason ?? "This target does not expose a runnable review command."}</p>
  {/if}

  {#if error}<p class="error ha-error ha-verify-err" role="alert">{error}</p>{/if}

  {#if result}
    {#if result.status === "failed"}
      <p class="ha-verify-fail" role="status">
        <span class="ha-verify-glyph" aria-hidden="true">✕</span>
        <span><span class="mono">{result.targetName}</span> failed to start — no start script. You can still record sign-off manually.{#if result.stderrHref} <a class="ha-link" href={result.stderrHref} target="_blank" rel="noopener">View stderr →</a>{/if}</span>
      </p>
    {:else if result.url}
      <p class="ha-verify-ok" role="status">
        <span class="ha-verify-glyph" aria-hidden="true">✓</span>
        <span>Open <a class="ha-link mono" href={result.url} target="_blank" rel="noopener">{result.url}</a> to verify, then record the result below.</span>
      </p>
    {/if}
  {/if}
</div>
