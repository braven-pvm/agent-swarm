import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createWebViewerServer } from "../dist/web-server.js";

// ---------------------------------------------------------------------------
// Fixture web/dist — a minimal SPA stub so we don't need a real Vite build.
// ---------------------------------------------------------------------------
function fixtureWebDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="app"></div>', "utf8");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('cb')", "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function get(port, p) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type") };
}

// ---------------------------------------------------------------------------
// Workspace seeding — builds a workspace with a target, a source, a lane,
// and a slice so the API endpoints have real data to return.
// Returns { workspace, historyRoot, sliceId, sourceId }.
// ---------------------------------------------------------------------------
async function seedWorkspace() {
  const { SwarmStore } = await import("../dist/storage.js");
  const { createEvent } = await import("../dist/events.js");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-web-srv-"));
  const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-web-srv-hist-"));

  const store = new SwarmStore(workspace);
  store.init();

  // run-mode meta so /api/snapshot returns a known runMode
  store.setMeta("run_mode", "scripted-codex");

  const targetId = "TARGET-web-e2e";
  store.addOrUpdateTarget({
    id: targetId,
    path: path.join(workspace, "invoice-api"),
    name: "invoice-api",
    config: { verificationCommand: "npm test" },
    now: new Date().toISOString(),
  });

  // Create the spec file so readSourceText() can read it when /api/source is hit
  const specsDir = path.join(workspace, "invoice-api", "specs");
  fs.mkdirSync(specsDir, { recursive: true });
  const specUri = path.join(specsDir, "invoice-api.md");
  fs.writeFileSync(specUri, "# Invoice API Spec\n\nAC-INV-001.1 Do the invoice thing.\n", "utf8");

  const sourceId = "SOURCE-web-e2e-01";
  store.addOrUpdateSource({
    id: sourceId,
    adapterId: "file",
    kind: "spec",
    uri: specUri,
    title: "Invoice API Spec",
    hash: "abc123",
    metadata: {
      domain: "Invoices",
      tags: ["invoice"],
      priority: 1,
      sections: [{ heading: "Overview", text: "AC-INV-001.1", refs: ["AC-INV-001.1"] }],
      frAcRefs: ["AC-INV-001.1"],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const laneId = "LANE-web-e2e";
  store.insertLane({
    id: laneId,
    name: "main",
    purpose: "Implement invoices",
    focusLabels: ["invoice"],
    targetId,
    orchestrator: "test-orchestrator",
    worktree: workspace,
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const sliceId = "SLICE-web-e2e-01";
  store.insertSlice({
    id: sliceId,
    laneId,
    targetId,
    title: "Invoice CRUD",
    status: "implementing",
    sourceRefs: [{ sourceId, frAcRef: "AC-INV-001.1" }],
    frAcRefs: ["AC-INV-001.1"],
    deliveryQuestion: "Can the API handle invoices?",
    workPackageType: "component_pack",
    minimumMeaningfulOutcome: "changes_runtime_path",
    scope: ["src/invoices.js"],
    outOfScope: [],
    expectedEvidence: ["tests pass"],
    unblockTargets: [],
    verificationRequirements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Seed an agent run on the slice so the run-focus endpoint has data to return
  const focusRunId = "RUN-web-e2e-focus-01";
  store.insertAgentRun({
    id: focusRunId,
    sliceId,
    role: "worker",
    entityType: "slice",
    entityId: sliceId,
    actor: "backend-worker",
    driver: "codex",
    status: "running",
    sessionId: "session-web-e2e",
    attempt: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Seed one event so recentEvents is non-empty
  store.addEvent(
    createEvent({ actor: "seeder", type: "harness.init", entityType: "harness", entityId: "h" }),
  );

  store.close();

  // Build a minimal history fixture so /api/history/runs returns data
  const runId = "RUN-web-e2e-01";
  const runDir = path.join(historyRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const summaryPath = path.join(runDir, "summary.json");
  const artifactIndexPath = path.join(runDir, "artifact-index.json");
  const artifactIndexMarkdownPath = path.join(runDir, "artifact-index.md");
  const summary = {
    runId,
    workspace,
    driver: "codex",
    runMode: "scripted-codex",
    startedAt: generatedAt,
    generatedAt,
    phase: "phase-5c",
    scenario: "web-e2e",
    fault: { mode: "none", injected: [] },
    finalOutcome: "accepted",
    finalReason: "E2E fixture accepted.",
    outcomeClassification: { code: "accepted", severity: "accepted", explanation: "fixture" },
    counts: {
      graphNodes: 1, graphEdges: 0, timelineItems: 1,
      turns: 1, verifyRuns: 1, lanes: 1, slices: 1,
      agentRuns: 1, evidence: 1, activeEscalations: 0,
    },
    productReadiness: {
      mode: "full-product",
      productName: "Invoice Operations Dashboard",
      passed: true,
      commands: { manualUrl: "http://127.0.0.1:4321" },
      dashboardDependencies: {
        satisfied: true,
        dependsOn: ["AC-INV-001.1"],
        acceptedRefs: ["AC-INV-001.1"],
        missingRefs: [],
      },
      checks: [{ id: "dashboard-start-probed", label: "Dashboard local URL is probed", passed: true }],
      blockers: [],
      commandResults: {
        start: {
          probes: {
            ui: { passed: true },
            api: { passed: true },
            markPaid: { passed: true },
          },
        },
      },
      productReadinessSlices: {
        ids: [{ id: sliceId, status: "accepted", refs: ["AC-PROD-001.1"] }],
      },
    },
    artifacts: {
      summary: summaryPath,
      productReadiness: path.join(workspace, "live-agent-run-artifacts", "product-readiness.json"),
    },
  };
  const artifactIndex = {
    generatedAt,
    workspace,
    runMode: summary.runMode,
    phase: summary.phase,
    scenario: summary.scenario,
    fault: summary.fault,
    finalOutcome: summary.finalOutcome,
    finalReason: summary.finalReason,
    classification: summary.outcomeClassification,
    counts: { items: 1, missingExpected: 0, byCategory: { run: 1 } },
    quickOpen: { summary: summaryPath },
    items: [{
      key: "summary",
      category: "run",
      path: summaryPath,
      exists: true,
      expected: true,
      description: "summary artifact",
    }],
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(workspace, "live-agent-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(artifactIndexPath, `${JSON.stringify(artifactIndex, null, 2)}\n`, "utf8");
  fs.writeFileSync(artifactIndexMarkdownPath, `# ${runId}\n`, "utf8");
  fs.writeFileSync(
    path.join(historyRoot, "runs.json"),
    `${JSON.stringify({
      version: 1,
      root: historyRoot,
      generatedAt,
      updatedAt: generatedAt,
      runs: [{
        runId,
        scenario: summary.scenario,
        runMode: summary.runMode,
        phase: summary.phase,
        driver: summary.driver,
        faultMode: "none",
        startedAt: generatedAt,
        generatedAt,
        finalOutcome: summary.finalOutcome,
        finalReason: summary.finalReason,
        classificationCode: "accepted",
        classificationSeverity: "accepted",
        counts: summary.counts,
        summary: summaryPath,
        artifactIndex: artifactIndexPath,
        artifactIndexMarkdown: artifactIndexMarkdownPath,
      }],
    }, null, 2)}\n`,
    "utf8",
  );

  return { workspace, historyRoot, sliceId, sourceId, focusRunId };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
test("web-server serves SPA, read APIs, SSE, and rejects writes", async (t) => {
  const { workspace, historyRoot, sliceId, sourceId, focusRunId } = await seedWorkspace();
  const webDistPath = fixtureWebDist();
  const server = createWebViewerServer({ workspace, defaultEventCount: 20, historyRoot, webDistPath });
  const port = await listen(server);

  try {
    // --- Static serving ---
    const index = await get(port, "/");
    assert.equal(index.status, 200, `GET / should be 200, got ${index.status}`);
    assert.match(index.body, /id="app"/, 'index.html should contain id="app"');
    assert.match(index.type, /text\/html/, "index.html should have text/html content-type");

    const appjs = await get(port, "/assets/app.js");
    assert.equal(appjs.status, 200, "GET /assets/app.js should be 200");
    assert.match(appjs.type, /javascript/, "app.js should have javascript content-type");

    // --- Snapshot shape ---
    const snap = await get(port, "/api/snapshot?events=5");
    assert.equal(snap.status, 200, "/api/snapshot should be 200");
    const snapshot = JSON.parse(snap.body);
    for (const key of [
      "workspace", "runMode", "targets", "sources", "slices",
      "agentRuns", "heartbeats", "activeEscalations", "checkpoints", "recentEvents",
    ]) {
      assert.ok(key in snapshot, `snapshot missing key: ${key}`);
    }
    assert.equal(snapshot.runMode, "scripted-codex", "runMode should match seeded value");
    assert.ok(Array.isArray(snapshot.focusQueue), "snapshot should include a focusQueue array");
    assert.ok(snapshot.runObservability, "snapshot should include runObservability");
    assert.equal(
      snapshot.runObservability.outcomeVsCoverage.state,
      "accepted_partial",
      "snapshot should distinguish accepted run outcome from partial coverage",
    );

    // --- Focus endpoints ---
    const sliceFocusRes = await get(port, `/api/focus/slice/${encodeURIComponent(sliceId)}`);
    assert.equal(sliceFocusRes.status, 200, `/api/focus/slice/${sliceId} should be 200`);
    const sliceFocus = JSON.parse(sliceFocusRes.body);
    assert.equal(sliceFocus.kind, "slice_focus", "slice focus packet should have kind slice_focus");
    assert.ok(sliceFocus.slice && sliceFocus.slice.id === sliceId, "slice focus packet should describe the seeded slice");

    const runFocusRes = await get(port, `/api/focus/run/${encodeURIComponent(focusRunId)}`);
    assert.equal(runFocusRes.status, 200, `/api/focus/run/${focusRunId} should be 200`);
    const runFocus = JSON.parse(runFocusRes.body);
    assert.equal(runFocus.kind, "run_focus", "run focus packet should have kind run_focus");
    assert.equal(runFocus.run.id, focusRunId, "run focus packet should describe the seeded run");

    const runFocusMissing = await get(port, "/api/focus/run/RUN-does-not-exist");
    assert.equal(runFocusMissing.status, 404, "/api/focus/run/<unknown> should be 404");

    const sliceFocusMissing = await get(port, "/api/focus/slice/SLICE-does-not-exist");
    assert.equal(sliceFocusMissing.status, 404, "/api/focus/slice/<unknown> should be 404");

    // --- Other read endpoints ---
    const reportRes = await get(port, `/api/report/${encodeURIComponent(sliceId)}`);
    assert.equal(reportRes.status, 200, `/api/report/${sliceId} should be 200`);

    const graphRes = await get(port, "/api/graph");
    assert.equal(graphRes.status, 200, "/api/graph should be 200");

    const coverageRes = await get(port, "/api/coverage");
    assert.equal(coverageRes.status, 200, "/api/coverage should be 200");
    const coverage = JSON.parse(coverageRes.body);
    assert.ok(coverage.totals && typeof coverage.totals.total === "number", "/api/coverage should have totals.total");
    assert.equal(coverage.interpretation.state, "partial", "/api/coverage should include partial interpretation");
    assert.ok(Array.isArray(coverage.byDomain), "/api/coverage should have byDomain array");
    assert.ok(Array.isArray(coverage.refs), "/api/coverage should have refs array");

    const runObservabilityRes = await get(port, "/api/run-observability");
    assert.equal(runObservabilityRes.status, 200, "/api/run-observability should be 200");
    const runObservability = JSON.parse(runObservabilityRes.body);
    assert.equal(runObservability.outcome.finalOutcome, "accepted", "run observability should expose final outcome");
    assert.equal(
      runObservability.outcomeVsCoverage.state,
      "accepted_partial",
      "run observability should call out accepted run with partial coverage",
    );
    assert.ok(
      runObservability.warnings.some((warning) => /coverage is partial/i.test(warning)),
      "run observability should include a partial-coverage warning",
    );
    assert.equal(runObservability.productReadiness.passed, true, "run observability should include product readiness");
    assert.deepEqual(
      runObservability.productReadiness.acceptedRefs,
      ["AC-PROD-001.1"],
      "run observability should expose product readiness accepted refs",
    );

    const sourceRes = await get(port, `/api/source/${encodeURIComponent(sourceId)}`);
    assert.equal(sourceRes.status, 200, `/api/source/${sourceId} should be 200`);

    const searchRes = await get(port, "/api/search/specs?q=invoice");
    assert.equal(searchRes.status, 200, "/api/search/specs should be 200");

    const historyRes = await get(port, "/api/history/runs");
    assert.equal(historyRes.status, 200, "/api/history/runs should be 200");
    const historyBody = JSON.parse(historyRes.body);
    assert.ok(Array.isArray(historyBody.runs), "/api/history/runs should have .runs array");

    // --- /api/agent-events: seeded actor returns events; unknown actor returns empty ---
    const agentEventsRes = await get(port, "/api/agent-events?actor=seeder");
    assert.equal(agentEventsRes.status, 200, "/api/agent-events should be 200");
    const agentEventsBody = JSON.parse(agentEventsRes.body);
    assert.equal(agentEventsBody.actor, "seeder", "/api/agent-events should echo actor");
    assert.ok(Array.isArray(agentEventsBody.events), "/api/agent-events should have events array");
    assert.ok(agentEventsBody.events.length >= 1, "/api/agent-events should have at least one event for seeded actor");
    assert.ok("id" in agentEventsBody.events[0] && "type" in agentEventsBody.events[0], "event should have id and type");

    const agentEventsNoneRes = await get(port, "/api/agent-events?actor=nonexistent-xyz");
    assert.equal(agentEventsNoneRes.status, 200, "/api/agent-events with unknown actor should be 200");
    const agentEventsNoneBody = JSON.parse(agentEventsNoneRes.body);
    assert.equal(agentEventsNoneBody.actor, "nonexistent-xyz", "unknown actor should be echoed");
    assert.deepEqual(agentEventsNoneBody.events, [], "unknown actor should return empty events");

    const agentEventsNoActorRes = await get(port, "/api/agent-events");
    assert.equal(agentEventsNoActorRes.status, 200, "/api/agent-events without actor param should be 200");
    const agentEventsNoActorBody = JSON.parse(agentEventsNoActorRes.body);
    assert.equal(agentEventsNoActorBody.actor, "", "missing actor should be empty string");
    assert.deepEqual(agentEventsNoActorBody.events, [], "missing actor should return empty events");

    // --- SSE: subscribe, then insert an event (de-raced); tailer should push event.appended ---
    const { SwarmStore } = await import("../dist/storage.js");
    const { createEvent } = await import("../dist/events.js");
    const sseChunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no SSE frame within 8s")), 8000);
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
        assert.match(
          res.headers["content-type"],
          /text\/event-stream/,
          "SSE should have text/event-stream content-type",
        );
        res.setEncoding("utf8");
        res.on("data", (c) => {
          sseChunks.push(c);
          const text = sseChunks.join("");
          if (text.includes("event: event.appended") && text.includes("probe.ping")) {
            clearTimeout(timer);
            req.destroy();
            resolve();
          }
        });
        // Let the tailer establish its cursor (one poll cycle ~400ms), then insert the event
        setTimeout(() => {
          const s = new SwarmStore(workspace);
          s.addEvent(createEvent({ actor: "test", type: "probe.ping", entityType: "harness", entityId: "h" }));
          s.close();
        }, 600);
      });
      req.on("error", () => {}); // req.destroy() emits an error after resolve; ignore it
    });
    assert.match(sseChunks.join(""), /event: event\.appended/, "SSE stream should emit event.appended frame");

    // --- Missing dist: GET / should return 503 with build instruction ---
    const server2 = createWebViewerServer({
      workspace,
      defaultEventCount: 20,
      historyRoot,
      webDistPath: path.join(os.tmpdir(), "does-not-exist-swarm-web-xyz"),
    });
    const port2 = await listen(server2);
    try {
      const missing = await get(port2, "/");
      assert.equal(missing.status, 503, "missing dist should return 503");
      assert.match(missing.body, /npm run build:web/, "503 body should mention build command");
    } finally {
      server2.close();
    }

    // --- POST rejected ---
    const post = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: "POST" });
    assert.equal(post.status, 405, "POST to /api/snapshot should return 405");
  } finally {
    server.close();
  }
});
