# Ground truth: what agent-swarm actually does

Source-grounded baseline for the six subsystems compared against the `Workflow` tool. Established by
reading `src/` directly (a 6-lens forensic workflow + independent main-agent reads), every claim
cited to a file. This corrects the earlier draft, which over-claimed gaps from session memory.

> Read with [forensic-analysis.md](forensic-analysis.md) (how Workflow works) and
> [lessons-for-agent-swarm.md](lessons-for-agent-swarm.md) (the confirmed recommendations).
> Raw per-lens detail: [artifacts/forensic-run/ground-truth-by-lens.txt](artifacts/forensic-run/ground-truth-by-lens.txt).

---

## 1. Structured output & result validation — **strong, with seams**

We already do schema-enforced structured output, **model-agnostically** — this matches Workflow's
intent, not a gap:

- **codex** is launched with `--output-schema <path> --output-last-message <path>`; the child writes
  a result file, and `finalize()` → `validateResultArtifact()` does `JSON.parse` + Zod
  `schema.safeParse` (`worker-driver.ts:60-139`).
- **claude** is launched with `--json-schema <json>`; `finalize()` scans the `stream-json` for the
  `type:"result"` event, `safeParse`s its `structured_output`, and persists it
  (`worker-driver.ts:169-252`). Claude's own `StructuredOutput` tool is even recognized in
  `classifyHeartbeat` (`:213`).
- Schemas are rich and are the real contract: `workerResultSchema` (frAcCoverage + evidence),
  `reviewResultSchema` (the **Sleuth quality gate**, requiredFixes, escalations),
  `overseerDecisionSchema` (recommendedCommands, lanePlan, blockers) — `schemas.ts:38-144`.
- Results are validated **twice**: at finalize, and again at consume/accept
  (`cli.ts:3846-3865` review, `5667-5686` overseer, `4326-4345` worker verifier).

The real seams (confirmed gaps):

- **No model-side re-ask.** A malformed/near-miss result sets the slice `blocked` and inserts an
  escalation (`cli.ts:2464`, `2740-2744`, `2183-2219`); recovery is operator-driven revive/restart,
  not an in-turn "fix your JSON" retry. Workflow self-retries at the tool layer.
- **Two sources of schema truth.** The driver-facing JSON Schema is **hand-written** in
  `writeWorkerResultSchema` / `writeReviewResultSchema` / `writeOverseerDecisionSchema`
  (`cli.ts:6460-6611`), separate from the Zod schemas (`schemas.ts`). They can drift; no parity test.
  Worse, `reviewResult.qualityGate` has a Zod **default** (`schemas.ts:95-101`), so a "valid" result
  can silently omit the Sleuth gate.
- **Per-driver extraction divergence** with no shared validate/persist core; the **fixture** driver
  bypasses validation entirely (`cli.ts:2360-2366`), so tests never exercise the `safeParse` gate.

## 2. Resume, recovery & idempotency — **session-level, evidence-backed**

- Recovery is **session-level**: `recovery scan --mark-stale`, same-session `revive` (re-uses
  `sessionId`/`thread_id`, recovered from JSONL if needed), and `restart` fallback
  (`cli.ts:1489-1566`, `1583-1646`, `1796-1842`).
- Resume packets / checkpoints make chat memory disposable (`checkpoints.ts`); they already compute a
  `doNotRedo` / `evidenceStatus` / `commandEvidence` block (`checkpoints.ts:195-224`, `311-323`).
- The **requirement ledger is derived from evidence** (`observability.ts:590-745`), and evidence is
  keyed/looked-up by ref+slice — so "is this unit already done?" is already answerable from durable
  state, not chat.
- **What's missing:** there is no *content-addressed step journal* that lets an identical agent leaf
  be replayed without re-billing the model. Re-running a step re-spawns the provider. (The skeptic
  judged most journal framings already-covered by the evidence ledger + skill/source hashing —
  see lessons CB-/OCF- note.) `grep journal|memoiz|content-address` in `src/` finds only the SQLite
  WAL pragma and a transient in-rollup `evidenceCache`.

## 3. Orchestration control flow — **already a "propose → allowlist-execute" hybrid**

- The overseer is **not** raw "LLM does everything." It emits a structured `overseerDecisionSchema`
  with `recommendedCommands` (each `purpose` / `expectedStateChange` / `requiresHuman`); code
  validates each against an allowlist (`validateOverseerCommand`, `cli.ts:6038`) and a child-dispatch
  contract (explicit actor, `--driver`, allowed slice statuses, worker-evidence-before-review)
  before executing (`cli.ts:6174-6232`). Decisions are recorded as events/checkpoints (visible).
