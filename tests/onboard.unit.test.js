import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGitignoreBlock, scaffoldSampleSpec, GITIGNORE_MARKER } from "../dist/onboard.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swarm-onboard-unit-"));
}

test("ensureGitignoreBlock creates .gitignore with the managed block when missing", () => {
  const repo = tempRepo();
  const result = ensureGitignoreBlock(repo);
  assert.equal(result.added, true);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.ok(content.includes(GITIGNORE_MARKER));
  assert.ok(content.includes(".swarm/state.db*"));
  assert.ok(content.includes(".swarm/artifacts/"));
  assert.ok(content.includes("/schemas/worker-result.schema.json"));
  // config files are NOT ignored
  assert.ok(!content.includes(".swarm/target.yaml"));
  assert.ok(!content.includes(".swarm/protocol.yaml"));
});

test("ensureGitignoreBlock appends to an existing .gitignore without clobbering it", () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
  const result = ensureGitignoreBlock(repo);
  assert.equal(result.added, true);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.ok(content.startsWith("node_modules/\n"));
  assert.ok(content.includes(GITIGNORE_MARKER));
});

test("ensureGitignoreBlock is idempotent (no duplicate block on re-run)", () => {
  const repo = tempRepo();
  ensureGitignoreBlock(repo);
  const second = ensureGitignoreBlock(repo);
  assert.equal(second.added, false);
  const content = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.equal(content.split(GITIGNORE_MARKER).length - 1, 1);
});

test("scaffoldSampleSpec writes a valid sample spec with FR/AC refs when absent", () => {
  const repo = tempRepo();
  const result = scaffoldSampleSpec(repo);
  assert.equal(result.created, true);
  assert.equal(result.path, path.join(repo, "docs", "specs", "onboarding-sample.md"));
  const text = fs.readFileSync(result.path, "utf8");
  assert.ok(text.includes("FR-ONB-001"));
  assert.ok(text.includes("AC-ONB-001.1"));
  assert.ok(/^Domain:\s*Onboarding/m.test(text));
});

test("scaffoldSampleSpec is idempotent (does not overwrite an existing sample)", () => {
  const repo = tempRepo();
  scaffoldSampleSpec(repo);
  fs.writeFileSync(path.join(repo, "docs", "specs", "onboarding-sample.md"), "EDITED", "utf8");
  const second = scaffoldSampleSpec(repo);
  assert.equal(second.created, false);
  assert.equal(fs.readFileSync(second.path, "utf8"), "EDITED");
});
