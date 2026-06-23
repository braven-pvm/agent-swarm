# Current Project Memory

Last updated: 2026-06-23

This file is the durable handoff memory for the current state of `agent-swarm`. It should let a fresh agent resume without relying on the chat transcript.

## Latest Handoff Update

2026-06-23 repair-budget reset hardening:

- Repair retry exhaustion is now resettable without erasing history. Use:

```powershell
node dist\cli.js recovery reset-repair-budget SLICE-... --reason "human approved another focused repair attempt" --actor human-ui
```

- The reset writes `repair.retry_budget_reset`, clears active `Repair retry budget exhausted.` blockers for that slice only, and preserves all historical worker/reviewer runs.
- The H2 live runner now treats the latest reset event as a new retry epoch: repair-budget counts and "latest worker after repair" checks use only worker/reviewer runs started after the reset. Old retry pressure remains visible but no longer blocks the next focused repair.
- Repair-proof, retry-budget, and stale-run blockers are filtered out of worker `repairProof[]` requirements. They can remain visible recovery/dispatch signals, but workers prove the canonical underlying review/human/operational repair cause rather than proving a self-referential harness blocker.
- Live restart after this change exposed a driver-facing schema issue: Codex/OpenAI strict structured outputs require every property on the root output object and every nested object to appear in `required`. `workerResultSchema.repairProof` is now required with default `[]`; repair-proof entry optional fields and skeptic verdict optional fields are now required-with-defaults. Worker prompts explicitly instruct agents to emit `repairProof: []` when no targeted repair context exists.
- The same restart exposed a stale-artifact recovery bug: direct worker runs reused the fixed `worker-result.json` path, so a failed/no-output child could be mistaken for success by validating an old result file, and an interrupted later worker could erase prior valid proof. Worker result/event/stderr artifacts are now run-scoped (`worker-result-RUN-....json`, `worker-events-RUN-....jsonl`, `worker-stderr-RUN-....log`). Artifact recovery now validates the current run's unique result path, while historical evidence keeps its own path.
- A later continuation exposed stale recovery blockers as permanent acceptance blockers: old `Agent run RUN-... is stale after ...` slice blockers still blocked verification even after a newer worker passed repair proof and review accepted. Verification now clears stale-run blockers when a later successful same-role run supersedes them, emitting `escalation.cleared` with `clearedAfterVerificationSupersededRun: true`.
- `tests/schema-parity.test.js` now asserts nested role-output objects require every property so this strict-schema failure class is caught before live agent runs.
- Focused verification passed:

```text
npm run build -> passed
node --test tests\invoice-demo.e2e.test.js -> 12/12 passing
node --test tests\result-journal.e2e.test.js -> 6/6 passing
node --test tests\schema-parity.test.js -> 20/20 passing
node --test tests\structured-result-reask.e2e.test.js -> 6/6 passing
node --test tests\support-triage-live-runner.e2e.test.js -> 9/9 passing
```

2026-06-22 repair-proof hardening:

- Latest H2 real run exposed a real repair-loop failure class: agents received concrete reviewer/human repair context, returned schema-valid `passed` worker results, but did not prove that they addressed the specific blockers. The harness now treats targeted repair proof as a generic engine invariant, not an H2-specific convention.
- `workerResultSchema` now supports optional `repairProof[]` entries with `source` (`required_fix`, `non_passing_ref`, `human_feedback`, `active_blocker`), `ref`, `item`, `status`, evidence, changed files, and commands.
- When a slice has targeted repair context, the worker prompt lists exact repair-proof requirements. `executeWorkerRun` validates the structured worker result against those requirements before marking the slice `implemented` or storing it in the result journal.
- A generic repair result is now rejected before review: the slice stays `repairing`, the worker heartbeat is blocked, `worker.repair_proof_failed` is emitted, the worker-result evidence carries `repairProofGate`, and an active slice blocker says `Worker result did not address targeted repair context.`
- Deterministic verification also refuses worker evidence whose persisted `repairProofGate.passed === false`.
- H2 targeted repair dispatch now treats active scoped blockers as repair context, so a failed repair-proof gate becomes a fresh repair signal instead of a dead-end blocked slice.
- Worker repair-proof blockers are agent-resolvable. A later worker result for the same slice that passes `repairProofGate` automatically clears the active blocker `Worker result did not address targeted repair context.`, emits `escalation.cleared` with `clearedAfterWorkerRepairProofPassed: true`, and emits `worker.repair_proof_cleared`. Review blockers still require independent review acceptance.
- UI/API contract note is documented in `docs/architecture/local-control-api.md` under "Agent-Resolvable Repair Proof Blockers".
- Focused verification passed:

```text
npm run build -> passed
node --test tests\support-triage-live-runner.e2e.test.js -> 8/8 passing
node --test tests\web-server.e2e.test.js tests\coverage.test.js tests\fr-focused.e2e.test.js tests\settled-facts.e2e.test.js tests\focus-packet.e2e.test.js -> 19/19 passing
git diff --check -> clean
```

- A full `npm test` attempt hit the 10-minute wrapper timeout in the known long `tests/live-agent-runner.e2e.test.js` path; the leftover npm/node test processes were stopped. Do not count the full suite as passed for this slice until the long-runner timeout issue is addressed separately.

2026-06-22 post-Workflow reassessment:

- The Claude Workflow handoff has been implemented on `main` and pushed. Recent commits added schema-invalid result re-ask, shared driver result validation/persistence, lazy skeptic review in the live loop, lane-budget enforcement, bounded concurrent dependency-satisfied slice dispatch, deterministic overseer fast-paths, extracted hard run guards, ledger-derived settled facts in worker/revive prompts, structured focus/intervention packets, recovery `focus_consulted` events, and an opt-in content-addressed worker-result journal prototype.
- H2 remains the right real-world smoke case: Customer Support Triage Board should still prove a fresh swarm can start from immutable multi-domain specs and end with a real working product. Do not reshape support-triage specs just to trigger every new engine-room branch.
- The next clean run should use a two-layer proof: first run focused control-plane regressions for settled facts/interventions/focus packets plus H2 fake/live-runner regressions; then run H2 from scratch through the built CLI with the dashboard on `http://127.0.0.1:4319/`.
- Clean preflight sequence:

```powershell
npm run build
node --test tests\fr-focused.e2e.test.js tests\settled-facts.e2e.test.js tests\focus-packet.e2e.test.js
node --test tests\support-triage-fake.e2e.test.js tests\support-triage-live-runner.e2e.test.js
git diff --check
```

- Deterministic H2 confidence run:

```powershell
npm run demo:live-agent:h2:fake
```

- Standard clean observability server for the next real H2 run:

```powershell
node dist\cli.js smoke live-agent reset --scenario live-agent-smoke-h2
node dist\cli.js serve --workspace .swarm-demo\live-agent-smoke-h2 --host 127.0.0.1 --port 4319
```

- Real run command after the reset/serve step:

```powershell
node dist\cli.js smoke live-agent full --scenario live-agent-smoke-h2
```

- During that run, observe that outcome, product readiness, global coverage, active concerns, human actions, focus interventions, settled-facts artifacts, and skill-isolation warnings remain separate visible truths. Use `full --reset` only when no same-workspace UI server needs to stay up, or trigger reset through Command Bridge so the server can exclude itself from reset cleanup.
- Reassessment verification passed:

```text
npm run build -> passed
node --test tests\fr-focused.e2e.test.js tests\settled-facts.e2e.test.js tests\focus-packet.e2e.test.js -> 13/13 passing
node --test tests\support-triage-fake.e2e.test.js tests\support-triage-live-runner.e2e.test.js -> 9/9 passing
git diff --check -> clean
npm run demo:live-agent:h2:fake -> passed after support-ui review server cleanup fix
```

- The first direct H2 fake wrapper attempt exposed a real reset-first issue: a relative `node -e "import('./src/server.js')..."` support-ui review probe stayed alive after tests and pinned `.swarm-demo/live-agent-smoke-h2`. Root cause was `createReviewServer()` closing the UI server but not its companion support-api server. `fixtures/templates/support-ui/src/server.js` now closes the companion API server when the returned review server closes; after the fix, the H2 fake wrapper reset and ran cleanly, and no H2/support-ui probe processes or relevant ports remained.

2026-06-20 human-verification rework/control update:

- Command Bridge trusted-local control endpoints now exist for UI buttons: `POST /api/control/continue`, `POST /api/control/recovery/scan`, `POST /api/control/recovery/revive`, `POST /api/control/recovery/restart`, `POST /api/control/dev-server/start`, `GET /api/control/commands`, and `GET /api/control/dev-servers`.
- Human verification cannot be blind. `/api/human-actions` now includes `reviewTarget` for human-verification actions, with target name/path, resolved review command availability, `startAction` template, unavailable reason, packet/focus/source links, immutable requirement text/context, responsible party, expected outcomes, and review instructions. UI should show the packet plus runnable URL path, or clearly block/signpost when no review server can be started.
- `POST /api/control/dev-server/start` now resolves a stack-agnostic review command before spawning. It checks `.swarm/target.yaml` `reviewEnvironment.command`, target `commands.review/dev/start/preview`, then package scripts. It returns `400` without allocating a URL if no review command exists. When it does spawn, the returned server record includes `displayCommand`, `openable`, and `readiness`; the UI must only open the URL when `openable === true` and `readiness.status === "passed"`.
- Failed or `needs_rework` human verification is now autonomous repair input, not a terminal human wait and not a repeat human-action item. Once the human records any result, the ref leaves `/api/human-actions`; the evidence and slice state feed targeted repair so the affected slice can be repaired, reviewed, verified, and then re-presented for human sign-off.
- On 2026-06-20 the H2 Command Bridge process on `127.0.0.1:4319` had stopped, causing UI controls to report `Failed to fetch`; restarting `swarm serve --workspace .swarm-demo/live-agent-smoke-h2-rerun --host 127.0.0.1 --port 4319` restored control calls. A bounded real continuation `H2-CONT-HUMAN-REWORK-SMOKE-20260620T0832Z` then dispatched `dashboard-worker` for failed human-verification slice `SLICE-349e94c3` and moved it from `blocked` to `implemented`.
- Reset-first from the UI used to kill the Command Bridge itself because reset cleanup found the bridge artifact/port inside the workspace. Control-spawned commands now set `SWARM_RESET_EXCLUDE_PIDS` and `SWARM_RESET_EXCLUDE_PORTS`, and reset cleanup honors them so product/dev servers can be stopped without killing the bridge.
- The live H2 workspace `.swarm-demo/live-agent-smoke-h2-rerun` was resumed through `POST /api/control/continue` with run id `H2-CONT-20260619T125802Z`; this did real work, not a fake test. It pulled `SLICE-b0661a76`, launched `dashboard-worker`, completed `FR-SUP-UI-001` / `AC-SUP-UI-001.1..001.4`, and then launched `dashboard-reviewer`.
- Recovery scan through `POST /api/control/recovery/scan` works. With the normal `300s` threshold it reported no stale runs during the healthy worker/reviewer flow; with an intentionally tiny threshold it can surface quiet-but-active runs, so the UI should gate revive/restart on real stale/failed state rather than every quiet period.
- `support-ui` in the current H2 rerun now has a runnable review shell: `npm start` runs `src/server.js`, serves the generated UI modules, and proxies `/api/*` to sibling `support-api`. The first live instance started through `POST /api/control/dev-server/start` is `http://127.0.0.1:56981/`, with readiness passed. Human-verification cards should expose this through `reviewTarget.startAvailable === true`; stale browser/UI state may need a refresh.
- Session persistence for recovery was hardened: live JSONL ingestion now writes discovered `thread_id`/`session_id` to `agent_runs.session_id` as soon as it appears, and `swarm recovery revive` can recover a missing DB session id from the run's JSONL artifact before attempting same-session resume.
- Focused verification passed: `npm run build`, `node --test tests\support-triage-live-runner.e2e.test.js`, and `git diff --check`.
- The dashboard server has been restarted at `http://127.0.0.1:4319/` from workspace `.swarm-demo/live-agent-smoke-h2-rerun` after the continue command completed, so the live API exposes the new `reviewTarget` and dev-server readiness contract.

The invoice live smoke is now the control scenario for future hardening. Latest accepted control run:

- run id: `LAR-20260618T141404-live-agent-smoke-none-13300`
- started: `2026-06-18T14:14:04.665Z`
- generated: `2026-06-18T15:41:19.343Z`
- elapsed: about `1h 27m`
- final outcome: `accepted`
- final reason: full-product readiness passed and indexed FR/AC coverage is complete
- coverage: `83/83`
- slices: `11`
- agent runs: `48`
- deterministic verification runs: `11`
- product readiness: passed
- active escalations: `0`
- history: `.swarm-demo/live-agent-run-history/LAR-20260618T141404-live-agent-smoke-none-13300`

Important lessons from this run and the immediately preceding hardening:

