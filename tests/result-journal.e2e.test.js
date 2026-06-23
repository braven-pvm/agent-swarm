import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { computeEnvelopeKey } from "../dist/result-journal.js";

// OCF-3 (CONTESTED, opt-in prototype) — content-addressed worker-RESULT journal.
//
// These tests prove the MECHANISM and the SAFETY boundaries, with the spawn count measured by a marker
// file the fake codex appends to on EVERY invocation:
//   (a) flag ON + identical envelope -> 2nd run is a HIT that replays the byte-identical validated result
//       WITHOUT a 2nd spawn (marker count stays 1) and emits worker.journal_hit;
//   (b) changing an envelope field (model) -> MISS -> a real re-spawn (marker count increments);
//   (c) a source-spec MUTATION -> different registered source hash -> MISS -> re-spawn (immutability);
//   (d) flag OFF (default) -> no journal dir, no journal events, behavior unchanged;
//   (e) only a SCHEMA-VALID result is stored (an invalid worker result never lands in the journal).

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

function setupWorkspace(label) {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-result-journal-${label}-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
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
  assert.ok(sliceId, "expected a slice to be created");
  return { workspace, target, sliceId };
}

function runSwarm(workspace, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

// A fake codex that (1) appends one line to a marker file on EVERY invocation (the spawn counter) and
// (2) writes a schema-valid worker result. `validResult=false` writes a schema-INVALID result.
function writeCountingFakeCodex(scriptPath, markerPath, { validResult = true } = {}) {
  const validBody = `{
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
  }`;
  // Intentionally invalid: status is not in the schema enum and required arrays are missing.
  const invalidBody = `{ status: "definitely-not-a-valid-status", note: "schema invalid on purpose" }`;
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(markerPath)}, "spawn\\n");
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
if (outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(${validResult ? validBody : invalidBody}) + "\\n", "utf8");
}
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    "utf8",
  );
}

function spawnCount(markerPath) {
  if (!fs.existsSync(markerPath)) return 0;
  return fs
    .readFileSync(markerPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() === "spawn").length;
}

function codexEnv(scriptPath, extra = {}) {
  return {
    SWARM_CODEX_COMMAND: process.execPath,
    SWARM_CODEX_ARGS: JSON.stringify([scriptPath]),
    SWARM_AGENT_IDLE_TIMEOUT_SECONDS: "30",
    ...extra,
  };
}

function readEvents(workspace, type, actor) {
  const store = new SwarmStore(workspace);
  try {
    return store.listEvents().filter((event) => event.type === type && (actor ? event.actor === actor : true));
  } finally {
    store.close();
  }
}

function readResultJson(workspace, sliceId) {
  const store = new SwarmStore(workspace);
  try {
    const run = store
      .listAgentRuns()
      .filter((item) => item.sliceId === sliceId && item.role === "worker" && item.resultPath)
      .slice(-1)[0];
    assert.ok(run?.resultPath, "expected latest worker run to record a result path");
    return fs.readFileSync(run.resultPath, "utf8");
  } finally {
    store.close();
  }
}

test("OCF-3 (a): journal ON + identical envelope -> HIT replays the byte-identical result without a 2nd spawn", () => {
  const { workspace, sliceId } = setupWorkspace("hit");
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeScript = path.join(fakeDir, "fake-codex.mjs");
  const marker = path.join(fakeDir, "spawns.log");
  writeCountingFakeCodex(fakeScript, marker);
  const env = codexEnv(fakeScript, { SWARM_RESULT_JOURNAL: "1" });

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-hit"], env);
  assert.equal(spawnCount(marker), 1, "first run must spawn the worker exactly once (MISS)");
  const firstResult = readResultJson(workspace, sliceId);
  const storeEvents = readEvents(workspace, "worker.journal_store");
  assert.equal(storeEvents.length, 1, "MISS must store the validated result");

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-hit"], env);
  assert.equal(spawnCount(marker), 1, "second run must be a HIT and NOT spawn the worker again");
  const secondResult = readResultJson(workspace, sliceId);
  const journalEntry = JSON.parse(
    fs.readFileSync(
      path.join(workspace, ".swarm", "result-journal", fs.readdirSync(path.join(workspace, ".swarm", "result-journal"))[0]),
      "utf8",
    ),
  );
  // The HIT replays the stored VALIDATED VALUE through the shared persist core (canonical 2-space JSON),
  // exactly as a fresh validated result is persisted. Defaults such as repairProof: [] are materialized in
  // the journal value even when the raw first-run fake artifact omitted them.
  assert.deepEqual(JSON.parse(secondResult), journalEntry.result, "HIT must replay the stored validated value");
  assert.equal(secondResult, `${JSON.stringify(journalEntry.result, null, 2)}\n`, "HIT writes the canonical persisted validated result");

  const hitEvents = readEvents(workspace, "worker.journal_hit");
  assert.equal(hitEvents.length, 1, "exactly one journal_hit event expected");
  assert.match(String(hitEvents[0].payload.resultPath), /worker-result-RUN-[A-Za-z0-9-]+\.json$/);
  assert.match(String(hitEvents[0].payload.soundnessNote), /contested boundary/i);

  // The journal entry exists on disk under .swarm/result-journal/.
  const journalDir = path.join(workspace, ".swarm", "result-journal");
  const entries = fs.readdirSync(journalDir).filter((name) => name.endsWith(".json"));
  assert.equal(entries.length, 1, "exactly one journal entry expected");
});

