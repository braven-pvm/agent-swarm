# Codex CLI and SDK Research for a Development Swarm

Date: 2026-05-25

## Goal

Design an agent harness for development at scale: precise requirements in, verified product slices out. The harness should support sub-agents, lifecycle visibility, acceptance criteria tracking, backend/frontend verification, and repeatable cadence across many slices.

## Non-Negotiable Product Constraint

This harness exists for agentic implementation against pre-defined, approved specifications. It is not a specification authoring, adaptation, morphing, or generation system.

Specs, functional requirements, non-functional requirements, acceptance criteria, and slice contracts consumed by implementation agents must be immutable inside the harness. The harness may serve them, cite them, trace against them, and detect ambiguity or conflict in implementation, but no implementation agent may modify them in any way.

If a specification must change, that change belongs outside this implementation harness, or in a separate explicit `spec-update`/`spec-creation` module with different permissions and governance.

This does not prevent agentic implementation strategy. Orchestration agents may instruct worker agents on how to implement an FR/AC, decompose work, choose technical approaches, infer necessary implementation details, and create tests that operationalize the criteria. Those implementation interpretations are allowed as working hypotheses, but they do not become changes to the source spec. They must be explicitly traceable back to the immutable FR/AC and verified against it.

The harness should not impose an artificial ceiling on agent autonomy. If a project protocol allows agents to create PRs, merge, change dependencies, modify infrastructure, run migrations, or perform other normal development actions, the harness should support those actions. Its responsibility is full visibility, tracking, attribution, verification, and governance according to the active protocol, not hiding work behind opaque sub-agent execution.

## Current OpenAI/Codex Primitives

### Codex CLI

Codex CLI is a maintained Rust CLI with a standalone executable install path. The official repo documents installation through `npm i -g @openai/codex`, Homebrew, or releases. It also documents `config.toml`, MCP client support, an experimental `codex mcp-server`, notifications, `codex exec`, and sandbox modes.

Source: https://github.com/openai/codex/blob/main/codex-rs/README.md

Most relevant CLI primitive for this repo:

```powershell
codex exec --json --output-schema schema.json --output-last-message result.json -C <workspace> "<task>"
```

Useful properties:

- `codex exec` runs non-interactively for automation and CI.
- `--json` emits JSONL events suitable for progress ingestion.
- `--output-schema` constrains the final response shape.
- `--output-last-message` writes the final result to a file.
- `--cwd`/`-C` targets a workspace.
- `--ephemeral` avoids persisted session data for one-off jobs.
- `--sandbox workspace-write` or `--full-auto` gives controlled automation.
- `--add-dir` can expose additional writable directories.

Sources:

- https://www.mintlify.com/openai/codex/cli/exec
- https://www.mintlify.com/openai/codex/advanced/exec-mode

### Codex as an MCP server

The Codex repo documents `codex mcp-server` as an experimental mode that lets other MCP clients use Codex as a tool for another agent. This is important because it gives us two possible orchestration modes:

- Harness spawns Codex CLI worker processes directly.
- Harness exposes Codex workers as MCP tools to a higher-level orchestrator.

Source: https://github.com/openai/codex/blob/main/codex-rs/README.md

### Agents SDK

OpenAI positions the Agents SDK for applications that own orchestration, tool execution, approvals, and state. The docs explicitly call out agents that plan, call tools, collaborate across specialists, and keep enough state to finish multi-step work.

This is the better fit for the coordinator/control plane, while Codex CLI is the better fit for isolated implementation/verifier workers.

Source: https://developers.openai.com/api/docs/guides/agents

Relevant SDK surfaces to research deeper during implementation:

- agent definitions
- running agents and resumable state
- orchestration and handoffs
- guardrails and human review
- tools and MCP
- integrations and observability
- agent workflow evals

### Evaluation and trace grading

OpenAI trace grading scores a full agent trace: model calls, tool calls, decisions, guardrails, and handoffs. Agent evals combine traces, graders, datasets, and eval runs to identify regressions and failure modes.

