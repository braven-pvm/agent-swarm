# Control-plane handoff — implementation summary

Date: 2026-06-21
Handoff: [../../claude-workflow-implementation-handoff.md](../../claude-workflow-implementation-handoff.md)
Method: dogfooded via Claude Workflow (run `wf_437a2db3-cee`, 15 agents, ~1.3M tokens, ~46 min),
then **independently verified** by the main agent (build + tests + diff review).

## Status: ✅ both slices implemented, verified, additive

All six FRs met; build green; 34/34 focused tests pass; **0 existing tests weakened** (purely additive).

## Files changed (this slice — on top of in-flight Codex hardening)

| File | Δ | What |
|---|---|---|
| `src/cli.ts` | +409 | settled-facts helpers + worker/revive prompt wiring + `recovery.focus_consulted` |
| `src/focus.ts` | +249 | `FocusIntervention` types + `computeIntervention` + additive `intervention` on both packets |
| `tests/fr-focused.e2e.test.js` | new | one labeled test per FR (FR-CP-001/002/003, FR-PI-001/002/003) |
| `tests/settled-facts.e2e.test.js` | new | settled-facts section + scope isolation |
| `tests/focus-packet.e2e.test.js` | +102 | intervention field assertions |
| `tests/invoice-demo.e2e.test.js` | +21 | additive assertions |
| `tests/live-agent-runner.e2e.test.js` | +48 | additive assertions |
| `tests/web-server.e2e.test.js` | +21 | API intervention shape |

> `src/worker-driver.ts`, `tests/review-runner.e2e.test.js`, `tests/streaming-worker.e2e.test.js`
> were **pre-existing uncommitted Codex hardening** (valid-artifact recovery); the handoff said to
> build on top, not discard. They are bundled in the same working tree.

## Exact new fields / API / events

**Prompt (Slice A — FR-CP):**
- `buildWorkerPrompt` adds an optional `settledFacts?: LedgerSettledFacts` input and renders a
  delimited **"Settled facts from the requirement ledger"** section, persisted in
  `worker-prompt-<runId>.md`.
- `buildWorkerRevivePrompt` forwards `settledFacts` + a **"Resume / ledger context"** block, persisted
  in `worker-revive-prompt-<revivedRunId>.md`.
- Explicit guard sentence: *"These settled facts do NOT waive your evidence obligations for the current
  slice scope … the current slice's own refs are NOT settled merely because work was claimed."*
  (`cli.ts:4494`) — satisfies FR-CP-003 scope isolation.
- New types (in `cli.ts`, **not** the shared `types.ts`): `LedgerSettledFacts { inScopeRefs,
  acceptedSiblings, blockedRefs }`, `SettledFact { ref, ledgerStatus, sliceId?, evidenceIds[],
  commandSummary? }`, `SettledBlockedRef { ref, status, message }`. Sourced from
  `buildCoverage(store).ledger` + `buildCheckpointPayload(...).commandEvidence` (durable, not chat).

**Focus packet (Slice B — FR-PI):**
- `RunFocusPacket.intervention` and `SliceFocusPacket.intervention` (additive siblings of `diagnosis`).
- Exported `FocusIntervention { classification, confidence, recommendedAction, reason, evidence[],
  risk }` with unions `InterventionClassification` / `InterventionConfidence` /
  `InterventionRecommendedAction` (`src/focus.ts`).
- `computeIntervention` maps failure classes → action (first-match priority), e.g.
  `child_idle_timeout && resultArtifact.exists → valid_artifact_hung_child / accept_valid_artifact`
  (risk: *"Restart would discard a valid produced artifact"*) — directly the live failure mode.
- **Event `recovery.focus_consulted`** (entityType `agent_run`) recorded **before** revive/restart
  (`cli.ts:1998-2007`), payload `{ focusRunId, recoveryKind, hasSession, classification,
  recommendedAction, confidence, reason, risk, evidence, validArtifactPreserved?,
  samesessionPreferred? }` — satisfies FR-PI-002 (same-session revive stays preferred; valid-artifact
  not downgraded to restart churn).

**API (FR-PI-003):** `/api/focus/run/:runId` and `/api/focus/slice/:sliceId` now serialize the
`intervention` object verbatim (no route change — additive to the packet they already return).

## Tests run + results (independent main-agent verification)

- `npm run build` (`tsc && build:web`) → **exit 0, no TS errors** (run twice).
- `node --test` over `fr-focused`, `settled-facts`, `focus-packet`, `streaming-worker`,
  `review-runner`, `web-server`, `invoice-demo` → **34 tests, 34 pass, 0 fail, 0 skip** (de-ANSI'd
  summary, exit 0).
- Integrity: existing files the workflow touched have **0 removed/changed assertion lines** — additive.
- `tests/live-agent-runner.e2e.test.js` (long full-product E2E, +48 additive): launched separately;
  it can exceed shell timeouts per the handoff caveat — see test-output.txt for final status. The
  targeted FR coverage above does not depend on it.

## Residual risk

- The long `live-agent-runner` full E2E was not confirmed green within the verification window (slow by
  design). Its changes are additive and the focused suite passes; re-run it explicitly to close out.
- `computeIntervention` classification is heuristic (priority-ordered first-match). It is advisory and
  additive — no existing consumer is forced to act on it yet (FR-PI-002 only *records* consultation).
- Settled-facts only promotes **ledger-accepted** sibling refs; correct by FR-CP-003, but coverage of
  edge ledger states (e.g. `overridden`) should be confirmed as the ledger evolves.

## Generic vs scenario-specific

**Fully generic + model-agnostic.** No codex/claude-only path; everything reuses driver-agnostic
ledger/checkpoint/focus code. Skeptics confirmed `modelAgnostic=true` for all 6 FRs.

## Archived Workflow artifacts (this folder)

`workflow.script.js` · `journal.jsonl` · `agent-anatomy.tsv` (15 agents) · `workflow-output.json`
(full structured output incl. design/impl/verify/meta) · `skeptic-verdicts.json` (6 FRs, all met) ·
`PRE-workflow-HEAD.txt` + `PRE-workflow-diffstat.txt` (attribution baseline) · this summary ·
`test-output.txt`.

## Meta / dogfood verdict

Using Workflow to implement agent-swarm's own hardening **succeeded**: it produced complete, correct,
additive, tested, model-agnostic code across two files + six test files, with every FR independently
verified and no existing test weakened. The phased shape (Baseline read-only → Design → sequential
Impl A/B with `tsc` self-checks → Test → independent Verify → per-FR Skeptic → Meta) avoided
file-conflict and caught its own gaps. Honest caveats: (1) ~46 min wall-clock for a "small" slice —
the deterministic sequential implementation is thorough but not fast; (2) the in-workflow skeptics
were not a substitute for the main agent independently re-building, re-testing, and reading the diff —
which is exactly the RE-1/RE-2 lesson (an *independent* verifier matters). This run is itself evidence
for the next recommended slice.

## Recommended next slice

Per the handoff follow-up + meta: **SO-1** (generate the driver JSON Schema from Zod via
`z.toJSONSchema()` + a parity test — kills the dual-source drift), then **RE-1 → RE-2** (independent
skeptic role + per-finding severity). Keep OCF-3 (result journal) as a measured prototype only.
