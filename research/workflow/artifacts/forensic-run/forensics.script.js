export const meta = {
  name: 'agent-swarm-vs-workflow-forensics',
  description: 'Source-grounded forensic comparison of agent-swarm internals vs the Workflow tool, with mission-aligned recommendations',
  phases: [
    { title: 'Forensics', detail: '6 lenses read the real src/ and compare to Workflow mechanisms' },
    { title: 'Verify', detail: 'skeptic re-reads source to confirm each recommendation (default-reject)' },
  ],
};

const MISSION = [
  'AGENT-SWARM MISSION (docs/architecture/core-philosophy.md, docs/onboarding/new-agent-start-here.md):',
  '"Agent Swarm converts immutable requirements into verified implementation state." It coordinates',
  'autonomous implementation agents against approved IMMUTABLE FR/AC requirements at scale, keeping',
  'planning, work, verification, evidence, recovery, and progress VISIBLE.',
  'Operating maxim: "No executable slice without a verification plan. No accepted work without evidence."',
  'Key non-negotiables: specs immutable; FR/AC refs are the unit of truth; every executable slice declares',
  'verification obligations before worker dispatch; accepted FR/AC needs evidence vs immutable criteria;',
  'WORKERS MAY NOT create/edit/approve their own verification obligations; status rollups derive from the',
  'requirement ledger NOT chat memory; planner decisions visible as events/checkpoints; checkpoints/resume',
  'packets make chat memory disposable; independent review includes a structured Sleuth Review Gate.',
  'Chain of truth: source spec -> FR/AC ref -> verification obligation -> slice -> lane -> worker -> reviewer',
  'findings -> deterministic/human verification evidence -> requirement ledger -> rollup -> status sink.',
  'Anti-drift: resist busy work that does not move verified state; unknown status != done status.',
].join('\n');

const WORKFLOW_MECHANISMS = [
  'THE WORKFLOW TOOL (the thing to compare against) — 7 forensically-confirmed mechanisms',
  '(full writeup: research/workflow/forensic-analysis.md):',
  '1. CONTROL PLANE IS CODE: orchestration is deterministic JS (loops/parallel/pipeline); the LLM only fills',
  '   leaves via agent() calls. Date.now()/Math.random() are banned in scripts to keep runs replayable.',
  '2. CONTENT-ADDRESSED RESULT JOURNAL: each agent() call is keyed v2:sha256(prompt+opts); journal.jsonl',
  '   stores the VALIDATED result object under that key. Resume replays unchanged steps for free; only the',
  '   first changed call onward re-runs. Step-level memoization = exact, cheap resume.',
  '3. SCHEMA-ENFORCED OUTPUT: agent(prompt,{schema}) forces a StructuredOutput tool call; validation is at',
  '   the tool layer so the model SELF-RETRIES until valid (one agent retried 7x). Caller gets a typed',
  '   object, never parses prose.',
  '4. PIPELINE, NO BARRIER: each item flows through all stages independently; verifiers ran while a slow',
  '   reviewer was still working. Wall-clock = slowest single chain, not sum-of-stage-maxes.',
  '5. FRESH-CONTEXT ISOLATION: each subagent is its own session with only a shared CONTEXT block + its one',
  '   task; full tool access; scales past one context window.',
  '6. ADAPTIVE DEPTH: no per-agent budget; spend self-scales by difficulty (1.5k..25.6k output tokens),',
  '   under hard backstops (concurrency min(16,cores-2), <=1000 agents, <=4096 items/call).',
  '7. ADVERSARIAL VERIFY ON ACTIONABILITY: a skeptic per finding, default-reject; it killed a finding that',
  '   was factually correct but pre-existing/out-of-scope. Filters true-but-not-worth-acting-on noise.',
].join('\n');

