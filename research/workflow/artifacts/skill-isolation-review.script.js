export const meta = {
  name: 'skill-isolation-ui-review',
  description: 'Adversarial review of the skill-isolation/global-skill-leak UI surface before commit',
  phases: [
    { title: 'Review', detail: '3 independent lenses: correctness, contract, design' },
    { title: 'Verify', detail: 'adversarially verify each finding to filter false positives' },
  ],
};

const CONTEXT = [
  'TASK UNDER REVIEW: a new "skill-isolation / global-skill-leak warning" surface in the Command Bridge web UI',
  '(Svelte 5.55 runes SPA under x:/repositories/agent-swarm/web/src). The harness flags when an agent read a',
  'user-global Codex skill (e.g. ~/.codex/skills/...) OUTSIDE the harness-managed skill packet. This is a WARNING',
  '(reproducibility risk), never a hard blocker. The UI must surface it.',
  '',
  'AUTHORITATIVE CONTRACT: docs/architecture/skill-observability-ui-contract.md (READ IT).',
  'Key recommended-UI requirements from that doc:',
  ' - If skillIsolationFindings is non-empty, show a warning badge and link to run focus.',
  ' - Add a "Skills" section to run focus; show isolation findings there.',
  ' - If diagnosis.failureClasses includes "global_skill_leak", show it as a run-level WARNING and link the',
  '   operator to the event stream/focus packet; it is NOT automatically a slice blocker.',
  ' - Make missing skill data NEUTRAL, not an error (historical / pre-Phase-10D runs carry none).',
  '',
  'DATA SHAPE (from web/src/lib/types.ts + live /api/snapshot and /api/focus/run):',
  ' - AgentRunRecord.skillIsolationFindings?: SkillIsolationFinding[] (top-level on each agent run).',
  ' - SkillIsolationFinding = { kind:"global_user_skill_reference"; severity:"warning"; path:string; snippet:string; lineNumber?:number }.',
  ' - Run-focus packet: eventStream.globalSkillReferences: SkillIsolationFinding[]; diagnosis.failureClasses may include "global_skill_leak".',
  ' - CRITICAL: the live path/snippet are scraped from raw PowerShell output and CONTAIN ANSI/VT escape codes',
  '   (ESC[31;1m etc.) and the path can be truncated mid-word. The UI MUST strip ANSI before display.',
  ' - LIVE: 141 agent runs, 140 with a skill binding, exactly 1 run (RUN-c28d3b2f, actor h2-live-overseer,',
  '   role overseer, status completed) carries 2 findings; its focus packet failureClasses=["global_skill_leak","active_blocker"].',
  '',
  'FILES CHANGED (all under web/src/ — READ each before judging):',
  ' 1. lib/skills.ts — added interface SkillIsolationFinding; cleanLeakText (strips ANSI via new RegExp from',
  '    escaped strings + control chars + collapses whitespace); leakSkillName (last path segment); normalizeFindings',
  '    (tolerant array normalizer, defaults severity "warning", drops junk); isolationFindingsOf(run) (reads',
  '    run.skillIsolationFindings safely); dedupeFindings (by cleaned path + lineNumber).',
  ' 2. components/SkillIsolationFindings.svelte — NEW shared component. Props {findings, heading="Skill isolation"}.',
  '    Renders nothing when findings empty. Shows eyebrow head with count, an explanatory note, and a list:',
  '    per finding a mono skill-name (leakSkillName), optional "line N", full cleaned path (muted, when != name),',
  '    and a cleaned+truncated(160) snippet (muted).',
  ' 3. lib/console.svelte.ts — AgentRosterRow gains skillLeakCount?: number. In the agents $derived.by, inside the',
  '    actorRuns block: leaks = dedupeFindings(actorRuns.flatMap(r => isolationFindingsOf(r))); if leaks.length>0',
  '    row.skillLeakCount = leaks.length. Import updated to {skillsOf, isolationFindingsOf, dedupeFindings}.',
  ' 4. components/AgentRoster.svelte — amber ".agent-leak" badge (glyph + count) rendered after the ".agent-skills"',
  '    chip when row.skillLeakCount>0, with a descriptive title.',
  ' 5. components/InspectorDrawer.svelte — agentLeakFindings derived = dedupeFindings across agentRuns (agent branch).',
  '    Agent-detail renders <SkillIsolationFindings findings={agentLeakFindings}/> after the Skills section. focusRun',
  '    branch: {@const leakFindings = normalizeFindings(pick(eventStream,"globalSkillReferences"))} then renders',
  '    <SkillIsolationFindings/> after the run-focus Skills section. The "global_skill_leak" failure-class chip is',
  '    tinted amber (reason-amber) instead of red (reason-red).',
  ' 6. app.css — .agent-leak/.agent-leak-glyph + .skill-leak/.skill-leak-head/.skill-leak-glyph/.skill-leak-note/',
  '    .skill-leak-list/.skill-leak-item/.skill-leak-row/.skill-leak-sev/.skill-leak-name/.skill-leak-line/',
  '    .skill-leak-path/.skill-leak-snippet. Amber tokens (--amber #d6a13c).',
  ' 7. lib/skills.test.ts — unit tests for the new helpers + the component (28 tests pass; full web suite 281 pass).',
  '',
  'ALREADY VERIFIED (do NOT re-flag as unknowns): production build compiles clean (148 modules); full vitest suite',
  '281/281 pass; amber #d6a13c contrast = 7.28:1 on panel #191d22, 6.63:1 on surface-2 #20252b, 5.73:1 on the',
  'amber-tinted chip — all PASS AA 4.5:1. Design tokens live in web/src/app.css (--amber, --muted, --ink, --bg,',
  '--panel, --surface-2, spacing --s1..--s4, --fs-eyebrow/--fs-meta). The project design system + practical-ui',
  'principles apply: status colour ALWAYS paired with a glyph (never colour-alone); 8pt spacing; eyebrow/tier',
  'hierarchy; mono for ids/paths; sentence case; missing data neutral.',
  '',
  'CONSTRAINTS: only web/src files may change. Svelte 5 runes ($state/$derived/$props, {#snippet}/{@render},',
  '{@const} must be a direct child of a block). Tests run with: npx -w web vitest run --pool=forks.',
].join('\n');

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'summary', 'findings'],
  properties: {
    lens: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph overall assessment for this lens' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'file', 'detail', 'suggestedFix'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string', description: 'file:line or file path the finding concerns' },
          detail: { type: 'string', description: 'what is wrong and why it matters; cite the code' },
          suggestedFix: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['isReal', 'severity', 'reasoning', 'recommendedFix'],
  properties: {
    isReal: { type: 'boolean', description: 'true ONLY if this is a genuine issue worth fixing; default false if uncertain' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    reasoning: { type: 'string', description: 'cite the actual code you read to confirm or refute' },
    recommendedFix: { type: 'string' },
  },
};

