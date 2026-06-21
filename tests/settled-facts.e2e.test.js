import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

// ---------------------------------------------------------------------------
// FR-CP-001 / FR-CP-003: ledger-derived "Settled facts" in the worker prompt.
//
// The harness must inject an accepted SIBLING FR/AC ref as settled context (backed
// by DURABLE ledger status + evidence id) while NEVER promoting the current slice's
// own in-scope refs to "settled" just because a worker claim exists, and while
// rendering blocked/human-gated refs as visibly blocked. This proves the scope
// isolation that FR-CP-003 demands: a worker claim cannot manufacture settled facts.
// ---------------------------------------------------------------------------
function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env },
    encoding: "utf8",
  });
}

function setupWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-settled-facts-"));
  const target = path.join(workspace, "target");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.mkdirSync(path.join(target, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ name: "invoice-api-fixture", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "src", "invoices.js"),
    `const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices() {
  return invoices;
}

export function getInvoiceSummary() {
  return {
    count: invoices.length,
  };
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(target, "test", "invoices.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
`,
    "utf8",
  );

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);

  const store = new SwarmStore(workspace);
  const now = new Date().toISOString();
  const siblingSliceId = "SLICE-settled-sibling";
  const inScopeSliceId = "SLICE-settled-inscope";
  const blockedRef = "AC-INV-003.1";
  try {
    const targetRecord = store.listTargets()[0];
    const targetId = targetRecord.id;

    const specsDir = path.join(target, "specs");
    fs.mkdirSync(specsDir, { recursive: true });
    const specUri = path.join(specsDir, "invoices.md");
    fs.writeFileSync(specUri, "# Invoice spec\n\nAC-INV-001.1, AC-INV-002.1, AC-INV-003.1.\n", "utf8");

    const sourceId = "SOURCE-settled-01";
    store.addOrUpdateSource({
      id: sourceId,
      adapterId: "file",
      kind: "spec",
      uri: specUri,
      title: "Invoice Spec",
      hash: "settled-hash",
      metadata: {
        domain: "Invoices",
        tags: ["inv"],
        priority: 1,
        frAcRefs: ["AC-INV-001.1", "AC-INV-002.1", "AC-INV-003.1"],
        sections: [
          {
            id: `${sourceId}#invoice-spec`,
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
      id: "LANE-settled",
      name: "Settled Lane",
      purpose: "Exercise ledger-derived settled facts",
      focusLabels: ["inv"],
      targetId,
      orchestrator: "settled-overseer",
      worktree: target,
      state: "active",
      createdAt: now,
      updatedAt: now,
    });

    // ----- ACCEPTED SIBLING SLICE (AC-INV-001.1): accepted + passing evidence.
    // This is the only thing that legitimately becomes a settled fact.
    store.insertSlice({
      id: siblingSliceId,
      laneId: "LANE-settled",
      targetId,
      title: "Accepted sibling invoice listing slice",
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
      id: "LEASE-settled-sibling",
      frAcRef: "AC-INV-001.1",
      sliceId: siblingSliceId,
      laneId: "LANE-settled",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    const siblingEvidenceId = "EVID-settled-sibling";
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

    // ----- CURRENT IN-SCOPE SLICE (AC-INV-002.1): only a worker_result CLAIM, NOT accepted.
    store.insertSlice({
      id: inScopeSliceId,
      laneId: "LANE-settled",
      targetId,
      title: "In-scope invoice summary slice",
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
      id: "LEASE-settled-inscope",
      frAcRef: "AC-INV-002.1",
      sliceId: inScopeSliceId,
      laneId: "LANE-settled",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // A pure worker CLAIM on the in-scope ref. This must NEVER become a settled fact.
    store.insertEvidence({
      id: "EVID-settled-inscope-claim",
      sliceId: inScopeSliceId,
      ref: "AC-INV-002.1",
      kind: "worker_result",
      summary: "Worker claims AC-INV-002.1 is implemented.",
      payload: { status: "passed" },
      createdAt: now,
    });

    // ----- BLOCKED REF (AC-INV-003.1): owned by a blocked slice with an active blocker
    // escalation -> visibly blocked in the ledger, NOT settled.
    const blockedSliceId = "SLICE-settled-blocked";
    store.insertSlice({
      id: blockedSliceId,
      laneId: "LANE-settled",
      targetId,
      title: "Blocked invoice lookup slice",
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
      id: "LEASE-settled-blocked",
      frAcRef: blockedRef,
      sliceId: blockedSliceId,
      laneId: "LANE-settled",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    store.insertEscalation({
      id: "ESC-settled-003",
      level: "blocker",
      status: "active",
      entityType: "slice",
      entityId: blockedSliceId,
      message: "AC-INV-003.1 is blocked pending dependency.",
      createdBy: "settled-overseer",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    store.close();
  }

  return { workspace, siblingSliceId, inScopeSliceId, blockedRef };
}

test("worker prompt renders ledger-settled accepted sibling and gates in-scope refs (FR-CP-001/003)", () => {
  const { workspace, inScopeSliceId } = setupWorkspace();

  runSwarm(workspace, ["run", inScopeSliceId, "--actor", "settled-worker", "--driver", "fixture"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const run = snapshot.agentRuns.find((item) => item.actor === "settled-worker" && item.sliceId === inScopeSliceId);
  assert.ok(run, "settled-worker run should exist");

  const packet = JSON.parse(runSwarm(workspace, ["inspect", "run", run.id, "--json"]));
  assert.equal(packet.artifacts.prompt.exists, true, "persisted worker prompt should exist (FR-CP-001 artifact)");
  const prompt = fs.readFileSync(packet.artifacts.prompt.path, "utf8");

  // FR-CP-001: harness-authored settled facts section is present and provenance-stamped.
  assert.match(prompt, /Settled facts from the requirement ledger/);
  assert.match(prompt, /harness-authored from DURABLE state/i);
  assert.match(prompt, /do NOT waive your evidence obligations/i);

  // FR-CP-003: the accepted SIBLING ref appears as settled, with its DURABLE evidence id.
  const settledBlock = prompt.slice(prompt.indexOf("Settled facts from the requirement ledger"));
  assert.match(settledBlock, /AC-INV-001\.1 \(accepted\)/, "accepted sibling ref should be a settled fact");
  assert.match(settledBlock, /EVID-settled-sibling/, "settled sibling should carry its durable evidence id");

  // FR-CP-003: the current slice's OWN in-scope ref must NOT be promoted to settled,
  // even though a worker_result claim exists for it. It must only appear in the
  // explicit "in-scope refs you must still prove" sentence.
  const acceptedListRegion = settledBlock.slice(
    0,
    settledBlock.indexOf("Still-blocked"),
  );
  assert.ok(
    !/AC-INV-002\.1 \((accepted|verified|human_verified|review_passed)\)/.test(acceptedListRegion),
    "in-scope ref must NOT be listed as a settled/accepted fact from a mere worker claim",
  );
  assert.match(
    settledBlock,
    /produce fresh per-FR\/AC evidence for every in-scope ref \(AC-INV-002\.1\)/,
    "in-scope ref must be named as still-owing evidence",
  );

  // FR-CP-003: the blocked ref renders as visibly blocked, never settled.
  assert.match(settledBlock, /Still-blocked \/ human-gated refs/);
  assert.match(settledBlock, /AC-INV-003\.1 \(blocked\)/, "blocked ref should render as visibly blocked");
  const blockedRegion = settledBlock.slice(settledBlock.indexOf("Still-blocked"));
  assert.ok(
    !/AC-INV-003\.1 \(accepted\)/.test(blockedRegion),
    "blocked ref must never be promoted to a settled accepted fact",
  );
});
