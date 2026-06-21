export const meta = {
  name: 'control-plane-handoff-impl',
  description: 'Implement Slice A (settled-facts CP-1/CP-2) + Slice B (intervention packet PI) per the handoff, dogfooded via Workflow',
  phases: [
    { title: 'Baseline', detail: 'map current prompt/checkpoint/focus/recovery paths (read-only)' },
    { title: 'Design', detail: 'concrete additive edit plan + prompt text + intervention shape' },
    { title: 'Implementation', detail: 'Slice A then Slice B, additive, self-build until tsc green' },
    { title: 'Test', detail: 'focused tests per FR' },
    { title: 'Verification', detail: 'independent build + tests' },
    { title: 'Skeptic', detail: 'one skeptic per FR, default-reject, re-read code' },
    { title: 'Meta', detail: 'dogfood analysis' },
  ],
};

const MISSION = [
  'AGENT-SWARM MISSION (docs/architecture/core-philosophy.md): converts immutable requirements into',
  'verified implementation state. NON-NEGOTIABLES that bound this work:',
  '- Immutable specs stay immutable; FR/AC refs are the unit of truth.',
  '- No accepted work without evidence; status rolls up from the requirement LEDGER, not chat memory.',
  '- Workers may not create/edit/weaken/approve the criteria used to accept their own work.',
  '- human_input_required blocks (unclear); human_verification_required permits impl but blocks final accept.',
  '- The implementation MUST stay model-agnostic (codex/claude/fixture). Do NOT build a Claude-only path.',
  '- ALL changes here must be ADDITIVE: existing focus-packet/prompt consumers must keep working.',
].join('\n');

const RULES = [
  'HARD RULES:',
  '- The working tree has UNCOMMITTED Codex hardening in src/cli.ts, src/worker-driver.ts,',
  '  tests/review-runner.e2e.test.js, tests/streaming-worker.e2e.test.js. BUILD ON TOP of them.',
  '  NEVER run git reset --hard, git checkout -- ., git clean, or any destructive cleanup. Never discard them.',
  '- Read source truth before editing (functions move; grep for the exact symbol, do not trust line numbers).',
  '- cli.ts is ~6800 lines. Use Grep/Read to locate; make targeted Edits; do NOT rewrite whole files.',
  '- Self-verify TypeScript with `npx tsc` (the build script is `tsc && npm run build:web`; web build is not',
  '  needed for a TS self-check). Fix any compile errors YOU introduce until tsc is clean. Report honestly.',
  '- Do not edit immutable specs under docs/requirements or fixtures specs.',
].join('\n');

const POINTERS = [
  'SOURCE POINTERS (verify with grep; lines shifted by uncommitted changes):',
  '- buildWorkerPrompt (~src/cli.ts:6320) assembles the worker prompt; persisted as an artifact.',
  '- buildWorkerRevivePrompt (~src/cli.ts:1583-1646) + the recovery revive call site.',
  '- src/checkpoints.ts: buildResumePacket / buildCheckpointPayload compute doNotRedo, evidenceStatus,',
  '  commandEvidence, activeBlockers (~:195-224, evidenceStatusForSlice ~:311-323) — REUSE these, do not reinvent.',
  '- src/observability.ts buildCoverage / requirement-ledger (~:590-745) is the source of accepted/passed refs.',
  '- src/focus.ts: buildRunFocusPacket / buildSliceFocusPacket, classifyRunFocus/failureClasses,',
  '  recommendRunInterventions/recommendSliceInterventions, focusPriority — add the intervention field here.',
  '- recovery/revive/restart/scan flow in src/cli.ts (~:1489-1842); the focus API routes (/api/focus/run/:id,',
  '  /api/focus/slice/:id) live in src/cli.ts or src/web-server.ts.',
  '- src/types.ts: focus packet + AgentRunRecord types. src/schemas.ts: Zod schemas.',
  'REQUIRED DOCS: docs/architecture/core-philosophy.md; research/workflow/lessons-for-agent-swarm.md (CP-1/CP-2,',
  'RE-*); research/workflow/ground-truth-agent-swarm.md.',
].join('\n');