const LENSES = [
  {
    key: 'correctness',
    prompt: CONTEXT + '\n\nYOUR LENS: CORRECTNESS & ROBUSTNESS. Read every changed file. Verify the data wiring and logic '
      + 'are correct against types.ts and the live shape. Specifically scrutinize: (a) isolationFindingsOf reads the '
      + 'EXACT field name skillIsolationFindings; (b) cleanLeakText actually strips the live ANSI codes (ESC[31;1m, ESC[0m) '
      + 'AND control chars — verify the regex character classes are correct and not over/under-matching (e.g. does it '
      + 'wrongly eat normal letters?); (c) the dedupe key (cleaned path + lineNumber) is sound; (d) the roster aggregates '
      + 'findings across ALL actorRuns, not just latest, and undefined-vs-0 yields no badge; (e) focusRun reads '
      + 'eventStream.globalSkillReferences via normalizeFindings and the {@const} is a valid direct child of its block; '
      + '(f) null/undefined safety everywhere (malformed/absent data → neutral, never throws); (g) leakSkillName fallback '
      + 'for separator-less paths; (h) the tests genuinely exercise ANSI stripping and dedupe (not tautological). '
      + 'Report ONLY real defects with file:line. If something is correct, do not invent a finding.',
  },
  {
    key: 'contract',
    prompt: CONTEXT + '\n\nYOUR LENS: CONTRACT FIDELITY. Read docs/architecture/skill-observability-ui-contract.md and the '
      + 'changed files. Verify the implementation satisfies every relevant recommended-UI requirement: warning badge when '
      + 'findings non-empty AND a path to the run focus; an isolation/Skills section in run focus; global_skill_leak shown '
      + 'as a run-level WARNING (amber) and explicitly NOT treated as a slice blocker; missing skill data is NEUTRAL (no '
      + 'error/empty-state noise). Flag any requirement unmet, any place a blocker/error treatment leaked in, and any '
      + 'mismatch between the contract field names and what the UI reads. Also assess whether the roster badge adequately '
      + '"links to run focus" (the operator can open the agent/run to see findings) or whether that path is missing.',
  },
  {
    key: 'design',
    prompt: CONTEXT + '\n\nYOUR LENS: DESIGN QUALITY & ACCESSIBILITY (practical-ui-principles). Read SkillIsolationFindings.svelte, '
      + 'AgentRoster.svelte, the app.css additions, and skim the existing app.css to match the system. Check: status colour '
      + 'ALWAYS paired with a glyph (never colour-alone) on both the badge and the findings; 8pt spacing rhythm; eyebrow/tier '
      + 'hierarchy reads (squint test) — is the warning distinguishable without being alarmist (it is a warning, not an error); '
      + 'mono for paths; sentence-case, concise copy (the note < ~20 words, no jargon); snippet/path overflow handled (ellipsis, '
      + 'no layout break) given the messy live data; the badge sits well among existing roster chips (agent-skills, runtime, age) '
      + 'without crowding; consistency with existing warning patterns (.reason-amber, .agent-focus-pill, .ha-notice-warn). '
      + 'Contrast is already verified — do not re-flag it. Report concrete visual/UX/copy/a11y issues with the class or file.',
  },
];

