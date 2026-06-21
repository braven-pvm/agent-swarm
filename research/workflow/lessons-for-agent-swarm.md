# Lessons for agent-swarm (source-confirmed)

What to borrow from the `Workflow` tool, **after** reading our own `src/` and running every candidate
through an independent skeptic. This replaces the earlier draft, which over-claimed gaps from session
memory. Method: a 6-lens forensic workflow (each lens read the real source) → 24 recommendations →
per-recommendation skeptic that re-read the source and **default-rejected** → **12 survived**.

- Ground truth (what we actually do): [ground-truth-agent-swarm.md](ground-truth-agent-swarm.md)
- The run that produced this (and what it dropped): [meta-run-analysis.md](meta-run-analysis.md)
- Raw confirmed/dropped data: [artifacts/forensic-run/forensics-output.json](artifacts/forensic-run/forensics-output.json)

Every recommendation below is cited to source and tied to a mission non-negotiable
(`docs/architecture/core-philosophy.md`). Effort S/M/L, risk low/med/high as scored by the skeptic.

---

## First, what we already do well (do NOT rebuild)

The skeptic dropped a third of the candidates as **already implemented** — credit where due:

- **Model-agnostic schema-enforced results.** codex `--output-schema`, claude `--json-schema`, both
  Zod-`safeParse`'d, validated again at accept time (`worker-driver.ts`, `schemas.ts`, `cli.ts:3846+`).
- **Evidence-derived requirement ledger** — status rolls up from evidence, not chat
  (`observability.ts:590-745`); "is this done?" is answerable from durable state.
- **A propose→allowlist-execute overseer** — `overseerDecisionSchema.recommendedCommands` validated by
  `validateOverseerCommand` against a child-dispatch contract (`cli.ts:6038, 6174-6232`).
- **The Sleuth Review Gate** — structured quality dimensions block acceptance even when status says
  "accepted" (`cli.ts:4124-4243`); reviewer is already a separate actor from the worker.
- **Session-level recovery** + resume packets that already compute `doNotRedo`/evidence
  (`cli.ts:1489-1842`, `checkpoints.ts:195-224`).

The real opportunities are narrower than "adopt Workflow's design" — they're about closing specific
seams.

---

## P1 — quick wins (small, low-risk, high-leverage)

### SO-1 · Generate the driver JSON Schema FROM the Zod schema (single source of truth) · S/low
The driver-facing JSON Schema is **hand-written** (`cli.ts:6460-6611`) separately from the Zod
schemas (`schemas.ts`) — two contracts that can drift. Replace the three `writeXSchema` functions
with one generator using **zod v4's native `z.toJSONSchema()`** (already on `zod ^4.1.13` — no new
dep), emitting `additionalProperties:false` and correct per-role `required`. Add a parity test
(`tests/schema-parity.test.js`) that fixtures accepted/rejected identically by both.
**Mission:** *evidence vs immutable criteria* — the contract a worker is held to must equal the
contract its evidence is judged by. Closes a silent path where a "valid" result drops the Sleuth gate
(`schemas.ts:95-101`).

### CP-1 · Inject a settled-facts / already-verified block into worker (and revive) prompts · S/low
`buildWorkerPrompt` (`cli.ts:6320-6388`) has no ledger-derived no-redo block; the `doNotRedo` material
already computed for resume packets (`checkpoints.ts:195-224`) is never sent to the worker. Add a
harness-authored "settled facts (do not re-derive)" section scoped to **sibling-accepted** passing
FR/AC + already-passed commands — never excusing the worker's own in-scope evidence.
**Mission:** *status derives from the ledger, not chat memory* — the no-redo facts are ledger-derived
and FR/AC-keyed; cuts redundant investigation while keeping checkpoints authoritative.

### CP-2 · Feed the resume packet into revive dispatch, not just the CLI · S/low
The revive path (`cli.ts:1621 buildWorkerRevivePrompt`) sends a generic slice brief; `buildResumePacket`
already produces the structured no-redo block (evidenceStatus, commandEvidence, activeBlockers,
doNotRedo) but it isn't threaded in. Compute `buildSliceRepairContext` at the revive call site and
embed it.
**Mission:** *checkpoints/resume packets make chat memory disposable* — recovery should resume from
authoritative facts, not a blank brief.

