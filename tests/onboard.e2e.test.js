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

function freshRepo(name) {
  const ws = path.join(repoRoot, ".swarm-demo", `${name}-${process.pid}-${Date.now()}`);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.cpSync(template, ws, { recursive: true });
  return ws;
}

function run(ws, args, extraEnv = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: ws,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
}

test("onboard sets up a repo and registers a sample spec, idempotently", () => {
  const ws = freshRepo("test-onboard");

  const out = run(ws, ["onboard"]);
  assert.match(out, /onboard/i);

  // state + config
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "state.db")));
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "target.yaml")));
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "protocol.yaml")));

  // gitignore split
  const gitignore = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".swarm/state.db*"));
  assert.ok(gitignore.includes("/schemas/worker-result.schema.json"));
  assert.ok(!gitignore.includes(".swarm/target.yaml"));

  // sample spec scaffolded + registered
  assert.ok(fs.existsSync(path.join(ws, "docs", "specs", "onboarding-sample.md")));
  let sources;
  {
    const store = new SwarmStore(ws);
    try {
      sources = store.listSources();
    } finally {
      store.close();
    }
  }
  assert.equal(sources.length, 1);
  assert.ok(sources[0].uri.endsWith("onboarding-sample.md"));

  // pull works immediately (no worker needed). The target name is the workspace dir
  // basename (initTarget uses path.basename(repoPath)), NOT "invoice-api".
  const targetName = path.basename(ws);
  const pull = run(ws, ["slices", "pull", "--target", targetName, "--source", "onboarding-sample.md", "--batch-size", "1"]);
  assert.match(pull, /Created slice (SLICE-[a-f0-9]+)/i);

  // idempotency: second onboard adds no duplicate source, no duplicate gitignore block
  run(ws, ["onboard"]);
  const store2 = new SwarmStore(ws);
  try {
    assert.equal(store2.listSources().length, 1);
  } finally {
    store2.close();
  }
  const gitignore2 = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.equal(gitignore2.split("agent-swarm harness runtime state").length - 1, 1);
});

test("onboard --source registers an existing spec and does not scaffold the sample", () => {
  const ws = freshRepo("test-onboard-source");
  const specPath = path.join(ws, "specs", "invoice-api.md"); // ships in the fixture template
  assert.ok(fs.existsSync(specPath));

  run(ws, ["onboard", "--source", specPath]);

  assert.ok(!fs.existsSync(path.join(ws, "docs", "specs", "onboarding-sample.md")));
  const store = new SwarmStore(ws);
  try {
    const sources = store.listSources();
    assert.equal(sources.length, 1);
    assert.ok(sources[0].uri.endsWith("invoice-api.md"));
  } finally {
    store.close();
  }
});

test("onboard completes with a soft warning in a non-git directory", () => {
  const ws = freshRepo("test-onboard-nongit");
  // freshRepo copies the template (no .git), so this is already non-git.
  const out = run(ws, ["onboard"]);
  assert.match(out, /not a git repo|no git repo|git/i);
  assert.ok(fs.existsSync(path.join(ws, ".swarm", "state.db")));
});
