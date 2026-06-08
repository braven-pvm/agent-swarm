# Invoice Dashboard Requirements

Depends-On: AC-INV-001.1, AC-INV-001.2, AC-INV-002.1, AC-INV-002.2, AC-INV-003.1

## Product Context

Operations users need dashboard view models only after the backend invoice query, summary, and lookup capabilities are accepted. The planner must not serve this frontend lane against stubs.

## Acceptance Criteria

- AC-UI-INV-001.1: Dashboard model includes `summaryCards` using accepted backend summary fields.
- AC-UI-INV-001.2: Dashboard model includes `openInvoiceIds` using accepted backend open-invoice query behavior.
- AC-UI-INV-001.3: Dashboard model includes `featuredInvoice` using accepted backend single-invoice lookup behavior.

## Functional Requirements

- FR-UI-INV-001: The dashboard shall compose accepted backend invoice capabilities into a UI-ready model.

## Verification Notes

- Behavior must be proven through `npm test`.
- No stubbed backend assumptions may be introduced.
