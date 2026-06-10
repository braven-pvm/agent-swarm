# Live Smoke Product Spec: Invoice Operations Dashboard

Date: 2026-06-10

Status: proposed product spec for the ultimate live-agent smoke.

## Purpose

This spec defines the product that the full live-agent smoke should produce from an empty resettable target workspace.

The smoke test should eventually prove:

```text
before run: no implemented product
after run: a small, real, working invoice operations dashboard
```

This is not just a harness fixture. It is a deliberately small but tangible product with backend behavior, browser UI, local persistence, tests, and operator usability.

## Product Name

Invoice Operations Dashboard

## Product Goal

Give an operations user a local dashboard for reviewing invoice status, finding overdue/open invoices, viewing invoice detail, and marking invoices as paid from a seeded local dataset.

The product does not need external services, authentication, multi-user support, or production deployment. It does need to run locally as a coherent application.

## Target User

An operations coordinator who needs to answer:

- How much open invoice value do we have?
- Which invoices are overdue?
- Which customers have open invoices?
- What is the detail for this invoice?
- Can I mark this invoice as paid and see the dashboard update?

## Product Boundary

In scope:

- local Node application
- local seeded invoice/customer data
- API endpoints for invoice list, summary, detail, and status update
- browser dashboard served locally
- tests for backend behavior and UI model/interaction logic
- simple persistence across one local process run

Out of scope:

- external database
- external payment processor
- authentication/authorization
- multi-user concurrency
- production hosting
- email/SMS notifications
- complex accounting workflows

## Run Expectations

The final product should support:

```powershell
npm install
npm test
npm start
```

`npm start` should print or document a local URL, such as:

```text
http://127.0.0.1:4321
```

Opening the URL should show the dashboard UI.

## Data Model

Seeded data should include at least:

- 5 invoices
- 3 customers
- a mix of `open`, `paid`, and `overdue` invoices
- invoice totals in cents
- due dates
- issue dates
- customer display names

Recommended fields:

```ts
type Invoice = {
  id: string;
  customerId: string;
  status: "open" | "paid" | "overdue";
  totalCents: number;
  issuedOn: string;
  dueOn: string;
  description: string;
};

type Customer = {
  id: string;
  displayName: string;
};
```

Local persistence can be a JSON file copied from seed data on first run.

## Functional Requirements

### FR-PROD-001: Local Runnable Product

The product shall run locally as a complete application.

Acceptance criteria:

- AC-PROD-001.1: `npm start` starts a local server without external services.
- AC-PROD-001.2: The local server exposes a browser dashboard.
- AC-PROD-001.3: The local server exposes JSON API endpoints used by the dashboard.
- AC-PROD-001.4: `npm test` passes after implementation.

### FR-DATA-001: Seeded Invoice Data

The product shall provide deterministic local invoice and customer data.

Acceptance criteria:

- AC-DATA-001.1: The dataset includes at least 5 invoices.
- AC-DATA-001.2: The dataset includes at least 3 customers.
- AC-DATA-001.3: The dataset includes at least one `open`, one `paid`, and one `overdue` invoice.
- AC-DATA-001.4: Customer display names are resolvable for every invoice.

### FR-API-001: Invoice Listing API

The backend shall expose invoice listing behavior for dashboard consumption.

Acceptance criteria:

- AC-API-001.1: `GET /api/invoices` returns all invoices with customer display names.
- AC-API-001.2: `GET /api/invoices?status=open` returns only open invoices.
- AC-API-001.3: `GET /api/invoices?status=overdue` returns only overdue invoices.
- AC-API-001.4: `GET /api/invoices?customerId=<id>` returns only invoices for that customer.
- AC-API-001.5: Results are sorted by due date ascending, then invoice id ascending.

### FR-API-002: Invoice Summary API

The backend shall expose aggregate dashboard summary values.

Acceptance criteria:

- AC-API-002.1: `GET /api/summary` returns `invoiceCount`, `openCount`, `overdueCount`, `paidCount`, `openTotalCents`, and `overdueTotalCents`.
- AC-API-002.2: Summary counts and totals match the seeded data.
- AC-API-002.3: Summary updates after an invoice status changes.

### FR-API-003: Invoice Detail API

The backend shall expose invoice detail lookup.

Acceptance criteria:

- AC-API-003.1: `GET /api/invoices/:id` returns invoice detail with customer display name.
- AC-API-003.2: A missing invoice id returns HTTP 404 with a JSON error body.

### FR-API-004: Mark Invoice Paid API

The backend shall allow an operations user to mark an invoice as paid.

Acceptance criteria:

