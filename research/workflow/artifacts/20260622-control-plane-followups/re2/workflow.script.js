export const meta = {
  name: 're2-skeptic-scored-severity',
  description: 'RE-2: the accept gate consumes independent-skeptic per-finding verdicts (downgrade refuted findings to residual-risk); hard backstops stay unconditional',
  phases: [
    { title: 'Baseline', detail: 'map the gate: reviewQualityBlockingReasons/readLatestReviewGate/applyReviewOutcome + finding_challenge evidence shape' },
    { title: 'Design', detail: 'consumption rule, downgradable-vs-unconditional split, backward-compat, recording' },
    { title: 'Implement', detail: 'gate consumes skeptic verdicts; self-build' },
    { title: 'Test', detail: 'fixture tests: downgrade works, backstops hold, no-skeptic unchanged' },
    { title: 'Verify', detail: 'independent build + gate/review regression' },
    { title: 'Skeptic', detail: 'adversarial: prove no weakening of acceptance' },
  ],
};

const MISSION = [
  'AGENT-SWARM (docs/architecture/core-philosophy.md): converts immutable requirements into verified',
  'implementation state. NON-NEGOTIABLES bounding RE-2 (this slice CHANGES acceptance semantics, so these',
  'are HARD safety invariants — the skeptic-review phase will try to break them):',
  '- No accepted work without evidence. Unknown status is NOT done status.',
  '- WORKERS MAY NOT approve their own work: only an INDEPENDENT skeptic (distinct role+actor, never the',
  '  worker or reviewer of the slice — RE-1 already guarantees+guards this) may influence severity.',
  '- HARD BACKSTOPS STAY UNCONDITIONAL — the skeptic can NEVER downgrade/clear: source-mutation',
  '  (reviewResult.sourceMutationDetected / sourceMutations), human_input_required / human_required,',
  '  failed FR/AC coverage (frAcFindings status=failed / missing_evidence), or missing structured evidence.',
  '  The skeptic may ONLY downgrade SLEUTH QUALITY-GATE findings (qualityGate dimensions + blockingConcerns)',
  '  and reviewer quality findings that it INDEPENDENTLY assessed and explicitly refuted/marked residual.',
  '- BACKWARD-COMPATIBLE: when NO finding_challenge (skeptic) evidence exists for the slice, the gate must',
  '  behave EXACTLY as before (byte-identical blocking decisions). RE-2 only changes behavior when an',
  '  independent skeptic has actually challenged findings.',
  '- VISIBILITY (status from the ledger, not chat): every downgrade must be RECORDED (as a residualRisk +',
  '  a harness event) so a human can see what the skeptic downgraded and why. Nothing hidden.',
  '- MODEL-AGNOSTIC: no Claude-only path.',
].join('\n');

const FACTS = [
  'CONFIRMED ANCHORS (verify exact lines by grep; cli.ts ~6900+ lines):',
  '- reviewQualityBlockingReasons(result: ReviewResult): string[] at src/cli.ts:5150 — current blocking logic:',
  '  blocks if qualityGate.status==="failed", each blockingConcerns entry, and each dimension with',
  '  status==="failed" || risk==="high". THIS is the primary downgrade point. It currently takes only the',
  '  ReviewResult; to consult skeptic verdicts it needs the slice + store (read finding_challenge evidence).',
  '- readLatestReviewGate(...) at src/cli.ts:4915 — reads latest review_result; the gate consumer.',
  '- applyReviewOutcome(...) at src/cli.ts:4682 — applies status/escalations on review.',
  '- Hard backstop signals: sourceMutationDetected at src/cli.ts:4268; human_required/human_input_required',
  '  throughout; frAcFindings status enum passed|failed|missing_evidence|uncertain (schemas.ts:87).',
  '- RE-1 (just shipped) records skeptic verdicts as kind:"finding_challenge" evidence with a payload',
  '  containing skepticResult.findingVerdicts (each { ref?, dimension?, verdict: real|refuted|uncertain,',
  '  severity, reasoning }), role:"skeptic", a distinct actor. Read the LATEST finding_challenge evidence for',
  '  the slice the same way readLatestReviewGate reads review_result (store.listEvidence(slice.id).filter(kind).at(-1)).',
  '- schemas.ts has skepticResultSchema (RE-1). reviewResult.qualityGate has residualRisks: string[] already',
  '  (a natural home for recorded downgrades).',
].join('\n');

