import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptedDemo = path.join(repoRoot, "scripts", "run-live-agent-scripted-demo.mjs");

test("scripted live smoke runs a codex worker, reviewer, and final verifier", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-scripted-${process.pid}-${Date.now()}`);
  const fakeCodexScript = writeFakeCodex();

  const output = execFileSync(process.execPath, [scriptedDemo, "--workspace", workspace, "--driver", "codex"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SWARM_CODEX_COMMAND: process.execPath,
      SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);

  assert.equal(summary.workspace, workspace);
  assert.equal(summary.driver, "codex");
  assert.equal(summary.runMode, "scripted-codex");
  assert.equal(summary.phase, "phase-3-scripted-worker-reviewer");
  assert.equal(summary.finalOutcome, "accepted");
  assert.ok(Object.entries(summary.assertions).every(([, value]) => value === true));
  assert.equal(summary.runs.worker.driver, "codex");
  assert.equal(summary.runs.reviewer.driver, "codex");
  assert.equal(summary.review.status, "accepted");
  assert.ok(fs.existsSync(summary.artifacts.summary));
  assert.ok(fs.existsSync(summary.artifacts.snapshot));
  assert.ok(fs.existsSync(summary.artifacts.report));
  assert.ok(fs.existsSync(summary.artifacts.workerResult));
  assert.ok(fs.existsSync(summary.artifacts.reviewerResult));

  const snapshot = JSON.parse(fs.readFileSync(summary.artifacts.snapshot, "utf8"));
  const slice = snapshot.slices.find((item) => item.id === summary.sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "review_result"));
  assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "worker.codex_event"));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "reviewer.codex_event"));

  const manifest = JSON.parse(fs.readFileSync(path.join(workspace, "live-agent-smoke.json"), "utf8"));
  assert.equal(manifest.runMode, "scripted-codex");
  assert.equal(manifest.phase, "phase-3-scripted-worker-reviewer");
  assert.equal(manifest.scriptedRun.driver, "codex");
});

function writeFakeCodex() {
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-scripted-"));
  const scriptPath = path.join(fakeCodexDir, "fake-codex.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const schemaIndex = args.indexOf("--output-schema");
const schemaPath = schemaIndex >= 0 ? args[schemaIndex + 1] : "";
const refs = ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"];

console.log(JSON.stringify({ type: "thread.started", thread_id: schemaPath.includes("review") ? "fake-review-thread" : "fake-worker-thread" }));

if (schemaPath.includes("review-result")) {
  console.log(JSON.stringify({ type: "review.analysis", status: "accepted" }));
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "accepted",
      summary: "fake reviewer accepted scripted backend slice",
      frAcFindings: refs.map((ref) => ({
        ref,
        status: "passed",
        evidence: ["fake-review-evidence"],
        finding: "Runtime behavior and worker evidence cover this ref."
      })),
      testAssessment: "npm test evidence is behavior-focused for the query capability.",
      sourceMutationDetected: false,
      stubOrHardcodeRisk: "none",
      requiredFixes: [],
      escalations: [],
      recommendation: "Proceed to final deterministic verification."
    }) + "\\n", "utf8");
  }
} else {
  console.log(JSON.stringify({ type: "item.started", item: { type: "file_change", path: "src/invoices.js" } }));
  fs.writeFileSync(path.join(process.cwd(), "src", "invoices.js"), \`const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) {
      return false;
    }

    if (filters.customerId && invoice.customerId !== filters.customerId) {
      return false;
    }

    return true;
  });
}

export function getInvoiceSummary() {
  return {
    count: invoices.length,
  };
}
\`, "utf8");
  fs.writeFileSync(path.join(process.cwd(), "test", "invoices.test.js"), \`import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("lists only open invoices when filtered by open status", () => {
  assert.deepEqual(
    listInvoices({ status: "open" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1003"],
  );
});

test("lists only invoices for the requested customer", () => {
  assert.deepEqual(
    listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1002"],
  );
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
\`, "utf8");
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify({
      status: "passed",
      summary: "fake worker implemented invoice query filtering",
      changedFiles: ["src/invoices.js", "test/invoices.test.js"],
      commandsRun: ["npm test"],
      testsRun: ["npm test"],
      frAcCoverage: refs.map((ref) => ({
        ref,
        status: "covered",
        evidence: "Invoice query behavior is covered by listInvoices tests."
      })),
      risks: [],
      nextRecommendation: "Run independent review and deterministic verification."
    }) + "\\n", "utf8");
  }
}

console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
  return scriptPath;
}
