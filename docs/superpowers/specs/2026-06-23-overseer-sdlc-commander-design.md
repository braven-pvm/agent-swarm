# Overseer as SDLC Commander — System Design

Date: 2026-06-23
Status: System-level design (north star). Decomposes into four sub-projects, each of
which gets its own detailed spec → plan → implementation cycle.

## 1. Goal

Turn the overseer from a serial single-agent coordinator into a **deep SDLC commander**:
an intelligence that runs the whole development loop — deciding *what* to build next to
unblock the most work, *what* to scrutinise harder, *what's* going wrong, and *how* to
parallelise a fleet of isolated agents — optimising for **the best-quality product, shipped
fastest, under all real constraints** (concurrency budget, provider spend/rate limits,
dependency order, risk tolerance, and human directives).

It has two interfaces: it **commands** concurrent isolated execution (the hands), and it
**takes direction** from a human (the command channel). The decision model is the spine;
the other two are implementations of its contracts.

### Why now / what exists already

- The overseer already runs a thin serial version of this loop (propose → allowlist-execute),
  with an evidence ledger, a dependency graph, the Sleuth review gate, and session recovery.
- `executeOverseerRecommendedCommands` (src/cli.ts:8157) executes recommended commands in a
  **serial `spawnSync` loop** — the core serialization point.
- SC-1 (commit b61a816) already proved the concurrency model (independence predicate, bounded
  non-blocking pool, ledger-driven rollup) — but only in the demo runner, bypassing the overseer.
- SC-2 (commit 1ccae15) added the `maxActiveLanes` budget.
- `lanes.worktree` exists in the schema (storage.ts:73, types.ts:80) but is set to the shared
  `target.path` (planner.ts:358) — an unused isolation seam.
- The store is `better-sqlite3` + WAL but has **no `busy_timeout`** (storage.ts:29).

This design completes those arcs (OCF-1/OCF-2/SC-1/SC-2) rather than starting fresh.

## 2. Operating model — the OODA loop

The commander runs a continuous cycle:

> **Sense** (gather intel) → **Orient** (assess the board) → **Decide** (emit a Command Plan)
> → **Act** (dispatch concurrent isolated work) → **Integrate** (merge accepted work) → Sense.

Today's overseer does a thin serial version of this. Each step is deepened below.

## 3. Architecture overview

Three subsystems + a repo/integration layer:

- **S2 · Brain** — the scored decision model that emits a **Command Plan** each cycle.
- **S1 · Hands** — concurrent, worktree-isolated execution of the plan's dispatch batch,
  integrating accepted work back through git.
- **S3 · Command channel** — human directives folded into the brain's scoring.
- **Repo/integration layer** — the 3-tier git model that keeps concurrent work isolated and
  `main` clean.

Status always rolls up from each slice's own **evidence ledger** — never from scheduling or
integration order (the SC-1 invariant).

## 4. S2 — Commander intelligence (the brain)

### 4.1 Scored objective

Every candidate action is scored, so the overseer can explain *why* it chose one over another:

- **unblock-impact** — how many downstream slices this frees (derived from the dependency graph).
- **value** — requirement priority / business weight.
- **risk** — blast radius + historical failure signal for the change.
- **cost** — agent spend + time.

The objective: *maximise verified, quality requirements delivered per unit time and cost,
under constraints*. Constraints (hard): concurrency budget, provider rate/spend caps,
dependency order, and active **hard** directives.

### 4.2 The Command Plan (the key new artifact)

Each cycle the overseer emits a structured plan — a real deepening of today's
`OverseerDecision.recommendedCommands`:

1. **Concurrent dispatch batch** — which slices to run *now*, in which lanes, chosen to be
   dependency-satisfied **and** semantically/file-disjoint, bounded by budget.
2. **Scrutiny allocation** — which work earns extra verification (independent skeptic / deeper
   review / more tests) because it is high-risk or high-blast-radius; routine work earns less.
3. **Flagged problems + interventions** — detected bottlenecks, repeated failures, stalls →
   a proposed action (re-prioritise, spawn an analyst, escalate to the human).
4. **Promote actions** — when a milestone (AC/spec) is fully verified, a `promote` action
   (see §6.3).