This maps directly to our "full verification at scale" requirement: every slice should produce a trace, every verifier should produce structured evidence, and every release candidate should be scored against acceptance criteria.

Sources:

- https://developers.openai.com/api/docs/guides/trace-grading
- https://developers.openai.com/api/docs/guides/agent-evals

### Coding models

As of this research pass, the OpenAI model list marks `gpt-5.3-codex` as the most capable agentic coding model to date. The model page says it is optimized for agentic coding tasks in Codex or similar environments, supports `low`, `medium`, `high`, and `xhigh` reasoning effort, has a 400k context window, supports streaming, function calling, and structured outputs.

Source: https://developers.openai.com/api/docs/models/gpt-5.3-codex

## Recommended System Shape

Use a hybrid architecture:

1. Control plane: Agents SDK app owns planning, routing, guardrails, state, trace collection, approvals, and lifecycle.
2. Worker plane: Codex CLI workers execute implementation, review, frontend verification, backend verification, documentation, and migration tasks in isolated worktrees.
3. Evidence plane: structured artifacts store requirements, slice plans, worker events, test output, screenshots, coverage, review findings, and acceptance decisions.
4. Progress plane: a dashboard or CLI shows task state, blocker state, current worker output, AC coverage, and verification score.
5. Spec repository: immutable source of approved specs and the central state endpoint for slice assignment, progress, evidence, and lifecycle updates.

The dashboard is a core requirement, not a nice-to-have. Users should see explicit agent identities, active tasks, messages, tool calls, file changes, test runs, PR actions, blocked states, verification status, and lifecycle decisions.

## Spec Repository Operating Model

The harness should treat the spec repository as the source of immutable requirements and as the central coordination surface for delivery progress.

Agents should be able to:

- pull the next available slice from the spec repository or request a generated slice from immutable specs
- fetch exact FR/AC/NFR context for that slice
- fetch related specs, blockers, dependencies, and already-implemented status
- spin up implementation and verification workers
- stream operational status and event telemetry back to the harness
- submit progress, evidence, verification results, lifecycle state, and blockers back to the spec repository
- continue to the next slice once gates are satisfied

This prevents slice state and delivery tracking from living in scattered repo docs. Product truth and delivery state stay centralized in the harness/spec repository, while implementation happens in target code repositories.

The spec repository should support source adapters rather than force one canonical authoring format. Current real-world sources may include Linear issues/projects, local repository specs, Notion pages, file-based checklists, and hard links between them. A spec reader/slice-serving agent can resolve those sources, read the approved material, and produce a slice contract with source citations and spec version references.

This avoids the prior failure mode where useful specifications had to be manually translated into a rigid database shape before agents could work. The harness database should store what the harness owns: slice contracts, state, telemetry, evidence, decisions, and provenance.

The harness must be spec-store agnostic. Source adapters read Linear, files, Notion, GitHub issues, or other stores according to the user's workflow. Status sinks separately write concise progress back where appropriate. Slice tracking should remain harness-structured because operational visibility, scope, concurrency, lifecycle, and verification need one consistent control model.

Adapters do not need to produce rigid deterministic slice proposals. The spec server/orchestrator can shape slices dynamically from full source context. The key invariant is that each served slice declares the FR/AC scope needed for verification and that the harness tracks implementation status at slice and FR/AC level.

Do not model partial FR/AC implementation in MVP. Each FR/AC should have one authoritative status. Multi-FR/AC slices are allowed; splitting one FR/AC across multiple active slices is not.

Preventing concurrent duplicate FR/AC work is a core spec server responsibility. The spec server should lease FR/AC scope to active slices and refuse conflicting slice assignments.

Leases require recovery semantics. Agent/slice heartbeats should detect stalled work, automatically attempt revive/resume, and release FR/AC scope back to the pool if recovery fails.

Revive behavior should support configurable retry count, final-attempt UI highlighting, and manual revive/release controls.

