# Forensic analysis: how the `Workflow` tool actually works

Reconstructed from the run artifacts of `wf_e5f50995-09f` (the `skill-isolation-ui-review`).
Every claim below is cited to an artifact you can re-open.

---

## 0. What ran

The main agent authored a JS script and handed it to the `Workflow` tool. The script
(`artifacts/skill-isolation-review.script.js`) has three parts:

- `export const meta = {...}` — a **pure literal** manifest (name, description, `phases[]`).
  The runtime reads this *before executing the body* to render the progress UI and the
  permission dialog. It must be static (no variables/among computed values).
- A big `CONTEXT` string — shared, immutable facts handed to every subagent.
- A body using four orchestration primitives: `phase()`, `agent()`, `parallel()`, `pipeline()`.

The body, in essence:

```js
phase('Review');
const reviewed = await pipeline(
  LENSES,                                            // [correctness, contract, design]
  (l) => agent(reviewPrompt(l), {schema: FINDINGS_SCHEMA, phase:'Review'}),   // stage 1
  (review, l) => parallel(                           // stage 2, per finding
    review.findings.map(f => () =>
      agent(verifyPrompt(f), {schema: VERDICT_SCHEMA, phase:'Verify'})
        .then(v => ({lens:l.key, finding:f, verdict:v})))),
);
const confirmed = reviewed.flat().filter(Boolean).filter(x => x.verdict.isReal);
return { confirmed, refuted };
```

That's the whole control plane. Note what's **code** (the loop, the fan-out, the filter,
the dedupe) vs what's an **LLM call** (`agent(...)`). This split is the central idea.

---

## 1. Determinism: the control plane is ordinary code

The orchestration logic is deterministic JavaScript. The only non-deterministic steps are the
`agent()` calls. This is the inverse of an "LLM overseer decides what to do next" design: here a
human-written program decides the shape, and the model only fills the leaves.

Evidence: the script is plain control flow (`pipeline`, `parallel`, `.flat().filter()`); the
runtime even **forbids `Date.now()` / `Math.random()`** in scripts (they'd break replay). The
whole thing is built to be re-runnable to the same shape.

Consequence: the workflow is debuggable and auditable like code, and — combined with §2 —
**replayable**.

---

## 2. Content-addressed result journal (the resume/cache primitive)

`artifacts/journal.jsonl` is 24 records: **12 `started` + 12 `result`**. Shape:

```json
{"type":"started","key":"v2:1c2a0bf5a8f3...","agentId":"a6f53d8cc2abceb54"}
{"type":"result","key":"v2:0cdf5b1c8563...","agentId":"a3b2075eac563d561",
 "result":{"lens":"Design Quality...","summary":"...","findings":[ ... ]}}
```

Key facts:

- The `key` is `v2:<sha256>` — a **hash of the agent call's inputs** (prompt + opts/schema).
  Same inputs → same key.
- The `result` record stores the **fully validated structured object**, not raw text.
- On **resume** (`Workflow({scriptPath, resumeFromRunId})`), the runtime replays the script; for
  each `agent()` call it computes the key and, if the journal already has a `result` for it,
  returns that **instantly** without calling the model. The first call whose key is absent (an
  edited prompt, or a genuinely new call) and everything after it runs live.
- "Same script + same args → 100% cache hit." Editing one stage invalidates that stage's key and
  everything downstream, nothing upstream.

This is **content-addressed memoization at the step level**. It is the mechanism that makes a
long, expensive fan-out safe to interrupt and resume.

---

## 3. Schema-enforced structured output

Every subagent that was given a `schema` ends its run by calling a tool named **`StructuredOutput`**
whose `input` is the schema-shaped object. Evidence — the tool-use histogram across all 12 agents:

```
Read:66  Grep:35  Bash:34  StructuredOutput:18  Write:4  Glob:1
```

…and the refuted verifier's final call (`af4a459d4d`) literally is:

```json
{ "isReal": false, "severity": "nit",
  "reasoning": "The CSS facts in the finding are all accurate ... HOWEVER this is a PRE-EXISTING
               roster-wide constraint ... the finding itself concludes 'No change required' ...",
  "recommendedFix": "No change required for this PR ..." }
```

Mechanics:

- The schema passed to `agent()` (a JSON Schema) is turned into a forced `StructuredOutput` tool.
  The model **must** call it to finish.
- Validation happens at the **tool-call layer**: a non-conforming call is rejected and the model
  retries. (The hardest reviewer made **7** `StructuredOutput` calls before its result settled —
  visible in the anatomy table — i.e. it re-emitted until valid/complete.)
- `agent(prompt, {schema})` returns the validated object directly. The caller never parses prose.

Net effect: typed, guaranteed-shape returns flow between stages. The `pipeline` stage 2 could do
`review.findings.map(...)` with zero defensive parsing because stage 1 was schema-guaranteed.

---

## 4. Subagent anatomy & isolation

Each subagent is a **fresh sidechain session** (`isSidechain: true`) recorded in the standard
Claude Code transcript format (`agent-<id>.jsonl` + a tiny `agent-<id>.meta.json` =
`{"agentType":"workflow-subagent"}`).

The transcript opens with the orchestrator-supplied prompt as the **first `user` message**
(our `CONTEXT` + the lens/finding text, verbatim), followed by `attachment` records that inject
environment/repo context. There is no per-message "system" line in the transcript — the
workflow-subagent's base system framing is applied by the runtime (it tells the subagent its
*final output is the return value*, which is why subagents emit raw data, not chat).