const SCOPE = [
  'SCOPE — RE-2:',
  '1. Make the quality-gate blocking decision consult the LATEST independent finding_challenge (skeptic)',
  '   evidence for the slice. A blocking reason that maps (by dimension name or FR/AC ref) to a skeptic',
  '   verdict of "refuted" (or an explicit residual-risk severity like "minor"/"nit") is DOWNGRADED: it no',
  '   longer blocks; it is recorded as a residualRisk. A verdict of "real"/"uncertain", or NO matching',
  '   verdict, leaves the reason BLOCKING (default-keep-blocking — only an explicit independent refutation',
  '   downgrades).',
  '2. Restructure reviewQualityBlockingReasons (or add a slice/store-aware wrapper used by the gate) so it',
  '   can read skeptic evidence. Keep a pure no-skeptic path that returns the SAME reasons as today.',
  '3. HARD BACKSTOPS remain unconditional regardless of any skeptic verdict: sourceMutationDetected,',
  '   human_input_required/human_required, failed/missing-evidence frAcFindings, missing structured result.',
  '   The skeptic verdicts ONLY ever apply to qualityGate dimensions/blockingConcerns. Never to those.',
  '4. Record each downgrade: append to the slice review residualRisks AND emit a harness event',
  '   (e.g. review.finding_downgraded with {dimension/ref, fromSeverity, skepticVerdict, reasoning,',
  '   skepticActor}) so it is visible in the ledger.',
  '5. Tests (fixture, deterministic) PROVING the safety invariants:',
  '   (a) skeptic refutes a high-risk/failed qualityGate DIMENSION -> that reason no longer blocks ->',
  '       slice can accept; the downgrade is recorded (residualRisk + event).',
  '   (b) BACKSTOP: skeptic "refutes" a source-mutation / human_required / failed-frAcFinding -> STILL',
  '       BLOCKS (skeptic verdict ignored for backstops).',
  '   (c) BACKWARD-COMPAT: with NO finding_challenge evidence, reviewQualityBlockingReasons returns EXACTLY',
  '       the same reasons as before (assert against the pre-RE-2 logic for a fixture ReviewResult).',
  '   (d) only an INDEPENDENT skeptic counts: a finding_challenge whose actor == the slice worker/reviewer',
  '       actor is IGNORED (defense in depth atop RE-1 guard).',
  '   (e) a "real"/"uncertain" verdict (or unmatched finding) does NOT downgrade — still blocks.',
  '',
  'OUT OF SCOPE: auto-dispatching the skeptic inside the live acceptance loop (RE-2 consumes finding_challenge',
  'evidence when present; whether/where to auto-run the skeptic is a separate wiring slice — note it as a',
  'follow-up). SC-*/OCF-*.',
].join('\n');

const RULES = [
  'RULES: working tree clean at HEAD (9fe971c). Build on top. NEVER git reset/checkout/clean/discard.',
  'Self-verify with `npx tsc`; fix your own errors until clean. Use the fixture driver / seeded evidence in',
  'tests (no real provider spend). cli.ts is huge: grep to locate, targeted Edits only, never rewrite whole',
  'files. Report honestly; never claim a test passed you did not run. Preserve the exact existing blocking',
  'decisions on the no-skeptic path — write a test that asserts it.',
].join('\n');

const HEAD = MISSION + '\n\n' + FACTS + '\n\n' + SCOPE + '\n\n' + RULES;

const BASELINE_SCHEMA = { type:'object', additionalProperties:false, required:['gateLogic','findingChallengeShape','backstops','recordingHooks','tests'],
  properties:{
    gateLogic:{type:'string', description:'exactly how reviewQualityBlockingReasons + readLatestReviewGate + applyReviewOutcome decide blocking today, with citations + signatures'},
    findingChallengeShape:{type:'string', description:'the finding_challenge evidence payload shape from RE-1 + how to read the latest one for a slice (citation)'},
    backstops:{type:'string', description:'where source-mutation/human_required/failed-frAcFinding/missing-evidence block, that must stay unconditional, with citations'},
    recordingHooks:{type:'string', description:'how residualRisks + harness events are recorded (createEvent/addEvent), to record downgrades'},
    tests:{type:'array', items:{type:'string'}} } };

const DESIGN_SCHEMA = { type:'object', additionalProperties:false, required:['consumptionRule','signatureChange','downgradableVsUnconditional','backwardCompat','recording','testPlan','risks'],
  properties:{ consumptionRule:{type:'string'}, signatureChange:{type:'string'}, downgradableVsUnconditional:{type:'string'}, backwardCompat:{type:'string'}, recording:{type:'string'}, testPlan:{type:'string'}, risks:{type:'array',items:{type:'string'}} } };

const IMPL_SCHEMA = { type:'object', additionalProperties:false, required:['filesChanged','summary','downgradeRule','backstopsPreserved','backwardCompatPreserved','recordingAdded','tscClean','tscErrors','notes'],
  properties:{ filesChanged:{type:'array',items:{type:'string'}}, summary:{type:'string'}, downgradeRule:{type:'string'}, backstopsPreserved:{type:'boolean'}, backwardCompatPreserved:{type:'boolean'}, recordingAdded:{type:'string'}, tscClean:{type:'boolean'}, tscErrors:{type:'string'}, notes:{type:'string'} } };

const TEST_SCHEMA = { type:'object', additionalProperties:false, required:['testsAdded','commands','pass','failures','output'],
  properties:{ testsAdded:{type:'array',items:{type:'string'}}, commands:{type:'array',items:{type:'string'}}, pass:{type:'boolean'}, failures:{type:'string'}, output:{type:'string'} } };

