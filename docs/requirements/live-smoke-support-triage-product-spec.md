# Live Smoke Product Spec: Customer Support Triage Board

Date: 2026-06-18

Status: approved baseline product spec for Live Agent Smoke Harness 2.

Domain: Support Product
Priority: 1
Tags: support, product, smoke, full-product, human-verification

## Purpose

This spec defines the second full-product smoke target for agent-swarm. It exists to prove that the harness can take a different product domain, different source specs, project skills, design tokens, human verification, and backend-before-UI gating without hard-coding invoice-specific behavior into the engine.

The smoke test should prove:

```text
before run: no implemented support triage product
after run: a small, real, working customer support triage board
```

## Product Name

Customer Support Triage Board

## Product Goal

Give a support lead a local board for triaging customer tickets by priority, SLA state, customer tier, assignee, and status. The product should let the user find urgent or breached work, inspect a ticket, assign it, change its status, add an internal note, and see board metrics update.

## Target User

A support lead who needs to answer:

- Which tickets need action first?
- Which tickets are SLA-breached or due soon?
- Who owns each ticket?
- What is the customer context?
- Can I assign a ticket, update status, leave a note, and see the board update?

## Product Boundary

In scope:

- local Node application
- seeded ticket, customer, and agent data
- JSON APIs for ticket list, ticket detail, summary, assignment, status transition, and internal notes
- browser triage board served locally
- design-token driven UI
- tests and probes that prove API behavior, workflow behavior, and UI model behavior
- human verification packet for visual triage usability

Out of scope:

- external database
- authentication
- real notification delivery
- multi-user concurrency
- production deployment
- integrations with external helpdesk tools

## Run Expectations

The final product should support:

```powershell
npm install
npm test
npm start
```

`npm start` should print or document a local URL. Opening the URL should show the triage board UI.

## Verification Modes

The harness must create verification obligations for every FR/AC served in a slice.

- Automated verification applies to deterministic API, data, workflow, and UI model behavior.
- Independent review applies to all implementation slices through the Sleuth Review Gate.
- Human verification applies only to clear visual/usability criteria explicitly marked as human-verification criteria.
- Human input is not expected in the normal Harness 2 baseline. Human-input fault modes may be added later as scenario faults without changing this approved baseline spec.

## Functional Requirements

### FR-PROD-001: Local Runnable Product

The product shall run locally as a complete application.

Acceptance criteria:

- AC-PROD-001.1: `npm start` starts a local server without external services.
- AC-PROD-001.2: The local server exposes a browser triage board.
- AC-PROD-001.3: The local server exposes JSON API endpoints used by the board.
- AC-PROD-001.4: `npm test` passes after implementation.

### FR-PROD-002: Seeded Support Data

The product shall provide deterministic local support data.

Acceptance criteria:

- AC-PROD-002.1: The dataset includes at least 8 tickets.
- AC-PROD-002.2: The dataset includes at least 4 customers.
- AC-PROD-002.3: The dataset includes at least 3 support agents.
- AC-PROD-002.4: Tickets include a mix of `new`, `assigned`, `waiting_customer`, and `resolved` statuses.
- AC-PROD-002.5: Tickets include a mix of `urgent`, `high`, `normal`, and `low` priorities.
- AC-PROD-002.6: At least one ticket is SLA-breached and at least one ticket is due soon.

The seeded data must include the deterministic IDs required by the API requirements and product-readiness probe: agents `agent-ava`, `agent-ben`, `agent-cyra`; tickets `TCK-100` through `TCK-107`; and customers `cust-acme`, `cust-northwind`, `cust-summit`, `cust-river`.

### FR-PROD-003: Triage Workflow

The product shall support a complete local triage workflow.

Acceptance criteria:

- AC-PROD-003.1: The user can identify urgent or SLA-breached tickets from the board.
- AC-PROD-003.2: The user can filter the board by status, priority, assignee, and SLA state.
- AC-PROD-003.3: The user can select a ticket and view customer, ticket, SLA, and note context.
- AC-PROD-003.4: The user can assign a ticket to a support agent.
- AC-PROD-003.5: The user can change a ticket status to an allowed next state.
- AC-PROD-003.6: The user can add an internal note and see it on the selected ticket.
- AC-PROD-003.7: Summary metrics update after assignment, status, or note workflow actions where relevant.

### FR-PROD-004: Product Readiness Probe

The harness shall prove the generated product is runnable and useful at the end of the full-product run.

Acceptance criteria:

- AC-PROD-004.1: The product readiness probe starts the generated app in an isolated final-target copy.
- AC-PROD-004.2: The probe confirms the browser HTML includes `Customer Support Triage Board`.
- AC-PROD-004.3: The probe confirms `/api/summary` returns `openTicketCount`, `breachedSlaCount`, `urgentTicketCount`, and `unassignedTicketCount`.
- AC-PROD-004.4: The probe performs an assignment/status/note workflow through HTTP endpoints and confirms summary or detail state changes.
- AC-PROD-004.5: The probe archives JSON and Markdown readiness artifacts.

### FR-HUMAN-001: Human Visual Verification

The product shall produce a human-verifiable UI that is not fully accepted by automated checks alone.

Acceptance criteria:

- AC-HUMAN-001.1: A human verification packet includes exact UI/design criteria, product URL, screenshot or DOM evidence, changed files, automated evidence, and pass/fail/needs-rework controls.
- AC-HUMAN-001.2: The human can verify that urgent and breached tickets are visually distinguishable without relying on color alone.
- AC-HUMAN-001.3: The human can verify that the board is scannable at desktop width with summary, filters, queue, and detail context visible.
- AC-HUMAN-001.4: The human can verify that narrow-width layout remains usable without overlapping controls or clipped critical text.

### FR-QUALITY-001: Real-World Fitness

The product shall be reviewed for implementation quality, not only FR/AC checkbox evidence.

Acceptance criteria:

- AC-QUALITY-001.1: Independent review checks runtime wiring from server entry point through API and UI behavior.
- AC-QUALITY-001.2: Independent review checks for fake-ready stubs, hardcoded success paths, and hollow tests.
- AC-QUALITY-001.3: Independent review checks meaningful error handling for invalid API input and missing records.
- AC-QUALITY-001.4: Independent review checks that design-token usage is intentional rather than ad hoc styling.