5. **Deferrals** — what it is *not* doing this cycle and why (auditable judgment).

Every plan element carries its score breakdown + any directive that influenced it.

### 4.3 Intel (hybrid)

- **Ledger-derived state** (exists): evidence ledger, dependency graph, coverage, escalations,
  agent-run history.
- **Derived metrics** (new): critical path, per-slice unblock-impact, risk score,
  velocity/throughput, failure-pattern detection.
- **On-demand analyst sub-agents** (new): a focused analyst role the overseer spawns *only* for
  genuinely hard questions ("is this actually the bottleneck?", "how risky is this change?",
  "are these two slices semantically independent?"). Cost scales with need.

## 5. S1 — Concurrent isolated execution (the hands)

1. **Worktree-per-lane** — each active lane gets a real `git worktree add
   .swarm/worktrees/<lane> <lane-branch>`; the slice's agent runs with `cwd` = its worktree.
   The `lanes.worktree` column finally holds a real path. This is what lets N agents edit code
   without clobbering each other.
2. **Concurrent dispatch in the core** — `executeOverseerRecommendedCommands` stops being a
   serial `spawnSync` loop; the plan's batch runs through SC-1's non-blocking `runSwarmAsync` +
   `dispatchPool`, **promoted from the demo runner into `src/orchestrator.ts`** (the OCF-2 home),
   bounded by budget. Each command still passes `validateOverseerCommand` + the child-dispatch
   contract.
3. **Integrate-on-accept** — a slice's work lives on its lane branch; when it passes review +
   deterministic verification (the existing gate) it integrates into `swarm/integration`.
4. **Re-verify-after-merge** — a slice verified *in isolation* must stay green *after
   integration* (a disjoint merge can still interact semantically). Integration triggers a
   re-verification; a regression re-opens the slice.
5. **Store hardening** — add `busy_timeout` + a write-retry so N concurrent worker *processes*
   don't hit `SQLITE_BUSY`.

## 6. Repo & integration model

### 6.1 Whose repo

Worktrees are of the **target product repo** (the thing being built), under
`.swarm/worktrees/`, **gitignored**. agent-swarm's own repo is separate.

### 6.2 Branch topology (3 tiers)

- **`main`** — the human's trunk. The swarm never commits here directly and never rewrites
  history.
- **`swarm/integration`** — the swarm's working trunk, branched off `main`; accepted slices land
  here.
- **`swarm/lane/<id>`** — one branch + worktree per active lane, branched off `swarm/integration`.

### 6.3 Concurrency rule + promotion

- **Agent work is concurrent; integration is serialized.** Each worktree has its own git index,
  so parallel lane commits never collide. All merges into `swarm/integration` go through a single
  integrator, one at a time (the shared `.git` refs are the contention point). Disjoint-first
  means these are usually clean fast-forwards; on a real conflict the integrator rebases or
  escalates.