Use precise recovery semantics: revive resumes the same Codex session/run when possible; restart task starts a fresh agent and should be treated as a new run.

Within a multi-FR/AC slice, individual FR/AC states may advance independently. A slice cannot close with blocked/deferred FR/ACs still inside its scope; it must be split or rescoped first.

Slice splitting/rescoping is an autonomous orchestrator action. It is permitted because it changes execution planning, not source specs, and must be tracked in the harness event log.

On rescope, complete the existing slice for completed scope and create a new related slice for remaining scope. Avoid special partial-complete statuses in MVP.

Each slice should have a canonical harness-owned report URL. Status sinks can write concise native status plus this link back to Linear, files, Notion, or other stores. Detailed evidence, telemetry, artifacts, and event history remain in the harness.

The first visibility surface can be a terminal/TUI dashboard to prove the loop quickly. The web dashboard/report viewer should follow once canonical report links, team visibility, screenshots, filtering, and historical browsing become important.

## Core Domain Objects

- `Requirement`: source FR/NFR with IDs, rationale, owner, and status.
- `AcceptanceCriterion`: testable condition linked to one or more requirements.
- `Slice`: small implementable vertical increment with explicit scope and dependencies.
- `Task`: worker-sized unit assigned to one agent role.
- `WorkerRun`: one Codex/SDK execution with input prompt, model, sandbox, git ref, events, outputs, cost, duration, and result.
- `Evidence`: test output, screenshot, trace, review, coverage, build log, or manual decision.
- `Gate`: required verification condition before a slice can advance.
- `Decision`: human or automated lifecycle decision with timestamp and evidence links.
- `Implementation Interpretation`: an agent-produced technical reading of how an immutable FR/AC should be implemented, tested, or decomposed. It is traceable evidence, not a spec change.

Immutable spec records should be content-addressed or version-pinned. Implementation runs should reference exact spec versions, not mutable live text.

## Agent Roles

- `Spec Reader`: reads immutable FR/NFR/AC records and produces implementation context without altering source specifications.
- `Planning Agent`: coordinates development flow across lanes, creates backend-enabler/frontend/sub-slices, and prioritizes work so frontend lanes receive meaningful slices based on verified backend capabilities.
- `Slice Planner`: creates thin vertical increments with dependency graph and expected evidence.
- `Architect`: checks contracts, boundaries, data model, migration risk, and non-functional constraints.
- `Backend Implementer`: changes server/domain/data code and tests.
- `Frontend Implementer`: changes UI, state, routing, accessibility, and visual behavior.
- `Verifier`: runs backend, frontend, integration, visual, security, and AC-specific checks.
- `Reviewer`: performs code-review stance against diff, requirements, tests, and risk.
- `Release Shepherd`: decides whether a slice can merge, split, retry, or escalate.

## Slice Planning

The harness should support both pre-defined slices and agent-generated slices. The preferred operating mode is dynamic slice generation: orchestration agents create slices on the fly or in small batches from immutable specs, then validate each slice against progress and verification criteria.

This avoids large upfront slice administration, lets plans respond to implementation discoveries, and prevents mass rework when sequencing changes. Slice generation is agentic planning, not spec mutation.

Slices may cover multiple FR/ACs when that reduces agent spin-up/down overhead. The requirement is not one FR/AC per slice; the requirement is clean verification and evidence mapping for every FR/AC included in the slice.

Multiple implementation agents may work on the same slice in parallel. This is allowed as an orchestration choice, not required as a default. The harness should track which agent produced which changes, expose coordination messages, and surface conflict risk early.

## Lifecycle

1. Import or mount approved immutable requirements.
2. Validate that FR/NFR/AC records are addressable and version-pinned.
3. Generate or load a small batch of slices.
4. Validate each slice is traceable to immutable FR/AC.
5. Assign or create a managed feature/component/lane worktree, away from the main checkout.
6. Generate worker prompts from the slice contract.
7. Run implementation workers.
8. Run verification workers independently.
9. Collect structured evidence.
10. Grade trace and evidence against AC.
11. Open merge candidate, send slice back for repair, or rescope into a related new slice.
12. Track cadence: candidate, ready, claimed, implementing, implemented, verifying, repairing, blocked, ready for review, accepted, closed.

