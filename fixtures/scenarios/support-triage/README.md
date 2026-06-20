# Support Triage Scenario

This fixture is the Harness 2 scenario source package for the Customer Support Triage Board.

Current status:

- source specs are committed under `docs/requirements/live-smoke-support-triage-*.md`
- scenario skills are committed under `.swarm/skills`
- `scenario.json` declares the intended reset/run contract
- UI work has focused implementation, design-system, review, and accessibility skills
- `swarm smoke live-agent reset --scenario live-agent-smoke-h2` consumes this scaffold and writes the disposable H2 workspace

This fixture is not yet wired into the live runner. Phase 11C should add fake-agent H2 E2E before any real-agent H2 run.

Important boundary:

- product facts live here or in immutable source specs
- core harness code must not hard-code support-triage refs, titles, routes, or skill ids
