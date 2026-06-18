<script lang="ts">
  // Render a skill binding's REQUIRED then OPTIONAL skills as two separate stacks,
  // each under a small eyebrow with its count. Each skill is a compact row: a glyph
  // + the id (mono) + title (if present) + a source chip (tone) + the short hash.
  // The optional stack is omitted when empty. Pure display — no fetches, no writes.
  import type { SkillBindingSummary, SkillSummary } from "~/lib/skills";
  import { sourceTone, shortHash } from "~/lib/skills";

  let { binding }: { binding: SkillBindingSummary } = $props();
</script>

{#snippet stack(label: string, skills: SkillSummary[])}
  <div class="skill-stack">
    <div class="run-subhead skill-stack-head">{label} ({skills.length})</div>
    {#each skills as s (s.id)}
      {@const tone = sourceTone(s.source)}
      {@const hash = shortHash(s.hash)}
      <div class="skill-row" title={s.description ?? undefined}>
        <span class="skill-glyph" aria-hidden="true">⚙</span>
        <span class="skill-id">{s.id}</span>
        {#if s.title}<span class="skill-title">{s.title}</span>{/if}
        <span class="skill-src {tone.cls}" title="Source: {s.sourcePath || tone.label}">
          <span class="skill-src-glyph" aria-hidden="true">◆</span>{tone.label}
        </span>
        {#if hash}
          <span class="skill-hash" title="{s.hash}{s.sourcePath ? ` · ${s.sourcePath}` : ''}">{hash}</span>
        {/if}
      </div>
      {#if s.description}<div class="skill-desc muted">{s.description}</div>{/if}
    {/each}
  </div>
{/snippet}

<div class="skill-stacks">
  {@render stack("Required", binding.required)}
  {#if binding.optional.length > 0}
    {@render stack("Optional", binding.optional)}
  {/if}
</div>