const SCOPE = [
  'EXACT SCOPE — implement BOTH slices, nothing else.',
  '',
  'SLICE A — Ledger-derived settled facts (CP-1/CP-2):',
  'FR-CP-001 (worker prompt settled facts): buildWorkerPrompt includes a clearly delimited harness-authored',
  '  "Settled facts from the requirement ledger" section; generated from DURABLE state (ledger/checkpoints),',
  '  not chat; includes accepted SIBLING FR/AC refs + useful evidence ids/command summaries where available;',
  '  EXPLICITLY states settled facts do NOT waive evidence obligations for the current slice scope; appears in',
  '  the persisted worker-prompt artifact; prompt tests updated/added.',
  'FR-CP-002 (revive prompt no-redo): buildWorkerRevivePrompt or its call site includes a resume/ledger block:',
  '  prev run id/session when available, current slice status, active blockers/escalations, prior evidence+',
  '  commands, do-not-redo items, next expected action; must NOT silently mark any in-scope ref accepted;',
  '  recovery/revive tests updated/added.',
  'FR-CP-003 (scope isolation): current-slice refs are NOT listed as done merely from a worker claim; accepted',
  '  sibling refs used as context ONLY when the ledger shows accepted/passed evidence; blocked/human refs stay',
  '  visibly blocked; tests cover >=1 accepted sibling ref AND >=1 current in-scope ref to prove the distinction.',
  '',
  'SLICE B — Peek-in / intervention packet foundation (PI):',
  'FR-PI-001 (focus packet intervention field): buildRunFocusPacket and/or buildSliceFocusPacket expose an',
  '  ADDITIVE field "intervention" with: classification (e.g. valid_artifact_hung_child | schema_failure |',
  '  missing_result | stale_running_agent | review_blocker | human_verification_failed | retry_budget_pressure),',
  '  confidence (low|medium|high), recommendedAction (observe | coach_same_session | reask_structured_result |',
  '  accept_valid_artifact | revive_same_session | restart_fresh | dispatch_targeted_repair | escalate_human),',
  '  reason, evidence (artifact/event/escalation ids or paths), risk. Existing consumers keep working (additive).',
  'FR-PI-002 (recovery uses packet): recovery/revive/restart flow records an event that the focus/intervention',
  '  packet was consulted or generated BEFORE acting; same-session revive stays preferred when a session id',
  '  exists and the packet recommends it; fresh restart stays fallback; valid-artifact recovery is NOT',
  '  downgraded into restart churn.',
  'FR-PI-003 (API/test): the JSON focus packet surface (/api/focus/run/:runId and/or /api/focus/slice/:sliceId)',
  '  includes the new intervention field; add/update a test that consumes the JSON packet and asserts the field',
  '  exists for >=1 known failure class. (No UI work required; just document the API shape in the summary.)',
  '',
  'OUT OF SCOPE (do NOT implement): full skeptic role RE-1/RE-2; pipeline/concurrency SC-1/SC-2;',
  'content-addressed journal OCF-3; orchestrator extraction OCF-2; Zod->JSONSchema generation SO-1.',
].join('\n');

const BASELINE_SCHEMA = { type:'object', additionalProperties:false, required:['area','map','reusable','testPatterns','notes'],
  properties:{ area:{type:'string'},
    map:{type:'array', items:{type:'object', additionalProperties:false, required:['symbol','file','detail'], properties:{symbol:{type:'string'},file:{type:'string'},detail:{type:'string'}}}},
    reusable:{type:'array', items:{type:'object', additionalProperties:false, required:['fn','file','provides'], properties:{fn:{type:'string'},file:{type:'string'},provides:{type:'string'}}}},
    testPatterns:{type:'array', items:{type:'string'}}, notes:{type:'string'} } };

const DESIGN_SCHEMA = { type:'object', additionalProperties:false, required:['settledFacts','intervention','edits','testPlan','risks'],
  properties:{
    settledFacts:{type:'object', additionalProperties:false, required:['sectionTitle','sourceFns','promptText'], properties:{sectionTitle:{type:'string'},sourceFns:{type:'array',items:{type:'string'}},promptText:{type:'string'}}},
    intervention:{type:'object', additionalProperties:false, required:['tsShape','classificationToAction','computeLocation'], properties:{tsShape:{type:'string'},classificationToAction:{type:'string'},computeLocation:{type:'string'}}},
    edits:{type:'array', items:{type:'object', additionalProperties:false, required:['file','fn','change','additive'], properties:{file:{type:'string'},fn:{type:'string'},change:{type:'string'},additive:{type:'boolean'}}}},
    testPlan:{type:'array', items:{type:'object', additionalProperties:false, required:['fr','file','asserts'], properties:{fr:{type:'string'},file:{type:'string'},asserts:{type:'string'}}}},
    risks:{type:'array', items:{type:'string'}} } };