- The overseer prompt already carries **anti-churn discipline** (`cli.ts:5442-5444`: high retry +
  repair context → dispatch targeted repair or block, don't keep recommending inspect-only turns).
- **What's true:** the LLM turn is "largely an echo of a deterministically-precomputed command" —
  `buildOverseerStatePacket` already computes `activeSliceQueue` / `nextSourcePullQueue` / exact
  `nextCommand`, so for the common case the LLM is re-deciding what code already knows.
- **What's missing/duplicated:** the deterministic turn-loop + guards + fault handlers + verify
  sequencing live in the **demo scripts** (`scripts/run-live-agent-demo.mjs`,
  `run-support-triage-live-demo.mjs`), not a reusable `src/` orchestrator. (The skeptic rejected the
  framing that the loop "should ban Date.now()" — those `Date.now()` calls are demo wall-clock
  guards, not a replay engine.)

## 4. Findings → escalation / repair — **direct, no independent skeptic**

- Reviewer findings are themselves schema-validated and gated by the **Sleuth Review Gate**: a
  failed/high-risk `qualityGate` blocks acceptance even if the status string says "accepted"
  (`reviewQualityBlockingReasons`, `cli.ts:4230-4243`; `readLatestReviewGate` `:4124-4164`).
  Reviewer is already a **separate actor** from the worker (`cli.ts:2502-2707`).
- **What's true:** there is **no independent skeptic** between a finding and repair/human dispatch —
  `readReviewResultFile` (`cli.ts:3846-3865`) is a `safeParse`, not an adversarial challenge.
  `applyReviewOutcome` (`:3867-3959`) acts on the finding directly. So a single finding can flip a
  whole slice (boolean gate), and a `human_verification_rework` can re-drive repair with no challenge
  of the human verdict — the exact churn we observed live.

## 5. Scheduling & concurrency — **strictly serial**

- The run loop processes **one ready slice per turn** (`run-live-agent-demo.mjs:332` uses `.find()`),
  dispatches work as **blocking subprocesses** (`execFileSync`/`spawnSync`), and runs **one verify
  per turn**. The async `executeWorkerRun`/`executeReviewRun` (`cli.ts:2253/2502`) are already
  one-process-each but are awaited serially. There are **zero concurrency primitives** in `src/`.
- `protocol.lanes.maxActiveLanes` exists (`protocol.ts:53`) but is **dead config** — never read to
  cap concurrency; `planner.ts:133` reuses the first active lane without a budget.
- Net: wall-clock ≈ sum-of-everything; the overseer is also a per-turn global serialization point.

## 6. Context packets — **rich, but the no-redo guard isn't wired to workers**

- Focus packets are rich: `failureClasses`, deduped/capped `recommendedInterventions`, weighted
  `focusPriority` (`focus.ts:78-148`, `511-739`). Skill packets bind hashed SKILL.md files per run
  (`skills.ts`). Resume packets compute `doNotRedo`/`evidenceStatus`/`commandEvidence`
  (`checkpoints.ts:195-224`).
- **What's true (the gap):** that structured `doNotRedo` / already-verified material is **never
  injected into the worker or reviewer prompt**. `buildWorkerPrompt` (`cli.ts:6320-6388`) is
  hand-assembled with a verbal "implement only this slice scope" and no settled-facts block; the only
  data-driven no-redo signal is `formatRepairContextForPrompt` (`cli.ts:6390-6431`), which lists
  non-passing refs only. The revive path (`cli.ts:1621`) sends a generic slice brief, not the resume
  packet it's meant to carry. The anti-redundant-investigation discipline is **prose-only and
  overseer-only**.

---

## Summary: agent-swarm vs Workflow at a glance

| Mechanism | Workflow | agent-swarm today |
|---|---|---|
| Schema-enforced typed results | tool-layer, self-retry | ✅ schema-validated (Zod), **but** post-hoc, no re-ask, dual schema source |
| Deterministic control plane | code is the plane | ✅ hybrid (overseer proposes, code allowlists/executes); loop lives in demo scripts |
| Content-addressed replay journal | core primitive | ⚠️ partial — evidence ledger + hashes cover much; no leaf-result journal |
| Independent adversarial verify | per-finding skeptic | ❌ Sleuth gate yes, independent skeptic no |
| Pipeline / concurrency | pipeline, no barrier | ❌ strictly serial; `maxActiveLanes` dead config |
| Shared context + no-redo guard | shared CONTEXT block | ⚠️ packets rich, but `doNotRedo` not injected into worker/reviewer prompts |
| Fresh-context isolation | per subagent | ✅ each run is its own driver process/session |

The headline: agent-swarm is **further along than the first draft implied** — it already has the
hard parts (model-agnostic schema validation, evidence-derived ledger, a propose/execute overseer,
the Sleuth gate, session recovery). The real opportunities are **narrower and sharper** — see
[lessons-for-agent-swarm.md](lessons-for-agent-swarm.md).
