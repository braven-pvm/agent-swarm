<script lang="ts">
  import type { CoverageRef } from "~/lib/types";

  // The read-only obligation summary carried by a CoverageRef — "what must be proven"
  // to accept this AC/FR. Self-contained so it can be reused inline in the Spec Build
  // Map ledger and in the Coverage requirements table.
  let { obligation }: { obligation: NonNullable<CoverageRef["obligation"]> } = $props();

  // Mode → subtle chip tone + glyph + sentence-case label. Color is never the sole
  // signal (each carries a glyph + text). human_verification_required leans faint
  // amber because it needs a person; the rest stay neutral/blue.
  interface ModeChip { cls: string; glyph: string; label: string; }
  const MODE_CHIPS: Record<string, ModeChip> = {
    automated: { cls: "obl-mode-auto", glyph: "⚙", label: "Automated" },
    reviewer: { cls: "obl-mode-reviewer", glyph: "◑", label: "Reviewer" },
    human_verification_required: { cls: "obl-mode-human", glyph: "☑", label: "Human verification" },
    hybrid: { cls: "obl-mode-hybrid", glyph: "⊕", label: "Hybrid" },
  };
  const modeChip = $derived(obligation.mode ? MODE_CHIPS[obligation.mode] : undefined);
</script>

{#if obligation.status === "missing"}
  <div class="obl obl-missing">
    <span class="obl-missing-glyph">⚠</span><span>Obligation missing</span>
  </div>
{:else}
  <div class="obl">
    <div class="obl-head">
      {#if modeChip}
        <span class="obl-mode {modeChip.cls}" title="Verification mode: {modeChip.label.toLowerCase()}">
          <span class="obl-mode-glyph">{modeChip.glyph}</span>{modeChip.label}
        </span>
      {/if}
      {#if obligation.responsibleParty}
        <span class="obl-party muted">{obligation.responsibleParty}</span>
      {/if}
    </div>
    <div class="obl-criteria-head">Must prove ({obligation.criteriaCount})</div>
    {#if obligation.expectedOutcomes.length}
      <ul class="obl-outcomes">
        {#each obligation.expectedOutcomes as outcome}
          <li>{outcome}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
