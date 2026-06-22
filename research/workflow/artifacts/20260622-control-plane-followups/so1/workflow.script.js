export const meta = {
  name: 'so1-zod-to-jsonschema',
  description: 'SO-1: generate driver JSON Schemas from the Zod schemas (single source of truth) + parity test',
  phases: [
    { title: 'Baseline', detail: 'map the 3 writeXSchema writers, their consumers, and z.toJSONSchema behavior' },
    { title: 'Design', detail: 'generator design + diff strategy + parity test plan' },
    { title: 'Implement', detail: 'replace hand-written schemas with a generator; self-build' },
    { title: 'Test', detail: 'parity test + driver/schema consumer tests' },
    { title: 'Verify', detail: 'independent build + targeted tests' },
    { title: 'Skeptic', detail: 'confirm generated == at-least-as-strict, drivers still validate' },
  ],
};

const MISSION = [
  'AGENT-SWARM (docs/architecture/core-philosophy.md): converts immutable requirements into verified',
  'implementation state. NON-NEGOTIABLES bounding this work: MODEL-AGNOSTIC (codex + claude + fixture',
  'drivers must all keep working); the contract a worker/reviewer/overseer is HELD TO (the JSON Schema',
  'handed to the driver) must equal the contract its evidence is JUDGED BY (the Zod schema in',
  'src/schemas.ts). Do not weaken validation. Do not edit immutable specs.',
].join('\n');

const FACTS = [
  'CONFIRMED FACTS:',
  '- zod is 4.4.3 and `z.toJSONSchema` IS available (a function). Use it; do NOT add zod-to-json-schema.',
  '- Hand-written JSON Schema writers (the thing to replace) live in src/cli.ts:',
  '  writeWorkerResultSchema (~6859), writeReviewResultSchema (~6907), writeOverseerDecisionSchema (~7007).',
  '  Each fs.writeFileSync(schemaPath, <hand-written JSON Schema string>). VERIFY exact current lines by grep.',
  '- The canonical Zod schemas are exported from src/schemas.ts: workerResultSchema (line 38),',
  '  reviewResultSchema (81), overseerDecisionSchema (114). These are the single source of truth.',
  '- The written schema FILE is consumed at runtime by the drivers: codex via `--output-schema <file>`',
  '  and claude via `--json-schema <inlined json>` (see src/worker-driver.ts buildInvocation), and the',
  '  RESULT is validated post-hoc with Zod safeParse (worker-driver.ts validateResultArtifact / claude',
  '  finalize). So the generated JSON Schema must be COMPATIBLE with what those CLIs accept AND must not',
  '  be looser than the Zod schema.',
].join('\n');

const SCOPE = [
  'SCOPE — SO-1 ONLY:',
  '1. Add ONE generator (e.g. writeSchemaFromZod(schemaPath, zodSchema) or a small module) that derives',
  '   the driver-facing JSON Schema from a Zod schema via z.toJSONSchema, configured so the output is at',
  '   least as strict as today: additionalProperties:false on objects and correct per-role required sets.',
  '   Match the JSON Schema draft/shape the CLIs already accept (compare against the current hand-written',
  '   output; if z.toJSONSchema defaults differ in a way that matters, pass options to align).',
  '2. Replace the bodies of writeWorkerResultSchema / writeReviewResultSchema / writeOverseerDecisionSchema',
  '   to call the generator with workerResultSchema / reviewResultSchema / overseerDecisionSchema. Keep the',
  '   same function names + signatures + call sites (additive at the call-site level).',
  '3. Add tests/schema-parity.test.js asserting, for each of the 3 roles: (a) the GENERATED schema and the',
  '   Zod schema agree on a set of valid + invalid fixtures (Zod safeParse is the oracle; if a JSON-schema',
  '   validator like ajv is available use it, otherwise assert structural parity: additionalProperties===false,',
  '   required matches the Zod required keys, property names cover the Zod shape); (b) the generator output is',
  '   deterministic/stable.',
  'OUT OF SCOPE: RE-1, RE-2, SC-*, OCF-*, any non-schema change. Do not alter the Zod schemas themselves',
  'unless strictly required to make generation faithful (and call it out if so).',
  '',
  'CRITICAL CORRECTNESS: before finalizing, DIFF the generated JSON Schema against the current hand-written',
  'one for each role. The generated one must be EQUIVALENT-OR-STRICTER (never accept something the old one',
  'rejected). Run the existing driver/schema tests (tests/worker-driver.test.js, tests/review-runner.e2e.test.js,',
  'and any claude-reviewer / schema tests) and confirm they still pass.',
].join('\n');

