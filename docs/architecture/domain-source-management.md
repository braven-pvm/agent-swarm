# Domain Source Management

Date: 2026-06-09

Large projects usually have multiple approved domain specs. The harness needs enough structure to coordinate lanes and slices across those specs without forcing teams into a rigid ingestion pipeline.

## Boundary

Source specs remain immutable and native to their store: files, Linear, Notion, GitHub, or another adapter.

The harness stores a derived planning index:

- source refs and content hashes
- domain label
- tags
- priority
- extracted FR/AC refs
- current lease/status counts
- active, blocked, and accepted slice counts

This index is not canonical spec truth. If source content and harness metadata disagree, source content plus immutable source refs win.

## File Source Metadata

File sources can declare simple metadata inside the document:

```markdown
# Billing Domain Requirements

Domain: Billing
Tags: backend, ledger
Priority: 2

- AC-BILL-001.1: Billing exports include paid invoices.
- AC-BILL-001.2: Billing exports include overdue invoices.
```

Operators can also provide metadata at registration time:

```powershell
swarm sources add-file docs/specs/billing.md --domain Billing --tags backend,ledger --priority 2
swarm sources add-dir docs/specs --domain Billing --tags backend
```

CLI options override document metadata for domain/tags/priority. FR/AC refs are always derived from the immutable source text.

## Planning Use

Domain metadata lets the planning agent and overseer ask practical questions:

- Which domains have available work?
- Which domains are active or blocked?
- Which source specs are feeding a lane?
- Which FR/AC refs are leased, completed, or still available?
- Which domain should the next lane or slice target?

Example commands:

```powershell
swarm sources list
swarm sources list --domain Billing
swarm domains list
swarm domains inspect Billing
swarm slices pull --domain Billing --tag backend --batch-size 3
```

## MVP Behavior

The MVP implementation:

- supports file source metadata and CLI metadata
- indexes FR/AC refs at registration
- indexes Markdown sections by heading, source line range, snippet, and refs
- groups sources into domains
- exposes `domains list` and `domains inspect`
- exposes `sources inspect` for a source-level section/ref map
- exposes lightweight spec text search with `search specs`
- allows `slices pull` to filter by domain and tag
- includes domain summaries in `observe`
- enriches the graph with `domain -> source -> section -> FR/AC` edges
- exposes source/domain/spec data in the web viewer
- exposes read-only source markdown through the web viewer API

It deliberately does not require:

- full spec normalization
- a global canonical domain model
- human-managed capability catalogs
- mutation of source specs or Linear issues
- embeddings, semantic retrieval, or a separate RAG service for MVP

## Text Search and Graph First

MVP uses local text search plus an explicit derived graph.

```text
immutable source text
  -> source hash
  -> Markdown section index
  -> FR/AC refs per section
  -> domain/source/section/ref graph
  -> slice/lane/evidence graph
```

This keeps source navigation useful for agents without creating a separate spec-ingestion product. Keyword search is enough for targeted discovery, while explicit FR/AC and dependency edges remain authoritative for planning and verification.

RAG can be added later as an optional discovery tool. It should not decide completion, mutate scope, or replace explicit source refs and graph edges.

Example commands:

```powershell
swarm sources inspect billing.md
swarm search specs overdue --domain Billing
swarm graph --format json
```

## Next Hardening

Completed from the first hardening pass:

- domain summaries are visible in the web viewer
- registered specs are visible and searchable in the web viewer
- selected specs can be inspected by summary, indexed sections, and rendered Markdown
- section/ref graph nodes are exposed through `graph --format json` and `/api/graph`

Likely next steps:

- make section/ref graph nodes visually explorable in the web viewer
- add status sink updates scoped by domain
- allow planner rolling plans to reference domains explicitly
- support Linear-backed domain sources through the same source adapter contract
- detect stale source hashes and require source re-registration before new slices are served
