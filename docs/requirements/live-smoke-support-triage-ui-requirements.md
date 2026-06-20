# Live Smoke Support Triage UI Requirements

Date: 2026-06-18

Status: approved Harness 2 frontend source spec.

Domain: Support Dashboard
Priority: 1
Tags: support, frontend, ui, smoke, human-verification

## Purpose

This source spec defines the browser UI behavior for the Customer Support Triage Board. UI implementation must use the backend capabilities accepted for the corresponding API refs and the design tokens in `live-smoke-support-triage-design-system.md`.

## Dependency Rule

The planner should not serve production UI slices that depend on backend behavior until the related backend FR/AC refs are accepted. UI may include local helper functions and view models, but the accepted product must wire to real backend endpoints, not mocks or stubs.

## Functional Requirements

### FR-SUP-UI-001: Board Shell And Summary

The UI shall show a compact triage board shell with useful summary metrics.

Acceptance criteria:

- AC-SUP-UI-001.1: The first viewport includes the title `Customer Support Triage Board`.
- AC-SUP-UI-001.2: Summary cards show open tickets, urgent tickets, SLA-breached tickets, due-soon tickets, unassigned tickets, and resolved tickets.
- AC-SUP-UI-001.3: Summary cards are populated from `/api/summary`.
- AC-SUP-UI-001.4: Summary values refresh after assignment or status workflow actions.

### FR-SUP-UI-002: Ticket Queue And Filters

The UI shall present a scannable ticket queue with filters.

Acceptance criteria:

- AC-SUP-UI-002.1: The ticket queue shows ticket id, customer, customer tier, title, priority, status, assignee, SLA state, and SLA due time.
- AC-SUP-UI-002.2: The queue uses `/api/tickets` and preserves backend sorting.
- AC-SUP-UI-002.3: Status, priority, assignee, and SLA filters update the visible queue without a page reload.
- AC-SUP-UI-002.4: Empty filter results show a useful empty state.
- AC-SUP-UI-002.5: Urgent and breached tickets have visible affordances that do not depend on color alone.

### FR-SUP-UI-003: Ticket Detail Panel

The UI shall show detail for the selected ticket.

Acceptance criteria:

- AC-SUP-UI-003.1: Selecting a ticket loads `/api/tickets/:id`.
- AC-SUP-UI-003.2: Detail shows title, description, customer display name, customer tier, status, priority, assignee, SLA state, and notes.
- AC-SUP-UI-003.3: Missing detail responses show a user-visible error state.
- AC-SUP-UI-003.4: The selected ticket remains visibly selected in the queue.

### FR-SUP-UI-004: Assignment Workflow

The UI shall allow ticket assignment.

Acceptance criteria:

- AC-SUP-UI-004.1: The detail panel exposes an assignee control populated with support agents.
- AC-SUP-UI-004.2: Changing assignment calls `PATCH /api/tickets/:id/assignment`.
- AC-SUP-UI-004.3: After successful assignment, the queue row, detail panel, and summary refresh.
- AC-SUP-UI-004.4: Assignment errors are shown in the detail panel without losing the current selection.

### FR-SUP-UI-005: Status Workflow

The UI shall allow allowed status transitions.

Acceptance criteria:

- AC-SUP-UI-005.1: The detail panel exposes allowed next statuses for the selected ticket.
- AC-SUP-UI-005.2: Changing status calls `PATCH /api/tickets/:id/status`.
- AC-SUP-UI-005.3: After successful status change, the queue row, detail panel, and summary refresh.
- AC-SUP-UI-005.4: Invalid transition errors are shown in the detail panel.

### FR-SUP-UI-006: Internal Notes Workflow

The UI shall allow internal note entry.

Acceptance criteria:

- AC-SUP-UI-006.1: The detail panel includes an internal note text field and submit control.
- AC-SUP-UI-006.2: Submitting a non-empty note calls `POST /api/tickets/:id/notes`.
- AC-SUP-UI-006.3: The new note appears in the note list after submission.
- AC-SUP-UI-006.4: Empty note submission is prevented or shows a useful error.

### FR-SUP-UI-007: Human-Verifiable Visual Quality

The UI shall be suitable for human visual verification.

Acceptance criteria:

- AC-SUP-UI-007.1: A human can verify desktop board scannability with summary, filters, queue, and detail context visible.
- AC-SUP-UI-007.2: A human can verify narrow-width usability without overlapping controls or clipped critical text.
- AC-SUP-UI-007.3: A human can verify priority, SLA, and status indicators are readable and not color-only.
- AC-SUP-UI-007.4: A human can verify the design system tokens are followed for color, spacing, radius, typography, and component density.

