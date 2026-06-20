#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildHumanActionQueue } from "../dist/human-actions.js";
import { buildCoverage } from "../dist/observability.js";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario ?? "live-agent-smoke-h2";
if (scenario !== "live-agent-smoke-h2") {
  throw new Error(`Support triage fake demo only supports live-agent-smoke-h2; received ${scenario}.`);
}

const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");
const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "live-agent-smoke-h2"));
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "support-triage-fake-summary.json"));
const artifactDir = path.resolve(args.artifacts ?? path.join(workspace, "support-triage-fake-artifacts"));
const resetBeforeRun = args.reset === "true" || !fs.existsSync(path.join(workspace, ".swarm", "state.db"));

if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}. Run npm run build first.`);
if (resetBeforeRun) {
  execFileSync(process.execPath, [resetScript, "--scenario", scenario, "--workspace", workspace, "--stop-related-processes"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

fs.mkdirSync(artifactDir, { recursive: true });
runSwarm(["run-mode", "set", "live-agent-smoke"]);
const fakeReviewer = writeFakeReviewer();

const slices = [];
const backendSlice = pullSlice({
  target: "support-api",
  source: "live-smoke-support-triage-api-requirements.md",
  laneName: "H2 Backend Lane: Ticket API Core",
  lanePurpose: "Implement deterministic support ticket API capabilities before UI work.",
  labels: "support,backend,h2,fake",
  batchSize: 8,
});
slices.push(await completeSlice({ sliceId: backendSlice, worker: "h2-backend-worker", reviewer: "h2-backend-reviewer" }));

const uiSlice = pullSlice({
  target: "support-ui",
  source: "live-smoke-support-triage-ui-requirements.md",
  laneName: "H2 UI Lane: Board Interaction Core",
  lanePurpose: "Implement support board UI behavior against accepted backend-shaped capabilities.",
  labels: "support,frontend,h2,fake",
  batchSize: 9,
});
runSwarm(["run", uiSlice, "--driver", "fixture", "--actor", "h2-ui-worker"]);
runFakeReview(uiSlice, "h2-ui-reviewer", "repair_required");
runSwarm(["verify", uiSlice, "--actor", "h2-ui-verifier", "--force"]);
runSwarm(["run", uiSlice, "--driver", "fixture", "--actor", "h2-ui-repair-worker"]);
runFakeReview(uiSlice, "h2-ui-reviewer", "accepted");
const clearedUiRepairEscalations = clearSliceEscalations(
  uiSlice,
  (escalation) =>
    escalation.message.includes("Independent review status is repair_required") ||
    escalation.message.includes("Sleuth Review Gate blocked acceptance."),
  "H2 fake overseer cleared the intentionally injected UI repair blocker after repair work and accepted review evidence.",
);
runSwarm(["verify", uiSlice, "--actor", "h2-ui-verifier"]);
slices.push({
  sliceId: uiSlice,
  target: "support-ui",
  exercisedRepair: true,
  humanVerifiedRefs: [],
  clearedEscalations: clearedUiRepairEscalations,
});

const designSlice = pullSlice({
  target: "support-ui",
  source: "live-smoke-support-triage-design-system.md",
  laneName: "H2 Design Lane: Human Visual Quality",
  lanePurpose: "Exercise design-token and human-verification obligations for the support board.",
  labels: "support,frontend,design,human-verification,h2,fake",
  batchSize: 20,
});
runSwarm(["run", designSlice, "--driver", "fixture", "--actor", "h2-design-worker"]);
runSwarm(["review", designSlice, "--driver", "fixture", "--actor", "h2-design-reviewer"]);
runSwarm(["verify", designSlice, "--actor", "h2-design-verifier"]);
const humanRefs = latestHumanVerificationRefs(designSlice);
const humanActionsBefore = humanActionSummary();
for (const ref of humanRefs) {
  runSwarm([
    "human-verify",
    designSlice,
    ref,
    "--status",
    "human_verified",
    "--actor",
    "h2-human-qa",
    "--notes",
    "Fixture H2 human sign-off: visual criteria packet was reviewed and accepted.",
  ]);
}
slices.push({ sliceId: designSlice, target: "support-ui", exercisedRepair: false, humanVerifiedRefs: humanRefs });

const readiness = await runProductReadiness(path.join(workspace, "support-ui"));
const finalSnapshotPath = path.join(artifactDir, "final-snapshot.json");
runSwarm(["observe", "--events", "240", "--out", finalSnapshotPath]);
const coverage = withStore((store) => buildCoverage(store));
const humanActionsAfter = humanActionSummary();
const finalSnapshot = JSON.parse(fs.readFileSync(finalSnapshotPath, "utf8"));
const acceptedSlices = finalSnapshot.slices.filter((slice) => slice.status === "accepted");
const manifestPath = path.join(workspace, "live-agent-smoke.json");
updateManifest(manifestPath, {
  phase: "phase-11c-h2-fake-agent-e2e",
  runnerStatus: "fake_agent_e2e_passed",
  fakeRun: {
    generatedAt: new Date().toISOString(),
    summaryPath,
    slices: slices.map((slice) => slice.sliceId),
    productReadiness: readiness.status,
  },
});

const assertions = {
  resetScenarioIsH2: finalSnapshot.runMode === "live-agent-smoke",
  backendAccepted: acceptedSlices.some((slice) => slice.id === backendSlice),
  uiAcceptedAfterRepair: acceptedSlices.some((slice) => slice.id === uiSlice),
  designAcceptedAfterHumanVerification: acceptedSlices.some((slice) => slice.id === designSlice),
  reviewerRejectionExercised: finalSnapshot.recentEvents.some((event) => event.type === "review.blocked_acceptance"),
  humanPacketsCreated: humanRefs.length > 0,
  humanActionQueueSurfacedPacket: humanActionsBefore.totals.humanVerification >= humanRefs.length,
  humanActionQueueCleared: humanActionsAfter.totals.humanVerification === 0,
  productReadinessPassed: readiness.status === "passed",
};

const summary = {
  scenario,
  workspace,
  generatedAt: new Date().toISOString(),
  phase: "phase-11c-h2-fake-agent-e2e",
  finalOutcome: Object.values(assertions).every(Boolean) ? "accepted" : "blocked",
  slices,
  coverage: {
    done: coverage.totals.done,
    total: coverage.totals.total,
    percentage: coverage.interpretation.completionPercent,
    awaitingHumanVerification: coverage.ledger.totals.awaiting_human_verification ?? 0,
  },
  humanActionsBefore,
  humanActionsAfter,
  productReadiness: readiness,
  artifacts: {
    summary: summaryPath,
    finalSnapshot: finalSnapshotPath,
    productReadiness: readiness.artifactPath,
    fakeReviewer,
  },
  assertions,
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

async function completeSlice(input) {
  runSwarm(["run", input.sliceId, "--driver", "fixture", "--actor", input.worker]);
  runSwarm(["review", input.sliceId, "--driver", "fixture", "--actor", input.reviewer]);
  runSwarm(["verify", input.sliceId, "--actor", `${input.worker}-verifier`]);
  const target = currentSnapshot().slices.find((slice) => slice.id === input.sliceId)?.target?.name;
  return { sliceId: input.sliceId, target, exercisedRepair: false, humanVerifiedRefs: [] };
}

function pullSlice(input) {
  const output = runSwarm([
    "slices",
    "pull",
    "--target",
    input.target,
    "--source",
    input.source,
    "--new-lane",
    "--lane-name",
    input.laneName,
    "--lane-purpose",
    input.lanePurpose,
    "--lane-labels",
    input.labels,
    "--orchestrator",
    "h2-fake-overseer",
    "--batch-size",
    String(input.batchSize),
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(output)?.[1];
  if (!sliceId) throw new Error(`Could not parse slice id from output:\n${output}`);
  return sliceId;
}

function runFakeReview(sliceId, actor, status) {
  runSwarm(["review", sliceId, "--driver", "codex", "--actor", actor], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeReviewer]),
    FAKE_REVIEW_STATUS: status,
  });
}

function latestHumanVerificationRefs(sliceId) {
  return withStore((store) => {
    const commandEvidence = store.listEvidence(sliceId).filter((item) => item.kind === "command").at(-1);
    const refs = commandEvidence?.payload?.humanVerificationRefs;
    return Array.isArray(refs) ? refs.map(String) : [];
  });
}

function humanActionSummary() {
  return withStore((store) => buildHumanActionQueue(store, workspace));
}

function clearSliceEscalations(sliceId, predicate, reason) {
  const escalations = withStore((store) =>
    store
      .listEscalations("active")
      .filter((escalation) => escalation.entityType === "slice" && escalation.entityId === sliceId && predicate(escalation)),
  );
  for (const escalation of escalations) {
    runSwarm(["escalations", "clear", escalation.id, "--actor", "h2-fake-overseer", "--reason", reason]);
  }
  return escalations.map((escalation) => escalation.id);
}

async function runProductReadiness(targetPath) {
  const artifactPath = path.join(artifactDir, "product-readiness.json");
  const packageJson = JSON.parse(fs.readFileSync(path.join(targetPath, "package.json"), "utf8"));
  if (!packageJson.scripts?.test) throw new Error("support-ui package is missing npm test");
  if (!packageJson.scripts?.start) throw new Error("support-ui package is missing npm start");
  const testOutput = execFileSync(process.execPath, ["--test"], {
    cwd: targetPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: targetPath,
    windowsHide: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const url = await waitForUrl(() => stdout, 10000);
    const html = await (await fetch(url)).text();
    const summaryBefore = await (await fetch(`${url}/api/summary`)).json();
    const assignment = await fetch(`${url}/api/tickets/TCK-100/assignment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assigneeId: "agent-ava" }),
    });
    const status = await fetch(`${url}/api/tickets/TCK-100/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "waiting_customer" }),
    });
    const note = await fetch(`${url}/api/tickets/TCK-100/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "Ava", body: "Contacted customer." }),
    });
    const detail = await (await fetch(`${url}/api/tickets/TCK-100`)).json();
    const summaryAfter = await (await fetch(`${url}/api/summary`)).json();
    const result = {
      status:
        html.includes("Customer Support Triage Board") &&
        typeof summaryBefore.openTicketCount === "number" &&
        typeof summaryBefore.breachedSlaCount === "number" &&
        typeof summaryBefore.urgentTicketCount === "number" &&
        typeof summaryBefore.unassignedTicketCount === "number" &&
        assignment.status === 200 &&
        status.status === 200 &&
        note.status === 200 &&
        detail.ticket?.internalNotes?.some((item) => item.body === "Contacted customer.") &&
        summaryAfter.unassignedTicketCount === summaryBefore.unassignedTicketCount - 1
          ? "passed"
          : "failed",
      url,
      testOutput,
      summaryBefore,
      summaryAfter,
      workflow: {
        assignmentStatus: assignment.status,
        statusTransitionStatus: status.status,
        noteStatus: note.status,
        noteRecorded: detail.ticket?.internalNotes?.some((item) => item.body === "Contacted customer.") === true,
      },
      stdout,
      stderr,
      artifactPath,
    };
    fs.writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    stopProcessTree(server);
  }
}

