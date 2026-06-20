# Live Smoke Support Triage API Requirements

Date: 2026-06-18

Status: approved Harness 2 backend source spec.

Domain: Support Backend
Priority: 1
Tags: support, backend, api, smoke

## Purpose

This source spec defines the backend behavior for the Customer Support Triage Board. It is immutable input for the implementation harness. Agents may choose implementation details, but they must verify behavior against these FR/AC refs.

## Data Contract

Seeded data must contain deterministic records with these minimum fields:

```ts
type Customer = {
  id: string;
  displayName: string;
  tier: "enterprise" | "growth" | "starter";
};

type SupportAgent = {
  id: string;
  displayName: string;
};

type Ticket = {
  id: string;
  customerId: string;
  title: string;
  description: string;
  status: "new" | "assigned" | "waiting_customer" | "resolved";
  priority: "urgent" | "high" | "normal" | "low";
  assigneeId: string | null;
  slaDueAt: string;
  createdAt: string;
  internalNotes: Array<{ id: string; author: string; body: string; createdAt: string }>;
};
```

Required deterministic seed IDs for tests and probes:

- customers: `cust-acme`, `cust-northwind`, `cust-summit`, `cust-river`
- agents: `agent-ava`, `agent-ben`, `agent-cyra`
- tickets: `TCK-100` through `TCK-107`

These IDs are part of the Harness 2 product-readiness contract. Implementations may add additional records, but accepted API and workflow behavior must support these records because the final readiness probe uses `TCK-100` and `agent-ava`.

## Sorting Rules

Priority order is `urgent`, `high`, `normal`, `low`.

SLA state is derived from `slaDueAt` relative to a deterministic app clock or test clock:

- `breached`: SLA due time is before now and status is not `resolved`
- `due_soon`: SLA due time is within the next 24 hours and status is not `resolved`
- `ok`: everything else

Ticket list results must sort by:

1. priority order
2. breached SLA before due soon before ok
3. SLA due time ascending
4. ticket id ascending

## Functional Requirements

### FR-SUP-API-001: Ticket Listing API

The backend shall expose ticket listing behavior for board consumption.

Acceptance criteria:

- AC-SUP-API-001.1: `GET /api/tickets` returns all tickets with `customerDisplayName`, `customerTier`, `assigneeDisplayName`, and derived `slaState`.
- AC-SUP-API-001.2: `GET /api/tickets?status=new` returns only tickets with status `new`.
- AC-SUP-API-001.3: `GET /api/tickets?priority=urgent` returns only urgent tickets.
- AC-SUP-API-001.4: `GET /api/tickets?assigneeId=agent-ava` returns only tickets assigned to `agent-ava`.
- AC-SUP-API-001.5: `GET /api/tickets?assigneeId=unassigned` returns only unassigned tickets.
- AC-SUP-API-001.6: `GET /api/tickets?sla=breached` returns only non-resolved breached tickets.
- AC-SUP-API-001.7: Listing results follow the sorting rules in this spec.

### FR-SUP-API-002: Summary API

The backend shall expose aggregate triage board metrics.

Acceptance criteria:

- AC-SUP-API-002.1: `GET /api/summary` returns `ticketCount`, `openTicketCount`, `urgentTicketCount`, `breachedSlaCount`, `dueSoonCount`, `unassignedTicketCount`, and `resolvedTicketCount`.
- AC-SUP-API-002.2: Summary values match the seeded data at startup.
- AC-SUP-API-002.3: Summary values update after assignment or status changes where the underlying counts change.

### FR-SUP-API-003: Ticket Detail API

The backend shall expose ticket detail lookup.

Acceptance criteria:

- AC-SUP-API-003.1: `GET /api/tickets/:id` returns ticket detail with customer and assignee display fields.
- AC-SUP-API-003.2: Detail includes internal notes in chronological order.
- AC-SUP-API-003.3: A missing ticket id returns HTTP 404 with a JSON error body.

### FR-SUP-API-004: Assignment API

The backend shall allow assignment changes.

Acceptance criteria:

- AC-SUP-API-004.1: `PATCH /api/tickets/:id/assignment` with `{ "assigneeId": "agent-ava" }` assigns the ticket to Ava.
- AC-SUP-API-004.2: Assigning a ticket changes status from `new` to `assigned`.
- AC-SUP-API-004.3: Assigning an already assigned ticket updates the assignee and preserves non-`new` status.
- AC-SUP-API-004.4: Unknown agent ids return HTTP 400 with a JSON error body.
- AC-SUP-API-004.5: Missing ticket ids return HTTP 404 with a JSON error body.

### FR-SUP-API-005: Status Transition API

The backend shall enforce allowed status transitions.

Acceptance criteria:

- AC-SUP-API-005.1: `PATCH /api/tickets/:id/status` with `{ "status": "waiting_customer" }` is allowed from `assigned`.
- AC-SUP-API-005.2: `PATCH /api/tickets/:id/status` with `{ "status": "resolved" }` is allowed from `assigned` or `waiting_customer`.
- AC-SUP-API-005.3: `PATCH /api/tickets/:id/status` with `{ "status": "assigned" }` is allowed from `new` only when the ticket has an assignee.
- AC-SUP-API-005.4: Invalid transitions return HTTP 400 with a JSON error body.
- AC-SUP-API-005.5: Missing ticket ids return HTTP 404 with a JSON error body.

### FR-SUP-API-006: Internal Notes API

The backend shall allow internal notes on tickets.

Acceptance criteria:

- AC-SUP-API-006.1: `POST /api/tickets/:id/notes` with `{ "author": "Ava", "body": "Contacted customer." }` appends a note.
- AC-SUP-API-006.2: Empty note bodies return HTTP 400 with a JSON error body.
- AC-SUP-API-006.3: The response returns the updated ticket detail with the new note included.
- AC-SUP-API-006.4: Missing ticket ids return HTTP 404 with a JSON error body.
