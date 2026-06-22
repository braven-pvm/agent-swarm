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

async function postJson(port, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type") };
}

async function waitForText(url, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      if (response.ok && pattern.test(text)) return { response, text };
      lastError = new Error(`Unexpected response ${response.status}: ${text.slice(0, 120)}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
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
  const targetPath = path.join(workspace, "invoice-api");
  fs.mkdirSync(path.join(targetPath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(targetPath, "package.json"),
    `${JSON.stringify({ type: "module", scripts: { start: "node src/server.js" } }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(targetPath, "src", "server.js"),
    `import http from "node:http";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 0);
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("invoice dev server");
}).listen(port, host, () => {
  console.log("invoice dev server listening");
});
`,
    "utf8",
  );

  // Create the spec file so readSourceText() can read it when /api/source is hit
  const specsDir = path.join(targetPath, "specs");
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
  const humanRef = "AC-INV-001.1";
  store.insertSlice({
    id: sliceId,
    laneId,
    targetId,
    title: "Invoice CRUD",
    status: "blocked",
    sourceRefs: [{ sourceId, frAcRef: humanRef }],
    frAcRefs: [humanRef],
    deliveryQuestion: "Can the API handle invoices?",
    workPackageType: "component_pack",
    minimumMeaningfulOutcome: "changes_runtime_path",
    scope: ["src/invoices.js"],
    outOfScope: [],
    expectedEvidence: ["tests pass"],
    verificationObligations: [{
      ref: humanRef,
      sourceRef: humanRef,
      sourceUri: specUri,
      sourceTitle: "Invoice API Spec",
      sourceText: "AC-INV-001.1 Do the invoice thing.",
      mode: "human_verification_required",
      responsibleParty: "human-qa",
      criteria: [{
        id: "AC-INV-001.1.criterion-1",
        expectedOutcome: "Human confirms the invoice behavior is acceptable.",
        evidenceRequired: ["Human review packet"],
        acceptanceThreshold: "Human marks the ref verified.",
      }],
      createdBy: "test-planner",
      createdAt: new Date().toISOString(),
      immutable: true,
      guidance: ["Use the human packet before signing off."],
    }],
    unblockTargets: [],
    verificationRequirements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.insertLease({
    id: "LEASE-web-e2e-01",
    frAcRef: humanRef,
    sliceId,
    laneId,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const artifactsRoot = path.join(workspace, ".swarm", "artifacts", sliceId);
  fs.mkdirSync(artifactsRoot, { recursive: true });
  const packetId = "HVP-web-e2e";
  const packetEvidenceId = "EVID-web-e2e-packet";
  const packetMarkdownPath = path.join(artifactsRoot, "human-verification-AC-INV-001.1-HVP-web-e2e.md");
  const packetJsonPath = path.join(artifactsRoot, "human-verification-AC-INV-001.1-HVP-web-e2e.json");
  fs.writeFileSync(packetMarkdownPath, `# Human Verification Packet: ${humanRef}\n`, "utf8");
  fs.writeFileSync(packetJsonPath, `${JSON.stringify({ packetId, ref: humanRef }, null, 2)}\n`, "utf8");
  store.insertEvidence({
    id: packetEvidenceId,
    sliceId,
    kind: "artifact",
    ref: humanRef,
    summary: `Human verification packet ready for ${humanRef}`,
    payload: {
      type: "human_verification_packet",
      packetId,
      ref: humanRef,
      status: "awaiting_human_verification",
      markdownPath: packetMarkdownPath,
      jsonPath: packetJsonPath,
      generatedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  });
  store.insertEvidence({
    id: "EVID-web-e2e-command",
    sliceId,
    kind: "command",
    ref: humanRef,
    summary: `Verification awaits human sign-off for ${humanRef}`,
    payload: {
      command: "verify",
      passed: false,
      humanVerificationRefs: [humanRef],
      frAcResults: [{
        ref: humanRef,
        status: "awaiting_human_verification",
        evidenceIds: [packetEvidenceId],
        proof: "Automated support evidence passed; human sign-off remains.",
        verifiedBy: "web-e2e-verifier",
      }],
    },
    createdAt: new Date().toISOString(),
  });
  store.insertEscalation({
    id: "ESC-web-e2e-human",
    level: "human_required",
    status: "active",
    entityType: "harness",
    entityId: "scenario:web-e2e",
    message: "Need human decision before continuing the scenario.",
    createdBy: "test-overseer",
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

  return { workspace, historyRoot, sliceId, sourceId, focusRunId, humanRef, escalationId: "ESC-web-e2e-human" };
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------
test("web-server serves SPA, read APIs, SSE, and local human-action writes", async (t) => {
  const { workspace, historyRoot, sliceId, sourceId, focusRunId, humanRef, escalationId } = await seedWorkspace();
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

    // FR-PI-003: the JSON focus packet surface exposes the additive intervention field.
    const interventionActions = [
      "observe",
      "coach_same_session",
      "reask_structured_result",
      "accept_valid_artifact",
      "revive_same_session",
      "restart_fresh",
      "dispatch_targeted_repair",
      "escalate_human",
    ];
    assert.ok(runFocus.intervention, "run focus packet should expose intervention");
    assert.ok(typeof runFocus.intervention.classification === "string", "intervention.classification present");
    assert.ok(["low", "medium", "high"].includes(runFocus.intervention.confidence), "intervention.confidence is enum");
    assert.ok(interventionActions.includes(runFocus.intervention.recommendedAction), "intervention.recommendedAction is enum");
    assert.ok(Array.isArray(runFocus.intervention.evidence), "intervention.evidence is an array");
    assert.ok(typeof runFocus.intervention.risk === "string", "intervention.risk present");
    assert.ok(runFocus.intervention.evidence.includes(focusRunId), "intervention.evidence references the run id");
    assert.ok(sliceFocus.intervention, "slice focus packet should expose intervention");
    assert.ok(typeof sliceFocus.intervention.classification === "string", "slice intervention.classification present");

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

    // --- /api/settings: read-only protocol config the Command Bridge surfaces (defaults here) ---
    const settingsRes = await get(port, "/api/settings");
    assert.equal(settingsRes.status, 200, "/api/settings should be 200");
    assert.match(settingsRes.type, /application\/json/, "/api/settings should be JSON");
    const settings = JSON.parse(settingsRes.body);
    assert.equal(typeof settings.resultJournal, "boolean", "/api/settings resultJournal should be a boolean");
    assert.equal(typeof settings.maxActiveLanes, "number", "/api/settings maxActiveLanes should be a number");
    // The seeded workspace has no protocol.yaml override, so it returns the safe defaults.
    assert.equal(settings.resultJournal, false, "result journal defaults OFF without an opt-in");
    assert.equal(settings.maxActiveLanes, 3, "lane budget defaults to 3 without an override");

    const humanActionsRes = await get(port, "/api/human-actions");
    assert.equal(humanActionsRes.status, 200, "/api/human-actions should be 200");
    const humanActions = JSON.parse(humanActionsRes.body);
    assert.ok(Array.isArray(humanActions.actions), "/api/human-actions should expose actions");
    assert.ok(
      humanActions.actions.some((action) => action.kind === "decision_required" && action.id === `escalation:${escalationId}`),
      "human actions should include active human-required escalations",
    );
    const humanVerificationAction = humanActions.actions.find((action) => action.kind === "human_verification" && action.ref === humanRef);
    assert.ok(humanVerificationAction, "human actions should include awaiting human verification refs");
    assert.ok(
      humanVerificationAction.links.some((link) => link.label === "human packet" && link.href.startsWith("/api/artifacts/")),
      "human verification action should link to the packet artifact",
    );
    assert.ok(
      humanVerificationAction.allowedActions.some((action) => action.kind === "record_human_verification"),
      "human verification action should expose the POST action template",
    );
    assert.equal(humanVerificationAction.reviewTarget.targetName, "invoice-api");
    assert.equal(humanVerificationAction.reviewTarget.startCommand, "npm run start");
    assert.equal(humanVerificationAction.reviewTarget.commandName, "start");
    assert.equal(humanVerificationAction.reviewTarget.commandSource, "package.json.scripts.start");
    assert.equal(humanVerificationAction.reviewTarget.startAvailable, true);
    assert.equal(humanVerificationAction.reviewTarget.requirementRef, humanRef);
    assert.match(humanVerificationAction.reviewTarget.requirementText, /Do the invoice thing/);
    assert.deepEqual(humanVerificationAction.reviewTarget.expectedOutcomes, [
      "Human confirms the invoice behavior is acceptable.",
    ]);
    assert.match(humanVerificationAction.reviewTarget.packetHref, /^\/api\/artifacts\//);
    assert.equal(humanVerificationAction.reviewTarget.focusHref, `/api/focus/slice/${encodeURIComponent(sliceId)}`);
    assert.deepEqual(humanVerificationAction.reviewTarget.startAction, {
      method: "POST",
      path: "/api/control/dev-server/start",
      bodyTemplate: { targetName: "invoice-api", commandName: "start" },
    });
    assert.ok(
      humanVerificationAction.reviewTarget.instructions.some((instruction) => /open the URL only after the server reports running/i.test(instruction)),
      "human verification action should tell the UI/human how to open the review target",
    );

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

    const clearEscalationRes = await postJson(port, `/api/escalations/${encodeURIComponent(escalationId)}/clear`, {
      actor: "human-ui",
      reason: "Decision recorded through the UI.",
    });
    assert.equal(clearEscalationRes.status, 200, "POST /api/escalations/:id/clear should be 200");
    const clearEscalation = JSON.parse(clearEscalationRes.body);
    assert.equal(clearEscalation.ok, true, "clear escalation response should be ok");
    assert.equal(clearEscalation.escalation.status, "cleared", "clear escalation should return the cleared escalation");
    assert.ok(
      clearEscalation.humanActions.actions.every((action) => action.id !== `escalation:${escalationId}`),
      "cleared escalation should leave the returned human-action queue",
    );

    const storageForHumanEscalation = await import("../dist/storage.js");
    const humanEscalationStore = new storageForHumanEscalation.SwarmStore(workspace);
    const scopedHumanEscalationId = "ESC-web-e2e-human-verification";
    try {
      const now = new Date().toISOString();
      humanEscalationStore.insertEscalation({
        id: scopedHumanEscalationId,
        level: "human_required",
        status: "active",
        entityType: "slice",
        entityId: sliceId,
        message: `Human verification is awaiting a decision for ${humanRef}.`,
        createdBy: "test-verifier",
        createdAt: now,
        updatedAt: now,
      });
    } finally {
      humanEscalationStore.close();
    }

    const humanReworkRes = await postJson(port, "/api/human-verify", {
      sliceId,
      ref: humanRef,
      status: "needs_rework",
      actor: "human-ui",
      notes: "Returned for product repair from the web UI.",
    });
    assert.equal(humanReworkRes.status, 200, "POST /api/human-verify needs_rework should be 200");
    const humanRework = JSON.parse(humanReworkRes.body);
    assert.equal(humanRework.ok, true, "human verification rework response should be ok");
    assert.equal(humanRework.result.accepted, false, "needs_rework should not accept the one-ref slice");
    assert.equal(humanRework.result.finalSliceStatus, "repairing", "needs_rework should move the slice to repair");
    assert.ok(
      humanRework.result.clearedEscalationIds.includes(scopedHumanEscalationId),
      "recording a human result should clear scoped human_required verification escalations",
    );
    assert.ok(
      humanRework.humanActions.actions.every((action) => action.ref !== humanRef),
      "needs_rework should leave the human action queue immediately; repair is tracked internally by evidence and slice state",
    );
    assert.ok(
      humanRework.humanActions.actions.every((action) => action.id !== `escalation:${scopedHumanEscalationId}`),
      "cleared human_required verification escalation should leave the returned human-action queue",
    );
    assert.equal(humanRework.humanActions.totals.humanVerification, 0, "needs_rework should not keep a human verification prompt open");

    const humanVerifyRes = await postJson(port, "/api/human-verify", {
      sliceId,
      ref: humanRef,
      status: "human_verified",
      actor: "human-ui",
      notes: "Accepted from the web UI.",
    });
    assert.equal(humanVerifyRes.status, 200, "POST /api/human-verify should be 200");
    const humanVerify = JSON.parse(humanVerifyRes.body);
    assert.equal(humanVerify.ok, true, "human verification response should be ok");
    assert.equal(humanVerify.result.accepted, true, "human verification should accept the one-ref slice");
    assert.equal(humanVerify.result.finalSliceStatus, "accepted", "human verification should update final slice status");
    assert.ok(
      humanVerify.humanActions.actions.every((action) => action.ref !== humanRef),
      "accepted human verification should leave the returned human-action queue",
    );

    const coverageAfterHumanVerify = JSON.parse((await get(port, "/api/coverage")).body);
    const verifiedRef = coverageAfterHumanVerify.refs.find((row) => row.ref === humanRef);
    assert.equal(verifiedRef.ledgerStatus, "accepted", "human-verified ref should be accepted in coverage");
    assert.equal(verifiedRef.verification, "human_verified", "coverage should preserve the human verification status");

    const scanRes = await postJson(port, "/api/control/recovery/scan", { staleAfter: 1 });
    assert.equal(scanRes.status, 200, "POST /api/control/recovery/scan should be 200");
    const scan = JSON.parse(scanRes.body);
    assert.equal(scan.ok, true, "recovery scan should complete");
    assert.match(scan.result.stdout, /Stale agent runs:/, "recovery scan should return command stdout");

    const commandsRes = await get(port, "/api/control/commands");
    assert.equal(commandsRes.status, 200, "GET /api/control/commands should be 200");
    const commands = JSON.parse(commandsRes.body);
    assert.ok(commands.commands.some((command) => command.kind === "recovery-scan"), "control commands should include scan");

    const devServerRes = await postJson(port, "/api/control/dev-server/start", { targetName: "invoice-api" });
    assert.equal(devServerRes.status, 200, `POST /api/control/dev-server/start should be 200: ${devServerRes.body}`);
    const devServer = JSON.parse(devServerRes.body);
    assert.equal(devServer.ok, true, "dev server start should return ok");
    assert.equal(devServer.server.openable, true, "dev server should be openable after readiness passes");
    assert.equal(devServer.server.readiness.status, "passed", "dev server readiness should pass");
    assert.equal(devServer.server.displayCommand, "npm run start", "dev server should expose the configured command");
    assert.match(devServer.server.url, /^http:\/\/127\.0\.0\.1:\d+\//, "dev server should return a local URL");
    try {
      const devServerPage = await waitForText(devServer.server.url, /invoice dev server/);
      assert.equal(devServerPage.response.status, 200, "started dev server should respond");

      const devServersRes = await get(port, "/api/control/dev-servers");
      assert.equal(devServersRes.status, 200, "GET /api/control/dev-servers should be 200");
      const devServers = JSON.parse(devServersRes.body);
      assert.ok(devServers.servers.some((server) => server.id === devServer.server.id), "dev server list should include started server");
    } finally {
      const stopDevServerRes = await postJson(port, `/api/control/dev-server/${encodeURIComponent(devServer.server.id)}/stop`, {});
      assert.equal(stopDevServerRes.status, 200, "POST /api/control/dev-server/:id/stop should be 200");
      const stoppedDevServer = JSON.parse(stopDevServerRes.body);
      assert.equal(stoppedDevServer.ok, true, "stop dev server should return ok");
      assert.equal(stoppedDevServer.server.status, "stopped", "dev server should be stopped");
    }

    const noStartPath = path.join(workspace, "invoice-static");
    fs.mkdirSync(noStartPath, { recursive: true });
    const storageModule = await import("../dist/storage.js");
    const noStartStore = new storageModule.SwarmStore(workspace);
    noStartStore.addOrUpdateTarget({
      id: "TARGET-no-start",
      path: noStartPath,
      name: "invoice-static",
      config: {},
      now: new Date().toISOString(),
    });
    noStartStore.close();
    const unavailableDevServerRes = await postJson(port, "/api/control/dev-server/start", { targetName: "invoice-static" });
    assert.equal(unavailableDevServerRes.status, 400, "target without review command should fail before allocating a URL");
    const unavailableDevServer = JSON.parse(unavailableDevServerRes.body);
    assert.equal(unavailableDevServer.ok, false, "unavailable dev server response should not be ok");
    assert.equal(unavailableDevServer.reviewEnvironment.commandAvailable, false, "unavailable response should expose command availability");
    assert.match(unavailableDevServer.error, /does not define a runnable review command/i);

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

test("run observability follows manifest-linked scenario summary and readiness artifacts", async () => {
  const { workspace, historyRoot } = await seedWorkspace();
  const artifactsRoot = path.join(workspace, "support-triage-live-artifacts");
  fs.mkdirSync(artifactsRoot, { recursive: true });

  const summaryPath = path.join(workspace, "support-triage-live-summary.json");
  const readinessPath = path.join(artifactsRoot, "product-readiness.json");
  const manualUrl = "http://127.0.0.1:49999";
  const readiness = {
    mode: "full-product",
    productName: "Customer Support Triage Board",
    passed: true,
    acceptedProductSlices: [
      { id: "SLICE-prod", refs: ["FR-PROD-001"] },
      { id: "SLICE-prod-ac", refs: ["AC-PROD-001.1"] },
    ],
    commands: { manualUrl },
    checks: [
      { id: "product-start-probed", label: "Support product local URL is probed", passed: true },
    ],
    blockers: [],
    commandResults: {
      start: {
        probes: {
          ui: { passed: true },
          api: { passed: true },
          workflow: { passed: true, noteRecorded: true, deltaOk: true },
        },
      },
    },
  };
  const summary = {
    runId: "H2-web-observability",
    scenario: "live-agent-smoke-h2",
    workspace,
    phase: "phase-h2-web-observability",
    finalOutcome: "blocked",
    finalReason: "Max turns reached without complete product acceptance: 12.",
    counts: { turns: 12, acceptedSlices: 3, activeEscalations: 4 },
    productReadiness: { passed: true, blockers: [], manualUrl },
    artifacts: {
      summary: summaryPath,
      productReadiness: readinessPath,
    },
  };
  fs.writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(workspace, "live-agent-smoke.json"),
    `${JSON.stringify({
      scenarioId: "live-agent-smoke-h2",
      liveRun: {
        summaryPath,
        artifactsPath: artifactsRoot,
        finalOutcome: "blocked",
        finalReason: summary.finalReason,
        productReadiness: { passed: true, blockers: [], manualUrl },
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const webDistPath = fixtureWebDist();
  const server = createWebViewerServer({ workspace, defaultEventCount: 20, historyRoot, webDistPath });
  const port = await listen(server);
  try {
    const res = await get(port, "/api/run-observability");
    assert.equal(res.status, 200, "/api/run-observability should be 200");
    const body = JSON.parse(res.body);
    assert.equal(body.scenario, "live-agent-smoke-h2", "scenario should come from the manifest-linked summary");
    assert.equal(body.outcome.finalOutcome, "blocked", "outcome should come from the manifest-linked summary");
    assert.equal(body.outcome.classification.code, "blocked", "missing classification should fall back to final outcome");
    assert.equal(body.outcome.classification.severity, "warning", "blocked final outcome should classify as warning");
    assert.equal(body.productReadiness.available, true, "readiness artifact should be available");
    assert.equal(body.productReadiness.passed, true, "readiness should come from detailed readiness artifact");
    assert.equal(body.productReadiness.productName, "Customer Support Triage Board");
    assert.equal(body.productReadiness.manualUrl, manualUrl);
    assert.deepEqual(
      body.productReadiness.acceptedRefs,
      ["FR-PROD-001", "AC-PROD-001.1"],
      "support readiness should expose acceptedProductSlices refs",
    );
    assert.deepEqual(
      body.productReadiness.probes,
      { ui: true, api: true, markPaid: true, workflow: true },
      "generic workflow probe should be visible and also satisfy legacy markPaid readiness",
    );
  } finally {
    server.close();
  }
});

test("/api/settings reflects the target's protocol.yaml opt-ins (resultJournal + lane budget)", async () => {
  // Force the env disable OFF so the protocol opt-in is the only signal under test (an explicit
  // SWARM_RESULT_JOURNAL=off would otherwise win over the protocol opt-in by design).
  const priorEnv = process.env.SWARM_RESULT_JOURNAL;
  delete process.env.SWARM_RESULT_JOURNAL;
  const { workspace, historyRoot } = await seedWorkspace();

  // Write a protocol.yaml under the first target's path that opts INTO the result journal and
  // raises the lane budget. loadProtocol reads <targetPath>/.swarm/protocol.yaml.
  const targetPath = path.join(workspace, "invoice-api");
  const protocolDir = path.join(targetPath, ".swarm");
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, "protocol.yaml"),
    [
      "protocol:",
      "  workers:",
      "    resultJournal: true",
      "  lanes:",
      "    maxActiveLanes: 5",
      "",
    ].join("\n"),
    "utf8",
  );

  const webDistPath = fixtureWebDist();
  const server = createWebViewerServer({ workspace, defaultEventCount: 20, historyRoot, webDistPath });
  const port = await listen(server);
  try {
    const res = await get(port, "/api/settings");
    assert.equal(res.status, 200, "/api/settings should be 200");
    const settings = JSON.parse(res.body);
    assert.equal(settings.resultJournal, true, "protocol.yaml resultJournal: true should surface as enabled");
    assert.equal(settings.maxActiveLanes, 5, "protocol.yaml maxActiveLanes override should surface");
  } finally {
    server.close();
    if (priorEnv === undefined) delete process.env.SWARM_RESULT_JOURNAL;
    else process.env.SWARM_RESULT_JOURNAL = priorEnv;
  }
});