const RULES = [
  'FORENSIC RULES (critical):',
  '- READ THE ACTUAL SOURCE under x:/repositories/agent-swarm/src before claiming anything. Cite file:line.',
  '- Distinguish what the code ACTUALLY does from what docs/comments claim. Code wins.',
  '- Do NOT invent. If unsure, say so and lower confidence. "We do not do X" must be backed by having',
  '  looked where X would live.',
  '- agent-swarm already uses Zod schemas (src/schemas.ts, e.g. workerResultSchema). Determine HOW results',
  '  are obtained+validated (forced tool? parse-then-validate of stdout/JSONL? retry on invalid?).',
  '- Recommendations must tie to the MISSION/non-negotiables and respect agent-swarm being MODEL-AGNOSTIC',
  '  (codex/claude/fixture drivers) and an LLM-overseer system (NOT a pure code orchestrator).',
  '- At most 4 highest-leverage recommendations per lens. Prefer fewer, sharper, mission-aligned ones.',
].join('\n');

const LENSES = [
  {
    key: 'structured-output',
    title: 'Structured output & result validation',
    files: 'src/schemas.ts (workerResultSchema/reviewResult/etc.), src/worker-driver.ts, src/worker-events.ts (JSONL ingestion), the review/verify result handling in src/cli.ts (grep for workerResultSchema, reviewResult, parse, JSON.parse, safeParse).',
    question: 'How does a worker/reviewer/overseer result actually get from the driver process into validated harness state today? Is it a forced structured-output tool call, or parse-then-validate of stdout/JSONL/text? What happens on malformed output — retry, block, or silent fallback? Compare to Workflow mechanism 3. Where is this brittle, and what would a forced structured-return contract (per role, model-agnostic) buy us against the evidence/anti-drift invariants?',
  },
  {
    key: 'resume-idempotency',
    title: 'Resume, recovery & idempotency',
    files: 'src/checkpoints.ts, src/storage.ts, src/focus.ts, recovery in src/cli.ts (grep for recovery, revive, restart, mark-stale, scan, resume packet, sessionId, thread_id).',
    question: 'How does the harness resume/recover today (session-level revive/restart, checkpoints, resume packets)? Is there ANY content-addressed step-level memoization so an identical worker/reviewer/verify unit is not redone? Is re-running a step idempotent in storage? Compare to Workflow mechanism 2. Would a content-addressed result journal keyed by (role,sliceId,frAcRef,prompt-hash,skill-binding-hash) help, and does it conflict with "evidence not chat memory" / immutability invariants?',
  },
  {
    key: 'orchestration-controlflow',
    title: 'Orchestration control flow (LLM vs code)',
    files: 'the overseer loop in src/cli.ts (grep for orchestrate, runLoop, overseer, nextCommand, actionableState), src/planner.ts, scripts/run-live-agent-demo.mjs.',
    question: 'When the overseer runs, what is decided by an LLM turn vs by deterministic code today? Is the loop "LLM proposes nextCommand each turn" or scripted with LLM leaves? Where are mechanical fan-outs (e.g. verify each FR/AC, review each slice) done by the LLM that could be deterministic code? Compare to Workflow mechanism 1. Recommend a hybrid (overseer EMITS a plan; code executes mechanically; LLM fills leaves) ONLY where it preserves the visible-planner-decisions and autonomy invariants.',
  },
  {
    key: 'review-to-escalation',
    title: 'Findings -> escalation/repair (skeptic gap)',
    files: 'src/human-actions.ts, the review/verify/escalation handling in src/cli.ts (grep for escalation, repair, requiredFixes, qualityGate, Sleuth, repair_required), src/observability.ts for escalation shapes.',
    question: 'How do reviewer/verifier findings become escalations and repair dispatch today? Is there any independent skeptic step that challenges a finding before it drives repair/human queues, or does every finding flow straight through? Where do false-positive findings cause repair churn (we observed a repeated human_verification_rework loop)? Compare to Workflow mechanism 7 (default-reject verify on actionability). Where would a skeptic gate slot in WITHOUT violating "workers may not approve their own verification" (the skeptic must be independent)?',
  },
  {
    key: 'scheduling-concurrency',
    title: 'Scheduling & concurrency (barrier vs pipeline)',
    files: 'the run loop + dispatch in src/cli.ts, src/planner.ts (lane/slice selection), scripts/run-live-agent-demo.mjs.',
    question: 'Does the harness process slices/phases with barriers (e.g. wait for all workers, then review) or as independent per-slice pipelines? Is worker->review->verify per slice sequential or can slices progress concurrently? Are there lane-level concurrency controls? Compare to Workflow mechanism 4 (pipeline-no-barrier). Recommend scheduling changes that cut wall-clock while preserving dependency-gating and evidence ordering invariants.',
  },
  {
    key: 'context-packets',
    title: 'Context packets (shared facts & no-redo guard)',
    files: 'src/focus.ts (focus packets), src/skills.ts (skill packets/bindings), src/checkpoints.ts (resume packets), src/protocol.ts.',
    question: 'What exactly goes into worker prompts / focus packets / skill packets / resume packets today? Is there an explicit "settled facts / do not re-derive / already-verified" block to stop agents re-investigating known state? How is duplicate investigation avoided? Compare to Workflow mechanisms 5 and 6 (shared immutable CONTEXT + explicit already-verified guard). Recommend packet enrichments that reduce redundant tool spend while keeping checkpoints authoritative (chat memory disposable).',
  },
];

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area', 'currentBehavior', 'evidence', 'workflowComparison', 'gaps', 'recommendations', 'confidence'],
  properties: {
    area: { type: 'string' },
    currentBehavior: { type: 'string', description: 'what the code ACTUALLY does today, prose, source-grounded' },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'citation'],
      properties: { claim: { type: 'string' }, citation: { type: 'string', description: 'file:line or file:symbol' } } } },
    workflowComparison: { type: 'string', description: 'how this compares to the relevant Workflow mechanism(s)' },
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'detail', 'severity'],
      properties: { title: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string', enum: ['blocker','major','minor','nit'] } } } },
    recommendations: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'title', 'change', 'rationale', 'missionTieIn', 'effort', 'risk'],
      properties: {
        id: { type: 'string' }, title: { type: 'string' }, change: { type: 'string' },
        rationale: { type: 'string' }, missionTieIn: { type: 'string' },
        effort: { type: 'string', enum: ['S','M','L'] }, risk: { type: 'string', enum: ['low','med','high'] } } } },
    confidence: { type: 'string', enum: ['high','medium','low'] },
  },
};

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['claimAccurate', 'alreadyImplemented', 'missionAligned', 'verdict', 'reasoning', 'revised'],
  properties: {
    claimAccurate: { type: 'boolean', description: 'is the underlying what-we-do claim correct? Re-read the cited source.' },
    alreadyImplemented: { type: 'boolean', description: 'do we already substantially do this?' },
    missionAligned: { type: 'boolean', description: 'does it serve the mission/non-negotiables without violating them?' },
    verdict: { type: 'string', enum: ['keep','revise','drop'], description: 'default to drop if claim is wrong/already-done/misaligned or you cannot confirm' },
    reasoning: { type: 'string', description: 'cite the source you re-read' },
    revised: { type: 'string', description: 'sharpened recommendation if keep/revise; empty if drop' },
  },
};