const RULES = [
  'RULES: working tree is clean at HEAD (5328f02). Build on top. NEVER git reset/checkout/clean/discard.',
  'Self-verify TypeScript with `npx tsc` and fix your own errors until clean. cli.ts is ~6900 lines: grep to',
  'locate, make targeted Edits, never rewrite whole files. Report honestly; do not claim a test passed you',
  'did not run.',
].join('\n');

const HEAD = MISSION + '\n\n' + FACTS + '\n\n' + SCOPE + '\n\n' + RULES;

const BASELINE_SCHEMA = { type:'object', additionalProperties:false, required:['writers','consumers','toJsonSchemaNotes','tests'],
  properties:{
    writers:{type:'array', items:{type:'object', additionalProperties:false, required:['fn','file','shapeNotes'], properties:{fn:{type:'string'},file:{type:'string'},shapeNotes:{type:'string'}}}},
    consumers:{type:'string', description:'how the written schema file is used by codex/claude + Zod validation, with citations'},
    toJsonSchemaNotes:{type:'string', description:'how z.toJSONSchema 4.4.3 behaves: default draft, additionalProperties, $refs, options needed to match the hand-written shape'},
    tests:{type:'array', items:{type:'string', description:'existing test files that exercise the schemas/drivers'}} } };

const DESIGN_SCHEMA = { type:'object', additionalProperties:false, required:['generator','perRoleNotes','parityTestPlan','risks'],
  properties:{
    generator:{type:'string', description:'exact generator signature + z.toJSONSchema options to match the hand-written shape (additionalProperties:false, required, draft)'},
    perRoleNotes:{type:'string', description:'any per-role differences the generated schema must handle (e.g. defaults like reviewResult.qualityGate)'},
    parityTestPlan:{type:'string', description:'what tests/schema-parity.test.js asserts + whether ajv is available'},
    risks:{type:'array', items:{type:'string'}} } };

const IMPL_SCHEMA = { type:'object', additionalProperties:false, required:['filesChanged','summary','generatedVsHandwritten','tscClean','tscErrors','notes'],
  properties:{ filesChanged:{type:'array',items:{type:'string'}}, summary:{type:'string'},
    generatedVsHandwritten:{type:'string', description:'result of diffing generated vs hand-written per role; confirm equivalent-or-stricter'},
    tscClean:{type:'boolean'}, tscErrors:{type:'string'}, notes:{type:'string'} } };

const TEST_SCHEMA = { type:'object', additionalProperties:false, required:['testsAdded','commands','pass','failures','output'],
  properties:{ testsAdded:{type:'array',items:{type:'string'}}, commands:{type:'array',items:{type:'string'}}, pass:{type:'boolean'}, failures:{type:'string'}, output:{type:'string'} } };

const VERIFY_SCHEMA = { type:'object', additionalProperties:false, required:['buildOk','testsPass','buildTail','testTail','failures'],
  properties:{ buildOk:{type:'boolean'}, testsPass:{type:'boolean'}, buildTail:{type:'string'}, testTail:{type:'string'}, failures:{type:'string'} } };

const SKEPTIC_SCHEMA = { type:'object', additionalProperties:false, required:['role','equivalentOrStricter','driversStillValidate','additionalPropertiesFalse','requiredPreserved','evidence','gaps'],
  properties:{ role:{type:'string'}, equivalentOrStricter:{type:'boolean'}, driversStillValidate:{type:'boolean'}, additionalPropertiesFalse:{type:'boolean'}, requiredPreserved:{type:'boolean'}, evidence:{type:'string'}, gaps:{type:'string'} } };

