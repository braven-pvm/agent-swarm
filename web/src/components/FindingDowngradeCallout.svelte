<script lang="ts">
  import { verdictTone, type FindingDowngrade } from "~/lib/skeptic";

  // A WARNING-class callout for review.finding_downgraded: an independent skeptic OVERRODE a
  // blocking quality concern so the slice was accepted. This bypassed a blocking gate and does NOT
  // show on the reviewer's qualityGate, so it must be impossible to miss wherever acceptance shows.
  // Amber + glyph + explicit text (never colour-alone). Answers WHO (skepticActor), WHAT
  // (concern/dimension + fromSeverity), WHY (reasoning). Renders nothing when empty (neutral).
  let { downgrades }: { downgrades: FindingDowngrade[] } = $props();
</script>

{#if downgrades.length > 0}
  <section class="downgrade-callout" role="note" aria-label="Quality gate override warning">
    <div class="run-subhead downgrade-head">
      <span class="downgrade-glyph" aria-hidden="true">⚠</span>
      Quality gate overrides ({downgrades.length})
    </div>
    <p class="downgrade-note">
      An independent skeptic overrode a blocking quality concern — this accept bypassed a blocking gate.
    </p>
    <ul class="downgrade-list">
      {#each downgrades as d, i (d.label + ":" + i)}
        {@const tone = verdictTone(d.skepticVerdict)}
        <li class="downgrade-item">
          <div class="downgrade-row">
            <span class="downgrade-what" title={d.label}>{d.label}</span>
            {#if d.fromSeverity}
              <span class="downgrade-from">was {d.fromSeverity}</span>
            {/if}
            <span class="sk-verdict {tone.cls}" title="Skeptic verdict: {tone.label}">
              <span class="sk-verdict-glyph" aria-hidden="true">{tone.glyph}</span>{tone.label}
            </span>
          </div>
          <div class="downgrade-who muted">
            accepted by skeptic <code class="downgrade-actor">{d.skepticActor ?? "(unknown)"}</code>
          </div>
          {#if d.reasoning}
            <div class="downgrade-why" title={d.reasoning}>{d.reasoning}</div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