- **Milestone promotion is an overseer judgment.** When a coherent milestone is fully verified
  (an AC's slices all accepted + verified, a spec/epic complete), the overseer emits a `promote`
  action → opens a **PR** `swarm/integration → main`, gated on milestone-green. Knobs:
  checkpoint granularity (per-AC / per-spec / per-milestone) and PR-vs-auto-merge-on-green.
  Opening a PR / promoting is an outward-facing privileged action — behind the autonomy boundary,
  visible + gateable by a hard directive.
- **Git history as audit trail** — one integration commit per accepted slice, tagged with the
  slice id + FR/AC refs, so `git log` mirrors the ledger.

## 7. S3 — Command channel (human steering)

- **Directives are first-class objects**, not chat ephemera. NL input is parsed into a
  structured `Directive`: `{ intent, scope (global/domain/slice/lane), strength (soft|hard),
  lifetime (standing | until-resolved | N-cycles | timeboxed), status }`, then fed into the
  brain's scoring — steering and autonomy share the same decision machinery.
- **Soft directives = weight shifts** ("lean toward payments") — the overseer still exercises
  judgment; the Command Plan shows the influence ("payments boosted by D-12").
- **Hard directives = deterministic constraints** (a small set, enforced in code like OCF-1's
  guardrails): **focus-fire** (whole budget to one scope), **freeze** (exclude a scope),
  **pin** (force to front), **hold / promote-now** (promotion levers).
- **Lifetime** makes "temporarily redirect" real; the overseer always surfaces active directives
  + remaining lifetime.
- **Conversational** — the overseer echoes its interpretation back (and confirms high-impact hard
  modes) and reports how it responded + what it deferred. Directives become another observable
  surface in the Command Bridge (reusing the local-control API + the observability work already
  shipped).

## 8. Interface contracts (sketch — detailed in sub-specs)

- **Command Plan** — the brain's per-cycle output (§4.2). S1 consumes its dispatch batch +
  promote actions; S3 directives are inputs to the scoring that produces it.
- **Directive** — the S3 → S2 input object (§7).
- **Lane/worktree lifecycle** — created on lane activation, removed on lane close
  (`git worktree remove` + branch cleanup); `lanes.worktree` is the durable handle.

## 9. Decomposition & build order

Four sub-projects, each its own spec → plan → build. Build order is **hands → brain → steering**
(design was brain-first, which set these contracts).

1. **S1a · Concurrent isolated execution** *(foundation; riskiest engineering → first)* —
   worktree-per-lane + lifecycle, store hardening, core concurrent dispatch (SC-1 pool →
   `src/orchestrator.ts`), integrate-on-accept + re-verify-after-merge + conflict fallback.
   Driven initially by a simple "dispatch all disjoint dependency-satisfied slices up to budget"
   policy. Delivers *N agents running isolated*.
2. **S1b · Milestone promotion** — milestone detection + PR-promote `swarm/integration → main`,
   gated on milestone-green; granularity + PR-vs-auto knobs.
3. **S2 · Commander intelligence** — scored objective + Command Plan artifact + derived metrics +
   on-demand analysts. Replaces the simple policy with real prioritisation, scrutiny allocation,
   and problem detection.
4. **S3 · Command channel** — directives (NL → structured, soft/hard, lifetime) folded into the
   decision model + conversational feedback + the Command Bridge surface.

## 10. Locked decisions

- **Intel = hybrid** — ledger + derived metrics + on-demand analyst sub-agents.
- **Isolation = disjoint-first, conflict fallback** — the overseer parallelises non-overlapping
  scopes; overlap is handled via serialized integration + rebase, escalating on real conflict.
  "Choose parallelism to stay conflict-free" is part of the overseer's intelligence.
- **Steering = NL directives, soft-weighted + a small set of hard modes**, temporary or standing.
- **Promotion = overseer-judged, at milestone checkpoints, via PR to `main`** (staging branch
  `swarm/integration`), with granularity + PR-vs-auto as project knobs.
- **Ledger-driven truth** — status never depends on scheduling/integration order.

## 11. Key risks & open questions

- **Re-verify-after-merge cost** — re-verifying every integration could be expensive; may need to
  scope re-verification to semantically-related slices (an analyst question).
- **Semantic vs file disjointness** — file-disjoint ≠ semantically independent (API contract
  changes). The overseer must reason about semantic independence; needs a cheap heuristic +
  analyst fallback.
- **Worktree/branch sprawl + cleanup** — orphaned worktrees/branches accumulate without strict
  lifecycle discipline (we hit an analogous orphaned-process leak this session).
- **Resource/cost bounding** — N concurrent real agents = N× spend + provider rate limits; the
  budget must be cost/rate-aware, not just a lane count.
- **NL directive misinterpretation** — a misread directive could mis-steer the swarm; mitigated by
  echo-back confirmation, especially for hard modes.
- **Integration serialization throughput** — a single integrator could bottleneck at high
  concurrency; acceptable initially, revisit if it bites.

## 12. Out of scope (YAGNI for now)

- Multi-repo slices (assume one target repo per run).
- A full standing analyst layer (hybrid/on-demand only).
- Distributed execution across machines (single host, bounded concurrency).
- A bespoke merge engine for heavy overlap (disjoint-first + rebase/escalate covers the common
  case).

## 13. Next step

Brainstorm the **S1a · Concurrent isolated execution** detailed spec, then its implementation
plan. The remaining sub-projects follow in build order, each reusing the contracts above.