const IMPL_SCHEMA = { type:'object', additionalProperties:false, required:['slice','filesChanged','summary','newFields','tscClean','tscErrors','notes'],
  properties:{ slice:{type:'string'}, filesChanged:{type:'array',items:{type:'string'}}, summary:{type:'string'},
    newFields:{type:'array',items:{type:'string'}}, tscClean:{type:'boolean'}, tscErrors:{type:'string'}, notes:{type:'string'} } };

const TEST_SCHEMA = { type:'object', additionalProperties:false, required:['testsAdded','commands','pass','failures','output'],
  properties:{ testsAdded:{type:'array',items:{type:'string'}}, commands:{type:'array',items:{type:'string'}}, pass:{type:'boolean'}, failures:{type:'string'}, output:{type:'string'} } };

const VERIFY_SCHEMA = { type:'object', additionalProperties:false, required:['buildOk','testsPass','buildTail','testTail','failures'],
  properties:{ buildOk:{type:'boolean'}, testsPass:{type:'boolean'}, buildTail:{type:'string'}, testTail:{type:'string'}, failures:{type:'string'} } };

const SKEPTIC_SCHEMA = { type:'object', additionalProperties:false, required:['fr','acceptanceMet','isAdditive','modelAgnostic','evidence','gaps'],
  properties:{ fr:{type:'string'}, acceptanceMet:{type:'boolean'}, isAdditive:{type:'boolean'}, modelAgnostic:{type:'boolean'}, evidence:{type:'string'}, gaps:{type:'string'} } };

const META_SCHEMA = { type:'object', additionalProperties:false, required:['didWell','didPoorly','vsMonolithic','dogfoodVerdict','nextSlice'],
  properties:{ didWell:{type:'array',items:{type:'string'}}, didPoorly:{type:'array',items:{type:'string'}}, vsMonolithic:{type:'string'}, dogfoodVerdict:{type:'string'}, nextSlice:{type:'string'} } };

const HEAD = MISSION + '\n\n' + SCOPE + '\n\n' + RULES + '\n\n' + POINTERS;

phase('Baseline');
const BASE = [
  { key:'prompt-ledger', q:'Map the worker-prompt + revive-prompt + ledger/checkpoint code paths. Where exactly is buildWorkerPrompt assembled and persisted as an artifact? Where is buildWorkerRevivePrompt + its recovery call site? What durable ledger/checkpoint helpers already produce accepted-sibling refs, doNotRedo, evidenceStatus, commandEvidence, activeBlockers, and how do I call them from the prompt builders? Give exact symbols/files.' },
  { key:'focus-recovery', q:'Map the focus-packet builders (buildRunFocusPacket/buildSliceFocusPacket), how failureClasses/recommendedInterventions are computed, the recovery/revive/restart/scan flow (where an event is recorded), and the focus API routes (/api/focus/run/:id, /api/focus/slice/:id). Where should an additive intervention field be computed and where should recovery record that it consulted the packet?' },
  { key:'types-tests', q:'Map src/types.ts focus-packet + AgentRunRecord types, src/schemas.ts relevant schemas, and the EXISTING test patterns for prompt building, focus packets, and recovery/revive (which test files, what helpers/fixtures they use). What patterns should new FR-CP / FR-PI tests mirror?' },
];
const baseline = await parallel(BASE.map((a) => () =>
  agent(HEAD + '\n\nBASELINE LENS (' + a.key + ', READ-ONLY): ' + a.q, { label:'baseline:'+a.key, phase:'Baseline', schema: BASELINE_SCHEMA })));

phase('Design');
const design = await agent(
  HEAD + '\n\nBASELINE MAPS:\n' + JSON.stringify(baseline.filter(Boolean)) +
  '\n\nProduce a CONCRETE, ADDITIVE edit plan: (1) the exact "Settled facts from the requirement ledger" section text + which existing ledger/checkpoint fns to call; (2) the exact additive `intervention` TS shape + a classification->recommendedAction mapping + where in focus.ts to compute it; (3) the per-file/per-function edit list (additive=true for each); (4) the test plan per FR. Reuse existing helpers; do not reinvent ledger logic.',
  { label:'design', phase:'Design', schema: DESIGN_SCHEMA });