---

## P2 — high-value, medium effort

### SO-2 · Bounded in-turn re-ask on schema failure before blocking · M/med
On a **schema/parse** failure (not `is_error`/no-result — those are real run failures), resume the
**same** driver session 1–2× with the verbatim Zod error + "re-emit only the structured result"
before falling through to `blocked`/escalate (`cli.ts:2392/2423-2464` worker, `2647/2663-2744` review,
`2117/2133-2219` overseer). Cap attempts; record each as an event.
**Mission:** *anti-drift + verified-state throughput* — stops near-miss JSON from manufacturing
"blocked" busy-work and a full operator revive/restart cycle.

### RE-1 · Make the skeptic a distinct actor, never the reviewer or worker · M/low · (KEEP)
Add an independent finding-challenge step as its **own agent run + role + actor** (e.g. `role:"skeptic"`,
evidence kind `finding_challenge`), mirroring worker/reviewer separation (`cli.ts:2502-2707`); forbid
reusing the worker or the reviewer session; record verdicts as events.
**Mission:** directly upholds *workers may not create/edit/approve their own verification* and
*independent review* — a skeptic is only legitimate if independent. (Requires extending the
`EvidenceRecord.kind` union, `types.ts:174`.)

### RE-2 · Replace all-or-nothing slice blocking with skeptic-scored per-finding severity · M/med
Today one finding flips a whole slice. After RE-1, have `readLatestReviewGate`/
`reviewQualityBlockingReasons` (`cli.ts:4124-4243`) consume the skeptic's per-finding verdicts so only
findings the skeptic accepts as **blocking** flip the slice; the rest become recorded `residualRisks`.
Keep hard backstops unconditional (source mutation → `human_required`).
**Mission:** keeps ledger rollups accurate (real blockers only) and cuts the non-actionable churn we
observed live (`human_verification_rework` loop) **without** weakening immutability gates.

### SC-2 · Enforce `maxActiveLanes` (+ a per-lane agent cap) as a real scheduling budget · M/low
`protocol.lanes.maxActiveLanes` is **dead config** (`protocol.ts:53`, never enforced). Read it at lane
reuse/creation (`planner.ts:133`) to cap concurrently-active lanes, add a per-lane in-flight agent
cap, and emit a visible `scheduling.budget_applied` / `lane.starvation_deferred` event on deferral.
**Mission:** *anti-drift + visibility* — bounded, replayable scheduling decisions surfaced as events;
prerequisite for SC-1.

### SO-3 · One shared ResultExtractor (validate/persist core) per driver · M/med
Move `JSON.parse → safeParse → writeFile` into one `extractAndPersistResult(raw, spec)` helper; each
driver supplies only the raw-locator (codex: file at `resultPath`; claude:
`lastResultEvent(stdout).structured_output`). Make "a schema-valid result was persisted to
`resultPath`" the single invariant every driver must satisfy.
**Mission:** *model-agnostic* — makes adding drivers cheap/uniform and gives one guaranteed
chain-of-truth link (worker → validated result). Also make the **fixture** path run the same gate so
tests exercise `safeParse`.

---

## P3 — bigger bets (architectural)