## Verification Strategy

Every slice should declare its expected evidence before implementation starts:

- unit tests
- integration tests
- migration checks
- lint/typecheck/build
- Playwright/Cypress flows
- accessibility checks where UI is affected
- screenshots and visual diff for frontend work
- API contract tests
- security checks for auth, permissions, input validation, and secrets
- explicit AC mapping

The important design constraint: a slice is not done because an agent says it is done. It is done when the evidence graph satisfies the gates.

Verification should be behavior-first. Structural or regex-like checks may help detect missing code, but they must not be the primary proof of completion. For every FR/AC, prefer executable or observable evidence: tests, running behavior, API calls, browser automation, screenshots, visual diffs, contract checks, or other artifacts that demonstrate the actual behavior.

If a TDD red phase is used, the harness must track the linked green phase. Tests created to fail before implementation must be re-enabled and shown passing before the slice can complete.

## Initial MVP

Build a local-first harness before a dashboard:

1. `swarm init`: create repo metadata directories and config.
2. `swarm target init <repo>`: generate target `.swarm` defaults and autodiscovered commands.
3. `swarm sources add-file <path>`: register file-based immutable source material.
4. `swarm slices pull`: ask the spec server/orchestrator for the next available slice/batch.
5. `swarm run <slice-id>`: spawn real Codex implementation workers in the assigned lane/worktree.
6. `swarm verify <slice-id>`: spawn verifier workers according to protocol.
7. `swarm status`: show slice state and current evidence.
8. `swarm watch`: show live operational monitoring.
9. `swarm report <slice-id>`: emit AC coverage and merge recommendation.

Use real Codex workers immediately, but keep early slices trivial and low-risk. Mocked runs can help unit-test harness internals, but they should not be the main proof of the product loop.

Use a disposable target repository for the first real-worker experiments. The harness repo should remain the control-plane implementation; the throw-away repo should receive real agent edits, tests, and verification reports.

Prefer one fixed disposable fixture repo over generating a new toy repo for every run. Repeatability matters for measuring harness improvements.

Begin with backend/CLI tasks in the fixture repo, then add frontend/browser scenarios after the core harness loop works.

The fixture can live inside the harness repository, such as `fixtures/target-app`, while still being treated as the target repo by worker execution.

Worktree isolation should be from the main repo checkout, not necessarily from every slice. Use one worktree per feature/component/lane for related work where that reduces churn and preserves useful iteration context.

Each feature/component/lane worktree has one lead orchestrator, and each lead orchestrator owns one active lane. This keeps sequencing and ownership clear while allowing multiple workers beneath that orchestrator.

Lanes may request additional FR/AC leases dynamically. A practical default is small related batches, around 3-5 FR/ACs, to avoid expensive swarm spin-up/down for every tiny slice.

## Open Questions

- Should the first implementation be TypeScript or Python? TypeScript may fit dashboards and Node-based dev tooling; Python may fit orchestration, evaluation, and data pipelines.
- Should Linear/Notion be first-class integrations or adapters added after the local metadata model works?
- Should worker execution be direct `codex exec` first, or Agents SDK with Codex exposed via MCP?
- What immutable approved-spec format should the harness consume first: Markdown with IDs, Gherkin, YAML, or a hybrid?
- How strict should automatic merge be? Initial recommendation: never auto-merge; produce merge candidates with evidence.

## Recommendation

Start with a TypeScript local harness that shells out to `codex exec --json` and stores events/artifacts in SQLite plus files. Keep the architecture adapter-driven so the coordinator can move to the Agents SDK once the domain model and evidence loop are proven.

This gives fast learning with real Codex behavior, avoids overbuilding the orchestrator too early, and preserves a clean path toward richer handoffs, traces, guardrails, and evals.
