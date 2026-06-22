export const meta = {
  name: 're1-independent-skeptic',
  description: 'RE-1: independent skeptic agent role + finding_challenge evidence kind (foundation; does NOT change the accept gate)',
  phases: [
    { title: 'Baseline', detail: 'map review dispatch, evidence/event recording, role/skill plumbing, types' },
    { title: 'Design', detail: 'skeptic dispatch + result schema + prompt + CLI command + independence' },
    { title: 'Implement', detail: 'add skeptic role/evidence kind/dispatch; self-build' },
    { title: 'Test', detail: 'fixture-driver skeptic test: independence + finding_challenge evidence' },
    { title: 'Verify', detail: 'independent build + targeted tests' },
    { title: 'Skeptic', detail: 'confirm independence, additive, evidence/events recorded' },
  ],
};

const MISSION = [
  'AGENT-SWARM (docs/architecture/core-philosophy.md): converts immutable requirements into verified',
  'implementation state. NON-NEGOTIABLES bounding RE-1:',
  '- WORKERS MAY NOT create/edit/weaken/APPROVE the criteria used to accept their own work, and review',
  '  must be INDEPENDENT. So the skeptic MUST be a DISTINCT agent run: a distinct role + actor, never the',
  '  worker and never the same reviewer session/actor. This independence is the whole point of RE-1.',
  '- Status/rollups derive from the requirement LEDGER + recorded evidence/events, not chat memory: the',
  "  skeptic's verdicts must be persisted as durable evidence + harness events.",
  '- MODEL-AGNOSTIC: the skeptic dispatch must work through the existing driver registry (codex/claude/',
  '  fixture), exactly like the worker/reviewer dispatch. No Claude-only path.',
  '- ADDITIVE: do NOT change the accept/gate behavior in this slice. applyReviewOutcome and the',
  '  review-quality gate must behave EXACTLY as before. RE-1 only ADDS the skeptic capability + records',
  '  its verdicts; consuming them in gating is RE-2 (out of scope here).',
].join('\n');

const FACTS = [
  'CONFIRMED ANCHORS (verify exact lines by grep; cli.ts ~6900 lines):',
  '- AgentRole (src/types.ts:25): "overseer"|"planner"|"worker"|"verifier"|"reviewer"|"recovery" — ADD "skeptic".',
  '- EvidenceRecord.kind (src/types.ts:174): "command"|"worker_result"|"review_result"|"artifact"|"note" —',
  '  ADD "finding_challenge". (src/types.ts is otherwise user-owned; keep these two additions SURGICAL.)',
  '- Storage evidence kind is permissive: src/schemas.ts:16 `kind: z.string().min(1)` — already accepts a new',
  '  kind, no DB/zod change needed there.',
  '- executeReviewRun (src/cli.ts:2626) is the dispatch TEMPLATE: it builds a prompt + result schema, runs the',
  '  driver via the adapter, ingests JSONL, and records evidence with kind:"review_result" (cli.ts:2814-2817),',
  '  role:"reviewer", a distinct actor. Mirror this for the skeptic (role:"skeptic", a distinct actor).',
  '- applyReviewOutcome (src/cli.ts:4078) is the accept/gate path — DO NOT MODIFY IT in RE-1.',
  '- The latest reviewResult (the findings to challenge) is read via reviewResultSchema.safeParse of the',
  '  review_result evidence (see readReviewResultFile / readLatestReviewGate). The skeptic challenges those',
  "  findings (reviewResult.frAcFindings + qualityGate.dimensions + requiredFixes).",
  '- Skill binding: protocol.skills.roles (src/protocol.ts:103-107) maps required skills per role and the',
  '  harness BLOCKS dispatch if a required skill is missing. Give the skeptic role a skills entry (it may',
  "  reuse the reviewer's skills like sleuth-review/verification-obligations) so dispatch is not blocked;",
  '  use the fixture driver in tests to avoid real provider spend.',
  '- The Zod result schemas live in src/schemas.ts (workerResultSchema, reviewResultSchema, overseerDecisionSchema).',
  '  Add a skeptic result schema there; the driver JSON Schema is now generated from Zod (SO-1, src/schema-json.ts',
  '  writeSchemaFromZod) — reuse that generator for the skeptic schema file.',
].join('\n');

