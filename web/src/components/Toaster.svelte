<script lang="ts">
  import { onDestroy } from "svelte";
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { ActionToast } from "~/lib/console.svelte";
  import type { HumanActionItem, HumanActionKind, HumanActionSeverity } from "~/lib/human-actions";

  let { store }: { store: ConsoleStore } = $props();

  // How long a toast lingers before it auto-dismisses, and how many we show at once. New toasts
  // arrive at the FRONT of store.toasts (newest-first), so capping the tail keeps the most recent
  // ones on screen without an unbounded stack.
  const AUTODISMISS_MS = 9000;
  const MAX_VISIBLE = 4;

  // Severity glyph + tone pair the colour with a shape AND the title text — colour is never the
  // sole carrier (squint / colour-blind safe), matching the rail/detail vocabulary.
  const SEV_GLYPH: Record<HumanActionSeverity, string> = { danger: "✕", warning: "⚠", info: "ℹ" };
  const KIND_LABEL: Record<HumanActionKind, string> = {
    decision_required: "Decision required",
    clear_blocker: "Clear blocker",
    blocked_requirement: "Blocked requirement",
    human_verification: "Human verification",
    human_verification_rework: "Verification rework",
  };
  const sevGlyph = (a: HumanActionItem) => SEV_GLYPH[a.severity] ?? "•";
  const kindLabel = (a: HumanActionItem) => KIND_LABEL[a.kind] ?? a.kind;

  const visible = $derived(store.toasts.slice(0, MAX_VISIBLE));

  // ── Auto-dismiss timers ────────────────────────────────────────────────
  // One timer per toast id. Set when a toast first appears; cleared on manual dismiss / when the
  // toast leaves the list / on unmount. We never set state after unmount: the timer callback only
  // calls store.dismissToast (a no-op if already gone) and the whole map is cleared in onDestroy.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(id: string) {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function dismiss(id: string) {
    clearTimer(id);
    store.dismissToast(id);
  }

  function open(id: string) {
    // Opening the action in the inspector also removes the toast (it has served its purpose).
    store.selectAction(id);
    dismiss(id);
  }

  // Reconcile timers with the live toast list whenever it changes: arm a timer for every toast that
  // doesn't have one yet, and drop timers for toasts that have left the list (resolved / dismissed
  // elsewhere) so nothing leaks.
  $effect(() => {
    const ids = new Set(store.toasts.map((t) => t.id));
    for (const t of store.toasts) {
      if (timers.has(t.id)) continue;
      const id = t.id;
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        store.dismissToast(id);
      }, AUTODISMISS_MS));
    }
    for (const id of [...timers.keys()]) {
      if (!ids.has(id)) clearTimer(id);
    }
  });

  onDestroy(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
</script>

{#if visible.length > 0}
  <div class="toaster" role="region" aria-label="New actions">
    {#each visible as t (t.id)}
      {@const a = t.action}
      <div class="toast toast-{a.severity}" role="alert">
        <button class="toast-open" onclick={() => open(t.id)}>
          <span class="toast-glyph" aria-hidden="true">{sevGlyph(a)}</span>
          <span class="toast-body">
            <span class="toast-kind">{kindLabel(a)}</span>
            <span class="toast-title">{a.title}</span>
            {#if a.summary}<span class="toast-summary">{a.summary}</span>{/if}
            <span class="toast-resolve">Resolve →</span>
          </span>
        </button>
        <button
          class="toast-dismiss"
          title="Dismiss"
          aria-label="Dismiss notification"
          onclick={() => dismiss(t.id)}
        >✕</button>
      </div>
    {/each}
  </div>
{/if}
