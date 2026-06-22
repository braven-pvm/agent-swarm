# Triage: `tests/overseer-runner.e2e.test.js` — 3 pre-existing failures

Date: 2026-06-22

## TL;DR

> **RESOLVED 2026-06-22 (fix commit follows this doc):** all three are now fixed; the file is **9/9** and
> regression is green (live-agent-runner 15/15, H2 support-triage 9/9, focused 62/62). See **Resolution**
> at the bottom. The diagnosis below is retained as the record.

`tests/overseer-runner.e2e.test.js`: was **9 tests, 6 pass, 3 fail.** All three were **pre-existing** —
bisect-confirmed below — and predate every source change made in this session (control-plane slice,
triage fix, SO-1, RE-1, RE-2). They are **not** a regression from that work. All three concern the
**overseer prompt / planner state packet**. None are environmental (they reproduce deterministically).

## Bisect proof (not from this session)

Reverted `src/` to **`f394fcd`** (the last commit before *any* of this session's source work),
`npx tsc`, re-ran: **the same 3 tests fail identically (6 pass / 3 fail).** They were also
independently bisect-confirmed pre-existing by the SO-1 workflow via a detached worktree + fresh
`npm install`. So they regressed at some commit *before* `f394fcd` and were never caught (the
overseer-runner file is run individually and isn't in the routine green set).

## The three failures

### F1 — `codex overseer execute mode dispatches worker and reviewer child agents` (line 294)
- **Asserts:** the *latest* overseer prompt matches
  `/"nextCommand": "node .* run <slice> --actor backend-worker --driver codex"/`.
- **Reality:** the worker+reviewer DO dispatch (the test's later asserts pass: slice reaches
  `ready_for_review` with `worker_result` + `review_result` evidence). But `readLatestOverseerPrompt`
  returns the **last** prompt (turn 3 of `--execute-limit 3`), which reflects the **post-dispatch**
  state — so a `run … --actor backend-worker` nextCommand is no longer the active suggestion there.
- **Classification:** likely a **stale test** (it reads the newest prompt but expects turn-1 content)
  OR an actor-derivation change. Needs confirmation of how `activeSliceQueue[].nextCommand` derives the
  worker actor (`backend-worker`) and which turn's prompt the assertion intends.
- **Risk to "fix" blindly:** low-value; touches test intent, not product behavior.

### F2 — `overseer prompt queues backend prerequisite before blocked dashboard source` (line 422)  ← most likely a real bug
- **Asserts:** `actionableState.nextSourcePullQueue[0].targetName === "invoice-api"` (backend first).
- **Reality:** got `"invoice-dashboard"` (frontend) first.
- **Classification:** **real regression, and mission-relevant.** The core philosophy + the overseer
  code both intend backend-before-frontend ("Backend capabilities must be accepted before real
  frontend/dashboard slices"; see `src/cli.ts` ~6736–6767 `currentPriority` / the backend-first
  `slices pull --target invoice-api` recommendation). But `sourcePullQueues.ready` (consumed at
  `src/cli.ts:6125`) is not ordering **backend-role** sources ahead of **frontend-role** ones.
- **Recommended fix:** order `sourcePullQueues.ready` by target role (backend before frontend) before
  slicing into `nextSourcePullQueue`. This is the clearest, most defensible fix and aligns with a
  non-negotiable. Verify it doesn't reorder the live-loop's first pull in an unintended way.

### F3 — `overseer launches from a short prompt after dashboard worker evidence` (line 626)
- **Asserts:** `prompt.length < 22000` (the "compact launch prompt" budget from Phase 8C-9/8C-10,
  which moved overseer Codex launches to a short artifact-backed prompt to avoid Windows
  `spawn ENAMETOOLONG`).
- **Reality:** the dashboard-scenario prompt is **24448** chars (the simpler backend-only prompt is
  ~20909, *under* budget — so this is dashboard-scenario-specific, driven by more slices/sources).
- **Classification:** **prompt-budget regression.** The overseer prompt inlines the full
  harness-managed **skill packet** (4 required skills, each with description + content hash + absolute
  path) plus the allowed-command contract + the actionableState packet. The skills feature (Phase 10D)
  landed *after* the compact-prompt budget was set, growing the prompt past the 22000 cap on the
  larger (dashboard) scenario.
- **Recommended fix:** trim the skill packet in the overseer prompt (reference the binding/packet by
  artifact path instead of inlining the full descriptions, the way worker prompts can), or compact the
  actionableState further for launch; only re-baseline the 22000 cap if the larger prompt is genuinely
  acceptable for the spawn path on Windows.

## Recommendation / priority

1. **F2 (real bug, mission-aligned)** — order the ready source-pull queue backend-first. Highest value.
2. **F3 (prompt-budget regression)** — trim the inlined skill packet from the launch prompt (keep it
   artifact-referenced), restoring the compact-prompt guarantee on multi-target scenarios.
3. **F1 (likely stale test)** — confirm intended actor derivation + which turn's prompt the assertion
   should read; fix the test or the derivation accordingly.

These touch core overseer/planner behavior and the live-loop's spawn path, so each was implemented as a
focused, separately-verified change.

## Resolution (2026-06-22)

All three fixed in `src/cli.ts`; afterward **overseer-runner 9/9**, plus regression green
(**live-agent-runner 15/15**, **H2 support-triage 9/9**, **focused 62/62**).

- **F2** — `buildOverseerSourcePullQueues` now sorts **prerequisite-unblocker / upstream sources first**
  (a source producing a ref some other source is still blocked on leads; then dependency-free before
  dependent), so a backend capability source precedes the dashboard/product source. Backend-before-frontend.
- **F3** — the overseer launch prompt is back under the 22,000-char compact budget via three trims, none
  of which any test reads: drop the per-slice `agentRuns` array (keep `agentRunCount`); drop the scenario
  manifest's absolute paths (keep names/roles/ids/titles/domains); replace the inlined skill packet with a
  compact behavior-only `compactOverseerSkillReference` (role + skill id/title/description + the isolation
  rule). The compact skill reference also removes a contradiction — the full packet told the overseer to
  "read every required skill file" while its own decision discipline forbids reading files.
- **F1** — `isFrontendTargetOrSlice` was a **real bug** (not a stale test): it keyword-matched
  `dashboard`/`ui` in the **backend** spec's prose ("drive a dashboard lane", "summary values for
  dashboard cards", "before any UI lane is ready"), misclassifying backend slices as frontend and giving
  them a `dashboard-worker`/`dashboard-reviewer` actor. It now classifies by **structured identity**
  (target name, slice title, FR/AC refs, source domains) — never prose nor the absolute target path.
