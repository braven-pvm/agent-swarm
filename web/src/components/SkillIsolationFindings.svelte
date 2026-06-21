<script lang="ts">
  import { cleanLeakText, leakSkillName, type SkillIsolationFinding } from "~/lib/skills";

  // A warning section listing global-user-skill references read outside the harness-managed packet.
  // Renders nothing when there are no findings (neutral). `heading` lets callers title it for the
  // agent-detail vs run-focus context. Paths/snippets are ANSI-cleaned before display.
  let {
    findings,
    heading = "Skill isolation",
  }: { findings: SkillIsolationFinding[]; heading?: string } = $props();
</script>

{#if findings.length > 0}
  <section class="skill-leak" role="note" aria-label="Skill isolation warning">
    <div class="run-subhead skill-leak-head">
      <span class="skill-leak-glyph" aria-hidden="true">⚠</span>
      {heading} ({findings.length})
    </div>
    <p class="skill-leak-note">
      Read a user-global skill outside the harness packet — a reproducibility warning, not a blocker.
      The bound skill packet above is the source of truth for this run.
    </p>
    <ul class="skill-leak-list">
      {#each findings as f, i (cleanLeakText(f.path) + ":" + (f.lineNumber ?? i))}
        {@const path = cleanLeakText(f.path)}
        {@const name = leakSkillName(f.path)}
        {@const snippet = cleanLeakText(f.snippet)}
        <li class="skill-leak-item">
          <div class="skill-leak-row" title={path || undefined}>
            <code class="skill-leak-name">{name || "(unknown skill)"}</code>
            {#if f.lineNumber != null}<span class="skill-leak-line">line {f.lineNumber}</span>{/if}
          </div>
          {#if path && path !== name}<div class="skill-leak-path muted" title={path}>{path}</div>{/if}
          {#if snippet}<div class="skill-leak-snippet muted" title={snippet}>{snippet.length > 240 ? snippet.slice(0, 239) + "…" : snippet}</div>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
