# Run Observability Contract

Status: implemented contract, UI adoption pending
Date: 2026-06-15

## Purpose

The UI must not collapse these separate truths into one badge:

- latest run outcome
- indexed FR/AC coverage
- product-readiness proof
- active harness concerns

The key scenario is a successful live smoke run where the selected slices and product-readiness gate pass, while the broader registered product spec still has many not-started refs. That should read as "run accepted for selected scope" plus "coverage partial", not as "whole product complete".

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
- `accepted_partial`: run accepted, but indexed FR/AC coverage is incomplete
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

For an accepted run with partial coverage, the UI should show a warning-style callout even when all active slices are accepted and active escalations are zero.

## Run Summary Artifacts

`scripts/run-live-agent-demo.mjs` now writes compact coverage data into `live-agent-run-summary.json`:

- `summary.coverage.totals`
- `summary.coverage.interpretation`
- `summary.coverage.byDomain`
- `summary.outcomeVsCoverage`

Archived run summaries therefore preserve the outcome-vs-coverage distinction even when viewed outside the live server.