- Codex child workers/reviewers need explicit trusted-local bypass in this harness. `workspace-write` was not enough under disabled approvals, so the driver now supports `bypassApprovalsAndSandbox` and the default trusted local Codex config enables it for non-read-only child runs.
- The visible overseer remains read-only even while worker/reviewer children can run with full trusted local access.
- Process logs and other long-lived server artifacts should not live under resettable workspaces, because Windows file locks can break reset-first semantics.
- UI uptime is not run duration. The UI should show server uptime, current run elapsed, and latest completed run duration separately.
- Invoice smoke should stay the control case; do not keep reshaping core engine behavior around invoice-specific product facts.

Next product-scenario track:

- Harness 2 uses Customer Support Triage Board.
- Immutable source specs now live under `docs/requirements/live-smoke-support-triage-*.md`.
- Scenario skills now live under `fixtures/scenarios/support-triage/.swarm/skills`.
- Harness 2 UI work now has focused `support-ui-implementation`, `support-ui-design-system`, `support-ui-review`, and `support-accessibility-review` skills.
- Phase 11B reset scaffold is implemented: `swarm smoke live-agent reset --scenario live-agent-smoke-h2` creates the support-triage workspace, targets, sources, copied skills, and reset-only manifest.
- Phase 11C fake-agent E2E is implemented: `swarm smoke live-agent fake --reset --scenario live-agent-smoke-h2` exercises backend/UI/design slices, reviewer-requested repair, repair escalation clearing, human-verification packets and sign-off, support UI product readiness, and missing-required-skill blocking before dispatch.
- Phase 11D live-run CLI boundary is implemented: `swarm smoke live-agent full --reset --scenario live-agent-smoke-h2` routes through the built CLI into the support-triage live runner, consumes scenario-declared readiness workflow metadata, invokes overseer/worker/reviewer `--driver codex` paths, and writes support-triage summary, coverage, graph, human-action, and product-readiness artifacts.
- The first tightly bounded real Phase 11D H2 run completed on 2026-06-18. It produced a runnable Customer Support Triage Board and passed product readiness, but the run correctly ended `blocked` because only `2/124` indexed refs were done inside the 12-turn bound. Accepted product refs were `FR-PROD-001`, `AC-PROD-001.1`, and `AC-PROD-001.2`; the detailed readiness artifact proved HTML, `/api/summary`, and assignment/status/note workflow probes.
- H2 observability hardening now makes `/api/run-observability` and `/api/snapshot.runObservability` follow `live-agent-smoke.json -> liveRun.summaryPath` and scenario-specific readiness artifacts such as `support-triage-live-artifacts/product-readiness.json`. The dashboard now reports H2 outcome `blocked`, readiness `passed`, workflow probe `true`, and support accepted refs instead of falling back to invoice-era filenames.
- Warning-restatement suppression was tightened for low-signal/proof-churn warning families, but the completed H2 workspace still contains old active warning restatements from the pre-fix run. A fresh run is needed to confirm the suppression in live state.
- Harness 2 must prove design tokens, human verification, backend-before-UI gating, project skills, richer workflow, and reviewer sleuthing without hard-coding support-triage behavior into the engine.
- H2 coverage-continuation hardening is implemented in `scripts/run-support-triage-live-demo.mjs`: when product readiness passes but indexed coverage is partial, the H2 runner records `finalCoverageGate`, creates a normal visible `coverage-completion-slice-created` slice grouped by immutable source/domain plus FR/AC family, and continues the worker/reviewer/verifier loop instead of stopping with only a generic max-turn reason. The selector prioritizes backend/API refs before product/UI/design refs and maps targets from the scenario manifest rather than support-triage hardcoding.
- H2 completion obligations are planner-created and immutable. Refs that explicitly require human verification (`HUMAN` refs or source text mentioning human verification) are marked `human_verification_required`; automated refs remain verifier-owned. This preserves the distinction between implementable work and human sign-off.
- Focused regression `tests/support-triage-live-runner.e2e.test.js` now proves the post-readiness continuation path creates a visible backend coverage slice for remaining `SUP-API-001` refs with immutable obligations and observable `coverage_completion.slice_created` events.
- Child Codex global-skill leakage is now detected: JSONL references to user-global `.codex/skills/...` paths produce `<role>.skill_isolation_detected`, a run-scoped warning escalation via `<role>.skill_isolation_warning`, `skillIsolationFindings` on completion/failure payloads, and `global_skill_leak` in `swarm inspect run` focus packets. This does not yet fully prevent global skill loading; auth-safe clean `CODEX_HOME` isolation remains a future driver-hardening item.
- Next H2 task: run a fresh real H2 pass with the dashboard open and confirm the real overseer/agents advance from readiness into coverage-completion slices rather than stopping at `2/124`.
- Test note: focused tests passed after the H2 observability fix (`web-server.e2e`, `support-triage-live-runner.e2e`, `invoice-demo.e2e`). A full `npm test` attempt on 2026-06-18 exceeded the shell timeout and was stopped while `tests/live-agent-runner.e2e.test.js` was in a long full-product title-variant run; treat that as a test-runner duration/hang follow-up, not a passing full-suite result.

## Human Intent

The user wants a real agentic development harness, not another rigid spec-ingestion product. The harness should coordinate autonomous agents implementing already-approved specs. It should scale development across lanes and sub-agents while preserving full visibility, FR/AC-centered verification, recovery, and management tracking.

The user is deliberately pushing against:

- hidden background sub-agent work
- AC-slice bureaucracy that produces tiny proof PRs without meaningful delivery progress
- frontend lanes being served work before backend capabilities are real
- brittle chat-memory dependence after compaction
- rigid database-first spec ingestion

## Product Principles Settled So Far

- Specs are immutable and served by the harness or source adapters.
- Spec mutation/creation belongs outside this implementation harness or in a separate explicit module.
- Source adapters read specs; status sinks write progress elsewhere.
- The harness owns slice state, leases, telemetry, evidence, checkpoints, and reports.
- Dynamic slices are preferred over pre-generated admin-heavy slice plans.
- Multi-FR/AC slices are allowed when verification can prove the underlying FR/ACs.
- Lanes are flexible contained development streams with required name/purpose/focus labels.
- Worktrees should be per feature/component/lane, not blindly per slice.
- The planner has autonomy within project/protocol maximums.
- The planner must optimize coherence first and cadence a very close second.
- No fake-ready UI work by default. UI work should depend on accepted backend FR/ACs.
- Verification against FR/ACs is the glue that holds the system together.
- No executable slice without harness-owned verification obligations for each included FR/AC.
- Implementing agents may not create, edit, weaken, or approve the verification obligations used to accept their own work.
- `human_input_required` blocks the affected FR/AC, slice, and downstream dependencies for spec/input resolution; `human_verification_required` permits implementation but blocks acceptance until human sign-off.
- Requirement, slice, sprint, and product rollups must derive from the requirement ledger and evidence, not chat memory, broad command success, or agent confidence.
- Checkpoints/resume packets make chat memory disposable.

## Current Implementation State

Implemented and covered by tests:

- TypeScript CLI package with SQLite state via `better-sqlite3`
- target initialization and protocol loading
- file source adapter and source registration
- source metadata indexing for domain/tags/priority
- Markdown section extraction and FR/AC ref indexing
- source search, source inspect, domains list/inspect
- dynamic slice pulling with source/domain/tag filtering
- lane creation/reuse, FR/AC leases, dependency gating
- planning decision events and checkpoints
- model-agnostic worker driver registry (codex, claude, fixture) with per-driver protocol config; provider CLIs spawned via cross-spawn for Windows `.cmd`/`.ps1` shim support; prompts passed via stdin (avoids `.cmd` newline truncation); `--setting-sources` emitted as a joined token (avoids `.cmd` empty-arg dropping); Claude workers carry a default tool allowlist (`Edit Write Read Glob Grep Bash`) for build/test commands
- streaming Codex JSONL ingestion into events and heartbeats
- structured worker result validation
- verifier acceptance gate with per-FR/AC evidence coverage
- planner-created verification obligations derived from source text for every served FR/AC ref
- worker/reviewer dispatch gates that block slices with missing or malformed verification obligations
- worker/reviewer prompts include read-only verification obligations
- deterministic verification evidence includes criterion-level expected/actual results
- independent reviewer runner through `swarm review`; reviewer dispatches through the driver registry with the target protocol's normal tool/command posture
- reviewer JSONL events, heartbeats, structured `review_result` evidence, and review-gated verification
- structured Sleuth Review Gate in reviewer results, with runtime path, stub/hardcode, test meaningfulness, error handling, integration fit, maintainability, and real-world readiness dimensions; failed/high-risk gates block acceptance
- visible overseer runner through `swarm orchestrate`; overseer dispatches through the driver registry (read-only via `--permission-mode plan` for claude)
- overseer JSONL events, heartbeat, structured decision artifact, prompt artifact, and role/entity checkpoint
- bounded overseer command execution through `swarm orchestrate --execute`
- overseer command events/artifacts, Phase 5A state-command allowlist, and Phase 5B bounded child dispatch
- overseer-dispatched worker/reviewer child agents with explicit actor, `--driver codex`, evidence gating, and visible command metadata
- autonomous live acceptance loop through `npm run demo:live-agent:run`
- live smoke CLI boundary through `swarm smoke live-agent reset|run|full`; npm scripts now wrap built `dist/cli.js` instead of source runner paths
- live loop summary/artifacts for overseer turns, worker/reviewer evidence, deterministic verification, graph, timeline, report, artifact index, outcome classification, run history, and run comparison
- source-mutation fault injection through `swarm smoke live-agent run --reset --fault source-mutation`
- reviewer-repair fault injection through `swarm smoke live-agent run --reset --fault reviewer-repair`
- stale-run recovery fault injection through `swarm smoke live-agent run --reset --fault stale-run`
- supervised-revive recovery fault injection through `swarm smoke live-agent run --reset --fault supervised-revive`
- context-handoff fault injection through `swarm smoke live-agent run --reset --fault context-handoff`
- low-signal/proof-churn fault injection through `swarm smoke live-agent run --reset --fault low-signal`
- live-run artifact index and outcome classification through `live-agent-run-artifacts/artifact-index.json`, `artifact-index.md`, and `summary.outcomeClassification`
- reset-resistant live-run history and comparison through `.swarm-demo/live-agent-run-history/` and `npm run demo:live-agent:compare`
- web viewer History tab, read-only history APIs, latest-run comparison, and artifact-index detail for archived live runs
- Phase 8A full-product readiness mode, Phase 8B backend-to-dashboard full-product execution, Phase 8C-1 product evidence hardening, Phase 8C-2 reviewer handoff calibration, Phase 8C-3 real-agent rerun, Phase 8C-4 compact overseer state hardening, Phase 8C-5 real-agent calibration, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-7 real-agent rerun, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-9 real-agent dashboard rerun, Phase 8C-10 artifact-backed overseer launch hardening, Phase 8C-11 product-readiness feedback slices, Phase 8C-12/8C-13 real product-readiness calibration and stale-warning hardening, Phase 8C-14 real escalation-reconciliation confirmation, Phase 8C-15 reset-first lifecycle/final target snapshots, Phase 8C-16 reviewer-tooling/product-probe observability hardening, and Phase 8C-17 supervised recovery/heartbeat hardening through `npm run demo:live-agent:full` / `npm run smoke:live-agent:full`, product spec enforcement, dashboard worker/reviewer/verification, product readiness artifacts, structured HTML/API/mark-paid workflow probe artifacts, accepted dashboard-slice completion, calibrated real-agent limits, dependency-gate readiness evidence, source pull queues, dependency preflight, short overseer launch prompts, visible runtime-readiness work, stale warning cleanup, reset-first run lifecycle, archived final target snapshots, supervised child idle timeout, same-session revive, and bounded `product_not_ready` blocking
- stale-run recovery, same-session revive, restart fallback, and child idle timeout supervision
- low-signal work warning
- latest-only role/entity checkpoints
- role-specific resume packets
- observe/watch/timeline/graph/report surfaces
- CLI-hosted web viewer and local trusted control server
- `swarm onboard` one-command in-repo setup: init + target + gitignore split (runtime state ignored, config files committable) + sample spec registered; idempotent; does not run a worker (`src/onboard.ts`)
- `swarm check <provider>` resolve + spawn `--version` readiness probe via cross-spawn (same launch path as workers); `--live` adds an auth ping (`src/provider-check.ts`)
- `swarm smoke live-agent fake --reset --scenario live-agent-smoke-h2` deterministic H2 fake-agent E2E through the built CLI, including repair/human-verification/product-readiness lifecycle coverage and a missing-required-skill negative test (`scripts/run-support-triage-fake-demo.mjs`, `tests/support-triage-fake.e2e.test.js`)
- `swarm smoke live-agent full --reset --scenario live-agent-smoke-h2` H2 real-run boundary through the built CLI, including scenario-metadata-driven runner selection, support-triage readiness workflow probes, coverage/human-action/readiness artifacts, and a fake-Codex regression over the real overseer/worker/reviewer driver path (`scripts/run-support-triage-live-demo.mjs`, `tests/support-triage-live-runner.e2e.test.js`)

