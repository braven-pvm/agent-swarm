# Invoice Operations Backend Requirements

## Product Context

Operations users need a small invoice service that can drive a dashboard lane without relying on stubs. Backend work should expose real query and summary behavior from the fixture data before any UI lane is considered ready.

## Acceptance Criteria

- AC-INV-001.1: Listing invoices without filters returns all seeded invoices.
- AC-INV-001.2: Listing invoices with `{ status: "open" }` returns only open invoices.
- AC-INV-001.3: Listing invoices with `{ customerId: "CUST-1" }` returns only that customer's invoices.
- AC-INV-002.1: Invoice summary returns `count`, `openCount`, `paidCount`, and `totalOpenCents`.
- AC-INV-002.2: Invoice summary for the seeded data reports `count: 3`, `openCount: 2`, `paidCount: 1`, and `totalOpenCents: 17000`.
- AC-INV-003.1: Fetching invoice `INV-1001` returns its invoice record.
- AC-INV-003.2: Fetching a missing invoice returns `null`.

## Functional Requirements

- FR-INV-001: The invoice service shall support invoice listing for operations users.
- FR-INV-002: The invoice service shall expose aggregate summary values for dashboard cards.
- FR-INV-003: The invoice service shall support fetching a single invoice by id.

## Verification Notes

- Behavior must be proven through `npm test`.
- Source requirements must remain unchanged.
- No external service, database, or network dependency may be introduced for the fixture.
