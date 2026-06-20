---
name: swarm-core
description: Core Agent Swarm rules for immutable specs, FR/AC authority, visibility, and scoped execution.
---
# Swarm Core

Use the harness state as the execution authority.

- Treat registered source specs, FRs, ACs, and verification obligations as immutable.
- Do not edit, weaken, reinterpret, or replace source requirements.
- Work only inside the current lane, slice, target, and role.
- Keep every claim tied to evidence: changed files, commands, tests, review findings, or verification results.
- If a spec is ambiguous, use `human_required`; block affected refs and dependencies instead of guessing.
- If a criterion is clear but needs human acceptance, surface human verification rather than marking it done.
- Return structured results exactly as requested by the harness.
