# Source and Status Adapter Contracts

Date: 2026-05-25

## Purpose

Source adapters let the harness work with different spec stores without forcing every team into one requirements format or database import process.

The first source adapter should be file-based. Linear, Notion, GitHub, or custom services should be added by implementing the same source contract.

Status write-back is a separate concern. A status sink may update Linear, a checklist, a sidecar file, or another project-management surface, but it must not be confused with immutable spec reading.

## Design Rule

Source adapters expose source material and help serve slices. They are read-only with respect to immutable specs.

Status sinks receive concise progress updates and report links. They do not own slice execution state.

The harness owns:

- slice records
- lifecycle state
- agent runs
- event telemetry
- evidence
- verification gates
- canonical reports

The source adapter owns:

- reading source material from its native store
- resolving source references
- producing source citations and immutable references

The status sink owns:

- writing concise status back where supported
- linking back to the harness report

## Source Adapter Interface

```typescript
export interface SourceAdapter {
  readonly kind: string;
  readonly displayName: string;

  connect(config: SourceAdapterConfig): Promise<SourceAdapterConnection>;

  listSources(query?: SourceQuery): Promise<SourceSummary[]>;

  getSource(ref: SourceRef): Promise<SourceDocument>;

  resolveLinks(source: SourceDocument): Promise<SourceRef[]>;
}
```

## Supporting Types

```typescript
export interface SourceAdapterConfig {
  adapterId: string;
  settings: Record<string, unknown>;
}

export interface SourceAdapterConnection {
  adapterId: string;
  capabilities: SourceAdapterCapabilities;
}

export interface SourceAdapterCapabilities {
  canListSources: boolean;
  canResolveLinks: boolean;
  canHashContent: boolean;
  canReadLinkedSources: boolean;
}

export interface SourceQuery {
  labels?: string[];
  status?: string[];
  text?: string;
  limit?: number;
}

export interface SourceRef {
  adapterId: string;
  kind: string;
  uri: string;
  title?: string;
  version?: string;
  hash?: string;
  section?: string;
}

export interface SourceSummary {
  ref: SourceRef;
  title: string;
  status?: string;
  labels?: string[];
  updatedAt?: string;
}

export interface SourceDocument {
  ref: SourceRef;
  title: string;
  body: string;
  format: "markdown" | "text" | "json" | "unknown";
  links: SourceRef[];
  metadata: Record<string, unknown>;
}

export interface VerificationRequirement {
  description: string;
  type: "test" | "build" | "runtime" | "api" | "visual" | "review" | "other";
  sourceRefs: SourceRef[];
  required: boolean;
}
```

## Status Sink Interface

```typescript
export interface StatusSink {
  readonly kind: string;
  readonly displayName: string;

  connect(config: StatusSinkConfig): Promise<StatusSinkConnection>;

  updateStatus(update: StatusUpdate): Promise<StatusUpdateResult>;
}

export interface StatusSinkConfig {
  sinkId: string;
  settings: Record<string, unknown>;
}

export interface StatusSinkConnection {
  sinkId: string;
  capabilities: StatusSinkCapabilities;
}

export interface StatusSinkCapabilities {
  canWriteStatus: boolean;
  canAttachReportLink: boolean;
  canAttachPrLink: boolean;
  canWriteEvidenceSummary: boolean;
  canWriteLedgerSummary: boolean;
}

export interface StatusUpdate {
  sourceRefs: SourceRef[];
  sliceId?: string;
  status: string;
  summary: string;
  reportUrl?: string;
  prUrl?: string;
  evidenceSummary?: string;
  blocker?: string;
  ledger?: StatusSinkLedgerSummary;
}

export interface StatusSinkLedgerSummary {
  origin: "derived";
  canonicalDetail: {
    apiPath: "/api/coverage";
    payloadPath: "ledger";
  };
  generatedAt: string;
  state: "empty" | "complete" | "partial" | "human_attention" | "blocked";
  completion: {
    total: number;
    accepted: number;
    verifiedNotAccepted: number;
    incomplete: number;
    completionPercent: number;
  };
  totals: Record<string, number> & { total: number };
  attention: {
    blocked: number;
    failed: number;
    humanInputRequired: number;
    awaitingHumanVerification: number;
    refs: StatusSinkLedgerRef[];
  };
  human: {
    awaitingVerification: number;
    signed: number;
  };
  rollups: {
    total: number;
    incomplete: number;
  };
  buckets: Array<{ status: string; count: number; refs: string[] }>;
  nextRefs: StatusSinkLedgerRef[];
}

export interface StatusSinkLedgerRef {
  ref: string;
  status: string;
  domain: string;
  reason: string;
  sourceTitle: string;
  sliceId?: string;
  nextAction?: string;
  humanPath?: string;
  responsibleParty?: string;
}

export interface StatusUpdateResult {
  updated: boolean;
  nativeUrl?: string;
  message?: string;
}
```

## File-Based Adapter

The first adapter should support a directory of Markdown/text specs and optional checklist files.

Expected capabilities:

- read files by path
- list candidate spec files
- resolve local Markdown links
- produce source refs with file path and content hash

It should not require a strict spec schema. It exposes source material for the spec server/orchestrator to interpret.

It must not edit immutable spec files.

## File-Based Status Sink

A separate file-based status sink may write concise progress and report links to a sidecar file or checklist.

Expected capabilities:

- write status to a configured sidecar file
- attach harness report links
- avoid mutating immutable source specs
- keep detailed telemetry and evidence in the harness
- optionally write the compact derived requirement-ledger summary

## Requirement Ledger Write-Back

For the MVP, the requirement ledger is derived by the harness from source refs, leases, slice state, verification obligations, evidence, review results, dependencies, escalations, and human verification results. It is not persisted as a separate requirements table.

Status sinks may receive a compact `ledger` summary on `StatusUpdate`, but this summary is an outbound mirror only. The canonical full ledger detail remains `/api/coverage` at payload path `ledger`.

The compact summary exists so Linear, file-based checklists, or other sinks can show meaningful progress without reconstructing every row:

- total accepted/incomplete refs and completion percent
- blocked/failed/human-input/human-verification attention counts
- bounded attention refs and next refs
- rollup counts for parent FR visibility
- direct link back to the canonical `/api/coverage` payload

## Linear Adapter

Linear can implement both a source adapter and a status sink later.

Expected source capabilities:

- list issues by project/team/label/status
- fetch issue descriptions, comments, links, attachments, and relations
- resolve hard links to local specs or Notion/GitHub where possible

Expected status sink capabilities:

- update issue status/comment/description with concise progress
- attach or link the canonical harness slice report

Linear-specific behavior must stay inside the adapter.

## Spec Server and Slice Rule

Source adapters do not need to propose slices directly. The spec server/orchestrator uses adapter-provided source documents, refs, links, and status to decide which slice to serve next.

Every served slice must include source refs, FR/AC refs where available, and verification requirements before implementation starts. If the spec server cannot provide enough provenance for verification, the slice should be marked `blocked` or `needs_human`, not silently invented.

## MVP Decision

Implement file-based source adapter first. Keep status write-back separate. Design and test both interfaces as if Linear were the next adapter/sink.