phase('Baseline');
const baseline = await agent(
  HEAD + '\n\nBASELINE (READ-ONLY): read the 3 writeXSchema functions, the Zod schemas, how worker-driver.ts + cli.ts consume the written schema file, how the result is Zod-validated, and empirically check how z.toJSONSchema(workerResultSchema) renders in this repo (you may run a quick `node -e` against dist or a scratch). Note exactly what options are needed so the generated schema matches the hand-written shape (additionalProperties:false, required, draft). List existing tests that exercise schemas/drivers.',
  { label:'baseline', phase:'Baseline', schema: BASELINE_SCHEMA });

phase('Design');
const design = await agent(
  HEAD + '\n\nBASELINE:\n' + JSON.stringify(baseline) + '\n\nDesign the generator (signature + exact z.toJSONSchema options), per-role handling (watch reviewResult.qualityGate default + enums), and the schema-parity test plan. The generated schema MUST be equivalent-or-stricter than the hand-written one.',
  { label:'design', phase:'Design', schema: DESIGN_SCHEMA });

phase('Implement');
const impl = await agent(
  HEAD + '\n\nAPPROVED DESIGN:\n' + JSON.stringify(design) + '\n\nImplement SO-1 now: add the generator, replace the 3 writeXSchema bodies to use it (same names/signatures/call sites), and DIFF generated-vs-handwritten per role to confirm equivalent-or-stricter (report the diff result). Run `npx tsc` and fix your own errors until clean.',
  { label:'impl', phase:'Implement', schema: IMPL_SCHEMA });

phase('Test');
const tests = await agent(
  HEAD + '\n\nIMPLEMENTED:\n' + JSON.stringify(impl) + '\n\nAdd tests/schema-parity.test.js per the design. Then run it plus the existing driver/schema tests (tests/worker-driver.test.js, tests/review-runner.e2e.test.js, and any claude-reviewer/schema tests you found). Report results HONESTLY.',
  { label:'test', phase:'Test', schema: TEST_SCHEMA });

phase('Verification');
const verify = await agent(
  'Independently verify SO-1 in x:/repositories/agent-swarm (do NOT edit code). Run `npm run build` (tsc && web) then `node --test tests/schema-parity.test.js tests/worker-driver.test.js tests/review-runner.e2e.test.js`. Report buildOk, testsPass, output tails, failures verbatim.',
  { label:'verify', phase:'Verification', schema: VERIFY_SCHEMA });

phase('Skeptic');
const ROLES = ['worker','review','overseer'];
const skeptics = await parallel(ROLES.map((role) => () =>
  agent(MISSION + '\n\nINDEPENDENT SKEPTIC (READ-ONLY) for the ' + role + ' schema. After SO-1, the driver JSON Schema is generated from Zod. Re-read the generator + the ' + role + ' Zod schema + the generated output. Confirm with citations: generated schema is EQUIVALENT-OR-STRICTER than the prior hand-written one (never looser), objects have additionalProperties:false, required is preserved, and the drivers still validate results. Default the booleans to false unless you can prove them from the code/output.',
    { label:'skeptic:'+role, phase:'Skeptic', schema: SKEPTIC_SCHEMA }).catch(() => null)));

const sk = skeptics.filter(Boolean);
return {
  baseline, design, impl, tests, verify,
  skeptics: sk,
  allRolesStrict: sk.length === ROLES.length && sk.every((s) => s.equivalentOrStricter && s.driversStillValidate && s.additionalPropertiesFalse && s.requiredPreserved),
  skepticGaps: sk.filter((s) => !(s.equivalentOrStricter && s.driversStillValidate && s.additionalPropertiesFalse && s.requiredPreserved)).map((s) => ({ role: s.role, gaps: s.gaps })),
};