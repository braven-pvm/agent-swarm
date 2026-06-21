import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";

// ---------------------------------------------------------------------------
// Focused, one-test-per-FR coverage for the two slices:
//   Slice A — Ledger-derived settled facts: FR-CP-001 / FR-CP-002 / FR-CP-003
//   Slice B — Peek-in / intervention packet:  FR-PI-001 / FR-PI-002 / FR-PI-003
//
// Mirrors the existing seeding patterns in settled-facts.e2e.test.js,
// focus-packet.e2e.test.js, streaming-worker.e2e.test.js and web-server.e2e.test.js.
// Each test is self-contained so any single FR can be verified in isolation.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

const SETTLED_ACTIONS = [
  "observe",
  "coach_same_session",
  "reask_structured_result",
  "accept_valid_artifact",
  "revive_same_session",
  "restart_fresh",
  "dispatch_targeted_repair",
  "escalate_human",
];

function runSwarm(workspace, args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// Minimal target + init shared by all tests.
function baseWorkspace(prefix) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const target = path.join(workspace, "target");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify(
      { name: "invoice-api-fixture", version: "0.1.0", type: "module", scripts: { test: "node --test" } },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "src", "invoices.js"),
    `export function listInvoices() { return [{ id: "INV-1001" }]; }\nexport function getInvoiceSummary() { return { count: 1 }; }\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "test", "invoices.test.js"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { listInvoices } from "../src/invoices.js";\ntest("lists", () => assert.equal(listInvoices().length, 1));\n`,
    "utf8",
  );
  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  return { workspace, target };
}