const SCOPE = [
  'SCOPE — RE-1 FOUNDATION ONLY:',
  '1. types.ts: add "skeptic" to AgentRole and "finding_challenge" to EvidenceRecord.kind (surgical).',
  '2. schemas.ts: add a `skepticResultSchema` (Zod) — a per-finding challenge verdict, e.g. { status: enum;',
  '   summary; findingVerdicts: array of { ref?: string; dimension?: string; verdict: "real"|"refuted"|',
  '   "uncertain"; severity: "blocker"|"major"|"minor"|"nit"; reasoning: string }; recommendation }. Choose',
  '   fields that let RE-2 later decide per-finding blocking. Export its type.',
  '3. A skeptic dispatch function (mirror executeReviewRun) that: reads the latest reviewResult for a slice,',
  '   builds an independent skeptic prompt (challenge each finding; DEFAULT-REJECT: prefer verdict "refuted"',
  '   when uncertain; you are independent, you are NOT the worker or reviewer), runs the driver via the',
  '   adapter with the generated skeptic schema, ingests JSONL/heartbeats, and records the verdict as',
  '   insertEvidence kind:"finding_challenge" (role:"skeptic", a distinct actor) PLUS skeptic.* harness',
  '   events (e.g. skeptic.started / skeptic.completed / skeptic.finding_challenged). Enforce independence:',
  '   reject/guard if the requested skeptic actor equals the worker or reviewer actor for the slice.',
  '4. A CLI command `swarm skeptic <sliceId> --actor <actor> --driver <driver>` that invokes the dispatch.',
  '   (Mirror the `swarm review` command wiring.) This makes RE-1 runnable + testable on its own.',
  '5. Skill binding for the skeptic role in protocol.ts (reuse reviewer skills) so dispatch is not blocked.',
  '6. Tests (fixture driver, deterministic): prove (a) the skeptic runs as a DISTINCT role+actor, (b) it',
  '   records finding_challenge evidence + skeptic events, (c) independence guard rejects reusing the worker/',
  '   reviewer actor, (d) applyReviewOutcome / the accept gate behavior is UNCHANGED (a regression assert).',
  '',
  'OUT OF SCOPE (do NOT do here): changing applyReviewOutcome / readLatestReviewGate / reviewQualityBlockingReasons',
  'gating (that is RE-2); auto-running the skeptic inside the live acceptance loop; SC-*/OCF-*.',
].join('\n');

const RULES = [
  'RULES: working tree clean at HEAD (a026626). Build on top. NEVER git reset/checkout/clean/discard.',
  'Self-verify with `npx tsc`; fix your own errors until clean. Use the fixture driver in tests (no real',
  'provider spend). cli.ts is huge: grep to locate, targeted Edits only, never rewrite whole files. Report',
  'honestly; never claim a test passed you did not run. Reuse the SO-1 generator (src/schema-json.ts) for',
  'the skeptic JSON Schema file rather than hand-writing one.',
].join('\n');

const HEAD = MISSION + '\n\n' + FACTS + '\n\n' + SCOPE + '\n\n' + RULES;

const BASELINE_SCHEMA = { type:'object', additionalProperties:false, required:['reviewDispatch','evidenceAndEvents','roleSkillPlumbing','cliWiring','accptGateToLeaveAlone','tests'],
  properties:{
    reviewDispatch:{type:'string', description:'how executeReviewRun builds prompt/schema, runs driver, ingests, records — with citations; what to mirror'},
    evidenceAndEvents:{type:'string', description:'how evidence is inserted + how harness events are created (createEvent/addEvent), with citations'},
    roleSkillPlumbing:{type:'string', description:'how roles get skill bindings + how dispatch blocks on missing skills; how to add skeptic'},
    cliWiring:{type:'string', description:'how the `swarm review` command is wired (for mirroring a `swarm skeptic` command)'},
    accptGateToLeaveAlone:{type:'string', description:'exact applyReviewOutcome / gate functions to NOT modify'},
    tests:{type:'array', items:{type:'string'}} } };

const DESIGN_SCHEMA = { type:'object', additionalProperties:false, required:['skepticResultSchema','dispatchDesign','independenceGuard','cliCommand','skillBinding','testPlan','risks'],
  properties:{ skepticResultSchema:{type:'string'}, dispatchDesign:{type:'string'}, independenceGuard:{type:'string'}, cliCommand:{type:'string'}, skillBinding:{type:'string'}, testPlan:{type:'string'}, risks:{type:'array',items:{type:'string'}} } };

const IMPL_SCHEMA = { type:'object', additionalProperties:false, required:['filesChanged','summary','newEvidenceKind','newRole','events','tscClean','tscErrors','gateUnchanged','notes'],
  properties:{ filesChanged:{type:'array',items:{type:'string'}}, summary:{type:'string'}, newEvidenceKind:{type:'string'}, newRole:{type:'string'}, events:{type:'array',items:{type:'string'}}, tscClean:{type:'boolean'}, tscErrors:{type:'string'}, gateUnchanged:{type:'boolean', description:'true if applyReviewOutcome/gate code is byte-unchanged'}, notes:{type:'string'} } };