phase('Review');
const reviewed = await pipeline(
  LENSES,
  (l) => agent(l.prompt, { label: 'review:' + l.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (review, l) => {
    const findings = (review && Array.isArray(review.findings)) ? review.findings : [];
    if (findings.length === 0) return [];
    return parallel(findings.map((f) => () =>
      agent(
        CONTEXT + '\n\nADVERSARIALLY VERIFY ONE FINDING from the ' + l.key + ' review. Read the ACTUAL code in the cited '
          + 'file(s) before judging. Decide if it is a REAL issue worth fixing or a false positive. Be skeptical: default '
          + 'isReal=false if you cannot confirm it from the code. Do NOT inflate severity.\n\nFINDING:\n'
          + JSON.stringify(f, null, 2),
        { label: 'verify:' + l.key, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => ({ lens: l.key, finding: f, verdict: v })).catch(() => null),
    ));
  },
);

const all = reviewed.flat().filter(Boolean);
const confirmed = all.filter((x) => x.verdict && x.verdict.isReal);
const summaries = LENSES.map((l, i) => ({ lens: l.key, summary: reviewed[i] && false ? '' : undefined }));
log('Review complete: ' + all.length + ' findings raised, ' + confirmed.length + ' confirmed real.');

return {
  confirmedCount: confirmed.length,
  totalRaised: all.length,
  confirmed: confirmed.map((x) => ({
    lens: x.lens,
    title: x.finding.title,
    file: x.finding.file,
    severity: x.verdict.severity,
    detail: x.finding.detail,
    reasoning: x.verdict.reasoning,
    recommendedFix: x.verdict.recommendedFix,
  })),
  refuted: all.filter((x) => !(x.verdict && x.verdict.isReal)).map((x) => ({
    lens: x.lens, title: x.finding.title, severity: x.finding.severity,
    why: x.verdict ? x.verdict.reasoning : 'verifier error',
  })),
};