### OCF-1 · Overseer emits the plan; code executes the mechanical fan-out · M/med · (KEEP)
The LLM turn is "largely an echo of a deterministically-precomputed command" — `buildOverseerStatePacket`
already has `activeSliceQueue`/`nextCommand`. Execute the queue head **in code** when it equals the
precomputed `nextCommand` (the common case); invoke the LLM only when the queue is empty/ambiguous or
blockers/`focusQueue` need senior judgement. **Guardrail:** the code fast-path must still pass
`validateOverseerCommand` + the child-dispatch contract (`cli.ts:6038, 6174-6232`) — never bypass
safety re-validation. Keep emitting `recommendedCommands` as the visible plan.
**Mission:** preserves *planner decisions visible as events* and the autonomy boundary while honoring
*anti-drift* (don't spend LLM turns on busy work). Cuts cost + latency on every loop.

### OCF-2 · Extract one reusable deterministic orchestrator into `src/` · L/med
Lift the turn loop, hard guards (max turns/runtime/slices/agent-runs, source-mutation check), fault
handlers, and verify-then-orchestrate sequencing out of `run-live-agent-demo.mjs` /
`run-support-triage-live-demo.mjs` into `src/orchestrator.ts`, configured by a scenario manifest with
**pluggable** fault/acceptance hooks (respect the runners' real divergence; don't force-merge).
**Mission:** makes the deterministic control plane a platform guarantee, not a per-demo artifact;
consistent ledger-derived limits across scenarios.

### SC-1 · Pipeline dependency-satisfied slices with a bounded concurrency budget · L/med
Replace one-action-per-turn (`run-live-agent-demo.mjs:332` `.find()`) with a scheduler that each tick
dispatches up to a concurrency budget of slices whose next stage is dependency-satisfied, so worker(B)
runs while reviewer(A) runs. The real serialization to break is **blocking subprocess dispatch**
(`execFileSync`/`spawnSync` in the runners), not the already-async `executeWorkerRun`/`executeReviewRun`.
Verify stays per-slice behind that slice's own evidence. Needs SC-2's budget first.
**Mission:** realizes *coordinate autonomous agents at scale*; status still rolls up from the ledger,
not from scheduling order.

### OCF-3 · Content-addressed result journal for agent leaves · M/low · (contested — read this)
Wrap the leaf spawn (`spawnWorkerStreaming`, `cli.ts:2812`) in a journal keyed by `sha256` of a fully
enumerated input envelope (prompt + driver + model + result-schema + the **exact immutable source
hashes** and slice/ledger fields interpolated into the prompt); on an exact match, return the stored
**validated** result instead of re-spawning; record hits as events.
**Caveat (why it's P3, not P1):** the skeptic **dropped** this idea under the *resume* and
*context-packets* lenses, judging it largely **already covered** by the evidence ledger + skill/source
hashing — it only survived under the *orchestration* lens in this narrow "wrap the leaf, key on the
full envelope, replay only on byte-exact match" framing. Treat as an optimization to prototype and
measure, not a foundational gap. Must stay a **result** cache, never a criteria cache (immutability).

---

## What I over-claimed (dropped by the skeptic — recorded for honesty)

| Draft claim | Verdict | Why |
|---|---|---|
| "Adopt schema-enforced structured output" | already done | codex/claude both schema-validate via Zod |
| "Add content-addressed step memoization for resume" | dropped | evidence ledger + skill/source hashing already make units addressable; survived only as the narrow OCF-3 |
| "Make storage idempotent via evidence dedupe key" | dropped | evidence is already ref+slice keyed and the ledger derives from it |
| "Ban Date.now()/random in the orchestration loop" | dropped | those are demo-script wall-clock guards, not a replay engine — wrong target |
| "Stop paying an overseer turn between transitions" | already partly | overseer is already propose→allowlist-execute; refined into OCF-1 |
| "Gate human failed/needs_rework through the skeptic" | dropped | not how the human path works; folded into RE-1/RE-2 scope |

This table is the point of the exercise: most "obvious" lessons were already done or mis-framed. The
12 that survived are the ones worth your time.

---

## Recommended sequence

1. **SO-1, CP-1, CP-2** (all S/low) — schema parity + no-redo wiring. Days, not weeks; pure upside.
2. **RE-1 → RE-2** — the independent skeptic + per-finding severity. Directly kills the repair churn we
   hit live, and is the most *mission-resonant* change (independent verification).
3. **SO-2, SC-2, SO-3** — re-ask, enforce the dead lane budget, unify extraction.
4. **OCF-1**, then **SC-1** (needs SC-2), then **OCF-2** — the architectural bets, in that order.
5. **OCF-3** — prototype + measure only if leaf re-runs prove a real cost.

The throughline: agent-swarm and Workflow are the **same idea at different points** — code-deterministic
orchestration of schema-validated, independently-verified, resumable agent leaves. agent-swarm already
has the mission-critical guarantees; these 12 import Workflow's *discipline* (single schema source,
self-healing output, independent skeptic, real concurrency, wired no-redo) without surrendering the
adaptive overseer or the human-in-the-loop paths that Workflow lacks.