const VERIFY_SCHEMA = { type:'object', additionalProperties:false, required:['buildOk','testsPass','buildTail','testTail','failures'],
  properties:{ buildOk:{type:'boolean'}, testsPass:{type:'boolean'}, buildTail:{type:'string'}, testTail:{type:'string'}, failures:{type:'string'} } };

const SKEPTIC_SCHEMA = { type:'object', additionalProperties:false, required:['invariant','holds','evidence','gaps'],
  properties:{ invariant:{type:'string'}, holds:{type:'boolean'}, evidence:{type:'string'}, gaps:{type:'string'} } };

phase('Baseline');
const baseline = await agent(
  HEAD + '\n\nBASELINE (READ-ONLY): map the exact current blocking logic (reviewQualityBlockingReasons, readLatestReviewGate, applyReviewOutcome — signatures + how each blocking decision is made), the finding_challenge evidence payload shape from RE-1 + how to read the latest one for a slice, the hard-backstop sites that must stay unconditional, and the recording hooks (residualRisks + createEvent/addEvent). Cite file:line.',
  { label:'baseline', phase:'Baseline', schema: BASELINE_SCHEMA });

phase('Design');
const design = await agent(
  HEAD + '\n\nBASELINE:\n' + JSON.stringify(baseline) + '\n\nDesign RE-2: the consumption rule (how a skeptic verdict maps to + downgrades a blocking reason), the minimal signature change to make the gate slice/store-aware while keeping a byte-identical no-skeptic path, the EXACT downgradable-vs-unconditional split (quality-gate dimensions/blockingConcerns downgradable; backstops never), how downgrades are recorded (residualRisk + event), and the fixture test plan covering all 5 safety cases. Default-keep-blocking unless an independent skeptic EXPLICITLY refuted.',
  { label:'design', phase:'Design', schema: DESIGN_SCHEMA });

phase('Implement');
const impl = await agent(
  HEAD + '\n\nAPPROVED DESIGN:\n' + JSON.stringify(design) + '\n\nImplement RE-2 now. Make the gate consume the latest independent finding_challenge evidence to downgrade ONLY quality-gate findings the skeptic explicitly refuted; keep hard backstops unconditional; keep the no-skeptic path byte-identical; record every downgrade (residualRisk + event). Run `npx tsc` and fix your own errors until clean. Confirm backstopsPreserved + backwardCompatPreserved.',
  { label:'impl', phase:'Implement', schema: IMPL_SCHEMA });

phase('Test');
const tests = await agent(
  HEAD + '\n\nIMPLEMENTED:\n' + JSON.stringify(impl) + '\n\nAdd fixture/deterministic tests proving ALL FIVE safety cases (a)-(e) from the scope. Then run them plus the existing review/gate regression (tests/review-runner.e2e.test.js, tests/skeptic-runner.e2e.test.js, tests/live-agent-runner.e2e.test.js for the reviewer-repair path). Report HONESTLY.',
  { label:'test', phase:'Test', schema: TEST_SCHEMA });

phase('Verification');
const verify = await agent(
  'Independently verify RE-2 in x:/repositories/agent-swarm (do NOT edit code). Run `npm run build` then `node --test` on the new RE-2 test(s) plus tests/review-runner.e2e.test.js and tests/skeptic-runner.e2e.test.js. Report buildOk, testsPass, output tails, failures verbatim. Note any pre-existing unrelated failures (e.g. overseer-runner) separately.',
  { label:'verify', phase:'Verification', schema: VERIFY_SCHEMA });

phase('Skeptic');
const INVARIANTS = [
  'BACKSTOPS UNCONDITIONAL: no skeptic verdict can downgrade/clear source-mutation, human_input_required/human_required, failed/missing-evidence frAcFindings, or missing structured evidence. Prove by reading the code that these paths never consult skeptic verdicts.',
  'BACKWARD-COMPAT: with NO finding_challenge evidence, the blocking decision is byte-identical to before RE-2. Prove from the code + a test.',
  'INDEPENDENCE: only a finding_challenge from an independent skeptic actor (never the slice worker/reviewer actor) can downgrade. Prove the actor check.',
  'DEFAULT-KEEP-BLOCKING: only an EXPLICIT skeptic refusal/residual verdict downgrades; real/uncertain/unmatched findings still block. No silent weakening of acceptance.',
];
const skeptics = await parallel(INVARIANTS.map((invariant, i) => () =>
  agent(MISSION + '\n\nADVERSARIAL SKEPTIC (READ-ONLY). Try to BREAK ONE safety invariant of the RE-2 implementation in x:/repositories/agent-swarm by re-reading the code. INVARIANT: ' + invariant + ' Default holds=false unless you can prove it holds with file:line citations. If you can construct a case that weakens acceptance, report it as a gap.',
    { label:'skeptic:'+i, phase:'Skeptic', schema: SKEPTIC_SCHEMA }).catch(() => null)));

const sk = skeptics.filter(Boolean);
return {
  baseline, design, impl, tests, verify,
  skeptics: sk,
  allInvariantsHold: sk.length === INVARIANTS.length && sk.every((s) => s.holds),
  gaps: sk.filter((s) => !s.holds).map((s) => ({ invariant: s.invariant, gaps: s.gaps })),
};