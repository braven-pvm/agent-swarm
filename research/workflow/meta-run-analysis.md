# Meta-run analysis: the workflows that produced this study

You asked me to capture and analyze the Workflow runs I used for the analysis itself. Two ran:

| Run | Purpose | Agents | Output tok | ~Total tok | Wall-clock | Raised → confirmed | Drop rate |
|---|---|---|---|---|---|---|---|
| `wf_e5f50995-09f` ("skill-isolation-ui-review") | adversarial code review before a commit | 12 | 65,622 | ~708k | ~13 min | 9 → 8 | **11%** |
| `wf_b3842799-1d2` ("agent-swarm-vs-workflow-forensics") | this source-grounded analysis | 30 | 170,369 | ~1.6M | ~10.7 min | 24 → 12 | **50%** |

Artifacts: [artifacts/](artifacts/) (run 1) and [artifacts/forensic-run/](artifacts/forensic-run/)
(run 2 — script, journal, anatomy, full 147 KB output).

---

## 1. The meta-run re-confirmed Workflow's mechanisms — from its *own* trace

Studying run 2's artifacts independently corroborated the mechanisms in
[forensic-analysis.md](forensic-analysis.md):

- **Schema self-healing (mechanism 3) is visibly common.** In run 2's anatomy, the context-packets
  forensic agent (`ab11cbdcb7`) emitted **5 `StructuredOutput` calls** and the orchestration agent
  (`a1a9f21dbc`) **2** — i.e. they re-emitted until the object validated. Across both runs, *every*
  agent terminated in exactly one accepted `StructuredOutput`. The schema is the contract, enforced
  at the tool layer.
- **Verifiers genuinely re-investigate (mechanism 7 is real, not theatre).** Every VERIFY agent did
  its own `Read`+`Grep`; several ran `Bash` (`a8897b900c`: **Bash×12**; `a784b0ba36`: Bash×5) to test
  claims against source rather than trusting the finding. The skeptic re-read `worker-driver.ts`,
  `cli.ts`, `checkpoints.ts` etc. before each verdict (visible in the dropped-item `why` fields).
- **Pipeline, no barrier (mechanism 4).** The 6 forensic lenses started together; each lens's
  verifiers fired as that lens finished, while heavier lenses (the `cli.ts:6681`-line readers) were
  still grinding. Wall-clock (~10.7 min) was the slowest single lens→verify chain, not the sum.
- **Adaptive depth (mechanism 6).** Forensic agents spanned 3.5k–25.7k output tokens; the heaviest
  (`ab11cbdcb7`, context-packets, 25.7k / 70 msgs) read the most source. No fixed budget.
- **Content-addressed journal (mechanism 2).** Run 2's `journal.jsonl` is 30 `started` + 30 `result`,
  each keyed `v2:sha256(...)` with the validated object stored — the same resume primitive, now
  captured as our own reference artifact.

## 2. The skeptic stage earned its keep — louder than in run 1

Run 1 dropped 1 of 9 (a true-but-pre-existing finding). Run 2 dropped **12 of 24 (50%)** — because a
*source analysis* invites speculation, and the skeptic is exactly the antidote:

- **It caught my own over-claims.** Most of the original `lessons-` draft (written from session
  memory) was rejected as already-implemented or mis-framed — see the table in
  [lessons-for-agent-swarm.md](lessons-for-agent-swarm.md#what-i-over-claimed-dropped-by-the-skeptic--recorded-for-honesty).
  Without the skeptic + forced source re-reads, those would have shipped as "recommendations."
- **It resolved a cross-lens collision.** A *content-addressed result journal* was proposed by three
  different lenses (resume, orchestration, context-packets). The skeptic **dropped two framings**
  (judging them already covered by the evidence ledger + skill/source hashing) and **kept one** narrow
  framing (wrap the leaf spawn, key on the full input envelope). Independent per-finding verification
  caught duplication and framing error that a single reviewer would have rubber-stamped. That nuance
  is now OCF-3, explicitly marked "contested."
- **Default-reject discipline held.** Verdicts split keep / revise / drop; "revise" recommendations
  were sharpened with exact call-sites (e.g. SO-2 narrowed to *schema/parse failures only*, not
  `is_error`), and several "accurate but already-done" items were dropped outright.

This is the single biggest takeaway for agent-swarm: **diversity (6 lenses) + independent skeptic
(default-reject, re-read source) converts speculation into a small set of defensible, cited changes.**
It is the live argument for recommendations **RE-1/RE-2** (an independent skeptic in our own loop).

## 3. Limitations observed (so we copy the pattern honestly)

- **Subagents lacked my privileged context.** The forensic agents could not see the full `Workflow`
  tool specification — only the condensed `WORKFLOW_MECHANISMS` block I wrote into the prompt. So
  their "comparison to Workflow" was only as good as my summary. Mitigation used here: I did
  **independent main-agent source reads** of the highest-stakes files and wrote the comparisons
  myself, rather than relaying agent output verbatim. *Lesson:* when delegating, the orchestrator must
  supply the privileged context explicitly, and spot-check rather than trust.
- **Cost concentration + opacity.** Run 2 was ~1.6M tokens; you can't predict that precisely before
  running (adaptive depth). For agent-swarm this argues for the hard budget ceilings Workflow uses
  (concurrency cap, agent-count backstop) — and for our SC-2 lane budget.
- **One level of nesting.** These runs could not recursively spawn sub-workflows; the fan-out shape
  had to be decided up front. agent-swarm's recursive overseer is more flexible here.
- **Structured output scales but bloats.** Run 2's result was 147 KB of validated JSON — parseable
  precisely *because* of the schema, but large enough that synthesis still needed a human-in-the-loop
  (me) to prioritize. Schemas make machine hand-off reliable, not free.

## 4. This study is itself a worked example of the recommendations

The two runs demonstrate, on our own problem, the changes proposed for agent-swarm:

- **OCF-1 (overseer emits plan, code executes):** the JS script *was* the deterministic plan; the LLM
  only filled leaves. No LLM turn was spent deciding "what to do next."
- **RE-1/RE-2 (independent skeptic, per-finding):** the verify stage is precisely that gate, and it
  changed the output materially (24→12).
- **SO-1/SO-3 (one schema contract):** every leaf returned a typed object against one schema; zero
  prose parsing in the orchestration code.

If agent-swarm adopts these, a "scripted-plan mode" run would look structurally like
`wf_b3842799-1d2`: a deterministic plan over schema-validated, independently-verified, journaled
agent leaves — over our existing driver + observability substrate, with the adaptive overseer reserved
for the genuinely open decisions.

---

*Both runs' scripts, journals, per-agent anatomies, and full outputs are preserved under
[artifacts/](artifacts/) so these numbers and claims are reproducible.*