function forensicPrompt(L) {
  return [
    MISSION, '', WORKFLOW_MECHANISMS, '', RULES, '',
    'YOUR LENS: ' + L.title + ' (' + L.key + ').',
    'PRIMARY SOURCE TO READ: ' + L.files,
    '', 'QUESTION TO ANSWER FORENSICALLY: ' + L.question,
    '', 'Return source-grounded findings: currentBehavior (what we ACTUALLY do, cited), workflowComparison,',
    'gaps, and at most 4 highest-leverage mission-aligned recommendations. Cite file:line in evidence.',
  ].join('\n');
}

function verifyPrompt(L, res, r) {
  return [
    MISSION, '',
    'You are an independent SKEPTIC verifying ONE recommendation from the "' + L.title + '" forensic lens of',
    'agent-swarm (x:/repositories/agent-swarm/src). Re-read the cited source yourself; do not trust the claim.',
    'Default to DROP if: the underlying "what we do" claim is inaccurate, OR we already substantially do this,',
    'OR it violates/does not serve a non-negotiable, OR you cannot confirm it from the code.',
    '', 'LENS currentBehavior (claimed): ' + (res.currentBehavior || '').slice(0, 1200),
    'LENS evidence: ' + JSON.stringify((res.evidence || []).slice(0, 8)),
    '', 'RECOMMENDATION UNDER TEST:', JSON.stringify(r, null, 1),
    '', 'Verify against the real source and the mission. Return your verdict.',
  ].join('\n');
}