function waitForUrl(readStdout, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(readStdout());
      if (match) {
        clearInterval(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for support-ui server URL. stdout:\n${readStdout()}`));
      }
    }, 100);
  });
}

function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function writeFakeReviewer() {
  const scriptPath = path.join(artifactDir, "fake-support-reviewer.mjs");
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const prompt = (() => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } })();
const refs = [...new Set([...prompt.matchAll(/\\b(?:FR|AC)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?:\\.[0-9]+)?\\b/g)].map((match) => match[0]))];
const status = process.env.FAKE_REVIEW_STATUS || "accepted";
const accepted = status === "accepted";
const dimensions = ["runtime_path", "stub_or_hardcode", "test_meaningfulness", "error_handling", "integration_fit", "maintainability", "real_world_readiness"].map((dimension) => ({
  dimension,
  status: "passed",
  risk: "none",
  evidence: ["fake-h2-review-evidence"],
  finding: dimension + " checked by H2 fake reviewer"
}));
const result = {
  status,
  summary: accepted ? "H2 fake reviewer accepted implementation evidence." : "H2 fake reviewer requested repair before acceptance.",
  frAcFindings: refs.map((ref, index) => ({
    ref,
    status: accepted || index > 0 ? "passed" : "failed",
    evidence: ["fake-h2-review-evidence"],
    finding: accepted || index > 0 ? "Requirement evidence passed review." : "First review intentionally requested repair."
  })),
  testAssessment: accepted ? "Tests and runtime evidence are coherent." : "Initial pass needs repair before acceptance.",
  sourceMutationDetected: false,
  stubOrHardcodeRisk: "none",
  qualityGate: {
    status: "passed",
    summary: "Structured quality gate completed.",
    dimensions,
    blockingConcerns: [],
    residualRisks: accepted ? [] : ["repair pass required by injected H2 fake review"]
  },
  requiredFixes: accepted ? [] : ["Rerun worker after reviewer repair request."],
  escalations: [],
  recommendation: accepted ? "Proceed to deterministic verification." : "Repair implementation, rerun review, then verify."
};
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-h2-reviewer" }));
console.log(JSON.stringify({ type: "review.analysis", status }));
if (outputPath) fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\\n", "utf8");
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
  return scriptPath;
}

function currentSnapshot() {
  return JSON.parse(runSwarm(["observe", "--events", "80"]));
}

function withStore(callback) {
  const store = new SwarmStore(workspace);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}

function updateManifest(manifestPath, patch) {
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8");
}

function runSwarm(commandArgs, env = {}) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