- AC-API-004.1: `PATCH /api/invoices/:id/status` with `{ "status": "paid" }` marks an open or overdue invoice as paid.
- AC-API-004.2: The response returns the updated invoice detail.
- AC-API-004.3: A subsequent summary reflects the updated status.
- AC-API-004.4: A missing invoice id returns HTTP 404 with a JSON error body.
- AC-API-004.5: Unsupported statuses return HTTP 400 with a JSON error body.

### FR-UI-001: Dashboard Summary Cards

The dashboard shall show summary cards for operations users.

Acceptance criteria:

- AC-UI-001.1: The UI shows total invoices.
- AC-UI-001.2: The UI shows open invoices and open total value.
- AC-UI-001.3: The UI shows overdue invoices and overdue total value.
- AC-UI-001.4: The UI shows paid invoices.

### FR-UI-002: Invoice Table And Filters

The dashboard shall show an invoice table with useful filters.

Acceptance criteria:

- AC-UI-002.1: The UI shows invoice id, customer, status, due date, and amount.
- AC-UI-002.2: The UI can filter by all/open/overdue/paid.
- AC-UI-002.3: The UI can filter by customer.
- AC-UI-002.4: Filter changes update the visible invoice list without a page reload.

### FR-UI-003: Invoice Detail Panel

The dashboard shall show detail for a selected invoice.

Acceptance criteria:

- AC-UI-003.1: Selecting an invoice shows customer, status, issue date, due date, amount, and description.
- AC-UI-003.2: Missing detail responses are shown as a user-visible error state.

### FR-UI-004: Mark Paid Interaction

The dashboard shall let an operations user mark an invoice as paid.

Acceptance criteria:

- AC-UI-004.1: Open or overdue invoices show a "Mark paid" action in the detail panel.
- AC-UI-004.2: Paid invoices do not show the "Mark paid" action.
- AC-UI-004.3: After marking paid, the summary cards, table row, and detail panel update.
- AC-UI-004.4: Failed status updates show a user-visible error state.

### FR-QA-001: Behavior Verification

The product shall include behavior-focused tests.

Acceptance criteria:

- AC-QA-001.1: Tests cover invoice list filtering.
- AC-QA-001.2: Tests cover summary totals.
- AC-QA-001.3: Tests cover invoice detail success and missing invoice behavior.
- AC-QA-001.4: Tests cover mark-paid behavior and summary update.
- AC-QA-001.5: Tests cover UI model or browser interaction for filters, detail, and mark-paid refresh.

## Non-Functional Requirements

### NFR-001: Local-Only Operation

The product shall run without external services.

Acceptance criteria:

- AC-NFR-001.1: Tests and local run do not require network calls outside localhost.
- AC-NFR-001.2: The product does not require cloud credentials or secrets.

### NFR-002: Basic Usability

The dashboard shall be usable by a human operator.

Acceptance criteria:

- AC-NFR-002.1: The dashboard is readable at desktop width.
- AC-NFR-002.2: The dashboard remains usable at a narrow mobile-like width.
- AC-NFR-002.3: Currency values are formatted in dollars from cents.
- AC-NFR-002.4: Empty and error states are visible and understandable.

### NFR-003: Product Coherence

The final product shall feel like a coherent small application, not disconnected test functions.

Acceptance criteria:

- AC-NFR-003.1: The browser UI uses the backend API, not duplicated fixture data.
- AC-NFR-003.2: Mark-paid state changes flow through backend persistence and are reflected in the UI.
- AC-NFR-003.3: The implementation has a clear app entrypoint and documented commands.

## Live Smoke Harness Requirements

The harness must verify this product spec through real-agent work.

Acceptance criteria:

- AC-SMOKE-001.1: The live smoke reset starts with no completed product implementation in the target workspace.
- AC-SMOKE-001.2: The overseer must sequence backend API work before dependent UI work.
- AC-SMOKE-001.3: The planner may batch related FR/ACs when evidence remains clear.
- AC-SMOKE-001.4: The verifier/reviewer must inspect product coherence, not only test pass/fail.
- AC-SMOKE-001.5: The final smoke summary links every accepted FR/AC to evidence.
- AC-SMOKE-001.6: The final product can be started manually after the smoke run.
- AC-SMOKE-001.7: The smoke is successful only if a human can open and use the dashboard after the run, or if the run stops with exact blockers explaining why not.

## Final Product Acceptance

The ultimate smoke passes only when:

```text
reset workspace
  -> real overseer coordinates real agents
  -> agents implement the approved product spec
  -> verifier/reviewer and command gates pass
  -> source specs remain unchanged
  -> final dashboard runs locally
  -> user can open and use the product
```

If the run ends with blocked or human-required status, that is still useful when the blockers are exact, visible, and actionable.

