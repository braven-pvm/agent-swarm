# Source Index Demo

Date: 2026-06-09

This demo checks whether the lightweight source index is actually useful for large-spec coordination.

Run:

```powershell
npm run demo:source-index
```

The demo creates two fake domain specs, registers them, and exercises:

- `sources list`
- `sources inspect`
- `search specs`
- `domains list`
- `domains inspect`
- `slices pull --domain ... --tag ...`
- `observe`
- `graph --format json`
- the same source/domain data through the web viewer when served with `swarm serve`

It writes:

- summary: `.swarm-demo/source-index/source-index-summary.json`
- artifacts: `.swarm-demo/source-index/source-index-artifacts/`

The summary contains usefulness assertions. These check that:

- source lists show domain metadata
- source inspect maps FR/AC refs to sections
- search finds the relevant section
- tag filtering excludes unrelated domains
- domain status changes after a slice is pulled
- unrelated domains remain untouched
- the graph connects domain, source, section, FR/AC, and slice

This is intentionally text-search and graph-first. It does not use embeddings or a RAG service; those can be added later as optional discovery tools once the explicit source/ref/slice graph is stable.

To inspect the result in the web viewer:

```powershell
npm run build
node dist\cli.js serve --workspace .swarm-demo\source-index --host 127.0.0.1 --port 4318
```

Then open `http://127.0.0.1:4318/` and use:

- Overview tab for domain readiness
- Specs tab for source search, registered specs, and selected spec details
- Summary, Sections, and Markdown detail views for the selected spec

Use `--port 0` if the fixed port is busy.