phase('Forensics');
const reviewed = await pipeline(
  LENSES,
  (L) => agent(forensicPrompt(L), { label: 'forensic:' + L.key, phase: 'Forensics', schema: FINDINGS_SCHEMA }),
  (res, L) => {
    const recs = (res && Array.isArray(res.recommendations)) ? res.recommendations : [];
    if (recs.length === 0) return [{ lens: L.key, area: res && res.area, res, rec: null, verdict: null }];
    return parallel(recs.map((r) => () =>
      agent(verifyPrompt(L, res, r), { label: 'verify:' + L.key, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then((v) => ({ lens: L.key, area: res.area, currentBehavior: res.currentBehavior, evidence: res.evidence, gaps: res.gaps, workflowComparison: res.workflowComparison, rec: r, verdict: v }))
        .catch(() => null)));
  },
);

const all = reviewed.flat().filter(Boolean);
const recs = all.filter((x) => x.rec);
const confirmed = recs.filter((x) => x.verdict && x.verdict.verdict !== 'drop' && x.verdict.claimAccurate && x.verdict.missionAligned && !x.verdict.alreadyImplemented);
const dropped = recs.filter((x) => !(x.verdict && x.verdict.verdict !== 'drop' && x.verdict.claimAccurate && x.verdict.missionAligned && !x.verdict.alreadyImplemented));
log('Forensics complete: ' + recs.length + ' recommendations across ' + LENSES.length + ' lenses; ' + confirmed.length + ' survived skeptic, ' + dropped.length + ' dropped/revised.');

// one currentBehavior summary per lens (for the ground-truth doc)
const lensBehavior = {};
for (const x of all) { if (x.res && x.lens && !lensBehavior[x.lens]) lensBehavior[x.lens] = { area: x.res.area, currentBehavior: x.res.currentBehavior, evidence: x.res.evidence, workflowComparison: x.res.workflowComparison, gaps: x.res.gaps }; else if (x.currentBehavior && x.lens && !lensBehavior[x.lens]) lensBehavior[x.lens] = { area: x.area, currentBehavior: x.currentBehavior, evidence: x.evidence, workflowComparison: x.workflowComparison, gaps: x.gaps }; }

return {
  lensCount: LENSES.length,
  recommendationsRaised: recs.length,
  confirmedCount: confirmed.length,
  groundTruth: lensBehavior,
  confirmed: confirmed.map((x) => ({ lens: x.lens, id: x.rec.id, title: x.rec.title, change: x.rec.change, rationale: x.rec.rationale, missionTieIn: x.rec.missionTieIn, effort: x.rec.effort, risk: x.rec.risk, verdict: x.verdict.verdict, skepticReasoning: x.verdict.reasoning, revised: x.verdict.revised })),
  droppedOrRevised: dropped.map((x) => ({ lens: x.lens, title: x.rec ? x.rec.title : '(no rec)', verdict: x.verdict ? x.verdict.verdict : 'none', claimAccurate: x.verdict ? x.verdict.claimAccurate : null, alreadyImplemented: x.verdict ? x.verdict.alreadyImplemented : null, why: x.verdict ? x.verdict.reasoning : 'no verdict' })),
};