const TEST_SCHEMA = { type:'object', additionalProperties:false, required:['testsAdded','commands','pass','failures','output'],
  properties:{ testsAdded:{type:'array',items:{type:'string'}}, commands:{type:'array',items:{type:'string'}}, pass:{type:'boolean'}, failures:{type:'string'}, output:{type:'string'} } };

const VERIFY_SCHEMA = { type:'object', additionalProperties:false, required:['buildOk','testsPass','buildTail','testTail','failures'],
  properties:{ buildOk:{type:'boolean'}, testsPass:{type:'boolean'}, buildTail:{type:'string'}, testTail:{type:'string'}, failures:{type:'string'} } };

const SKEPTIC_SCHEMA = { type:'object', additionalProperties:false, required:['aspect','met','evidence','gaps'],
  properties:{ aspect:{type:'string'}, met:{type:'boolean'}, evidence:{type:'string'}, gaps:{type:'string'} } };

phase('Baseline');
const baseline = await agent(
  HEAD + '\n\nBASELINE (READ-ONLY): map executeReviewRun (dispatch template), how evidence + harness events are recorded, how role skill-bindings work + where dispatch blocks on missing skills, how the `swarm review` CLI command is wired, and the EXACT accept-gate functions to leave untouched (applyReviewOutcome/readLatestReviewGate/reviewQualityBlockingReasons). Cite file:line.',
  { label:'baseline', phase:'Baseline', schema: BASELINE_SCHEMA });

phase('Design');
const design = await agent(
  HEAD + '\n\nBASELINE:\n' + JSON.stringify(baseline) + '\n\nDesign RE-1: the skepticResultSchema (Zod), the dispatch function (mirroring executeReviewRun), the independence guard (reject reusing worker/reviewer actor), the `swarm skeptic` CLI command, the skeptic skill binding, and the fixture-driver test plan that also asserts the accept gate is UNCHANGED.',
  { label:'design', phase:'Design', schema: DESIGN_SCHEMA });

phase('Implement');
const impl = await agent(
  HEAD + '\n\nAPPROVED DESIGN:\n' + JSON.stringify(design) + '\n\nImplement RE-1 now (foundation only; do NOT modify the accept gate). Surgical types.ts additions; new skepticResultSchema; skeptic dispatch + independence guard; `swarm skeptic` command; skeptic skill binding; reuse src/schema-json.ts for the schema file. Run `npx tsc` and fix your own errors until clean. Confirm the accept-gate code is byte-unchanged.',
  { label:'impl', phase:'Implement', schema: IMPL_SCHEMA });

phase('Test');
const tests = await agent(
  HEAD + '\n\nIMPLEMENTED:\n' + JSON.stringify(impl) + '\n\nAdd fixture-driver tests proving: skeptic runs as a DISTINCT role+actor; records finding_challenge evidence + skeptic.* events; the independence guard rejects reusing the worker/reviewer actor; and the accept-gate behavior is unchanged. Run them. Report HONESTLY.',
  { label:'test', phase:'Test', schema: TEST_SCHEMA });

phase('Verification');
const verify = await agent(
  'Independently verify RE-1 in x:/repositories/agent-swarm (do NOT edit code). Run `npm run build` then `node --test` on the new skeptic test(s) plus tests/review-runner.e2e.test.js and tests/worker-driver.test.js (regression). Report buildOk, testsPass, output tails, failures verbatim. Be honest about any pre-existing unrelated failures.',
  { label:'verify', phase:'Verification', schema: VERIFY_SCHEMA });

phase('Skeptic');
const ASPECTS = [
  'independence: the skeptic is a distinct role AND actor, never the worker or the reviewer session, with a guard enforcing it',
  'persistence: skeptic verdicts are recorded as finding_challenge evidence AND skeptic.* harness events (ledger, not chat)',
  'additive-gate-unchanged: applyReviewOutcome / readLatestReviewGate / reviewQualityBlockingReasons are byte-unchanged; accept behavior is identical to before',
  'model-agnostic: dispatch goes through the driver registry (works for codex/claude/fixture), no Claude-only path',
];
const skeptics = await parallel(ASPECTS.map((aspect, i) => () =>
  agent(MISSION + '\n\nINDEPENDENT SKEPTIC (READ-ONLY). Verify ONE aspect of the RE-1 implementation in x:/repositories/agent-swarm by re-reading the code. ASPECT: ' + aspect + '. Default met=false unless you can prove it with file:line citations. List any gap.',
    { label:'skeptic:'+i, phase:'Skeptic', schema: SKEPTIC_SCHEMA }).catch(() => null)));

const sk = skeptics.filter(Boolean);
return {
  baseline, design, impl, tests, verify,
  skeptics: sk,
  allAspectsMet: sk.length === ASPECTS.length && sk.every((s) => s.met),
  gaps: sk.filter((s) => !s.met).map((s) => ({ aspect: s.aspect, gaps: s.gaps })),
};