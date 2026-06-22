import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

// SO-2: bounded in-turn re-ask of a structured result that was produced but failed schema
// validation. Exercised through a FAKE codex (invalid-then-valid-on-resume), NOT the fixture
// driver (which hardcodes finalize ok and bypasses the re-ask path entirely).

test("worker re-asks and recovers a schema-invalid structured result on resume", () => {
  const { workspace, sliceId, fakeCodexScript } = setupRun("reask-recover", writeFakeCodexInvalidThenValidOnResume);

  const runOutput = runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "reask-recover-worker"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
  });
  assert.match(runOutput, /Worker completed/);

  const store = new SwarmStore(workspace);
  try {
    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "implemented");
    const run = store.listAgentRuns().find((item) => item.actor === "reask-recover-worker");
    assert.equal(run?.status, "completed");

    const reaskEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.structured_result_reask" && item.actor === "reask-recover-worker");
    assert.equal(reaskEvents.length, 1, "exactly one re-ask attempt expected");
    assert.equal(reaskEvents[0].payload.attempt, 1);
    assert.equal(reaskEvents[0].payload.recovered, true);
    assert.equal(reaskEvents[0].payload.failureClass, "schema_invalid");

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "reask-recover-worker");
    assert.equal(completed?.payload.ok, true);

    // The corrected artifact must validate against the worker-result schema.
    const resultPath = run.resultPath;
    assert.ok(resultPath && fs.existsSync(resultPath));
    const finalResult = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.equal(finalResult.status, "passed");
    assert.equal(finalResult.frAcCoverage.length, 3);
  } finally {
    store.close();
  }
});

test("worker exhausts bounded re-ask attempts and blocks when every result is schema-invalid", () => {
  const { workspace, sliceId, fakeCodexScript } = setupRun("reask-exhaust", writeFakeCodexAlwaysInvalid);

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "reask-exhaust-worker"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
  });

  const store = new SwarmStore(workspace);
  try {
    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "blocked");
    const run = store.listAgentRuns().find((item) => item.actor === "reask-exhaust-worker");
    assert.equal(run?.status, "failed");

    const reaskEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.structured_result_reask" && item.actor === "reask-exhaust-worker");
    assert.equal(reaskEvents.length, 2, "default N=2 re-ask attempts expected");
    assert.deepEqual(
      reaskEvents.map((event) => event.payload.attempt),
      [1, 2],
    );
    assert.ok(reaskEvents.every((event) => event.payload.recovered === false));

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "reask-exhaust-worker");
    assert.equal(completed?.payload.ok, false);
    assert.equal(completed?.payload.failureClass, "schema_invalid");
    assert.match(completed?.payload.failureReason ?? "", /validation/);
  } finally {
    store.close();
  }
});

test("worker re-ask is env-tunable: SWARM_STRUCTURED_RESULT_REASK_MAX=1 yields exactly one attempt", () => {
  const { workspace, sliceId, fakeCodexScript } = setupRun("reask-bound", writeFakeCodexAlwaysInvalid);

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "reask-bound-worker"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
    SWARM_STRUCTURED_RESULT_REASK_MAX: "1",
  });

  const store = new SwarmStore(workspace);
  try {
    const reaskEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.structured_result_reask" && item.actor === "reask-bound-worker");
    assert.equal(reaskEvents.length, 1, "bound of 1 re-ask attempt expected");
  } finally {
    store.close();
  }
});

test("anti-drift: a real run failure (missing result) is NOT re-asked and blocks as today", () => {
  const { workspace, sliceId, fakeCodexScript } = setupRun("reask-antidrift", writeFakeCodexNoArtifact);

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "reask-antidrift-worker"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
  });

  const store = new SwarmStore(workspace);
  try {
    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "blocked");

    const reaskEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.structured_result_reask" && item.actor === "reask-antidrift-worker");
    assert.equal(reaskEvents.length, 0, "missing_result must NOT trigger a re-ask");

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "reask-antidrift-worker");
    assert.equal(completed?.payload.ok, false);
    assert.equal(completed?.payload.failureClass, "missing_result");
  } finally {
    store.close();
  }
});