phase('Implementation');
const implA = await agent(
  HEAD + '\n\nAPPROVED DESIGN:\n' + JSON.stringify(design) +
  '\n\nIMPLEMENT SLICE A ONLY now (FR-CP-001/002/003). Make targeted ADDITIVE edits in the shared working tree (build on top of the uncommitted hardening). Reuse the checkpoint/ledger helpers. Then run `npx tsc` and FIX any TypeScript errors you introduced until it is clean. Report exactly what you changed.',
  { label:'impl:sliceA', phase:'Implementation', schema: IMPL_SCHEMA });
const implB = await agent(
  HEAD + '\n\nAPPROVED DESIGN:\n' + JSON.stringify(design) + '\n\nSLICE A IS ALREADY IMPLEMENTED:\n' + JSON.stringify(implA) +
  '\n\nIMPLEMENT SLICE B ONLY now (FR-PI-001/002/003): the additive `intervention` field on the focus packets, recovery recording that it consulted the packet before acting, and the API/JSON shape. ADDITIVE only — existing consumers must keep working. Then run `npx tsc` and FIX any errors until clean. Report.',
  { label:'impl:sliceB', phase:'Implementation', schema: IMPL_SCHEMA });

phase('Test');
const tests = await agent(
  HEAD + '\n\nIMPLEMENTED:\nSliceA: ' + JSON.stringify(implA) + '\nSliceB: ' + JSON.stringify(implB) +
  '\n\nAdd FOCUSED tests for each FR (FR-CP-001/002/003, FR-PI-001/002/003), mirroring existing test patterns. FR-CP-003 must cover >=1 accepted sibling ref AND >=1 current in-scope ref. FR-PI-003 must assert the JSON focus packet has the intervention field for >=1 failure class. Then run your new tests plus `node --test tests/streaming-worker.e2e.test.js tests/review-runner.e2e.test.js`. Report results HONESTLY (do not claim pass you did not see).',
  { label:'test-worker', phase:'Test', schema: TEST_SCHEMA });

phase('Verification');
const verify = await agent(
  'Independently verify the control-plane-handoff implementation in x:/repositories/agent-swarm. Do NOT edit code. Run `npm run build` (tsc && web) and then run the focused tests (the new FR-CP/FR-PI tests plus tests/streaming-worker.e2e.test.js and tests/review-runner.e2e.test.js). Report buildOk, testsPass, the tails of output, and any failures verbatim. Be honest about timeouts or skips.',
  { label:'verify', phase:'Verification', schema: VERIFY_SCHEMA });

phase('Skeptic');
const FRS = ['FR-CP-001','FR-CP-002','FR-CP-003','FR-PI-001','FR-PI-002','FR-PI-003'];
const skeptics = await parallel(FRS.map((fr) => () =>
  agent(MISSION + '\n\n' + SCOPE + '\n\nYou are an INDEPENDENT skeptic (READ-ONLY). Re-read the IMPLEMENTED code AND tests for ' + fr +
    ' in x:/repositories/agent-swarm. Default to acceptanceMet=false unless you can cite file:line proving the acceptance criteria are actually met. Also judge: is the change strictly additive (existing consumers unbroken)? is it model-agnostic (no claude-only path)? List any gap.',
    { label:'skeptic:'+fr, phase:'Skeptic', schema: SKEPTIC_SCHEMA }).catch(() => null)));

phase('Meta');
const metaA = await agent(
  'You are a meta-analyst. This Workflow run implemented an agent-swarm control-plane slice (settled-facts + intervention packets) by dogfooding Claude Workflow. Based on what you can observe of this run and the resulting code in x:/repositories/agent-swarm, report: what Workflow did well, what it did poorly, how it compares to a single monolithic agent pass, an honest dogfood verdict (did using Workflow help here?), and the recommended next slice (per the handoff follow-up: SO-1, then RE-1/RE-2).',
  { label:'meta', phase:'Meta', schema: META_SCHEMA });

const skepticsClean = skeptics.filter(Boolean);
return {
  design,
  implementation: [implA, implB],
  tests,
  verification: verify,
  skeptics: skepticsClean,
  skepticsMet: skepticsClean.filter((s) => s.acceptanceMet).map((s) => s.fr),
  skepticsGaps: skepticsClean.filter((s) => !s.acceptanceMet).map((s) => ({ fr: s.fr, gaps: s.gaps })),
  meta: metaA,
};