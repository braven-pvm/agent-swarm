# Run Observability Contract

Status: implemented contract, UI adoption pending
Date: 2026-06-15

## Purpose

The UI must not collapse these separate truths into one badge:

- latest run outcome
- indexed FR/AC coverage
- product-readiness proof
- active harness concerns

The key scenario is a live smoke run where product-readiness probes pass while the registered product spec still has not-started refs. For full-product mode this must not be accepted yet: the runner should create visible coverage-completion slices for remaining refs and continue. If no completion work is visible or bounds stop the loop, it must read as "product readiness passed, but final acceptance is blocked by incomplete FR/AC coverage." Selected-scope runs may still report accepted with partial global coverage, but full-product acceptance requires every indexed in-scope FR/AC ref to be done.

## Endpoints

### `GET /api/run-observability`

Returns a UI-ready semantic summary:

- `outcome`: latest finalized run summary when `live-agent-run-summary.json` exists
- `coverage`: authoritative indexed FR/AC totals and incomplete-domain highlights
- `productReadiness`: runnable-product readiness state, accepted readiness refs, probes, blockers, manual URL
- `slices`: slice counts by status
- `outcomeVsCoverage`: the main UI truth row for accepted-vs-partial situations
- `warnings`: plain-language warning list
- `uiHints`: badges and callouts the UI can render directly

Important states:

- `accepted_complete`: run accepted and every indexed FR/AC ref is done
- `accepted_partial`: selected-scope run accepted, but indexed FR/AC coverage is incomplete; full-product runs should not end here
- `not_accepted`: latest run ended blocked/human-required/etc.
- `unknown`: no finalized run artifact exists yet

### `GET /api/snapshot`

Now includes `runObservability` with the same shape as `/api/run-observability`. This allows the status bar/header to hydrate from the normal snapshot without a second request.

### `GET /api/coverage`

Still returns every indexed FR/AC ref, but now includes:

- `interpretation.completionPercent`
- `interpretation.state`: `empty`, `complete`, or `partial`
- `interpretation.headline`
- `interpretation.detail`
- `interpretation.warning`
- `interpretation.nextActions`
- `interpretation.topIncompleteDomains`

The denominator remains every unique FR/AC ref indexed across registered sources, including refs not currently owned by any slice.

## UI Guidance

Recommended top-level badges:

- Run: `runObservability.outcome.finalOutcome`
- Coverage: `runObservability.coverage.totals.done / runObservability.coverage.totals.total`
- Readiness: `runObservability.productReadiness.passed ? "passed" : "not passed"`

Recommended primary callout:

- `runObservability.outcomeVsCoverage.headline`
- `runObservability.outcomeVsCoverage.detail`

For an in-progress full-product run with partial coverage, the UI should show the active coverage-completion slice(s) as normal work. For a terminal full-product run with partial coverage, the UI should show a blocked/not-accepted callout even when product readiness passed and all active slices are accepted. The expected terminal classifier is `coverage_incomplete`.

## Run Summary Artifacts

`scripts/run-live-agent-demo.mjs` now writes compact coverage data into `live-agent-run-summary.json`:

- `summary.coverage.totals`
- `summary.coverage.interpretation`
- `summary.coverage.byDomain`
- `summary.outcomeVsCoverage`
- `summary.finalCoverageGate` for full-product runs after product readiness passes; accepted only when this gate passes, otherwise used to drive visible completion slices or terminal `coverage_incomplete`

Coverage-completion turns and `coverage_completion.slice_created` events may include:

- `coveragePackKey`: stable machine key for product-spec completion packs, such as `api-data`, `ui-summary-table`, `ui-detail-mark-paid`, `qa-interaction`, `local-usability`, or `smoke-acceptance`
- `coveragePackLabel`: human-readable pack label
- `frAcRefs` / `refs`: exact immutable refs leased by that completion slice

The UI should prefer these fields over parsing long slice titles. A full-product run is not accepted until all indexed refs are done; a product-readiness pass with partial coverage is still an active or blocked coverage-completion state.

Archived run summaries therefore preserve the outcome-vs-coverage distinction even when viewed outside the live server.
