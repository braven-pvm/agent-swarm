<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { HumanActionCommand, HumanActionItem, HumanActionKind } from "~/lib/human-actions";
  import { runActionCommand } from "~/lib/human-actions";
  import DevServerVerify from "~/components/DevServerVerify.svelte";

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

  function truncate(s: string, n: number): string {
    const clean = s.replace(/\s+/g, " ").trim();
    return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
  }

  // ── "Why this needs you" context, joined from the snapshot already in the store (NO new fetch). ──
  // The slice this action concerns (when resolvable). Its reviewResult is the verdict + what-is-needed.
  const slice = $derived(
    action.sliceId ? store.snapshot?.slices.find((s) => s.id === action.sliceId) : undefined,
  );
  const review = $derived(slice?.reviewResult);
  const reviewTarget = $derived(action.reviewTarget);
  const reviewExpectedOutcomes = $derived(reviewTarget?.expectedOutcomes ?? []);
  const reviewInstructions = $derived(reviewTarget?.instructions ?? []);

  // The registered target this action's slice belongs to → its NAME, which the dev-server start
  // endpoint accepts. Resolved from the snapshot (slice.targetId → targets[].name). Undefined when
  // there's no slice or no matching target; the verify affordance degrades gracefully then.
  const verifyTargetName = $derived(
    reviewTarget?.targetName ?? (slice ? store.snapshot?.targets.find((t) => t.id === slice.targetId)?.name : undefined),
  );

  // Blocker reasons: the active escalations whose entity is THIS action's entity or its slice. These
  // are the literal "why it is blocked" lines. A 'blocker'/'critical'/'human_required' level reads red;
  // 'warning' amber; anything else neutral. A glyph pairs with the colour (never colour alone).
  const escalations = $derived(
    (store.snapshot?.activeEscalations ?? []).filter(
      (e) => e.entityId === action.entityId || (action.sliceId != null && e.entityId === action.sliceId),
    ),
  );
  function escTone(level: string): { cls: string; glyph: string } {
    if (level === "blocker" || level === "critical" || level === "human_required")
      return { cls: "reason-red", glyph: "✕" };
    if (level === "warning") return { cls: "reason-amber", glyph: "⚠" };
    return { cls: "reason-muted", glyph: "ℹ" };
  }

  // Findings that explain the block: the FR/AC review findings that did NOT pass.
  const openFindings = $derived((review?.frAcFindings ?? []).filter((f) => f.status !== "passed"));

  // Required fixes + recommendation = the headline "what to do".
  const requiredFixes = $derived(review?.requiredFixes ?? []);
  const recommendation = $derived(review?.recommendation?.trim() || undefined);

  // Recommended interventions: the engine's per-slice triage, flat-mapped + deduped across every
  // agentFocusQueue item bound to this action's slice.
  const interventions = $derived.by<string[]>(() => {
    if (!action.sliceId) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of store.snapshot?.agentFocusQueue ?? []) {
      if (f.sliceId !== action.sliceId) continue;
      for (const r of f.recommendedInterventions ?? []) {
        if (seen.has(r)) continue;
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  });

  const reviewClass = (s: string) =>
    s === "accepted" ? "verdict-accepted"
    : s === "blocked" || s === "human_required" ? "verdict-blocked"
    : s === "repair_required" ? "verdict-repair_required"
    : "verdict-other";
  const isReworkAction = $derived(action.kind === "human_verification_rework");
  const noDirectActionCopy = $derived(
    isReworkAction
      ? "Repair has been requested from agents. This legacy action should normally move out of the human queue; continue the run so the overseer can dispatch repair/review work."
      : "No direct action is available here. Inspect the linked context or continue the run to let the harness advance this state.",
  );

  function findingClass(status: string): string {
    if (status === "passed") return "passed";
    if (status === "uncertain" || status === "missing_evidence") return "missing_evidence";
    return "failed";
  }

  // Show the whole context region only when at least one sub-section has data. An action with no
  // resolvable slice/escalation still renders title + summary + the resolve form below.
  const hasContext = $derived(
    escalations.length > 0 ||
      review != null ||
      requiredFixes.length > 0 ||
      recommendation != null ||
      openFindings.length > 0 ||
      interventions.length > 0 ||
      reviewTarget != null ||
      reviewExpectedOutcomes.length > 0 ||
      reviewInstructions.length > 0,
  );

  // ── Form state (per the action currently open). Reset whenever the action id changes. ──
  let reason = $state("");
  let notes = $state("");
  let verifyStatus = $state<"human_verified" | "failed" | "needs_rework">("human_verified");
  let submitting = $state(false);
  let error = $state<string | undefined>(undefined);
  let notice = $state<string | undefined>(undefined);
  let lastId = $state<string | undefined>(undefined);
  const verifySubmitLabel = $derived(
    verifyStatus === "needs_rework" ? "Record rework"
    : verifyStatus === "failed" ? "Record failure"
    : "Record verification",
  );
  $effect(() => {
    if (action.id === lastId) return;
    lastId = action.id;
    reason = "";
    notes = "";
    verifyStatus = action.kind === "human_verification_rework" ? "needs_rework" : "human_verified";
    submitting = false;
    error = undefined;
    notice = undefined;
  });

  // The required reason/notes field IS the only friction. Disable submit while empty or in flight.
  const clearDisabled = $derived(submitting || reason.trim().length === 0);
  const verifyDisabled = $derived(submitting || notes.trim().length === 0);

  async function submit(cmd: HumanActionCommand, overrides: Record<string, unknown>) {
    if (submitting) return; // no double-submit
    submitting = true;
    error = undefined;
    notice = undefined;
    const res = await runActionCommand(cmd, overrides);
    if (res.ok) {
      // Replace the queue with the server's refreshed view, refresh snapshot/coverage, and drop the
      // selection if THIS action is no longer in the queue (it was resolved away).
      store.setHumanActions(res.humanActions);
      onResolved();
      // Per the human-verify contract, human_verified / failed / needs_rework REMOVE this ref from
      // the queue. So the normal path is "the item left" → close the drawer; with no inline surface
      // left, confirm via a toast. failed/needs_rework explicitly hands the defect back to autonomous
      // repair; a verified pass that left just acknowledges the sign-off.
      const stillThere = res.humanActions.actions.some((a) => a.id === action.id);
      if (cmd.kind === "record_human_verification") {
        const status = typeof overrides.status === "string" ? overrides.status : "";
        if (!stillThere) {
          store.notify(
            status === "failed" || status === "needs_rework"
              ? "Handed back to agent repair."
              : "Verification saved.",
            { title: "Recorded", tone: "ok" },
          );
        } else {
          // Rare/legacy: the item stayed — another required result is still unresolved, or an old
          // server kept the failed ref as human_verification_rework. Explain inline since the drawer
          // is still open.
          notice =
            status === "human_verified"
              ? "Verification recorded. This item is still open because another required result remains unresolved."
              : status === "needs_rework"
                ? "Rework recorded. The item should leave the human queue while agents repair it."
                : "Failure recorded. The item should leave the human queue while agents repair or block the affected scope.";
        }
      }
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

  <!-- "Why this needs you" — the joined context. Each sub-section renders only when it has data;
       the whole region is skipped when there's nothing to show. WHY = blockers + findings;
       WHAT = required fixes + recommendation + interventions. -->
  {#if hasContext}
    <div class="ha-context">
      <div class="run-subhead ha-context-head">Why this needs you</div>

      {#if escalations.length > 0}
        <div class="run-subhead">Blockers</div>
        <ul class="ha-esc-list">
          {#each escalations as e (e.id)}
            {@const tone = escTone(e.level)}
            <li class="ha-esc-item {tone.cls}">
              <span class="ha-esc-glyph" aria-hidden="true">{tone.glyph}</span>
              <div class="ha-esc-text">
                <span class="ha-esc-msg">{e.message}</span>
                {#if e.reason}<span class="ha-esc-reason muted">{e.reason}</span>{/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if requiredFixes.length > 0 || recommendation}
        <div class="run-subhead">What is needed</div>
        {#if requiredFixes.length > 0}
          <ul class="run-fixes">{#each requiredFixes as fix}<li>{fix}</li>{/each}</ul>
        {/if}
        {#if recommendation}<p class="ha-recommendation">{recommendation}</p>{/if}
      {/if}

      {#if reviewTarget}
        <div class="run-subhead">Verification target</div>
        <div class="kv-list">
          {#if reviewTarget.targetName}<div class="kv"><b>target</b><code>{reviewTarget.targetName}</code></div>{/if}
          {#if reviewTarget.targetPathRelative}<div class="kv"><b>path</b><code>{reviewTarget.targetPathRelative}</code></div>{/if}
          {#if reviewTarget.startCommand}<div class="kv"><b>command</b><code>{reviewTarget.startCommand}</code></div>{/if}
          {#if reviewTarget.commandSource}<div class="kv"><b>source</b>{reviewTarget.commandSource}</div>{/if}
          {#if reviewTarget.responsibleParty}<div class="kv"><b>owner</b>{reviewTarget.responsibleParty}</div>{/if}
        </div>

        {#if reviewTarget.requirementText}
          <div class="run-subhead">Requirement text</div>
          <p class="ha-recommendation">{reviewTarget.requirementText}</p>
        {/if}

        {#if reviewTarget.requirementContext}
          <div class="run-subhead">Source context</div>
          <p class="ha-recommendation">{truncate(reviewTarget.requirementContext, 420)}</p>
        {/if}
      {/if}

      {#if reviewExpectedOutcomes.length > 0}
        <div class="run-subhead">Verification checklist</div>
        <ul class="ha-interventions">{#each reviewExpectedOutcomes as outcome}<li>{outcome}</li>{/each}</ul>
      {/if}

      {#if reviewInstructions.length > 0}
        <div class="run-subhead">Review instructions</div>
        <ul class="ha-interventions">{#each reviewInstructions as instruction}<li>{instruction}</li>{/each}</ul>
      {/if}

      {#if review}
        <div class="run-subhead">Review verdict</div>
        <div class="ha-verdict-row">
          <span class="verdict {reviewClass(review.status)}">{review.status}</span>
          {#if review.summary}<span class="ha-verdict-summary">{review.summary}</span>{/if}
        </div>
      {/if}

      {#if openFindings.length > 0}
        <div class="run-subhead">Findings</div>
        <ul class="ha-findings">
          {#each openFindings as f (f.ref)}
            <li class="ha-finding" title={f.finding}>
              <span class="ref ref-{findingClass(f.status)}">{f.ref}</span>
              {#if f.finding}<span class="ha-finding-text">{truncate(f.finding, 110)}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if interventions.length > 0}
        <div class="run-subhead">Recommended interventions</div>
        <ul class="ha-interventions">{#each interventions as r}<li>{r}</li>{/each}</ul>
      {/if}
    </div>
  {/if}

  {#if action.allowedActions.length === 0}
    <p class="empty ha-noresolve">{noDirectActionCopy}</p>
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
      <!-- Visual-verification affordance: start the review dev server + open its URL before sign-off.
           Self-contained (own in-flight + error state); a failed start does NOT block the form below. -->
      {#if reviewTarget || verifyTargetName}
        <DevServerVerify
          targetName={verifyTargetName}
          commandName={reviewTarget?.commandName}
          startAvailable={reviewTarget?.startAvailable ?? true}
          unavailableReason={reviewTarget?.startUnavailableReason}
          startCommand={reviewTarget?.startCommand}
        />
      {/if}
      {#if isReworkAction}
        <p class="ha-notice ha-notice-warn" role="note">
          This item already has a failed human verification. Recording another result updates the defect note; current servers should move it out of the human queue and hand it back to agent repair.
        </p>
      {/if}
      <form class="ha-form" onsubmit={(e) => { e.preventDefault(); submit(cmd, { status: verifyStatus, notes }); }}>
        <div class="run-subhead">Record verification</div>
        <fieldset class="ha-field ha-radios">
          <legend class="ha-label">Result</legend>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="human_verified" bind:group={verifyStatus} disabled={submitting} onchange={() => { notice = undefined; }} />
            Verified
          </label>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="failed" bind:group={verifyStatus} disabled={submitting} onchange={() => { notice = undefined; }} />
            Failed
          </label>
          <label class="ha-radio">
            <input type="radio" name="ha-status" value="needs_rework" bind:group={verifyStatus} disabled={submitting} onchange={() => { notice = undefined; }} />
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
            oninput={() => { notice = undefined; }}
          ></textarea>
        </div>
        {#if error}<p class="error ha-error" role="alert">{error}</p>{/if}
        {#if notice}<p class="ha-notice ha-notice-ok" role="status">{notice}</p>{/if}
        <button class="ha-primary" type="submit" disabled={verifyDisabled}>
          {submitting ? "Recording…" : verifySubmitLabel}
        </button>
      </form>
    {/if}
  {/each}
</div>
