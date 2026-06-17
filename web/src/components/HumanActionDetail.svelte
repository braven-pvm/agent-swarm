<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { HumanActionCommand, HumanActionItem, HumanActionKind } from "~/lib/human-actions";
  import { runActionCommand } from "~/lib/human-actions";

  let {
    store,
    action,
    onResolved,
  }: { store: ConsoleStore; action: HumanActionItem; onResolved: () => void } = $props();

  const KIND_LABEL: Record<HumanActionKind, string> = {
    decision_required: "Decision required",
    clear_blocker: "Clear blocker",
    blocked_requirement: "Blocked requirement",
    human_verification: "Human verification",
    human_verification_rework: "Verification rework",
  };
  const kindLabel = (a: HumanActionItem) => KIND_LABEL[a.kind] ?? a.kind;
  const sevClass = (s: HumanActionItem["severity"]) =>
    s === "danger" ? "verdict-blocked" : s === "warning" ? "verdict-repair_required" : "verdict-other";

  // ── Form state (per the action currently open). Reset whenever the action id changes. ──
  let reason = $state("");
  let notes = $state("");
  let verifyStatus = $state<"human_verified" | "failed" | "needs_rework">("human_verified");
  let submitting = $state(false);
  let error = $state<string | undefined>(undefined);
  let lastId = $state<string | undefined>(undefined);
  $effect(() => {
    if (action.id === lastId) return;
    lastId = action.id;
    reason = "";
    notes = "";
    verifyStatus = "human_verified";
    submitting = false;
    error = undefined;
  });

  // The required reason/notes field IS the only friction. Disable submit while empty or in flight.
  const clearDisabled = $derived(submitting || reason.trim().length === 0);
  const verifyDisabled = $derived(submitting || notes.trim().length === 0);

  async function submit(cmd: HumanActionCommand, overrides: Record<string, unknown>) {
    if (submitting) return; // no double-submit
    submitting = true;
    error = undefined;
    const res = await runActionCommand(cmd, overrides);
    if (res.ok) {
      // Replace the queue with the server's refreshed view, refresh snapshot/coverage, and drop the
      // selection if THIS action is no longer in the queue (it was resolved away).
      store.setHumanActions(res.humanActions);
      onResolved();
      const stillThere = res.humanActions.actions.some((a) => a.id === action.id);
      if (!stillThere) store.selectAction(null);
      submitting = false;
    } else {
      error = res.error ?? "Something went wrong.";
      submitting = false;
    }
  }
</script>

<div class="ha-detail">
  <div class="ha-detail-head">
    <span class="verdict {sevClass(action.severity)}">{action.severity}</span>
    <span class="ha-detail-kind">{kindLabel(action)}</span>
  </div>
  <h4 class="ha-detail-title">{action.title}</h4>
  {#if action.summary}<p class="ha-detail-summary">{action.summary}</p>{/if}

  <div class="kv-list">
    <div class="kv"><b>status</b>{action.status}</div>
    {#if action.ref}<div class="kv"><b>ref</b><code>{action.ref}</code></div>{/if}
    {#if action.sliceId}<div class="kv"><b>slice</b><code>{action.sliceId}</code></div>{/if}
    {#if action.domain}<div class="kv"><b>domain</b>{action.domain}</div>{/if}
  </div>

  {#if action.source}
    <div class="run-subhead">Source</div>
    <a class="ha-link" href={action.source.uri}>{action.source.title || action.source.id}</a>
  {/if}

  {#if action.links.length > 0}
    <div class="run-subhead">Links</div>
    <div class="ha-links">
      {#each action.links as l (l.href)}<a class="ha-link" href={l.href}>{l.label}</a>{/each}
    </div>
  {/if}

  {#if action.allowedActions.length === 0}
    <p class="empty ha-noresolve">No direct action — inspect the linked context to resolve this.</p>
  {/if}

  {#each action.allowedActions as cmd (cmd.kind + cmd.path)}
    {#if cmd.kind === "clear_escalation"}
      <form class="ha-form" onsubmit={(e) => { e.preventDefault(); submit(cmd, { reason }); }}>
        <div class="run-subhead">Resolve</div>
        <div class="ha-field">
          <label class="ha-label" for="ha-reason">Reason <span class="ha-req">*</span></label>
          <textarea
            id="ha-reason"
            class="ha-textarea"
            rows="3"
            placeholder="Why is this cleared?"
            bind:value={reason}
            disabled={submitting}
          ></textarea>
        </div>
        {#if error}<p class="error ha-error" role="alert">{error}</p>{/if}
        <button class="ha-primary" type="submit" disabled={clearDisabled}>
          {submitting ? "Clearing…" : "Clear blocker"}
        </button>
      </form>
    {:else if cmd.kind === "record_human_verification"}
      <form class="ha-form" onsubmit={(e) => { e.preventDefault(); submit(cmd, { status: verifyStatus, notes }); }}>
        <div class="run-subhead">Record verification</div>
        <fieldset class="ha-field ha-radios">
          <legend class="ha-label">Result</legend>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="human_verified" bind:group={verifyStatus} disabled={submitting} />
            Verified
          </label>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="failed" bind:group={verifyStatus} disabled={submitting} />
            Failed
          </label>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="needs_rework" bind:group={verifyStatus} disabled={submitting} />
            Needs rework
          </label>
        </fieldset>
        <div class="ha-field">
          <label class="ha-label" for="ha-notes">Notes <span class="ha-req">*</span></label>
          <textarea
            id="ha-notes"
            class="ha-textarea"
            rows="3"
            placeholder="What did you check?"
            bind:value={notes}
            disabled={submitting}
          ></textarea>
        </div>
        {#if error}<p class="error ha-error" role="alert">{error}</p>{/if}
        <button class="ha-primary" type="submit" disabled={verifyDisabled}>
          {submitting ? "Recording…" : "Record verification"}
        </button>
      </form>
    {/if}
  {/each}
</div>
