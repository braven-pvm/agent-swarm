<script lang="ts">
  import type { ConsoleStore } from "~/lib/console.svelte";
  import type { SliceStatus, FrAcVerificationResult } from "~/lib/types";
  import { formatDuration } from "~/lib/format";
  let { store, onSelect }: { store: ConsoleStore; onSelect: (sliceId: string) => void } = $props();
  const COLUMNS: { key: SliceStatus[]; label: string }[] = [
    { key: ["candidate", "ready", "claimed"], label: "Queued" },
    { key: ["implementing", "implemented", "repairing"], label: "Implementing" },
    { key: ["verifying", "ready_for_review"], label: "Review" },
    { key: ["accepted", "closed"], label: "Accepted" },
    { key: ["blocked"], label: "Blocked" },
  ];
  const slices = $derived(store.snapshot?.slices ?? []);
  function inColumn(statuses: SliceStatus[]) { return slices.filter((s) => statuses.includes(s.status)); }
  function agentActors(slice: (typeof slices)[number]): string[] { return [...new Set(slice.agentRuns.map((r) => r.actor.split("-")[0]))]; }
  function sliceDur(slice: (typeof slices)[number]): string {
    const terminal = ["accepted", "closed"].includes(slice.status);
    return formatDuration((terminal ? Date.parse(slice.updatedAt) : Date.now()) - Date.parse(slice.createdAt));
  }
  // Drop a leading "Implement " verb so the title reads as the deliverable, not the task.
  function displayTitle(title: string): string {
    return title.replace(/^Implement\s+/i, "");
  }
  // Short, monospace slice id — strip a redundant leading "SLICE-" so we render it once.
  function shortSliceId(id: string): string {
    return id.replace(/^SLICE-/i, "");
  }
  // Map an FR/AC verification status to a calm dot colour class.
  function dotClass(status: FrAcVerificationResult["status"]): string {
    if (status === "passed" || status === "overridden") return "dot-pass";
    if (status === "failed") return "dot-fail";
    return "dot-warn"; // missing_evidence + anything unexpected
  }
  const MAX_DOTS = 8;
  function coverage(results: FrAcVerificationResult[]) {
    const total = results.length;
    const passed = results.filter((r) => r.status === "passed" || r.status === "overridden").length;
    const anyFail = results.some((r) => r.status === "failed");
    return { total, passed, anyFail, dots: results.slice(0, MAX_DOTS), overflow: Math.max(0, total - MAX_DOTS) };
  }
  // The most descriptive single domain/target label we can show as quiet metadata.
  function metaTarget(slice: (typeof slices)[number]): string | undefined {
    const t = store.snapshot?.targets.find((x) => x.id === slice.targetId);
    return t?.name ?? agentActors(slice)[0];
  }
</script>

<section class="board">
  {#each COLUMNS as col (col.label)}
    <div class="board-col">
      <h3 class="col-title">{col.label} <span class="count">{inColumn(col.key).length}</span></h3>
      {#each inColumn(col.key) as slice (slice.id)}
        {@const cov = coverage(slice.frAcResults)}
        {@const target = metaTarget(slice)}
        <button class="slice-card" onclick={() => onSelect(slice.id)}>
          <div class="slice-title">{displayTitle(slice.title)}</div>
          <div class="slice-id">SLICE-{shortSliceId(slice.id)}</div>
          {#if cov.total > 0}
            <div class="cov-summary" class:cov-ok={!cov.anyFail && cov.passed === cov.total} class:cov-bad={cov.anyFail}>
              <span class="cov-count">{cov.passed}/{cov.total}</span>
              <span class="cov-label">AC</span>
              <span class="cov-dots">
                {#each cov.dots as r (r.ref)}<span class="cov-dot {dotClass(r.status)}" title="{r.ref}: {r.status}"></span>{/each}
                {#if cov.overflow > 0}<span class="cov-more">+{cov.overflow}</span>{/if}
              </span>
            </div>
          {/if}
          <div class="slice-foot">
            {slice.evidence.length} evidence{#if target} · {target}{/if} · <span class="slice-dur" title={["accepted","closed"].includes(slice.status) ? "total time" : "open for"}>{sliceDur(slice)}</span>
          </div>
        </button>
      {/each}
    </div>
  {/each}
</section>
