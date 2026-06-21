# Workflow ⇄ agent-swarm: a forensic study

A teardown of the Claude Code `Workflow` multi-agent orchestrator, reconstructed from its **own run
artifacts**, then compared **source-to-source** against agent-swarm to extract mission-aligned
improvements. Both halves are forensic: the Workflow mechanisms come from real run journals/transcripts;
the agent-swarm baseline comes from reading `src/` directly (a 6-lens workflow + independent reads),
with every candidate improvement run through an independent skeptic that re-read the source.

## Read in this order

| File | What it is |
|---|---|
| [forensic-analysis.md](forensic-analysis.md) | How the **Workflow tool** works — 7 mechanisms, each cited to a run artifact |
| [ground-truth-agent-swarm.md](ground-truth-agent-swarm.md) | What **agent-swarm actually does** today, per subsystem, cited to `src/` |
| [lessons-for-agent-swarm.md](lessons-for-agent-swarm.md) | The **12 source-confirmed recommendations** (+ what got dropped) |
| [meta-run-analysis.md](meta-run-analysis.md) | Analysis of the **two Workflow runs** used to produce this study |
| [claude-workflow-implementation-handoff.md](claude-workflow-implementation-handoff.md) | Actionable handoff for a Claude Workflow implementation run: no-redo context, peek-in/intervention packets, and required meta-analysis artifacts |

## Artifacts (reproducible)

| Path | What |
|---|---|
| [artifacts/skill-isolation-review.script.js](artifacts/skill-isolation-review.script.js) | run 1 script (the code review) |
| [artifacts/journal.jsonl](artifacts/journal.jsonl) · [artifacts/agent-anatomy.tsv](artifacts/agent-anatomy.tsv) · [artifacts/findings-output.json](artifacts/findings-output.json) | run 1 journal / per-agent stats / result |
| [artifacts/forensic-run/forensics.script.js](artifacts/forensic-run/forensics.script.js) | run 2 script (this analysis) |
| [artifacts/forensic-run/journal.jsonl](artifacts/forensic-run/journal.jsonl) · [agent-anatomy.tsv](artifacts/forensic-run/agent-anatomy.tsv) · [forensics-output.json](artifacts/forensic-run/forensics-output.json) · [ground-truth-by-lens.txt](artifacts/forensic-run/ground-truth-by-lens.txt) | run 2 journal / stats / 147 KB result / per-lens ground truth |

> Full per-subagent transcripts (`agent-*.jsonl`) stay in the session dir:
> `~/.claude/projects/x--repositories-agent-swarm/<session>/subagents/workflows/<runId>/`.

## TL;DR

**Workflow's 7 mechanisms** (from [forensic-analysis.md](forensic-analysis.md)): (1) control plane is
deterministic code, LLM only fills leaves; (2) content-addressed result journal → free exact resume;
(3) schema-enforced output with tool-layer self-retry; (4) pipeline, no barrier; (5) fresh-context
isolation per subagent; (6) adaptive depth under hard caps; (7) adversarial verify on *actionability*,
default-reject.

**The headline finding:** agent-swarm is **further along than first assumed**. It already has the
hard, mission-critical parts — model-agnostic **schema-validated results** (Zod), an **evidence-derived
ledger**, a **propose→allowlist-execute overseer**, the **Sleuth Review Gate**, and **session
recovery**. The skeptic dropped a third of candidate "lessons" as already-done or mis-framed (the full
list is in [lessons-for-agent-swarm.md](lessons-for-agent-swarm.md#what-i-over-claimed-dropped-by-the-skeptic--recorded-for-honesty)).

**The 12 that survived**, by theme:
- *Structured output:* generate the driver JSON Schema **from** Zod (kill the dual source of truth);
  bounded in-turn re-ask before blocking; one shared validate/persist extractor.
- *Review → escalation:* add an **independent skeptic actor** (never the worker/reviewer); score
  per-finding severity instead of all-or-nothing slice blocking. ← most mission-resonant.
- *Context packets:* inject a ledger-derived **settled-facts / no-redo** block into worker + revive
  prompts (the data already exists; it just isn't wired in).
- *Scheduling:* enforce **`maxActiveLanes`** (currently **dead config**); then pipeline
  dependency-satisfied slices with a concurrency budget.
- *Orchestration:* let the overseer **emit** the plan and have **code execute** the mechanical head;
  extract the deterministic loop out of the demo scripts into `src/`; (contested) a content-addressed
  leaf-result journal.

**The throughline:** agent-swarm and Workflow are the *same idea at different points* — deterministic
orchestration of schema-validated, independently-verified, resumable agent leaves. agent-swarm already
holds the guarantees Workflow can't (adaptive overseer, human-in-the-loop); these 12 import Workflow's
*discipline* into the seams.

*Method note:* this study used the Workflow tool to analyze the Workflow tool — see
[meta-run-analysis.md](meta-run-analysis.md). The skeptic stage caught the analyst's (my) own
over-claims, which is the live argument for recommendations RE-1/RE-2.