Latest known verification:

```text
Clean real full-product run LAR-20260616T171831-live-agent-smoke-none-48036 -> accepted, coverage 83/83, product readiness passed
Generated invoice dashboard npm test -> 20/20 passing
2026-06-18 H2 fake-agent E2E:
  npm run build -> passed
  node --test tests\support-triage-fake.e2e.test.js -> 2/2 passing
2026-06-18 H2 live-run CLI boundary:
  npm run build -> passed
  node --test tests\support-triage-live-runner.e2e.test.js -> passed
2026-06-17 Sleuth Review Gate slice:
  npm run build -> passed
  focused reviewer/driver/coverage tests -> passed
  web tests -> 88/88 passing
  all Node tests except the long live-agent-runner stress file -> 96/96 passing
  live-agent-runner targeted regressions -> supervised revive, full-product acceptance, and readiness-feedback acceptance all passed individually
  full live-agent-runner file attempt exceeded the wrapper timeout, but the in-progress run reached an accepted final summary before cleanup
git diff --check -> clean
```

## Latest Observability Contract Update

On 2026-06-15, after a smooth live smoke run accepted with partial global coverage, the next hardening focus narrowed to observability clarity. On 2026-06-16 this was tightened again for full-product mode.

- `finalOutcome: accepted` means the selected bounded run path passed only for selected-scope modes.
- Historical selected-scope runs can be accepted while global indexed coverage is partial.
- Full-product mode must not end `accepted` while coverage is partial; it now creates visible coverage-completion slices for remaining refs, and only blocks with `coverage_incomplete` if no completion work can run inside the bounds.
- The clean real full-product run `LAR-20260616T171831-live-agent-smoke-none-48036` confirmed the gate: final outcome `accepted`, coverage `83/83`, product readiness passed, and generated product tests passed.
- The UI must show run outcome, coverage, product readiness, and active concerns separately.

Implemented contract additions:

- new `GET /api/run-observability`
- `GET /api/snapshot` now includes `runObservability`
- `GET /api/coverage` now includes `interpretation`
- `scripts/run-live-agent-demo.mjs` now writes compact `coverage` and `outcomeVsCoverage` into `live-agent-run-summary.json`
- `scripts/run-live-agent-demo.mjs` now writes `finalCoverageGate` for full-product coverage gating and drives coverage-completion slices from it
- frontend type/API mirror updated in `web/src/lib/types.ts` and `web/src/lib/api.ts`
- design note added at `docs/architecture/run-observability-contract.md`

Expected UI behavior:

- show run outcome, coverage, and product readiness as separate top-level truths
- call out `accepted_partial` as a warning for selected-scope runs
- call out active coverage-completion slices while the full-product run is still able to make progress
- call out `coverage_incomplete` as a blocker for terminal full-product runs whose readiness probes pass while FR/AC refs remain incomplete
- use `runObservability.uiHints` for badges/callouts where useful

## Core Verification Doctrine Decision

On 2026-06-15, after reviewing why a run could be accepted while global coverage remained `15/83`, the product doctrine was tightened:

- Agent Swarm converts immutable requirements into verified implementation state.
- Every executable slice must have verification obligations before worker dispatch.
- Each obligation must state the immutable FR/AC ref/text, expected outcome, responsible verifier, required evidence, and acceptance threshold.
- The planner/authorized overseer may derive obligations from the source spec; workers may not create, edit, weaken, or approve obligations for their own work.
- Planner/overseer may add verifier guidance/comments later, but cannot alter the responsible party or acceptance criteria after dispatch.
- `human_input_required` means ambiguity or missing decision; block the affected FR/AC, slice, and downstream dependencies.
- `human_verification_required` means clear requirement but human acceptance needed; implementation may proceed, but final acceptance waits for a human packet and result.
- A human verification packet must include exact FR/AC text, source context, slice/lane/worktree, implementation summary, automated evidence, changed files or PR link, steps to run/open/test, expected outcome, and pass/fail/needs-rework controls.
- Requirement status must be ledger-derived with explicit parent FR rollups; selected-scope run acceptance is not whole-product completion.
- Phase 10C-1B makes full-product coverage actionable: after product readiness passes, the runner creates visible coverage-completion slices with immutable obligations for any remaining indexed refs. Phase 10C-1C makes product-spec completion pack-based and explicit about UI/QA interaction proof. Fake full-product E2E proves both normal and delayed-product-readiness paths can reach accepted with `83/83` refs done, and the clean real full-product run on 2026-06-16 confirmed that behavior with real agents.

Architecture docs updated for this doctrine:

- `docs/architecture/core-philosophy.md`
- `docs/architecture/fr-ac-verification-contract.md`
- `docs/architecture/planning-agent-decision-contract.md`

## Recent UI Work Completed

The local web viewer was upgraded from a simple panel layout into a tabbed observability surface:

- Overview tab with domain readiness and blockers
- Specs tab with search, registered specs table, and rendered spec details
- Work tab with lanes, slices, and rendered slice report
- Agents tab with agent run and heartbeat tables
- Events tab with recent event table
- History tab with archived live runs, latest-run comparison, and selected-run artifact index details
- spec detail views: Summary, Sections, Markdown
- slice reports render Markdown
- read-only `GET /api/source/:selector` endpoint returns source metadata and markdown
- search supports selected-source filtering through the existing source search API
- read-only history APIs:
  - `GET /api/history/runs`
  - `GET /api/history/run/:runId`
  - `GET /api/history/compare`

Source/history views remain read-only. The local trusted server also exposes bounded human-action write APIs for clearing escalations and recording human verification results.

## Web Observability E2E Harness Completed

Implemented after the UI cleanup:

- `scripts/run-web-observability-demo.mjs`
- `tests/web-observability-demo.e2e.test.js`
- `docs/examples/web-observability-demo.md`
- `npm run demo:web-observability`
- `npm run demo:web-observability:codex`

The demo creates three domains and a full observable lifecycle:

- Invoice Backend source/domain
- Invoice Dashboard source/domain
- Release Operations source/domain
- backend lanes accepted before dashboard work
- dashboard lane blocked until backend dependencies are accepted
- worker and verifier runs
- stale operations run
- recovery scan and restart
- active blocker visibility
- planner/worker/verifier/recovery checkpoints
- web API artifacts and lightweight browser-logic assertions

Artifacts are written to `.swarm-demo/web-observability/web-observability-artifacts/`.

Important correction made on 2026-06-10:

- `demo:web-observability` is a fixture regression harness.
- `demo:web-observability:codex` can exercise real Codex workers, but planning is still scripted.
- Neither is the full real-agent smoke the user expected.
- The missing product rehearsal is now specified in `docs/architecture/live-agent-smoke-test.md`.
- The phased build plan is in `docs/architecture/live-agent-smoke-implementation-plan.md`.
- The ultimate full-product target spec is `docs/requirements/live-smoke-invoice-dashboard-product-spec.md`.
- The next implementation priority is a resettable live smoke with a real Codex overseer/planner, real Codex workers, real Codex verifier/reviewer agents, and UI observability.
- The destination is stronger than a coordination demo: full-product mode should start with no completed product and end with a small real working invoice dashboard, or exact blockers explaining why not.

Phase 1 implementation completed:

- `swarm run-mode set/show`
- `runMode` visible in `observe`, `watch`, `status`, `/api/snapshot`, and web UI metrics/header
- `scripts/reset-live-agent-smoke.mjs`
- `npm run demo:live-agent:reset`
- `npm run demo:live-agent:serve`
- live smoke scenario manifest at `.swarm-demo/live-agent-smoke/live-agent-smoke.json`
- `tests/live-agent-smoke-reset.e2e.test.js`

Phase 2 implementation completed:

- `swarm review <slice-id> --actor <actor> --driver codex|fixture`
- `reviewResultSchema` and generated `schemas/review-result.schema.json`
- reviewer agent runs, heartbeats, JSONL artifact capture, and `reviewer.codex_event` events
- `review_result` evidence with reviewer findings and source hash checks
- verifier gate now considers the latest reviewer result when one exists
- material reviewer failures create blockers/escalations and prevent acceptance
- slice reports and observe snapshots expose latest review status
- `tests/review-runner.e2e.test.js`

Phase 3 implementation completed:

- `scripts/run-live-agent-scripted-demo.mjs`
- `npm run demo:live-agent:scripted`
- runner resets or uses the live smoke workspace, then labels run mode `scripted-codex`
- runner pulls one backend slice, runs `swarm run --driver codex`, runs `swarm review --driver codex`, and runs `swarm verify --force` as the final gate
- runner writes `live-agent-scripted-summary.json` and `live-agent-scripted-artifacts/`
- summary includes worker/reviewer runs, review result, bounded outcome, source mutation assertion, graph/report/timeline artifacts, and command evidence
- `tests/live-agent-scripted.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path and real target verification

Phase 4 implementation completed:

- `swarm orchestrate --actor live-overseer --driver codex|fixture --scenario live-agent-smoke`
- `npm run demo:live-agent:overseer`
- `npm run demo:live-agent:overseer:fixture`
- `overseerDecisionSchema` and generated `schemas/overseer-decision.schema.json`
- overseer agent runs use role `overseer` and entity `harness:scenario:<scenario>`
- Codex JSONL events stream as `overseer.codex_event` against the scenario entity
- heartbeats use `harness:scenario:<scenario>` instead of fake slice IDs
- full overseer prompt is written to `.swarm/artifacts/scenario-<scenario>/overseer-prompt-<run-id>.md`
- Codex receives a compact actionable prompt directly; the prompt artifact remains audit-only
- overseer prompt includes top-level compact `slices`, `actionableState.activeSliceQueue`, and exact active-slice `nextCommand` values
- structured decision is written to `.swarm/artifacts/scenario-<scenario>/overseer-decision-<run-id>.json`
- decisions create `overseer.decision_recorded` and `overseer.completed` events
- decision blockers can raise harness-scoped escalations
- overseer and recovery checkpoints are refreshed
- web Agents tab and terminal `watch --view agents` show role and entity
- graph artifacts include overseer actor events
- `tests/overseer-runner.e2e.test.js` uses fake Codex while exercising the real `--driver codex` path

Phase 5A implementation completed:

- `swarm orchestrate --execute`
- `--execute-limit` bounds recommended command execution
- `npm run demo:live-agent:overseer:execute`
- `npm run demo:live-agent:overseer:execute:fixture`
- recommended commands are parsed into argv and executed shell-free
- allowlisted Phase 5A commands: `observe`, `sources list`, `domains list`, `domains inspect`, and `slices pull`
- Phase 5A explicitly blocks `run`, `review`, and `verify` child-agent dispatch commands
- command events are visible: `overseer.command_started`, `overseer.command_completed`, `overseer.command_failed`, `overseer.command_blocked`, and `overseer.commands_completed`
- command stdout/stderr artifacts are written under `.swarm/artifacts/scenario-<scenario>/`
- CLI output reports executed/blocked/failed command counts
- fake Codex E2E proves `--execute` can run an allowlisted `slices pull`, creating a backend lane, slice, and active leases
- fake Codex E2E proves worker dispatch is blocked in Phase 5A

Phase 5B implementation completed:

- `swarm orchestrate --execute` can now execute bounded `run` and `review` child-agent commands
- child dispatch command metadata records `category: child_agent`, `childRole`, and `sliceId`
- `run` is allowed only for existing ready/blocked/repairing slices
- `review` is allowed only for existing implemented/ready_for_review/repairing slices with prior `worker_result` evidence
- child dispatch requires explicit `--actor` so the UI/observe trail is not anonymous
- child dispatch requires `--driver codex`; fixture child dispatch is intentionally blocked in this path
- concurrent worker/reviewer runs on the same slice are blocked
- deterministic `verify` remains blocked in overseer execution until the next acceptance-loop phase
- command stdout/stderr artifacts still live under `.swarm/artifacts/scenario-<scenario>/`
- fake Codex E2E proves a visible overseer can dispatch a worker and reviewer through the real `--driver codex` code paths
- fake Codex E2E proves verifier dispatch is still blocked in Phase 5B

Phase 5C implementation completed:

- `scripts/run-live-agent-demo.mjs`
- `npm run demo:live-agent:run`
- live runner repeatedly invokes `swarm orchestrate --execute`
- state carries across pull -> worker -> review -> deterministic verify
- deterministic `swarm verify` runs only after reviewer acceptance
- scenario bounds: max turns, max slices, max agent runs, max runtime, execute limit
- source hash mutation checks before each turn and in final summary
- final summary is written to `live-agent-run-summary.json`
- artifacts are written under `live-agent-run-artifacts/`
- manifest updates record `phase-5c-autonomous-acceptance-loop` and `liveRun`
- fake Codex E2E proves the live runner exercises real overseer, worker, and reviewer `--driver codex` paths and reaches accepted deterministic verification

Phase 6A implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault source-mutation`
- controlled mutation of a registered disposable source spec after registration
- source hash mismatch detection before overseer/worker/reviewer dispatch
- `human_required` escalation on `harness:scenario:live-agent-smoke`
- summary phase is `phase-6-fault-injection`
- summary records fault mode, injected fault path, source mutation details, bounded outcome, active escalation, and artifacts
- manifest records `liveRun.fault = source-mutation` and final outcome
- E2E confirms no agent runs are created before the stop
- E2E confirms `observe` shows `human_required` and `escalation.created`

