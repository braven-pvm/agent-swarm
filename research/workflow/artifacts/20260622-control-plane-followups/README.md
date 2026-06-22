# Dogfood record — control-plane follow-up slices (SO-1, RE-1, RE-2)

Each of these slices was implemented by running the Claude **Workflow** tool against agent-swarm's
own codebase (Baseline → Design → Implement → Test → Verify → adversarial Skeptic), then **independently
re-built and re-tested by the main agent** before commit. Artifacts here = the orchestration script,
the content-addressed journal, the full structured output, and per-agent token/tool anatomy.

This is the companion to the earlier [20260621-control-plane-handoff/](../20260621-control-plane-handoff/)
(Slice A/B) dogfood record.

## The runs

| Slice | Commit | Agents | Output tok | Wall-clock | Outcome |
|---|---|---|---|---|---|
| [so1](so1/) — Zod→JSON Schema generator + parity test | `a026626` | 8 | ~82k | ~38 min | 52/52; 3 skeptics confirm generated schema **equivalent-or-stricter** |
| [re1](re1/) — independent skeptic role + `finding_challenge` | `9fe971c` | 9 | ~76k | ~35 min | 56/56; accept gate byte-unchanged; 4 skeptics confirm independence/persistence/additive/model-agnostic |
| [re2](re2/) — gate consumes skeptic per-finding severity | `0e45a49` | 9 | ~119k | ~50 min | 16/16 + 15/15; **adversarial skeptic caught a real independence gap** (see below) |

(Output-token counts are the agents' own output only; total incl. input/cache is far larger.)

## The headline lesson (RE-2)

RE-2 changed acceptance semantics, so the workflow ran **four adversarial skeptics**, each trying to
*break* one safety invariant. Three held out of the box (hard backstops unconditional, no-skeptic path
byte-identical, default-keep-blocking). The fourth **found a real hole**: the gate verified "some
independent skeptic ran" separately from "who authored the *consumed* challenge" — a decoupling a
malicious challenge could ride. The main agent then **closed it** (persist `skepticActor` on the
`finding_challenge` evidence; bind independence to the consumed challenge's author) and added a
dedicated decoupling regression test. That find-then-fix is exactly the case for RE-1/RE-2 in our own
product — an independent adversary catches what the builder misses.

## Method note

Every slice was verified twice: by the workflow's own Verify/Skeptic phases **and** by the main agent
re-running `npm run build` + the targeted tests and reading the diff. The workflow's self-report was
never taken on faith — which is how the RE-2 gap (flagged by a skeptic, then independently confirmed)
and the pre-existing `overseer-runner` failures (see ../overseer-runner-triage.md) were both surfaced
honestly rather than papered over.
