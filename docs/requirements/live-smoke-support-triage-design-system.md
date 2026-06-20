# Live Smoke Support Triage Design System

Date: 2026-06-18

Status: approved Harness 2 design source spec.

Domain: Support Design System
Priority: 2
Tags: support, frontend, design-system, accessibility, human-verification

## Purpose

This source spec defines visual and interaction constraints for the Customer Support Triage Board. It should be bound to frontend workers and reviewers through scenario/project skills so the design guidance is deterministic, compact, and observable.

## Visual Direction

The product is an operational SaaS tool. It should feel quiet, dense, and work-focused. The first screen should be the actual triage board, not a landing page.

Avoid:

- marketing hero sections
- decorative gradient backgrounds
- oversized cards that reduce scanning density
- color-only priority or SLA communication
- ad hoc palettes outside the tokens below

## Tokens

### Color

```json
{
  "color.background": "#f7f8fa",
  "color.surface": "#ffffff",
  "color.surfaceMuted": "#eef2f6",
  "color.border": "#d8dee8",
  "color.text": "#172033",
  "color.textMuted": "#667085",
  "color.accent": "#2563eb",
  "color.urgent": "#b42318",
  "color.high": "#b54708",
  "color.success": "#067647",
  "color.warning": "#b54708",
  "color.focus": "#1d4ed8"
}
```

### Spacing

Use a 4px base scale: `4`, `8`, `12`, `16`, `24`, and `32`.

### Radius

Use `6px` for cards, panels, inputs, chips, and buttons. Do not exceed `8px`.

### Typography

Use system fonts. Do not scale font size with viewport width. Letter spacing must be `0`.

Recommended sizes:

- page title: `22px`
- section heading: `14px`
- body: `14px`
- compact labels: `12px`
- table rows: `13px` to `14px`

### Layout

- Use a full-width app shell.
- Desktop layout should show summary, filters, queue, and detail panel together where width allows.
- Narrow layout may stack sections, but controls and critical labels must not overlap.
- Ticket rows should have stable height with a minimum of `44px`.
- Filters should not resize the table when changed.

## Components

### FR-DS-001: Summary Metric Components

Summary metric components shall follow the support triage design tokens and remain readable in a dense operational layout.

Acceptance criteria:

- AC-DS-001.1: Metric components use the tokenized surface, border, text, and spacing values.
- AC-DS-001.2: Metrics show a label and value without wrapping the value into unreadability.

### FR-DS-002: Filter Toolbar Components

Filter toolbar components shall remain labelled, stable, and usable across desktop and narrow layouts.

Acceptance criteria:

- AC-DS-002.1: Filters use native select/input/button controls or accessible equivalents.
- AC-DS-002.2: Filter labels remain associated with their controls.
- AC-DS-002.3: Filter controls remain usable at narrow widths.

### FR-DS-003: Ticket Queue Components

Ticket queue components shall expose operational status clearly without relying on color alone.

Acceptance criteria:

- AC-DS-003.1: Ticket rows expose priority, SLA state, and status as chips or equivalent compact indicators.
- AC-DS-003.2: Urgent and breached indicators include text or iconography in addition to color.
- AC-DS-003.3: Selected row state is visible and keyboard-focusable.

### FR-DS-004: Detail Panel Components

The detail panel shall group ticket context, actions, errors, and notes in a readable way.

Acceptance criteria:

- AC-DS-004.1: Detail content is grouped into ticket, customer, SLA, assignment/status, and notes sections.
- AC-DS-004.2: Error states appear near the action that failed.
- AC-DS-004.3: Notes preserve readable line length.

## Human Verification Criteria

### FR-DS-HUMAN-001: Human Visual Review

The design system shall include criteria that require human visual verification.

These criteria require human verification in addition to automated evidence:

- AC-DS-HUMAN-001.1: The board is scannable at desktop width without forcing the user to hunt for urgent, breached, or unassigned work.
- AC-DS-HUMAN-001.2: The board remains usable at narrow width without overlapping controls, clipped critical text, or hidden primary actions.
- AC-DS-HUMAN-001.3: Priority and SLA states are understandable without relying on color alone.