Phase 6B implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault reviewer-repair`
- first independent reviewer returns `repair_required`
- slice moves to `repairing` with visible `review.blocked_acceptance` and blocker escalation
- overseer dispatches a repair worker for the same slice
- second independent reviewer accepts the repaired work
- live runner clears only repair-related slice blockers after later reviewer acceptance
- deterministic verification runs after accepted review and cleared repair blocker
- summary records repair clearances, multiple worker/reviewer runs, bounded outcome, and artifacts
- E2E confirms at least two worker runs and two reviewer runs are visible
- E2E confirms `review.blocked_acceptance`, `escalation.cleared`, and passing `verification.completed`

Phase 6C implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault stale-run`
- overseer first creates the live backend slice through normal bounded command execution
- runner injects a stale worker run with an old heartbeat on that real slice
- `swarm recovery scan --mark-stale` marks the stale run, blocks the slice, raises a scoped blocker, and records recovery artifacts
- `swarm recovery restart RUN-live-stale-001` starts a fresh worker for the same slice through the configured driver
- independent review must accept the restarted work before the live runner clears the stale-run blocker
- deterministic verification runs after accepted review and cleared stale blocker
- summary records stale recovery state, scan/mark/restart artifacts, clearance records, bounded outcome, and accepted verification
- E2E confirms `recovery.marked_stale_run`, `recovery.restart_started`, `recovery.restart_completed`, `escalation.cleared`, and passing `verification.completed`