test("anti-drift: a crashed run (non-zero exit, no result event, no artifact) blocks WITHOUT re-asking", () => {
  const { workspace, sliceId, fakeCodexScript } = setupRun("reask-crash", writeFakeCodexCrash);

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "reask-crash-worker"], {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([fakeCodexScript]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
  });

  const store = new SwarmStore(workspace);
  try {
    const slice = store.listSlices().find((item) => item.id === sliceId);
    assert.equal(slice?.status, "blocked");
    const run = store.listAgentRuns().find((item) => item.actor === "reask-crash-worker");
    assert.equal(run?.status, "failed");

    // A genuine run failure (no structured result was ever produced) must NEVER be re-asked:
    // re-asking these would mask real failures (anti-drift).
    const reaskEvents = store
      .listEvents()
      .filter((item) => item.type === "worker.structured_result_reask" && item.actor === "reask-crash-worker");
    assert.equal(reaskEvents.length, 0, "a crashed run / no-result must NOT trigger a re-ask");

    const completed = store
      .listEvents()
      .find((item) => item.type === "worker.completed" && item.actor === "reask-crash-worker");
    assert.equal(completed?.payload.ok, false);
    // codex never produced an artifact, so finalize labels this missing_result, NOT schema_invalid.
    assert.equal(completed?.payload.failureClass, "missing_result");
    assert.notEqual(completed?.payload.failureClass, "schema_invalid");
  } finally {
    store.close();
  }
});

function setupRun(label, writeFake) {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-${label}-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  const fakeCodexDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeCodexScript = path.join(fakeCodexDir, `fake-codex-${label}.mjs`);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  writeFake(fakeCodexScript);

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);
  return { workspace, sliceId, fakeCodexScript };
}

function runSwarm(workspace, args, extraEnv) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

const VALID_RESULT_JS = `JSON.stringify({
  status: "passed",
  summary: "fake codex completed",
  changedFiles: [],
  commandsRun: ["npm test"],
  testsRun: ["npm test"],
  frAcCoverage: [
    { ref: "AC-INV-001.1", status: "covered", evidence: "fake evidence" },
    { ref: "AC-INV-001.2", status: "covered", evidence: "fake evidence" },
    { ref: "AC-INV-001.3", status: "covered", evidence: "fake evidence" }
  ],
  risks: [],
  nextRecommendation: "continue"
}) + "\\n"`;

// status:"passed" alone is missing the required worker-result fields -> safeParse fails -> schema_invalid.
const INVALID_RESULT_JS = `JSON.stringify({ status: "passed" }) + "\\n"`;

function fakeCodexProgram(body) {
  return `import fs from "node:fs";
const args = process.argv.slice(2);
const isResume = args.includes("resume");
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
${body}
console.log(JSON.stringify({ type: "turn.completed" }));
`;
}

// TEST 1: invalid on the first (non-resume) call, valid on every resume.
function writeFakeCodexInvalidThenValidOnResume(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    fakeCodexProgram(`if (outputPath) {
  fs.writeFileSync(outputPath, isResume ? (${VALID_RESULT_JS}) : (${INVALID_RESULT_JS}), "utf8");
}`),
    "utf8",
  );
}

// TEST 2/3: schema-invalid on EVERY call, including resumes.
function writeFakeCodexAlwaysInvalid(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    fakeCodexProgram(`if (outputPath) {
  fs.writeFileSync(outputPath, ${INVALID_RESULT_JS}, "utf8");
}`),
    "utf8",
  );
}

// Anti-drift: never write an artifact -> codex finalize = missing_result (a real run failure).
function writeFakeCodexNoArtifact(scriptPath) {
  fs.writeFileSync(scriptPath, fakeCodexProgram(``), "utf8");
}

// Anti-drift: a genuine crashed run. No result event, no artifact written, non-zero exit
// (the turn.completed is never reached). codex finalize = missing_result -> blocks, no re-ask.
function writeFakeCodexCrash(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
console.error("fake codex crashed before producing a result");
process.exit(1);
`,
    "utf8",
  );
}