Isolation properties that matter:

- Each agent sees **only** the shared CONTEXT + its single task (one lens, or one finding). A
  verifier judging finding X cannot see finding Y or the other lenses. No cross-contamination.
- Each agent has its **own context window**, so the fan-out scales past what one context could hold.
- Agents have **full tool access** — observed: `Read, Grep, Glob, Bash, Write`. They independently
  investigated the real repo: read source, grepped, and (the correctness lens) **ran `node` and
  wrote scratch files** to empirically test behaviour before judging.

---

## 5. Scheduling: pipeline, not barrier

From file mtimes in the run dir:

- The **3 review agents** (`a3b2075e` design, `adf90a8e` contract, `a6f53d8c` correctness) all
  started together at **07:50**.
- The design lens finished ~**07:53**; its per-finding **verifiers ran 07:53–07:55**.
- The correctness lens kept working until ~**08:03** (it was the heavy one); its verifiers ran
  **08:03–08:04**.

So design-lens findings were being verified **while the correctness reviewer was still running**.
That is `pipeline()` semantics: item A can be in stage 2 while item B is still in stage 1. There is
**no barrier** between review and verify. Wall-clock ≈ the slowest *single* find→verify chain
(~13 min, dominated by the correctness reviewer), not (slowest review) + (slowest verify).

Concurrency is capped at `min(16, cores−2)`; excess `agent()` calls queue and drain as slots free.
Hard backstops exist: ≤4096 items per `parallel`/`pipeline` call, ≤1000 agents per workflow.

---

## 6. Adaptive depth (emergent, not configured)

There is no per-agent token/turn budget. Spend self-scaled to difficulty
(`artifacts/agent-anatomy.tsv`):

| agent | role | msgs | tool calls | output tokens |
|---|---|---|---|---|
| `a6f53d8c` | REVIEW: correctness | 153 | 54 (Bash×27, Read×13, **StructuredOutput×7**, Write×4) | **25,652** |
| `adf90a8e` | REVIEW: contract | 60 | 21 | 7,990 |
| `a3b2075e` | REVIEW: design | 45 | 17 | 6,244 |
| `ac6710e4` | VERIFY (isReal=true) | 33 | 12 | 3,839 |
| `af4a459d` | VERIFY (isReal=**false**) | 13 | 4 | 2,392 |
| … 7 more verifiers … | VERIFY | 13–30 | 4–11 | 1,451–4,334 |
| **total** | 12 agents | | | **65,622 out** (~708k incl. input/cache) |

The correctness reviewer spent ~10× a simple verifier because its task (verify data wiring against
types + live shape + a regex edge case) genuinely warranted running code. Nobody told it to; it
escalated its own rigor. Cost is concentrated: one agent was 39% of output tokens.

---

## 7. The quality pattern: find → adversarially verify

The headline reason the run is trustworthy is the **second stage**. Structure:

- **Find** (3 lenses, diverse): correctness, contract-fidelity, design — each blind to the others,
  each returning a structured findings list.
- **Verify** (1 skeptic per finding): re-reads the actual code, defaults to `isReal=false` when
  uncertain, returns a verdict with cited reasoning.

Result: **9 raised → 8 confirmed, 1 refuted**. The refuted one is the instructive case
(`af4a459d`): the verifier **agreed every CSS fact was accurate**, then ruled `isReal=false`
because the issue is pre-existing, roster-wide, and the finding itself said "no change required."

That is the key insight: the verify pass filters on **actionability**, not factual correctness. A
true-but-not-worth-acting-on observation is exactly the kind of noise that, unfiltered, generates
busywork. The skeptic's default-reject posture is what makes the survivors worth acting on.

(One nuance the verifiers also caught: when a finding's fix would touch code the change set didn't
own, or restated a pre-existing constraint, they down-rated or rejected it — keeping the review
scoped to the diff under review.)

---

## 8. Auditability

Everything is on disk, durably:

- the **script** (`workflows/scripts/<name>-<runId>.js`) — re-runnable / editable for resume,
- the **journal** (`journal.jsonl`) — the content-addressed result log,
- the **top-level record** (`workflows/<runId>.json`) — script + timestamp + taskId + runId,
- a full **sidechain transcript per subagent** (`agent-<id>.jsonl`) — every message + tool call.

You can reconstruct exactly what each agent saw, did, and returned. This study is itself proof of
that.

---

## 9. Honest limits of the model

- **Nesting is one level.** `workflow()` inside a child throws. You cannot recurse orchestration.
- **Static routing.** The control flow is fixed JS; it cannot re-plan mid-run based on an LLM's
  judgement the way an LLM overseer can. It trades adaptivity for determinism.
- **Fire-and-forget.** The run is background; there is no mid-run human-in-the-loop gate (no
  pausing to ask the operator a question, then continuing the same agents).
- **Cost opacity at author time.** Adaptive depth is great for quality but means you can't predict
  spend precisely before running (this run: ~708k tokens, mostly from one agent).

These are exactly the seams where **agent-swarm** does something different — see
[lessons-for-agent-swarm.md](lessons-for-agent-swarm.md).