Phase 6D implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault context-handoff`
- loop waits for a real slice with completed worker evidence
- runner refreshes worker, reviewer, verifier, and overseer checkpoints with actor `live-context-handoff`
- runner generates worker, reviewer, verifier, overseer, and recovery resume packets from durable harness state
- packet artifacts are written under `live-agent-run-artifacts`
- checkpoint refreshes are visible in `observe` through `checkpoint.refreshed` events and checkpoint rows
- loop continues after handoff and must still pass independent review plus deterministic verification
- summary records checkpoint ids, packet paths, handoff turn, bounded outcome, and accepted verification
- E2E confirms role-specific packet sections, visible checkpoints, review after handoff, and passing verification

Phase 6E implementation completed:

- `node scripts\run-live-agent-demo.mjs --reset --fault low-signal`
- loop waits for a real slice with completed worker evidence
- runner raises a lane-scoped `warning` escalation with low-signal/proof-churn rationale
- runner records `planner.low_signal_work` with affected slice, reason, and suggested action
- runner refreshes a planner checkpoint for the affected lane
- warning artifact is written under `live-agent-run-artifacts`
- warning does not bypass independent review or deterministic verification
- summary records warning id, checkpoint id, warning artifact, warning turn, bounded outcome, and accepted verification
- E2E confirms active warning visibility, planner event, planner checkpoint, review completion, and passing verification after the warning turn

Phase 7A implementation completed:

- every `scripts/run-live-agent-demo.mjs` run writes `live-agent-run-artifacts/artifact-index.json`
- every run also writes a human-readable `live-agent-run-artifacts/artifact-index.md`
- `live-agent-run-summary.json` includes `outcomeClassification`
- manifest `liveRun` records the latest outcome classification and artifact index path
- accepted runs classify as `accepted`
- source mutation stops classify as `source_mutation`
- blocked/human-required paths have bounded classifier codes such as `limit_exceeded`, `verification_failed`, `human_required`, `orchestration_no_progress`, `recovery_blocked`, `blocked_escalation`, or `blocked_unknown`
- artifact index links core run artifacts, latest worker/reviewer artifacts, deterministic verification output, recovery artifacts, context handoff packets, low-signal warning artifacts, and turn outputs
- E2E confirms baseline and all Phase 6 fault modes produce classification-aligned artifact indexes

Phase 7B-1 implementation completed:

- every `scripts/run-live-agent-demo.mjs` run gets a durable `runId`
- default history root is `.swarm-demo/live-agent-run-history/`
- history root can be overridden with `--history-root`
- history can be disabled with `--history false`
- history root safety refuses paths outside `.swarm-demo` and refuses paths inside the reset workspace
- each archived run stores `summary.json`, `artifact-index.json`, and `artifact-index.md`
- history index is stored at `runs.json`
- summary records `history` pointers to archived and original artifacts
- manifest `liveRun` records `runId` and history pointers
- `scripts/compare-live-agent-runs.mjs`
- `npm run demo:live-agent:compare`
- comparison supports explicit `--left/--right` run ids or defaults to the latest two runs
- comparison can output JSON or Markdown with outcome, classifier, fault mode, lifecycle count deltas, artifact paths, and interpretation
- E2E archives an accepted run and a source-mutation run, then verifies explicit and latest-two comparison

Phase 7B-2 implementation completed:

- `swarm serve` accepts `--history-root <path>`
- viewer default history root is `.swarm-demo/live-agent-run-history/` when serving a `.swarm-demo/*` workspace, otherwise `.swarm/run-history/`
- Overview metrics include archived run count
- web viewer has a History tab
- History tab lists archived live runs with generated time, fault mode, outcome, classifier, turns, agent runs, verification runs, and active escalations
- latest comparison panel shows latest-two outcome/classifier/fault deltas, lifecycle count deltas, and interpretation
- artifact index panel shows selected run summary, classifier explanation, and indexed artifacts
- read-only APIs expose history list, run detail, and comparison
- `tests/web-viewer.e2e.test.js` creates an isolated history fixture and verifies the UI/API surface

Phase 8A implementation completed:

- `scripts/run-live-agent-demo.mjs` supports `--mode full-product`
- `npm run demo:live-agent:full`
- full-product mode uses broader default limits
- full-product mode rejects fault injection for now
- full-product mode refuses to run when the approved invoice dashboard product spec copy is missing or unregistered
- reset leaves `invoice-dashboard` intentionally incomplete; it has `npm test` but no `npm start`
- accepted backend slice verification no longer counts as final full-product acceptance
- full-product runs write:
  - `live-agent-run-artifacts/product-readiness.json`
  - `live-agent-run-artifacts/product-readiness.md`
  - `live-agent-run-artifacts/product-dashboard-test-output.txt`
- summary includes `mode: "full-product"`, `phase: "phase-8-full-product-execution"`, `productReadiness`, final commands, and manual URL
- incomplete full-product output classifies as `outcomeClassification.code = "product_not_ready"`
- artifact index links product readiness artifacts
- E2E confirms incomplete dashboard blocks honestly and missing product spec copy refuses to run

Phase 8B implementation completed:

- full-product mode no longer stops at accepted backend work when product readiness is still incomplete
- product readiness is checked at accepted-slice boundaries and falls through to more orchestration when additional dashboard work is visible
- the fake live overseer can recover from truncated prompt snapshots by reading the live harness snapshot directly
- full-product fake overseer serves the dashboard lane only after backend slice acceptance
- fake dashboard worker writes a runnable `invoice-dashboard` target with `npm test` and `npm start`
- dashboard reviewer and deterministic verifier gate the dashboard slice before product acceptance
- product readiness now records `product-dashboard-start-output.txt`
- product readiness now records structured product probe artifacts:
  - `live-agent-run-artifacts/product-dashboard-probe.json`
  - `live-agent-run-artifacts/product-dashboard-probe.md`
- local start probing checks the dashboard HTML and `/api/summary`
- full-product E2E proves backend plus dashboard acceptance reaches `outcomeClassification.code = "accepted"`
- bounded full-product E2E still proves `product_not_ready` when limits stop before product completion
- latest full verification after this slice: `npm test -> 68/68 passing`

Phase 8C-1 implementation completed:

- package script `smoke:live-agent:full` resets and runs full-product mode with real Codex by default
- reset manifests now advertise `smoke:live-agent:full` as the resettable full-product smoke command
- accepted full-product summaries include `productProbeArtifactRecorded` and `productProbeChecksPassed` assertions
- artifact indexes include `productProbe` and `productProbeMarkdown` quick-open/product artifacts
- `/api/summary` probing now requires JSON fields such as `invoiceCount` and `openTotalCents`

Phase 8C-2 calibration attempt completed:

- ran `npm run smoke:live-agent:full` with real Codex CLI `0.130.0`
- run id: `LAR-20260611T065131-live-agent-smoke-none-25232`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max runtime exceeded: 1220s > 1200s`
- real overseer created the backend slice and repeatedly dispatched real backend workers/reviewers
- dashboard work was correctly not served because backend acceptance never happened
- root blocker: reviewers blocked because their read-only command policy rejected `npm test` / `node --test`, even though deterministic `swarm verify` is the separate executable command gate
- first fix separated semantic review from deterministic verification; Phase 8C-16 then removed the hardcoded reviewer read-only posture entirely
- reviewer runs now use the target protocol's normal driver posture, can run local commands/tools when useful, and still cannot mutate immutable source specs without source-hash detection
- regression coverage in `tests/review-runner.e2e.test.js` fails if codex reviewers are forced into read-only or lose the command/tool access instruction

Phase 8C-3 real-agent calibration rerun completed:

- ran `npm run smoke:live-agent:full` with real Codex
- run id: `LAR-20260611T073238-live-agent-smoke-none-33448`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max runtime exceeded: 1333s > 1200s`
- positive signal: reviewer handoff fix worked; two backend slices reached accepted status
- `SLICE-577e6523` accepted `AC-INV-001.1`
- `SLICE-6f864b27` accepted `AC-INV-001.2`, `AC-INV-001.3`, and `AC-INV-002.1`
- deterministic verification ran after review and passed 4/4 target tests for `SLICE-6f864b27`
- backend-first dependency sequencing held; dashboard work was not served against stubs
- root blocker: overseer prompt/state drift. The active next backend slice was discoverable as `SLICE-673d346e`, but later overseer turns kept reading/grepping prompt artifacts and inspecting state instead of dispatching `run`

Phase 8C-4 compact overseer state hardening completed:

- `src/cli.ts` now builds a compact actionable overseer state packet instead of embedding the raw full observe snapshot
- packet exposes top-level compact `slices` and `actionableState.activeSliceQueue`
- active slices include concrete `nextCommand` and `nextCommandPurpose`
- real Codex overseers receive the compact prompt directly; prompt artifact is audit-only
- prompt tells overseers not to read prompt files, list artifacts, query SQLite, grep state, or invoke harness commands themselves
- stale Phase 5B deterministic-verifier language was removed; deterministic verification is now described as live-runner-owned after reviewer acceptance
- `scripts/run-live-agent-demo.mjs` now selects the latest accepted slice for worker/reviewer quick-open artifacts
- regression coverage added/updated in `tests/overseer-runner.e2e.test.js` and `tests/live-agent-runner.e2e.test.js`
- focused verification after this slice:
  - `npm run build`
  - `node --test tests/overseer-runner.e2e.test.js`
  - `node --test tests/live-agent-runner.e2e.test.js`

Phase 8C-5 real-agent calibration after compact state completed:

- ran `npm run smoke:live-agent:full` with the UI open on `http://127.0.0.1:4319/`
- run id: `LAR-20260611T082909-live-agent-smoke-none-47084`
- outcome: `blocked`
- classifier: `product_not_ready`
- reason: `Max turns reached without acceptance: 16.`
- compact active-slice state worked: the real overseer dispatched active backend workers/reviewers directly instead of rediscovering prompt artifacts
- four backend slices reached accepted status with worker evidence, review evidence, and deterministic command evidence:
  - `SLICE-948efc98`: `AC-INV-001.1`
  - `SLICE-d829f68d`: `AC-INV-001.2`
  - `SLICE-e2802cf9`: `AC-INV-001.3`
  - `SLICE-fa91cc4a`: `AC-INV-002.1`
- backend tests reached 4/4 passing
- source specs remained unchanged
- dashboard work was correctly not served because declared dashboard dependencies were not all accepted; missing refs included `AC-INV-002.2` and `AC-INV-003.1`
- root hardening finding: 16 turns / 1200s / 30 agents was too small for real-agent one-AC backend cadence plus dashboard work

Phase 8C-6 full-product budget and dependency-gate hardening completed:

- full-product default limits were 40 turns, 2700 seconds, 12 slices, and 60 agent runs after Phase 8C-6; Phase 10C-1C raises them to 80 turns, 7200 seconds, 20 slices, and 150 agent runs so coherent coverage-completion packs can reach 100%
- `npm run demo:live-agent:full` and `npm run smoke:live-agent:full` now use the Phase 10C-1C calibrated limits
- reset manifest records `fullProductMode.maxTurns = 80`, `maxAgentRuns = 150`, `maxSlices = 20`, and `maxRuntimeMinutes = 120`
- product readiness now records dashboard dependency-gate state:
  - declared `Depends-On` refs
  - accepted refs
  - missing refs
  - satisfied/not satisfied
- `product-readiness.md` now includes a `Dashboard Dependency Gate` section
- bounded full-product runs now surface missing backend refs as explicit readiness blockers

Phase 8C-7 real-agent rerun after budget calibration:

- run id: `LAR-20260611T091057-live-agent-smoke-none-10516`
- outcome: `blocked`
- classifier: `product_not_ready`
- five backend slices reached accepted status:
  - `AC-INV-001.1`
  - `AC-INV-001.2`
  - `AC-INV-001.3`
  - `AC-INV-002.1`
  - `AC-INV-002.2`
- product readiness correctly reduced missing dashboard dependencies to `AC-INV-003.1`
- lower-level `slices pull` correctly rejected premature dashboard work with `Source dependencies are not satisfied: AC-INV-003.1`
- root hardening finding: the overseer actionable state did not explicitly queue prerequisite source work before blocked downstream/dashboard sources

Phase 8C-8 orchestration dependency-gate hardening completed:

- compact overseer state now includes `actionableState.nextSourcePullQueue`
- compact overseer state now includes `actionableState.blockedSourceQueue`
- ready source queue items include exact `nextCommand`, available refs, target/source, batch size, and reason
- blocked source queue items include declared dependencies, missing dependencies, reason, and prerequisite pull commands where known
- prompt discipline now tells the overseer to choose active slice commands first, then ready source pulls, and never pull blocked downstream sources
- overseer execution preflights `slices pull` source dependencies and blocks unsafe dashboard pulls before process execution
- full-product runner treats dependency-blocked downstream commands as recoverable so a later turn can pick prerequisite work
- focused overseer tests cover the 8C-7 regression shape

Phase 8C-9/8C-10 real-agent calibration and prompt hardening completed:

- real run resumed from `.swarm-demo/live-agent-smoke` with the observability UI available
- positive signal: source pull queues worked; backend dependencies reached accepted state through `AC-INV-003.2` / `FR-INV-003`
- positive signal: dashboard source unlocked only after accepted backend dependencies
- positive signal: real dashboard worker implemented `SLICE-cd4193e4` for `AC-UI-INV-001.1`, `AC-UI-INV-001.2`, and `AC-UI-INV-001.3`
- failure found: the next overseer turn hit Windows `spawn ENAMETOOLONG` because the full overseer prompt was passed through argv
- hardening applied:
  - overseer Codex launches now use a short artifact-backed launch prompt
  - full overseer instructions/state remain in `overseer-prompt-RUN-*.md`
  - compact prompt state now exposes `sliceSummary` and `agentRunSummary` instead of duplicating full slice/run detail
  - overseer fake tests understand the compact prompt contract
  - spawn errors are captured as failed agent results instead of rejecting out of the runner path
- resumed real run passed the previous crash point, dispatched `dashboard-reviewer`, accepted `SLICE-cd4193e4`, and ran deterministic dashboard tests
- product readiness now blocks honestly on the next real product gap:
  - no dashboard `npm start` script
  - no local URL/start probe
- latest verification:

```text
node --test tests/overseer-runner.e2e.test.js -> 8/8 passing
node --test tests/live-agent-runner.e2e.test.js -> 10/10 passing
npm test -> 68/68 passing
```

Phase 8C-11 product-readiness feedback loop completed:

- product readiness blockers for missing dashboard `npm test`, `npm start`, or local HTML/API probes now create visible harness work instead of ending as hidden no-work-left state
- the generated work is a normal dashboard-target slice titled `Resolve invoice dashboard product readiness`
- the slice traces to immutable product refs:
  - `AC-PROD-001.1`
  - `AC-PROD-001.2`
  - `AC-PROD-001.3`
  - `AC-PROD-001.4`
- the slice records normal leases, dependency, planner decision event, `product_readiness.slice_created`, and planner checkpoints
- product readiness JSON now exposes `productReadinessSlices`
- full-product readiness is deferred while active product-readiness work exists
- fake live Codex can simulate a dashboard model slice that passes tests while omitting `npm start`; the follow-up readiness slice then repairs runtime behavior
- Windows `npm start` probe cleanup now terminates the spawned process tree to reduce stale servers on `127.0.0.1:4321`
- focused verification:

```text
node --test tests/live-agent-runner.e2e.test.js -> 11/11 passing
npm test -> 69/69 passing
git diff --check -> clean
```

Operational note:

- an old pre-fix dashboard process was still listening on `127.0.0.1:4321`; it was stopped manually
- the observability UI remained active on `127.0.0.1:4319`

Current manual viewer path:

```powershell
npm run demo:source-index
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

## Current Dirty Worktree Expectation

Use `git status --short` as source of truth. Do not assume older untracked-file lists are still current, and do not revert unrelated user changes. The current live-smoke work includes prior Phase 7B-1 live runner/history/comparison changes, Phase 7B-2 web viewer history/detail changes, Phase 8A full-product readiness changes, Phase 8B full-product execution changes, Phase 8C-1 product evidence hardening changes, Phase 8C-2/8C-5 calibration docs, Phase 8C-4 compact overseer state hardening, Phase 8C-6 full-product budget/dependency-gate hardening, Phase 8C-8 orchestration dependency-gate hardening, Phase 8C-10 artifact-backed overseer launch hardening, and Phase 8C-15 reset-first lifecycle/final target snapshot hardening in `src/cli.ts`, `scripts/run-live-agent-demo.mjs`, `scripts/reset-live-agent-smoke.mjs`, `tests/live-agent-runner.e2e.test.js`, `tests/live-agent-smoke-reset.e2e.test.js`, `tests/overseer-runner.e2e.test.js`, package scripts, and docs.

`docs/dieselbrook-overseer/` is a parked local copy of a project-specific skill. Do not modify it unless the user explicitly asks.

## How To Reconstruct Current Context

Start with:

```powershell
Get-Content docs\onboarding\new-agent-start-here.md
Get-Content docs\onboarding\current-project-memory.md
git status --short
npm test
```

Then inspect current harness demos:

```powershell
npm run demo:source-index
npm run demo:web-observability
npm run demo:resume-context
npm run demo:observability
```

Useful state commands inside a generated demo workspace:

```powershell
node ..\..\dist\cli.js observe --events 80
node ..\..\dist\cli.js graph --format json
node ..\..\dist\cli.js checkpoint list
node ..\..\dist\cli.js resume-context --entity slice:<slice-id> --role worker
node ..\..\dist\cli.js timeline <slice-id> --json
node ..\..\dist\cli.js report <slice-id>
```

## Latest Live-Run State

Phase 8C-12 through Phase 8C-14 ran real Codex full-product smoke with the dashboard active.

- `LAR-20260611T111547-live-agent-smoke-none-55164`: accepted. Real agents created, implemented, reviewed, and verified a product-readiness slice after the dashboard model slice. Final product readiness passed `npm test`, `npm start`, browser HTML probe, `/api/summary` probe, source hash checks, artifact index, and run history.
- `LAR-20260611T115536-live-agent-smoke-none-41016`: accepted after the first hardening patch. Product readiness passed again and the runtime slice was accepted, but the run exposed an observability defect: 13 stale planning escalations remained active because the real overseer used different wording than the initial cleanup regex.
- `LAR-20260611T172111-live-agent-smoke-none-23668`: accepted after process-lifecycle hardening. The run used 44 turns, 5 slices, and 28 agent runs. Backend work was accepted before the dashboard lane opened. The dashboard model slice was initially blocked by review because it lacked independent evidence, then reworked, re-reviewed, deterministically verified, and accepted. The final product-readiness slice found and fixed a real Windows `npm start` entrypoint bug, reran `npm test`, captured the local URL, and proved `/` plus `/api/summary` with an in-process HTTP probe.
- `LAR-20260611T181720-live-agent-smoke-none-42040`: accepted after stale-warning reconciliation hardening. The run used 40 turns, 5 slices, 24 agent runs, and 5 verification runs. Backend slices were accepted before dashboard work was served, the dashboard slice was accepted, the product-readiness slice implemented local runtime/API behavior, reviewer and deterministic verification passed, product readiness passed, and final `counts.activeEscalations` was `0`.
- `LAR-20260612T055330-live-agent-smoke-none-29148`: accepted after reset-first lifecycle/final target snapshot hardening. The run used 43 turn records, 5 slices, 24 agent runs, and 5 verification runs. Product readiness passed, failed assertions were `[]`, source hashes were unchanged, and final target snapshots were archived. The final snapshot still had 3 warning-level active escalations related to reviewer command execution policy, but no active blocker/human/critical escalation and `acceptedHasNoActiveBlockingEscalations === true`.
- Phase 8C-16 hardening addresses that run's lessons: reviewers now run with normal protocol tool access, final product readiness clears stale reviewer command-policy diagnostics, product probes include a mark-paid workflow, the agent table surfaces last-signal/latest-event state, and `npm` probe launch no longer uses `shell: true`.
- Product readiness now passes only with `npm test`, `npm start`, HTML probe, `/api/summary` probe, mark-paid workflow probe, immutable source hashes, artifact index, and run history.
- Phase 8C-13 exposed one observability gap: `counts.activeEscalations` remained at 8 because stale dashboard dependency warnings stayed active after final acceptance, even though all assertions passed and there were no active blocker/human/critical escalations.
- Phase 8C-14 confirmed the hardening: six dashboard dependency warning escalations were cleared once backend/product readiness made them stale, and the final accepted snapshot had no active escalations.
- Phase 8C-15 hardens run lifecycle preservation: reset E2E now uses an isolated approved test workspace instead of wiping `.swarm-demo/live-agent-smoke`; `reset-live-agent-smoke.mjs` allows only safe direct children under `.swarm-demo`; live run history now snapshots final `invoice-api` and `invoice-dashboard` targets under `final-targets/`; accepted full-product E2E asserts the terminal workspace still has `npm start`/`src/server.js` and the history snapshot is runnable after completion.
- The 2026-06-12 manual product inspection verified the generated dashboard directly:
  - active product URL left running clean: `http://127.0.0.1:4322/`
  - harness UI for the live smoke workspace: `http://127.0.0.1:4319/`
  - active dashboard `npm test`: 6/6 passing
  - archived final dashboard `npm test`: 6/6 passing
  - API probe: `/api/summary` returned 5 invoices, 2 open, 2 overdue, 1 paid, `openTotalCents: 340000`, `overdueTotalCents: 151500`
  - workflow probe: `PATCH /api/invoices/INV-1005/status` with `{ "status": "paid" }` updated the in-memory summary from 2 overdue/1 paid to 0 overdue/3 paid after a prior probe had already marked `INV-1002` paid; server was restarted afterward to restore clean seed state
- New hardening findings from `LAR-20260612T055330-live-agent-smoke-none-29148`, addressed in Phase 8C-16:
  - reviewer command-execution policy warnings can remain active after acceptance; reviewers now get normal tool access and stale reviewer command-policy diagnostics clear after final product readiness passes
  - live run stderr recorded Node `DEP0190` from `shell: true`; live product probes now launch `npm` without shell wrapping
  - the product-readiness worker had a long quiet-but-alive period visible only through event polling; the web viewer agent table now shows last signal age and latest event detail
  - product readiness should prove one real workflow, not only page/API availability; the readiness probe now marks an overdue invoice paid and verifies summary counters
  - the overseer selected an extra backend slice `SLICE-c455b1a2` (`AC-INV-003.2`, `FR-INV-003`) before dashboard work; it accepted cleanly and remains a cadence/prioritization item to review
- Stale-warning reconciliation covers the real overseer wording:
  - `Invoice Dashboard source is blocked by missing accepted backend prerequisite refs...`
  - `Invoice Dashboard source remains blocked by missing accepted backend prerequisite refs...`
  - `Invoice Dashboard source ... is blocked by missing accepted backend prerequisites...`
  - `Historical dashboard prerequisite warnings...`
  - `dashboard prerequisite warnings appear stale...`
- The fake full-product tests now inject the real stale-warning wording and assert the final accepted snapshot has none of those messages active.

Verification after Phase 8C-13 hardening:

- `node --test --test-name-pattern "full-product mode coordinates" tests/live-agent-runner.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode turns runtime" tests/live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Verification after Phase 8C-15 hardening:

- `npm run build`: passed
- `node --test tests\live-agent-smoke-reset.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Verification after Phase 8C-16 hardening:

- `npm run build`: passed
- `node --test tests\review-runner.e2e.test.js`: passed
- `node --test tests\claude-reviewer.e2e.test.js`: passed
- `node --test tests\web-viewer.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode coordinates" tests\live-agent-runner.e2e.test.js`: passed
- `node --test --test-name-pattern "full-product mode turns runtime" tests\live-agent-runner.e2e.test.js`: passed
- `npm test`: passed 70/70

Phase 8C-17 supervised recovery and heartbeat hardening:

- Triggered by the real-run concern that a worker can stall, stop, or fail to emit the expected structured result while still having useful session context.
- `spawnWorkerStreaming` now supports a configurable child idle timeout from `SWARM_AGENT_IDLE_TIMEOUT_SECONDS`, `SWARM_CHILD_IDLE_TIMEOUT_SECONDS`, or target protocol `recovery.childIdleTimeoutSeconds`.
- On timeout the harness records a blocked heartbeat, emits `<role>.child_idle_timeout`, kills the child process, and records `idleTimedOut` on the completed run event.
- The live runner detects failed/stale worker runs with no later completed worker, then tries `swarm recovery revive <run-id>` first when a session id exists. Restart remains the fallback.
- `recovery revive` now uses a stronger prompt: inspect current target state and previous session, emit the structured worker result if work is complete, finish only scoped work if incomplete, or return an exact blocked/failed result.
- `--fault supervised-revive` simulates a real child worker session that emits JSONL, goes quiet, is killed by idle supervision, revives through the captured session id, then still must pass independent review and deterministic verification.
- Structured heartbeat classification now wins over keyword fallback, preventing successful `command_execution` events containing text like `failed assertions []` from showing as blocked.
- Accepted-slice cleanup can clear historical same-slice warning/blocker noise after review and deterministic verification accept the slice, while low-signal/proof-churn warnings remain visible by design.
- Worker/reviewer prompts now recommend per-command `git -c safe.directory=<target> ...` usage for dubious-ownership warnings instead of mutating global Git config.

Verification after Phase 8C-17 hardening:

- `npm run build`: passed
- `node --test tests\worker-events.test.js`: passed
- `node --test tests\protocol.test.js`: passed
- `node --test --test-name-pattern "revives a stalled worker" tests\live-agent-runner.e2e.test.js`: passed
- `node --test tests\live-agent-runner.e2e.test.js`: passed 12/12
- `npm test`: passed 87/87
- `git diff --check`: clean

Phase 8C-18 real-agent rerun and immediate harness hardening:

- Real run `LAR-20260612T110407-live-agent-smoke-none-26068` accepted after reset-first execution with the dashboard UI observing the run.
- Outcome: 5 slices accepted, 24 agent runs, product readiness passed, failed assertions `[]`, source specs unchanged, final target snapshots archived, and `product-dashboard-probe.json` proved HTML, `/api/summary`, and mark-paid workflow.
- The run produced a real local Invoice Operations Dashboard. The product-readiness worker added `npm start`, a browser HTML dashboard, JSON APIs, seeded invoice/customer data, and mark-paid behavior; reviewer and deterministic verification accepted it.
- Lessons from the run:
  - reset-first can fail on Windows when an old `swarm serve` or product `npm start` process still holds `.swarm-demo/live-agent-smoke`; the new run must stop related viewer/product processes before deleting the workspace
  - child agents can emit premature structured-looking `needs_human` progress messages; harness finalization must trust the final `--output-last-message` artifact plus evidence, not intermediate agent chatter
  - Git `safe.directory` examples should use normalized forward-slash paths; the worker discovered that backslash paths can still fail dubious-ownership checks
  - overseers can amplify old non-blocking warnings by restating them on every dispatch; active state should keep the original warning visible, not accumulate restatements
  - quiet reviewer/worker periods can be valid when JSONL, process state, or later completion proves continued work
- Hardening from those lessons:
  - `scripts/reset-live-agent-smoke.mjs --stop-related-processes` can stop related Windows viewer/product processes for the resettable smoke workspace before reset
  - `scripts/run-live-agent-demo.mjs --reset` now delegates to the reset script and passes the process-cleanup flag
  - worker/reviewer prompts now use normalized forward-slash `git -c safe.directory=<target> ...` guidance
  - overseer escalation insertion suppresses duplicate/restated non-blocking warning escalations while recording `overseer.escalation_suppressed`
  - final full-product cleanup scans all accepted slices and broader historical planning/git-warning wording so accepted runs should finish with cleaner active escalation state
  - tests now cover reset cleanup output shape, normalized reviewer safe-directory guidance, and zero active escalations in the product-readiness feedback path

Phase 8C-18A product probe isolation hardening:

- Product readiness now copies `invoice-dashboard` into `live-agent-run-artifacts/product-dashboard-probe-workspace` before running `npm test` and `npm start`.
- Readiness JSON and probe artifacts record `probeIsolation`, command `cwd`, source target, and copied probe workspace.
- `commandResults.start.passed` now requires the HTML probe, `/api/summary` probe, and mark-paid workflow probe to pass.
- This keeps workflow-level proof from mutating the terminal product target and makes repeated readiness checks less order-dependent.
- Verification on 2026-06-14:
  - `npm run build; node --test tests/live-agent-runner.e2e.test.js`: passed 12/12
  - `npm test`: passed 87/87
  - `git diff --check`: clean

Phase 8C-19 real rerun and probe-shape hardening:

- Real run `LAR-20260614T143508-live-agent-smoke-none-41428` completed with `finalOutcome: blocked` and `outcomeClassification.code: product_not_ready`.
- This was a useful clean block, not a crash:
  - 5 slices were accepted: three backend slices, one dashboard/UI slice, and one product-readiness slice.
  - 24 agent runs completed.
  - 5 deterministic verification runs completed.
  - failed assertions were `[]`.
  - stale dashboard dependency blockers cleared to zero once backend dependencies were accepted.
  - final active escalation count was 1, scoped to product readiness.
- Final blocker: `No overdue invoice was available for the mark-paid workflow probe.`
- Artifact inspection showed the generated product did have overdue invoices and `/api/summary` returned `overdueCount: 2`; the issue was the harness probe expected `/api/invoices?status=overdue` to return a raw array, while the real product returned a normal wrapped API payload `{ invoices: [...] }`.
- Hardening after the run:
  - `scripts/run-live-agent-demo.mjs` mark-paid probe now accepts raw arrays plus `{ invoices: [...] }` and `{ items: [...] }`.
  - The patched invoice response now accepts raw invoice objects plus `{ invoice: ... }` and `{ item: ... }`.
  - `tests/live-agent-runner.e2e.test.js` fake dashboard server now returns wrapped list/detail/status payloads so the E2E covers the exact real-run failure shape.
- Verification on 2026-06-14:
  - focused full-product E2E: passed
  - `node --test tests/live-agent-runner.e2e.test.js`: passed 12/12
  - `npm test`: passed 99/99
  - `git diff --check`: clean

Operational cleanup on 2026-06-14:

- Stopped leftover repo-owned servers before the next run:
  - `dist/cli.js serve --workspace .swarm-demo/live-web-flow --port 4317`
  - `dist/cli.js serve --workspace .swarm-demo/web-observability --port 4318`
  - `dist/cli.js serve --workspace .swarm-demo/live-agent-smoke --port 4319`
  - generated product server `src/dashboard.js` on port `4321`
- Verified ports `4317`, `4318`, `4319`, `4321`, and `4322` had no repo-owned listeners afterward.
- Next live run should start all UI/product processes fresh from the reset-first path.

Phase 9 real-run rebaseline attempt on 2026-06-15:

- A real full-product smoke was started from the reset-first path with the UI live on `http://127.0.0.1:4319/`.
- Backend-first orchestration worked:
  - three backend slices accepted
  - dashboard slice unlocked only after backend refs were accepted
  - dashboard slice accepted
  - coverage moved conservatively from `0/83` to `11/83` as accepted refs landed
- Product-readiness exposed a real stalled-worker failure:
  - first product-readiness worker stopped emitting JSONL after editing `package.json` and never wrote `worker-result.json`
  - manual termination of the child Codex process caused the harness to mark it failed and start a same-slice recovery/restart worker
  - restarted worker surfaced a malformed inline PowerShell/Node `npm start` self-probe and then went quiet after a blocked command
- The run was intentionally stopped before the outer max-runtime; no `live-agent-run-summary.json` was produced.
- Terminal state before cleanup: 5 slices, 4 accepted, product-readiness slice still implementing, 23 agent runs, 7 active warning escalations, coverage `11/83 done`, `4 in_progress`, `68 not_started`.
- Findings:
  - same-session/restart recovery can continue after a child exits, but real full-product runs did not have automatic child idle timeout armed
  - product-readiness workers should not hand-roll fragile local-server probes; the harness should provide canonical probes
  - warning restatement suppression still needs hardening because repeated non-blocking warnings accumulated
  - coverage needs status reason, owner, evidence, escalation, dependency, and next-action detail so humans and overseers can understand each ref state
- Immediate hardening:
  - live-smoke reset now writes `recovery.childIdleTimeoutSeconds: 300` into both disposable target `protocol.yaml` files and records it in the manifest/summary
  - `/api/coverage` now has additive operational fields: source title/URI/section, status reason, next action, last changed, lane/target/worktree, actors, active escalations, dependencies, and evidence summaries

Phase 10B Super Overseer focus-packet foundation:

- Triggered by the product-readiness stall where a human could diagnose the likely quoting/probe failure from JSONL command output, prompt context, heartbeat state, and artifacts, but the overseer did not yet have a first-class way to zoom in.
- Worker, reviewer, and revive prompts are now durable artifacts:
  - `worker-prompt-<run-id>.md`
  - `review-prompt-<run-id>.md`
  - `worker-revive-prompt-<run-id>.md`
- Run/review/revive started/completed events include `promptPath`.
- New inspection commands:
  - `swarm inspect run <run-id>`
  - `swarm inspect run <run-id> --json`
  - `swarm inspect slice <slice-id>`
  - `swarm inspect slice <slice-id> --json`
- Run focus packets summarize prompt/result/stderr artifacts, JSONL event tail, last command, last agent message, file changes, target git status, heartbeat, related evidence, active escalations, recent harness events, failure classes, and recommended interventions.
- Slice focus packets summarize slice/lane/target state, leases, evidence, active escalations, recent runs, latest run focus, retry pressure, and recommended interventions.
- Same-session attempt numbers now count as retry pressure for high-retry slice diagnosis; a single run at attempt 5 is no longer hidden as one harmless run record.
- Focused E2E coverage now proves a successful fixture worker focus packet and a failed command/missing-result focus packet.
- Compact overseer state now includes `actionableState.focusQueue` when an active slice has blocked/failed/stale/quiet/high-retry diagnostic signals.
- Focus queue items include exact `inspect run` and `inspect slice` commands plus latest run status, attempt, session presence, failure classes, last command summary, artifact pointers, active escalations, and recommended interventions.
- Overseer prompt discipline now tells the overseer to treat focusQueue as required senior-developer zoom-in work before ordinary dispatch/revive/restart/escalation.
- Bounded overseer command execution now allowlists validated `inspect run <run-id>` and `inspect slice <slice-id>` commands with optional `--json`.
- Supervised recovery now captures `recoveryRunFocus` and `recoverySliceFocus` JSON artifacts before attempting same-session revive or restart fallback.

Tracked improvement backlog from the last run:

| Item | Status | Discussion needed? | Notes |
| --- | --- | --- | --- |
| Phase 8C-19 real confirmation run | ran, blocked cleanly on probe-shape bug | no | Real run accepted all implementation slices and exposed a harness mark-paid probe envelope assumption. |
| Phase 9 rerun after probe-shape hardening | attempted, blocked on stalled product-readiness worker | no | Backend/dashboard accepted correctly; product-readiness exposed missing real-run idle timeout and fragile worker self-probe. |
| Clean final warning state | needs more hardening | no | Phase 9 accumulated repeated non-blocking warning restatements; suppression is not complete. |
| Browser-level product proof | planned | yes | Decide whether proof should be DOM-only, screenshot artifact, or Playwright-style interaction. Current proof covers HTML, API summary, and mark-paid workflow but not actual browser interaction. |
| Warning history vs active concern UX | planned | yes | Decide how the UI should separate resolved warning history from active escalations so visibility does not become noise. |
| Quiet-but-alive agent state | partially addressed | yes | Focus packets expose heartbeat age and JSONL/event tails; UI still needs a clearer distinction between quiet alive, blocked, stale, and complete. |
| Super Overseer focus packets | engine-wired | no | `swarm inspect run/slice` now provides human/JSON zoom-in packets, overseer state exposes focusQueue, bounded overseer execution can inspect, and supervised recovery archives focus artifacts before intervention. |
| Child idle timeout defaults | implemented for live smoke | no | Reset writes `recovery.childIdleTimeoutSeconds: 300` for both disposable targets; global default stays off. |
| Fresh seeded product state | implemented | no | Readiness commands run from an isolated copied product target and record the probe workspace in readiness/probe artifacts. |
| Reset process cleanup audit | implemented, needs real confirmation | maybe | Reset can stop related processes automatically. Confirm whether this remains automatic for trusted local smoke only or becomes a general harness option. |

## Next Slice To Execute

Name: Phase 11D First Bounded Harness 2 Real-Agent Run

Phase 11A/11B/11C are implemented: Customer Support Triage Board source specs and scenario skills are committed, reset creates the H2 workspace while preserving invoice as the control scenario, and fake H2 execution proves lifecycle, skills, repair, human verification, and product-readiness surfaces. Phase 11D now wires the built CLI full-run boundary for H2.

Next implementation objective:

- run a tightly bounded real Codex H2 smoke through `swarm smoke live-agent full --reset --scenario live-agent-smoke-h2`
- observe the run through the dashboard and preserve terminal state/artifacts after completion
- inspect summary, coverage, graph, human-action, product-readiness, and focus artifacts
- harden only generic harness gaps that appear in the run, not support-triage product facts
- decide whether the H2 runner needs invoice-runner parity features such as history archiving, coverage-completion packs, or richer outcome classification based on observed evidence

Historical foundation below explains why the next scenario must preserve full FR/AC verification, human-verification semantics, and product-readiness coverage.

Previous phase: Phase 10C-2 Requirement Ledger And Human Verification Semantics

Phase 10C-1 implemented the first enforceable layer: `VerificationObligation` type/storage, planner-derived obligations from source text, `slice.created`/`planner.decision` obligation summaries, dispatch preflight, read-only worker/reviewer prompt sections, criterion-level verifier evidence, and additive `/api/coverage` obligation fields.

Phase 10C-1A fixed the critical full-product acceptance truth gap found after the `15/83` run: product readiness passing no longer allows final `accepted` when registered FR/AC coverage is partial. Phase 10C-1B then made the gap actionable: `scripts/run-live-agent-demo.mjs` records `finalCoverageGate`, creates coverage-completion slices for remaining refs, and blocks with `outcomeClassification.code = "coverage_incomplete"` only if coverage cannot complete inside the run bounds. This is why product API refs such as `AC-API-001.*` must be leased, obligated, verified, and accepted explicitly instead of being inferred from a broad readiness probe.

Phase 10C-1C fixed the first real 100%-coverage calibration gap. A clean real run on 2026-06-16 reached product readiness and created coverage-completion work, but the remaining product-spec refs were collapsed into one 65-ref proof pack. The reviewer correctly rejected that pack because `AC-QA-001.5` was still hollow: tests checked static inline script text instead of executing a UI model/browser/DOM workflow for filters, detail selection, mark-paid, and refreshed summary/table/detail state. The runner now splits product-spec completion into coherent packs (`api-data`, `ui-summary-table`, `ui-detail-mark-paid`, `qa-interaction`, `local-usability`, and `smoke-acceptance`), raises full-product defaults to 80 turns / 7200 seconds / 20 slices / 150 agent runs, and injects explicit obligation guidance that static script-presence tests do not satisfy UI/QA interaction refs. Focused fake-Codex E2E proves both normal and delayed-readiness full-product paths can now reach accepted with `83/83` indexed refs done.

Phase 10C-1D makes review quality a first-class acceptance gate. Reviewer output now includes a structured Sleuth Review Gate with seven dimensions: runtime path, stub/hardcode, test meaningfulness, error handling, integration fit, maintainability, and real-world readiness. Reviewer prompts require the gate, slice reports/UI show it, and deterministic verification blocks failed gates, blocking concerns, failed dimensions, or high-risk dimensions. This is the answer to "review the functionality and implementation, not just AC/FR evidence."

Phase 10C-2A adds the first derived requirement ledger. `/api/coverage` now exposes `ledger.entries`, `ledger.totals`, and `ledger.rollups`, and every coverage row can carry `kind`, `directStatus`, `ledgerStatus`, `ledgerReason`, `parentRefs`, `childRefs`, `humanPath`, and `rollup`. Parent FRs with child ACs are explicit: container parents can roll up from accepted child ACs, and parents with incomplete child ACs remain visibly incomplete. The ledger is still derived from existing source refs, slices, leases, obligations, evidence, review results, dependencies, and escalations; it is not yet persisted as a separate table.

Phase 10C-2B makes human-verification obligations operational. When a ref's immutable obligation mode is `human_verification_required`, normal worker/reviewer/automated verification may still run and pass, but verifier output records that ref as `awaiting_human_verification`, writes JSON and Markdown human verification packet artifacts, records packet evidence as `artifact`/`human_verification_packet`, and keeps the slice from final acceptance until a future human result is recorded. `/api/coverage` exposes the latest packet link through `humanVerificationPacket` and `humanPath.packet`.

Phase 10C-2C adds human sign-off. `swarm human-verify <slice-id> <ref> --status human_verified|failed|needs_rework` records a durable human result, appends updated FR/AC verification evidence, updates slice/dependency state, completes leases when all refs are satisfied, and keeps failed/needs-rework refs blocked or repairing. Coverage now recognizes `human_verified` as a first-class verification result and reflects the latest human packet/result status.

Phase 10C-2D keeps the requirement ledger derived for now and makes that decision explicit: the durable facts remain source refs, leases, slice state, obligations, evidence, review results, dependencies, escalations, and human verification results; `/api/coverage` derives the latest ledger view from those facts. The Coverage UI now consumes ledger status, direct status, rollup reason, obligation mode, human packet/result state, and ledger filters directly. Persisted ledger snapshots should wait until real usage proves a need for point-in-time audit/history beyond existing events and evidence.

Phase 10C-2E defines the compact status-sink ledger contract without implementing a concrete external sink. `src/status-sink.ts` now owns `StatusSink`, `StatusUpdate`, and `buildStatusSinkLedgerSummary()`. The summary is explicitly `origin: "derived"`, links back to `/api/coverage` at payload path `ledger`, carries accepted/incomplete totals, attention counts, human-verification state, rollup counts, bounded buckets, and bounded next refs. This lets future Linear/file/Notion sinks publish meaningful progress without becoming a second source of requirement truth.

Phase 10C-2F adds the local human-action API for UI handoff: `GET /api/human-actions`, `POST /api/escalations/:id/clear`, and `POST /api/human-verify`. The queue derives from active escalations and `/api/coverage` ledger state, exposes focus/source/packet links plus allowed action templates, and returns refreshed queue state after writes. The Command Bridge server is now local trusted control, not purely read-only. See `docs/architecture/human-action-api.md`.

Phase 10C-2G CLI rebaseline/product-probe hardening: a fresh real run was launched through `node dist\cli.js smoke live-agent full` after reset-first and `swarm serve` on `127.0.0.1:4319`. Run `LAR-20260617T190112-live-agent-smoke-none-20932` accepted 5 slices and reached `19/83` coverage, then blocked final product readiness correctly. The generated app passed tests and printed `http://127.0.0.1:4321`, while the harness had assigned/probed a random `PORT` URL (`http://127.0.0.1:59808` in this run). `scripts/run-live-agent-demo.mjs` now records `assignedManualUrl`, parses local URLs printed by `npm start`, retries probes against the printed URL, records `probeUrlSource`/`observedStartUrls`, and reports the effective `commands.manualUrl`. Focused regression `full-product readiness probes the URL printed by npm start when PORT is ignored` passed.

Phase 10C-2H worker-status handoff hardening: the next built-CLI run `LAR-20260617T195034-live-agent-smoke-none-46088` was launched after reset-first with the UI server on `127.0.0.1:4319`. It proved meaningful real-agent flow: backend completed first, dashboard unlocked after accepted backend refs, product runtime/API/UI slices accepted, product readiness passed, final target snapshots were archived, source specs stayed unchanged, and the generated invoice dashboard passed `npm test` with `20/20` tests plus HTML/API/mark-paid probes. The final outcome was still `blocked` at `61/83` because the last QA proof-pack worker returned final status `needs_human` to mean "independent reviewer step still required." That was protocol misuse: the harness did run the independent reviewer, the reviewer accepted all 9 refs, and deterministic `npm run test` passed, but the verifier correctly refused to accept a final worker status of `needs_human`. `src/cli.ts` worker prompts now explicitly say to return `passed` when worker implementation/evidence is complete even though normal review/verifier phases remain pending, and to reserve `needs_human` for true human decision, clarification, or human verification. Regression coverage was added to `tests/invoice-demo.e2e.test.js`; `node --test tests\invoice-demo.e2e.test.js --test-name-pattern "planner creates read-only verification obligations"` ran the full file and passed `11/11`; `npm run build` also passed.

Phase 10C-2I accepted real full-product CLI run: after reset-first and fresh `swarm serve` on `127.0.0.1:4319`, run `LAR-20260618T062936-live-agent-smoke-none-40784` completed with `finalOutcome: accepted`, `83/83` indexed FR/AC refs done, `11` accepted slices, `53` agent runs, and product readiness passed. The final product probe verified browser HTML, `/api/summary`, and mark-paid workflow against an isolated copied target. The previous title-mismatch failure was fixed by letting the harness accept controlled dashboard title variants and by continuing API probes when HTML responds successfully. The run also showed real recovery behavior: a worker hit Windows `spawn EINVAL` during an agent-authored npm-start probe and recovered with alternate evidence; one reviewer incorrectly blocked because local Codex skill/config inheritance made it think `project-overseer` had to be loaded before review, then the overseer recovered by rerunning the slice/review. Hardening now isolates Codex child agents with `--ignore-user-config` by default, adds `protocol.workers.drivers.codex.ignoreUserConfig`, and broadens historical-warning cleanup for stale prior-slice git-access warnings. Residual lesson: archived summary counts can still be noisy if warning cleanup misses a wording variant, so warning/history vs active blocker visibility remains a UI/engine polish item.

Clean 100%-coverage real run confirmed:

- Run id: `LAR-20260616T171831-live-agent-smoke-none-48036`
- Final outcome: `accepted`
- Final reason: full-product readiness passed and indexed FR/AC coverage is complete
- Coverage: `83/83` indexed refs done, `0` incomplete
- Product readiness: passed
- Slices: `13` accepted slices, including coherent product coverage packs for API/data, UI summary/table, UI detail/mark-paid, QA interaction, local usability, and final smoke acceptance
- Agent/verifier activity: `56` agent runs and `13` deterministic verification runs
- Generated product: `.swarm-demo/live-agent-smoke/invoice-dashboard`; `npm test` passes `20/20`
- Product URL when started manually: `http://127.0.0.1:4321/`
- Residual hardening: 4 non-blocking active warning restatements remain around the same `git status` sandbox/ACL diagnostic. They did not block final acceptance, but should be cleaned before treating active-warning state as fully polished.

The next recommended implementation steps for Phase 10C-2 are:

- validate the derived-ledger Coverage UI and compact status-sink ledger summary against the accepted `LAR-20260618T062936-live-agent-smoke-none-40784` run
- keep Codex child-agent config isolation covered by tests and document any explicit protocol opt-in to user config inheritance
- keep product-readiness probe expectations scenario-declared rather than hidden in the runner
- design Harness 2 as a second scenario that consumes generic contracts instead of modifying core behavior around one product
- wire `buildStatusSinkLedgerSummary()` into the first concrete file/Linear status sink when that sink is implemented

Phase 10C-2J hardening after the accepted 2026-06-18 run:

- `scripts/reset-live-agent-smoke.mjs` now declares `fullProductMode.productReadinessProbe` in the scenario manifest.
- `scripts/run-live-agent-demo.mjs` consumes the manifest probe contract for UI text, API JSON-field probes, and the invoice mark-paid workflow paths.
- The invoice smoke remains product-specific as a scenario, but the readiness runner no longer hides invoice title/API assumptions inside the generic probe path.
- Run summaries now include `counts.activeBlockingEscalations`, `counts.activeWarningEscalations`, `counts.activeInfoEscalations`, and `escalationSummary` so UI/history can separate active blockers/human-required concerns from warning history.
- Harness 2 planning started in `docs/architecture/live-agent-smoke-harness-2.md`; Customer Support Triage Board is the approved baseline domain.

Phase 10D harness-managed skills:

- Skills are now a harness concept, not driver-level/global Codex leakage.
- Built-in skills live under `skills/builtin/<skill-id>/SKILL.md`.
- Default `protocol.skills` catalogs are `builtin` and `.swarm/skills`.
- Default role mappings attach `swarm-core`, `implementation-worker`, `verification-obligations`, `sleuth-review`, `super-overseer`, `recovery-focus`, and related skills by role.
- Dispatch resolves skills before worker/reviewer/overseer/recovery launch, copies selected files into the target workspace at `.swarm/run-skills/<run-id>/`, writes `skill-bindings-<run-id>.json` and `skill-packet-<run-id>.md`, inserts the skill packet into prompts, and records skill ids/hashes/paths in run events.
- `/api/snapshot` agent runs and `swarm inspect run` focus packets now expose skill binding artifacts.
- Missing required skills block dispatch before agent launch.
- Codex child agents still use `--ignore-user-config` by default; project-specific skills should be committed under `.swarm/skills` or scenario catalogs.
- Harness 2 should add project/scenario skills for support-triage domain rules, design tokens, and UI/accessibility guidance instead of expanding prompts.
- UI handoff is documented in `docs/architecture/skill-observability-ui-contract.md`. Current UI can consume skills through `/api/snapshot` agent runs, `/api/focus/run/:runId`, and skill-bearing event payloads. Next skill-observability hardening is to add artifact-relative URLs for skill binding/packet artifacts and a focused missing-required-skill dispatch test.
- Current invoice smoke should prove built-in skill bindings are visible on every overseer/worker/reviewer/recovery run. Harness 2 should stress project/scenario skills with support-triage domain rules, design tokens, and accessibility review.

Phase 11D H2 real-run queue-order lesson:

- A fresh H2 real run on 2026-06-19 exposed that the generated actionable queue served `Support Product` before `Support Backend`.
- The child overseer obeyed the prompt literally: "recommend the first nextSourcePullQueue item", so the issue was not model judgement; it was incorrect source-priority truth in the scenario reset scaffold.
- Fake-codex H2 tests had been masking this because the fake overseer hard-coded a backend-first command.
- `scripts/reset-live-agent-smoke.mjs` now registers H2 sources in implementation order: Support Backend priority 1, Support Design System priority 2, Support Dashboard priority 3, Support Product priority 4.
- `src/cli.ts` now suggests coherent FR-family batch sizes for source pulls: when the first available ref is a parent FR, the suggested batch includes that FR and its currently available child ACs, capped at 12.
- `tests/support-triage-live-runner.e2e.test.js` now parses the generated real overseer prompt and asserts `actionableState.nextSourcePullQueue[0]` is `Support Backend` targeting `support-api`, with `Support Product` last and a `SUP-API-001` FR+AC family batch.
- This keeps the core engine spec-agnostic: source priority remains scenario/input metadata, while the generic queue honors it.
- Focused verification passed: `npm run build` and `node --test tests\support-triage-live-runner.e2e.test.js`.

Phase 11D H2 backend-enabler confirmation run:

- Run id: `H2-20260619T070106Z-50228`.
- Command path: built CLI, `swarm smoke live-agent full --scenario live-agent-smoke-h2`, workspace `.swarm-demo/live-agent-smoke-h2-rerun`, dashboard on `http://127.0.0.1:4319/`.
- Final outcome: `blocked`, correctly, because the bounded 16-turn confirmation run stopped before full product acceptance.
- Coverage: `22/124` indexed refs done, `18%`, with `0` active escalations.
- Accepted slices: 4 backend capability packs:
  - `FR-SUP-API-001` plus `AC-SUP-API-001.1..001.7` ticket listing API
  - `FR-SUP-API-002` plus `AC-SUP-API-002.1..002.3` summary API
  - `FR-SUP-API-003` plus `AC-SUP-API-003.1..003.3` ticket detail API
  - `FR-SUP-API-004` plus `AC-SUP-API-004.1..004.5` assignment API
- Verification: each accepted slice passed worker evidence, independent Sleuth review, and deterministic verification; support-api tests reached `15/15`.
- Product readiness failed with `product-start-script` / `product-start-probed`, which is expected for this bounded backend-enabler run because frontend/product work was not reached.
- `finalCoverageGate` is `null` for this run because product readiness did not pass; the coverage gate only runs after readiness passes.
- Important lesson: child Codex agents still read the global `project-overseer` skill despite `--ignore-user-config` and run-bound harness skills. The harness now detects `.codex/skills/...` references and surfaces them as run-scoped warnings plus `global_skill_leak` focus diagnostics; full prevention remains future auth-safe driver isolation work.
- UI/product interpretation lesson: the dashboard should make it clear when a bounded backend-enabler run is blocked by the run bound/product readiness, rather than implying a product regression.

Phase 10C-1C verification is confirmed by the clean real full-product rebaseline. Phase 10C-1D is implemented in code/docs/tests and confirmed by the next real full-product smoke. Phase 10C-2A implements derived requirement-ledger semantics and parent FR rollups. Phase 10C-2B implements human verification packet artifacts and awaiting-human coverage links. Phase 10C-2C implements human result recording/sign-off. Phase 10C-2D implements the derived-ledger persistence decision and UI consumption of the ledger/rollup/packet/result fields. Phase 10C-2E implements the compact outbound ledger summary contract for future status sinks while keeping `/api/coverage` canonical.

Previous next goal is complete: the clean real full-product smoke reran with the hardened coverage-completion path and reached `83/83`.

Next practical slices:

Phase 9 follow-up:

- rerun `npm run smoke:live-agent:full` with the UI open after the live-smoke protocol timeout default is verified
- confirm no stale restated warning escalations remain active after final product acceptance
- confirm stderr no longer contains Node `DEP0190`
- confirm `product-dashboard-probe.json` includes `probes.markPaid.passed === true`
- confirm mark-paid probe accepts the real product's `{ invoices: [...] }` and `{ invoice: ... }` API payloads
- confirm readiness artifacts show `probeIsolation.strategy === "copied-target"` and `commandResults.start.passed` includes mark-paid workflow proof
- confirm reset-first works even when a previous viewer/product process exists, or records exact cleanup limitations
- confirm `/api/coverage` and the web Coverage tab reflect the final accepted FR/AC state

Phase 10A:

- extend `buildCoverage()` and `/api/coverage` additively so existing UI consumers keep working [implemented]
- for every FR/AC ref, expose source/domain, status, status reason, owning slice, lane/target/worktree, relevant worker/reviewer/verifier/overseer actors, latest verification/review findings, evidence ids/artifact paths where available, active blocker/escalation summary, dependency state, next expected action, and `lastChangedAt`
- keep the denominator as every indexed FR/AC ref, including not-started refs
- keep accepted refs tied to accepted slice/lease and/or passed verification evidence, not worker claims alone
- add tests for status reason, next action, blockers/escalations, dependency state, and accepted/not-started totals [focused tests implemented]
- harden warning-restatement suppression for repeated scenario warnings
- move product-readiness self-probing toward harness-owned canonical probes instead of agent-authored inline shell probes
- preserve all Phase 5C and Phase 6A-6F live scenarios plus Phase 7A/7B/8A/8B diagnostics

Phase 10B:

- persist worker/reviewer/revive prompt artifacts [implemented]
- add `swarm inspect run/slice` human and JSON focus packets [implemented]
- classify missing result, failed command, quiet running agent, stale run, active blocker, and high-retry states [foundation implemented]
- route focus packets into the real overseer prompt automatically for failed/stale/blocked/quiet/high-retry work [implemented as `actionableState.focusQueue`]
- allow bounded overseer `inspect run/slice` commands so the overseer can request zoom-in packets without shell spelunking [implemented]
- make recovery/revive use the focus diagnosis before restart [implemented by capturing focus artifacts before intervention]
- later expose focus summaries in the web UI agent/slice detail panels

Implementation order is defined in `docs/architecture/live-agent-smoke-implementation-plan.md`. Phase 1 through Phase 8C-19 are complete or attempted as documented. Phase 10A coverage enrichment is partially implemented. Phase 10B focus-packet foundation and overseer/recovery wiring are implemented. Phase 10C-1 through 10C-1C are confirmed through a clean real full-product run that reached `83/83`; Phase 10C-1D adds the structured Sleuth Review Gate to prevent fake-ready or hollow-proof slices from being accepted. The next useful checkpoint is Phase 10C-2: requirement-ledger semantics, parent FR rollups, and human verification/input state. Keep the Phase 5C happy path strict and auditable while evolving the full-product target with real agent behavior.

Do not lose the full-product target while implementing fault injection. The earlier phases built the measuring instrument; later full-product mode uses that instrument to prove the harness can turn `docs/requirements/live-smoke-invoice-dashboard-product-spec.md` into a local working product.

Acceptance criteria for the next slice should stay lifecycle-grounded:

- use `.swarm-demo/live-agent-smoke` as the resettable workspace
- prove the UI distinguishes simulated/scripted/live modes
- make overseer/planner a first-class visible agent
- keep overseer/planner command execution bounded and visible
- preserve fixture demos for CI
- keep `npm test` green

## Risks To Watch

- UI can become pretty without proving lifecycle truth. Keep tests tied to harness state.
- Scripted demos can accidentally be mistaken for real agent coordination. Label run modes explicitly.
- A graph visualization could become a side quest. Start with evidence/dependency usefulness.
- Planner autonomy must stay visible through decision events and checkpoints.
- Search/RAG must not become the source of completion truth. FR/AC graph and evidence remain authoritative.
- Avoid regenerating massive slice plans. Keep dynamic serving and short rolling plans.

## If Context Compacts Again

Do not rely on the previous chat. Use the docs and harness state:

1. Read this file.
2. Run `git status --short`.
3. Run `npm test` if feasible.
4. Inspect latest docs changed under `docs/architecture/` and `docs/examples/`.
5. Continue with the next slice above unless the user redirects.

## 2026-06-20 H2 Repair-Loop Hardening

Latest H2 lesson: a real run got stuck for over an hour on `SLICE-349e94c3` after human QA failed `FR-SUP-UI-007`/`AC-SUP-UI-007.*`. The reviewer found a concrete bug: support UI detail controls used broad `[data-ticket-id]` selection, so dropdown/textbox interaction could trigger ticket selection refresh and clear/close the input. The harness detected the defect, but then allowed repeated inspect/recommend cycles and high retry pressure instead of forcing a precise repair handoff.

Implemented hardening:

- Worker prompts now include a `Targeted repair context` section built from latest non-accepted review evidence, `requiredFixes`, failed/missing refs, active scoped blockers, and failed/needs-rework human verification notes.
- Overseer `actionableState.activeSliceQueue` now exposes `retryCount` and compact `repairContext`; prompt discipline says focus/inspect is diagnostic only when concrete repair context is missing.
- The H2 live runner now dispatches one direct `targeted-repair-dispatch` worker when a repairing/blocked slice has concrete review or human feedback and no worker has run after the latest repair signal.
- The H2 live runner now enforces `--max-repair-attempts` (default `8`): over-budget repair loops stop with `repair.retry_budget_exhausted`, the slice is blocked, and an active `Repair retry budget exhausted.` escalation is raised.
- `GET /api/control/commands` now includes an `activity` payload for background commands: stdout/stderr byte counts, latest output time, latest artifact, latest agent run, and latest heartbeat. The record updates while a child run is alive, so the UI no longer sees a frozen parent command for a busy runner.
- `/api/human-actions` is now an action queue only. After a human records `human_verified`, `failed`, or `needs_rework`, that ref leaves the human queue immediately; failed/rework results remain durable evidence and targeted repair context for the overseer/worker path.

Verification:

- `npm run typecheck`
- `npm run build --silent && node --test tests\support-triage-live-runner.e2e.test.js` passed `7/7`
- `node --test tests\web-server.e2e.test.js` passed `2/2`
- `npm -w web run test -- --run` passed `266/266`

## 2026-06-23 Human Visual QA Action Hardening

Latest H2 lesson: the design-system slice `SLICE-575b5433` was correctly blocked for human visual QA, but the UI surfaced it as generic `decision_required`/`human_input_required`, so the operator could not see the packet, concrete AC checklist, or start-dev-server mechanism. Root cause: the verifier treated reviewer `status: human_required` plus per-FR/AC `missing_evidence` findings as non-actionable, even when the missing evidence was explicitly the human visual QA required by immutable obligations.

Implemented hardening:

- `readLatestReviewGate()` now marks a human-required review as `humanVerificationReady` when all non-passing findings are only missing human visual/sign-off evidence, the refs require `human_verification_required`, and the quality gate has no blocking/high-risk concerns.
- Deterministic verification now emits `awaiting_human_verification` FR/AC results and writes human-verification packet artifacts for that state.
- `/api/human-actions` suppresses duplicate generic slice-level `human_required` escalations once concrete per-FR/AC human verification actions exist.
- Coverage ledger status now prefers explicit `awaiting_human_verification` over a broad active human-required escalation, so visual QA is not mislabeled as spec/human input.
- The web human-action detail drawer now renders `reviewTarget`, immutable requirement text, expected outcomes, review instructions, command source, and a target-specific dev-server start button.
- `postDevServerStart()` and `DevServerVerify` now pass through `commandName` from `reviewTarget.startAction.bodyTemplate` and disable the button when no runnable review command is available.

Live H2 workspace status after patch: rerunning `verify SLICE-575b5433 --force` generated four packets for `FR-DS-HUMAN-001` and `AC-DS-HUMAN-001.1` through `.3`; restarted Command Bridge on `http://127.0.0.1:4319/` now reports `/api/human-actions` totals `humanVerification: 4`, with `reviewTarget.targetName: support-ui`, `startCommand: npm run start`, packet links, expected outcomes, and `record_human_verification` actions.

Verification:

- `npm run build`
- `node --test tests\invoice-demo.e2e.test.js` passed `13/13`
- `node --test tests\human-actions.test.js` passed `1/1`
- `node --test tests\web-server.e2e.test.js` passed `3/3`
- `npm -w web test -- --run src/components/DevServerVerify.test.ts src/lib/control.test.ts src/lib/human-actions.test.ts` passed `32/32`