test("OCF-3 (b): changing an envelope field (model) -> MISS -> a real re-spawn", () => {
  const { workspace, sliceId } = setupWorkspace("model");
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeScript = path.join(fakeDir, "fake-codex.mjs");
  const marker = path.join(fakeDir, "spawns.log");
  writeCountingFakeCodex(fakeScript, marker);
  const env = codexEnv(fakeScript, { SWARM_RESULT_JOURNAL: "1" });

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-model", "--model", "model-a"], env);
  assert.equal(spawnCount(marker), 1);

  // Same slice, same prompt, same driver — but a different model => different key => MISS => re-spawn.
  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-model", "--model", "model-b"], env);
  assert.equal(spawnCount(marker), 2, "a different model must produce a MISS and a real re-spawn");
  assert.equal(readEvents(workspace, "worker.journal_hit").length, 0, "no HIT expected across distinct models");
});

test("OCF-3 (c): a source-spec MUTATION -> different source hash -> MISS -> re-spawn (immutability)", () => {
  const { workspace, target, sliceId } = setupWorkspace("mutate");
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeScript = path.join(fakeDir, "fake-codex.mjs");
  const marker = path.join(fakeDir, "spawns.log");
  writeCountingFakeCodex(fakeScript, marker);
  const env = codexEnv(fakeScript, { SWARM_RESULT_JOURNAL: "1" });

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-mutate"], env);
  assert.equal(spawnCount(marker), 1);

  // MUTATE the registered immutable source file on disk AND re-register it so the slice's source hash
  // changes. The journal key includes the registered source hash, so this MUST be a MISS.
  const specPath = path.join(target, "specs", "invoice-api.md");
  fs.appendFileSync(specPath, "\n\n<!-- OCF-3 immutability probe: mutated source content -->\n");
  // Re-pull so a fresh slice carries the NEW source hash (sources add-file re-registers the hash).
  runSwarm(workspace, ["sources", "add-file", specPath]);
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
  const mutatedSliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1] ?? sliceId;

  runSwarm(workspace, ["run", mutatedSliceId, "--driver", "codex", "--actor", "journal-mutate"], env);
  assert.equal(spawnCount(marker), 2, "a mutated source hash must produce a MISS and a real re-spawn");
});

test("OCF-3 (d): journal OFF (default) -> no journal dir, no journal events, behavior unchanged", () => {
  const { workspace, sliceId } = setupWorkspace("off");
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeScript = path.join(fakeDir, "fake-codex.mjs");
  const marker = path.join(fakeDir, "spawns.log");
  writeCountingFakeCodex(fakeScript, marker);
  const env = codexEnv(fakeScript); // SWARM_RESULT_JOURNAL intentionally unset -> default OFF

  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-off"], env);
  runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-off"], env);

  // With the journal OFF, BOTH runs spawn (no replay) and nothing journal-related is created.
  assert.equal(spawnCount(marker), 2, "with the journal off, every run must spawn (no replay)");
  assert.equal(fs.existsSync(path.join(workspace, ".swarm", "result-journal")), false, "no journal dir when off");
  assert.equal(readEvents(workspace, "worker.journal_hit").length, 0);
  assert.equal(readEvents(workspace, "worker.journal_store").length, 0);
});

test("OCF-3 (e): an invalid worker result is NEVER stored in the journal", () => {
  const { workspace, sliceId } = setupWorkspace("invalid");
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-swarm-fake-codex-"));
  const fakeScript = path.join(fakeDir, "fake-codex.mjs");
  const marker = path.join(fakeDir, "spawns.log");
  // Disable the in-turn re-ask so the invalid result is final, then assert nothing is stored.
  writeCountingFakeCodex(fakeScript, marker, { validResult: false });
  const env = codexEnv(fakeScript, { SWARM_RESULT_JOURNAL: "1", SWARM_STRUCTURED_RESULT_REASK_MAX: "0" });

  try {
    runSwarm(workspace, ["run", sliceId, "--driver", "codex", "--actor", "journal-invalid"], env);
  } catch {
    // a failed worker run may exit non-zero; we only care that nothing was journaled.
  }

  assert.equal(readEvents(workspace, "worker.journal_store").length, 0, "an invalid result must not be stored");
  const journalDir = path.join(workspace, ".swarm", "result-journal");
  const entries = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((n) => n.endsWith(".json")) : [];
  assert.equal(entries.length, 0, "no journal entry for an invalid result");
});

test("OCF-3 key: computeEnvelopeKey is stable, source-order-insensitive, and changes on any field", () => {
  const base = {
    prompt: "PROMPT",
    driver: "codex",
    model: "m1",
    resultSchemaJson: '{"a":1}',
    sourceHashes: [
      { uri: "b.md", title: "B", hash: "hb" },
      { uri: "a.md", title: "A", hash: "ha" },
    ],
  };
  const key = computeEnvelopeKey(base);
  // Reordering the source list does NOT change the key (order is not semantic for source identity).
  const reordered = computeEnvelopeKey({
    ...base,
    sourceHashes: [
      { uri: "a.md", title: "A", hash: "ha" },
      { uri: "b.md", title: "B", hash: "hb" },
    ],
  });
  assert.equal(reordered, key, "source ordering must not affect the key");

  // Any change to any field DOES change the key.
  assert.notEqual(computeEnvelopeKey({ ...base, prompt: "PROMPT2" }), key);
  assert.notEqual(computeEnvelopeKey({ ...base, driver: "claude" }), key);
  assert.notEqual(computeEnvelopeKey({ ...base, model: "m2" }), key);
  assert.notEqual(computeEnvelopeKey({ ...base, resultSchemaJson: '{"a":2}' }), key);
  assert.notEqual(
    computeEnvelopeKey({
      ...base,
      sourceHashes: [
        { uri: "b.md", title: "B", hash: "hb-MUTATED" },
        { uri: "a.md", title: "A", hash: "ha" },
      ],
    }),
    key,
    "a mutated source hash must change the key",
  );
});