// Seeds: one ACCEPTED SIBLING ref (durable accepted + passing evidence), one
// CURRENT IN-SCOPE ref that only carries a worker_result claim, one BLOCKED ref.
// Returns ids for the in-scope slice that the worker will run.
function seedLedger(workspace, target) {
  const store = new SwarmStore(workspace);
  const now = new Date().toISOString();
  const siblingSliceId = "SLICE-fr-sibling";
  const inScopeSliceId = "SLICE-fr-inscope";
  const blockedSliceId = "SLICE-fr-blocked";
  const blockedRef = "AC-INV-003.1";
  try {
    const targetId = store.listTargets()[0].id;
    const specsDir = path.join(target, "specs");
    fs.mkdirSync(specsDir, { recursive: true });
    const specUri = path.join(specsDir, "invoices.md");
    fs.writeFileSync(specUri, "# Invoice spec\n\nAC-INV-001.1, AC-INV-002.1, AC-INV-003.1.\n", "utf8");
    const sourceId = "SOURCE-fr-01";
    store.addOrUpdateSource({
      id: sourceId,
      adapterId: "file",
      kind: "spec",
      uri: specUri,
      title: "Invoice Spec",
      hash: "fr-hash",
      metadata: {
        domain: "Invoices",
        tags: ["inv"],
        priority: 1,
        frAcRefs: ["AC-INV-001.1", "AC-INV-002.1", "AC-INV-003.1"],
        sections: [
          {
            id: `${sourceId}#spec`,
            title: "Invoice Spec",
            level: 1,
            startLine: 1,
            endLine: 3,
            refs: ["AC-INV-001.1", "AC-INV-002.1", "AC-INV-003.1"],
            snippet: "AC-INV-001.1, AC-INV-002.1, AC-INV-003.1.",
          },
        ],
      },
      createdAt: now,
      updatedAt: now,
    });
    store.insertLane({
      id: "LANE-fr",
      name: "FR Lane",
      purpose: "Focused FR coverage",
      focusLabels: ["inv"],
      targetId,
      orchestrator: "fr-overseer",
      worktree: target,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });

    // ACCEPTED SIBLING (AC-INV-001.1)
    store.insertSlice({
      id: siblingSliceId,
      laneId: "LANE-fr",
      targetId,
      title: "Accepted sibling slice",
      status: "accepted",
      sourceRefs: [{ sourceId, frAcRef: "AC-INV-001.1" }],
      frAcRefs: ["AC-INV-001.1"],
      deliveryQuestion: "Are invoices listed?",
      workPackageType: "component_pack",
      minimumMeaningfulOutcome: "changes_runtime_path",
      scope: ["src/invoices.js"],
      outOfScope: [],
      expectedEvidence: ["tests pass"],
      unblockTargets: [],
      verificationRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-fr-sibling",
      frAcRef: "AC-INV-001.1",
      sliceId: siblingSliceId,
      laneId: "LANE-fr",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    const siblingEvidenceId = "EVID-fr-sibling";
    store.insertEvidence({
      id: siblingEvidenceId,
      sliceId: siblingSliceId,
      kind: "command",
      summary: "sibling verification run",
      payload: {
        passed: true,
        command: "npm test",
        frAcResults: [
          {
            ref: "AC-INV-001.1",
            status: "passed",
            evidenceIds: [siblingEvidenceId],
            proof: "AC-INV-001.1 verified by tests.",
            verifiedBy: "verifier",
          },
        ],
      },
      createdAt: now,
    });

    // CURRENT IN-SCOPE (AC-INV-002.1) — only a worker_result CLAIM.
    store.insertSlice({
      id: inScopeSliceId,
      laneId: "LANE-fr",
      targetId,
      title: "In-scope summary slice",
      status: "ready",
      sourceRefs: [{ sourceId, frAcRef: "AC-INV-002.1" }],
      frAcRefs: ["AC-INV-002.1"],
      deliveryQuestion: "Is the invoice summary computed?",
      workPackageType: "component_pack",
      minimumMeaningfulOutcome: "changes_runtime_path",
      scope: ["src/invoices.js"],
      outOfScope: [],
      expectedEvidence: ["tests pass"],
      unblockTargets: [],
      verificationRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-fr-inscope",
      frAcRef: "AC-INV-002.1",
      sliceId: inScopeSliceId,
      laneId: "LANE-fr",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertEvidence({
      id: "EVID-fr-inscope-claim",
      sliceId: inScopeSliceId,
      ref: "AC-INV-002.1",
      kind: "worker_result",
      summary: "Worker claims AC-INV-002.1 is implemented.",
      payload: { status: "passed" },
      createdAt: now,
    });

    // BLOCKED (AC-INV-003.1)
    store.insertSlice({
      id: blockedSliceId,
      laneId: "LANE-fr",
      targetId,
      title: "Blocked lookup slice",
      status: "blocked",
      sourceRefs: [{ sourceId, frAcRef: blockedRef }],
      frAcRefs: [blockedRef],
      deliveryQuestion: "Can a single invoice be looked up?",
      workPackageType: "component_pack",
      minimumMeaningfulOutcome: "changes_runtime_path",
      scope: ["src/invoices.js"],
      outOfScope: [],
      expectedEvidence: ["tests pass"],
      unblockTargets: [],
      verificationRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    store.insertLease({
      id: "LEASE-fr-blocked",
      frAcRef: blockedRef,
      sliceId: blockedSliceId,
      laneId: "LANE-fr",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertEscalation({
      id: "ESC-fr-003",
      level: "blocker",
      status: "active",
      entityType: "slice",
      entityId: blockedSliceId,
      message: "AC-INV-003.1 is blocked pending dependency.",
      createdBy: "fr-overseer",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }
  return { inScopeSliceId, siblingSliceId, blockedSliceId, blockedRef };
}

// ---------------------------------------------------------------------------
// FR-CP-001 — worker prompt carries a harness-authored "Settled facts" section
// generated from durable ledger state, including accepted sibling refs +
// evidence ids, and explicitly stating the section does NOT waive evidence
// obligations. Must appear in the persisted worker-prompt artifact.
// ---------------------------------------------------------------------------
test("FR-CP-001: persisted worker prompt carries ledger-derived settled facts with evidence ids", () => {
  const { workspace, target } = baseWorkspace("fr-cp-001");
  const { inScopeSliceId } = seedLedger(workspace, target);

  runSwarm(workspace, ["run", inScopeSliceId, "--actor", "fr-worker", "--driver", "fixture"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "fr-worker" && item.sliceId === inScopeSliceId);
  assert.ok(run, "fr-worker run should exist");

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", run.id, "--json"]));
  assert.equal(packet.artifacts.prompt.exists, true, "persisted worker prompt artifact should exist");
  const prompt = fs.readFileSync(packet.artifacts.prompt.path, "utf8");

  // Harness-authored, durable-state provenance header.
  assert.match(prompt, /Settled facts from the requirement ledger/);
  assert.match(prompt, /harness-authored from DURABLE state/i);
  // Accepted SIBLING ref appears as a settled fact, carrying its durable evidence id.
  const settledBlock = prompt.slice(prompt.indexOf("Settled facts from the requirement ledger"));
  assert.match(settledBlock, /AC-INV-001\.1 \(accepted\)/, "accepted sibling ref is a settled fact");
  assert.match(settledBlock, /EVID-fr-sibling/, "settled sibling carries its durable evidence id");
  // Explicit non-waiver of evidence obligations for the in-scope ref.
  assert.match(prompt, /do NOT waive your evidence obligations/i);
  assert.match(
    settledBlock,
    /produce fresh per-FR\/AC evidence for every in-scope ref \(AC-INV-002\.1\)/,
  );
});

// ---------------------------------------------------------------------------
// FR-CP-003 — scope isolation. The current in-scope ref must NOT be promoted to
// settled merely from a worker claim; the accepted sibling ref is settled only
// because the ledger shows accepted/passed evidence; blocked refs stay visibly
// blocked. Covers >=1 accepted sibling AND >=1 current in-scope ref.
// ---------------------------------------------------------------------------
test("FR-CP-003: worker claim never manufactures a settled in-scope ref; blocked stays blocked", () => {
  const { workspace, target } = baseWorkspace("fr-cp-003");
  const { inScopeSliceId } = seedLedger(workspace, target);

  runSwarm(workspace, ["run", inScopeSliceId, "--actor", "fr-worker", "--driver", "fixture"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "fr-worker" && item.sliceId === inScopeSliceId);
  assert.ok(run);

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", run.id, "--json"]));
  const prompt = fs.readFileSync(packet.artifacts.prompt.path, "utf8");
  const settledBlock = prompt.slice(prompt.indexOf("Settled facts from the requirement ledger"));

  // >=1 accepted sibling ref present as settled.
  assert.match(settledBlock, /AC-INV-001\.1 \(accepted\)/, "accepted sibling ref present as settled");

  // >=1 current in-scope ref NOT promoted to settled despite the worker_result claim.
  const acceptedRegion = settledBlock.slice(0, settledBlock.indexOf("Still-blocked"));
  assert.ok(
    !/AC-INV-002\.1 \((accepted|verified|human_verified|review_passed)\)/.test(acceptedRegion),
    "in-scope ref must NOT be a settled fact from a mere worker claim",
  );

  // Blocked ref renders visibly blocked, never accepted.
  assert.match(settledBlock, /Still-blocked \/ human-gated refs/);
  assert.match(settledBlock, /AC-INV-003\.1 \(blocked\)/, "blocked ref renders as visibly blocked");
  const blockedRegion = settledBlock.slice(settledBlock.indexOf("Still-blocked"));
  assert.ok(!/AC-INV-003\.1 \(accepted\)/.test(blockedRegion), "blocked ref is never promoted to settled");
});

// ---------------------------------------------------------------------------
// FR-CP-002 — revive prompt carries a resume/ledger block (prev run id +
// session, current durable slice status, do-not-redo, next expected action) and
// forwards the settled-facts section, while NOT silently marking an in-scope ref
// accepted. Drives the REAL `recovery revive` command via a fake-codex stub so
// the actual buildWorkerRevivePrompt path runs.
// ---------------------------------------------------------------------------
test("FR-CP-002: revive prompt carries resume/ledger block without marking in-scope refs accepted", () => {
  const { workspace, target } = baseWorkspace("fr-cp-002");
  const { inScopeSliceId } = seedLedger(workspace, target);

  // A fake codex that, on resume, writes a valid worker-result artifact and exits.
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-cp-002-codex-"));
  const fakeCodexScript = path.join(fakeCodexDir, "fake-codex.mjs");
  fs.writeFileSync(
    fakeCodexScript,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-revive-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "revived run completed",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [{ ref: "AC-INV-002.1", status: "covered", evidence: "revive evidence" }],
    risks: [],
    nextRecommendation: "continue"
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );

  // Seed a prior codex-driver run with a captured session id (resume precondition).
  const previousRunId = "RUN-fr-cp-002-prev";
  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    store.insertAgentRun({
      id: previousRunId,
      sliceId: inScopeSliceId,
      role: "worker",
      entityType: "slice",
      entityId: inScopeSliceId,
      actor: "fr-revive-worker",
      driver: "codex",
      status: "failed",
      sessionId: "session-fr-cp-002",
      attempt: 1,
      startedAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }

  runSwarm(workspace, ["recovery", "revive", previousRunId, "--actor", "fr-recovery"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
  });

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "60"]));
  const revivedRun = snapshot.agentRuns.find(
    (item) => item.actor === "fr-revive-worker" && item.id !== previousRunId,
  );
  assert.ok(revivedRun, "a revived run should be created");

  const revivePromptPath = path.join(
    workspace,
    ".swarm",
    "artifacts",
    inScopeSliceId,
    `worker-revive-prompt-${revivedRun.id}.md`,
  );
  assert.ok(fs.existsSync(revivePromptPath), "persisted revive prompt artifact should exist");
  const revivePrompt = fs.readFileSync(revivePromptPath, "utf8");

  // Resume / ledger block fields.
  assert.match(revivePrompt, /Resume \/ ledger context/);
  assert.match(revivePrompt, new RegExp(`Previous run id: ${previousRunId}`));
  assert.match(revivePrompt, /Previous run session id: session-fr-cp-002/);
  assert.match(revivePrompt, /Current slice status \(durable\): /);
  assert.match(revivePrompt, /Do not redo: any in-scope FR\/AC already backed by passing recorded evidence/);
  assert.match(revivePrompt, /Next expected action: /);

  // Forwards the settled-facts section.
  assert.match(revivePrompt, /Settled facts from the requirement ledger/);

  // The resume block must NOT silently mark the in-scope ref accepted. The only
  // permitted "accepted" mention in the resume block is the explicit disclaimer.
  const resumeBlock = revivePrompt.slice(
    revivePrompt.indexOf("Resume / ledger context"),
    revivePrompt.indexOf("Settled facts from the requirement ledger"),
  );
  assert.ok(
    !/AC-INV-002\.1 \(accepted\)/.test(resumeBlock),
    "resume block must not promote the in-scope ref to accepted",
  );
  assert.match(resumeBlock, /never marks an in-scope ref accepted/);
});

// ---------------------------------------------------------------------------
// FR-PI-001 — focus packets expose an additive `intervention` field with
// classification / confidence / recommendedAction / reason / evidence / risk.
// Seeds a known failure class (run failed + failed command, no result artifact).
// ---------------------------------------------------------------------------
test("FR-PI-001: run + slice focus packets expose the intervention field for a known failure class", () => {
  const { workspace, target } = baseWorkspace("fr-pi-001");
  const { inScopeSliceId } = seedLedger(workspace, target);

  const store = new SwarmStore(workspace);
  const runId = "RUN-fr-pi-001";
  try {
    const now = new Date().toISOString();
    const artifactDir = path.join(workspace, ".swarm", "artifacts", inScopeSliceId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const eventsPath = path.join(artifactDir, "worker-events-RUN-fr-pi-001.jsonl");
    const promptPath = path.join(artifactDir, "worker-prompt-RUN-fr-pi-001.md");
    fs.writeFileSync(promptPath, "Worker prompt for FR-PI-001.\n", "utf8");
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            status: "failed",
            command: "node bad-probe",
            exit_code: 1,
            aggregated_output: "Error: spawn EINVAL",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    store.insertAgentRun({
      id: runId,
      sliceId: inScopeSliceId,
      role: "worker",
      entityType: "slice",
      entityId: inScopeSliceId,
      actor: "fr-pi-worker",
      driver: "codex",
      status: "failed",
      sessionId: "session-fr-pi-001",
      attempt: 1,
      eventsPath,
      startedAt: now,
      updatedAt: now,
    });
    store.addEvent(
      createEvent({
        actor: "fr-pi-worker",
        type: "worker.started",
        entityType: "slice",
        entityId: inScopeSliceId,
        payload: { runId, promptPath },
      }),
    );
  } finally {
    store.close();
  }

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", runId, "--json"]));
  // Sanity: this is a known failure class.
  assert.ok(packet.diagnosis.failureClasses.includes("command_failed"));
  assert.ok(packet.diagnosis.failureClasses.includes("run_failed"));

  // Additive intervention field shape.
  assert.ok(packet.intervention, "run focus packet exposes intervention");
  assert.ok(typeof packet.intervention.classification === "string" && packet.intervention.classification.length > 0);
  assert.ok(["low", "medium", "high"].includes(packet.intervention.confidence));
  assert.ok(SETTLED_ACTIONS.includes(packet.intervention.recommendedAction));
  assert.ok(typeof packet.intervention.reason === "string" && packet.intervention.reason.length > 0);
  assert.ok(Array.isArray(packet.intervention.evidence) && packet.intervention.evidence.includes(runId));
  assert.ok(typeof packet.intervention.risk === "string" && packet.intervention.risk.length > 0);
  // run_failed + command_failed (no artifact) => coach in-session.
  assert.equal(packet.intervention.recommendedAction, "coach_same_session");

  // Slice packet mirrors the latest run focus intervention.
  const slicePacket = JSON.parse(runSwarm(workspace, ["inspect", "slice", inScopeSliceId, "--json"]));
  assert.ok(slicePacket.intervention, "slice focus packet exposes intervention");
  assert.equal(slicePacket.intervention.classification, packet.intervention.classification);
});

// ---------------------------------------------------------------------------
// FR-PI-002 — recovery records that the focus/intervention packet was consulted
// BEFORE acting, valid-artifact recovery is not downgraded to restart churn, and
// same-session revive stays preferred when a session id exists. Drives the REAL
// `recovery revive` command via a fake-codex stub.
// ---------------------------------------------------------------------------
test("FR-PI-002: recovery emits focus_consulted before reviving and prefers same-session", () => {
  const { workspace, target } = baseWorkspace("fr-pi-002");
  const { inScopeSliceId } = seedLedger(workspace, target);

  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-pi-002-codex-"));
  const fakeCodexScript = path.join(fakeCodexDir, "fake-codex.mjs");
  fs.writeFileSync(
    fakeCodexScript,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-pi-002-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify({
    status: "passed",
    summary: "revived run completed",
    changedFiles: [],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    frAcCoverage: [{ ref: "AC-INV-002.1", status: "covered", evidence: "revive evidence" }],
    risks: [],
    nextRecommendation: "continue"
  }) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );

  const previousRunId = "RUN-fr-pi-002-prev";
  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    store.insertAgentRun({
      id: previousRunId,
      sliceId: inScopeSliceId,
      role: "worker",
      entityType: "slice",
      entityId: inScopeSliceId,
      actor: "fr-pi-revive-worker",
      driver: "codex",
      status: "failed",
      sessionId: "session-fr-pi-002",
      attempt: 1,
      startedAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }

  runSwarm(workspace, ["recovery", "revive", previousRunId, "--actor", "fr-pi-recovery"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
  });

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));

  // The consult event exists and carries an intervention recommendation. Ordering
  // is a source-level guarantee (the consult store.addEvent precedes
  // recovery.revive_started in cli.ts); recentEvents collides at ms resolution so
  // we assert via existence + payload, not list index.
  const consult = snapshot.recentEvents.find((event) => event.type === "recovery.focus_consulted");
  assert.ok(consult, "recovery revive should emit recovery.focus_consulted");
  assert.equal(consult.payload.recoveryKind, "revive");
  assert.equal(consult.payload.hasSession, true);
  assert.ok(
    typeof consult.payload.recommendedAction === "string" && consult.payload.recommendedAction.length > 0,
    "focus_consulted carries an intervention recommendedAction",
  );

  // Same-session revive stays preferred: a revive happened, no restart fallback.
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.revive_started"));
  assert.ok(!snapshot.recentEvents.some((event) => event.type === "recovery.restart_started"));
});

// ---------------------------------------------------------------------------
// FR-PI-003 — the JSON focus packet surface (inspect run/slice --json, mirroring
// /api/focus/run/:id and /api/focus/slice/:id) includes the intervention field
// for >=1 known failure class. Uses a valid-artifact hung child so the
// classification is deterministic.
// ---------------------------------------------------------------------------
test("FR-PI-003: JSON focus packet includes intervention for a valid-artifact hung-child failure", () => {
  const { workspace, target } = baseWorkspace("fr-pi-003");
  const { inScopeSliceId } = seedLedger(workspace, target);

  const store = new SwarmStore(workspace);
  const runId = "RUN-fr-pi-003";
  try {
    const now = new Date().toISOString();
    const artifactDir = path.join(workspace, ".swarm", "artifacts", inScopeSliceId);
    fs.mkdirSync(artifactDir, { recursive: true });
    const eventsPath = path.join(artifactDir, "worker-events-fr-pi-003.jsonl");
    const promptPath = path.join(artifactDir, "worker-prompt-RUN-fr-pi-003.md");
    const resultPath = path.join(artifactDir, "worker-result-RUN-fr-pi-003.json");
    fs.writeFileSync(promptPath, "Worker prompt for FR-PI-003.\n", "utf8");
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ status: "implemented", summary: "done", frAcCoverage: [], findings: [] }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-fr-pi-003" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", status: "completed", command: "npm test", exit_code: 0 },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    store.updateSliceStatus(inScopeSliceId, "implementing");
    store.insertAgentRun({
      id: runId,
      sliceId: inScopeSliceId,
      role: "worker",
      entityType: "slice",
      entityId: inScopeSliceId,
      actor: "fr-pi-003-worker",
      driver: "codex",
      status: "running",
      sessionId: "session-fr-pi-003",
      attempt: 1,
      eventsPath,
      resultPath,
      startedAt: now,
      updatedAt: now,
    });
    store.upsertHeartbeat({
      actor: "fr-pi-003-worker",
      state: "blocked",
      detail: "Agent child process produced no output for 300s; terminating for supervised recovery.",
      entityType: "slice",
      entityId: inScopeSliceId,
      timestamp: now,
    });
    store.addEvent(
      createEvent({
        actor: "fr-pi-003-worker",
        type: "worker.child_idle_timeout",
        entityType: "slice",
        entityId: inScopeSliceId,
        payload: { runId, jsonlPath: eventsPath, idleTimeoutMs: 300000 },
      }),
    );
  } finally {
    store.close();
  }

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", runId, "--json"]));
  // Known failure class present.
  assert.ok(packet.diagnosis.failureClasses.includes("child_idle_timeout"));
  assert.equal(packet.artifacts.result.exists, true);

  // The JSON surface includes the intervention field, classified deterministically.
  assert.ok(packet.intervention, "JSON focus packet includes intervention");
  assert.equal(packet.intervention.classification, "valid_artifact_hung_child");
  assert.equal(packet.intervention.recommendedAction, "accept_valid_artifact");
  assert.equal(packet.intervention.confidence, "high");
  assert.ok(["low", "medium", "high"].includes(packet.intervention.confidence));
  assert.ok(SETTLED_ACTIONS.includes(packet.intervention.recommendedAction));
  assert.ok(Array.isArray(packet.intervention.evidence));
  assert.match(packet.intervention.risk, /discard a valid/i);

  // Slice JSON surface also includes it (mirrors /api/focus/slice/:id).
  const slicePacket = JSON.parse(runSwarm(workspace, ["inspect", "slice", inScopeSliceId, "--json"]));
  assert.ok(slicePacket.intervention, "slice JSON focus packet includes intervention");
});
