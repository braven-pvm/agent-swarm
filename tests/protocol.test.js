import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultProtocol, loadProtocol } from "../dist/protocol.js";

test("loads default protocol when target has no override", () => {
  const protocol = defaultProtocol();

  assert.equal(protocol.protocol.planning.heartbeat.defaultStaleAfterSeconds, 300);
  assert.equal(protocol.protocol.recovery.reviveRetries, 2);
  assert.equal(protocol.protocol.recovery.highlightFinalAttempt, true);
  assert.equal(protocol.protocol.recovery.childIdleTimeoutSeconds, 0);
});

test("merges target protocol override without dropping defaults", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-protocol-"));
  fs.mkdirSync(path.join(target, ".swarm"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  planning:
    heartbeat:
      defaultStaleAfterSeconds: 45
  recovery:
    reviveRetries: 4
`,
    "utf8",
  );

  const protocol = loadProtocol(target);

  assert.equal(protocol.protocol.planning.heartbeat.defaultStaleAfterSeconds, 45);
  assert.equal(protocol.protocol.planning.heartbeat.inferFromEvents, true);
  assert.equal(protocol.protocol.recovery.reviveRetries, 4);
  assert.equal(protocol.protocol.recovery.highlightFinalAttempt, true);
  assert.equal(protocol.protocol.recovery.childIdleTimeoutSeconds, 0);
  assert.equal(protocol.protocol.verification?.behaviorFirst, true);
});

test("default protocol exposes worker driver configuration", () => {
  const protocol = defaultProtocol();

  assert.equal(protocol.protocol.workers.defaultDriver, "codex");
  assert.equal(protocol.protocol.workers.drivers.codex.sandbox, "workspace-write");
  assert.equal(protocol.protocol.workers.drivers.claude.permissionMode, "acceptEdits");
  assert.equal(protocol.protocol.workers.drivers.claude.settingSources, "");
});

test("merges workers override without dropping driver defaults", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-protocol-workers-"));
  fs.mkdirSync(path.join(target, ".swarm"), { recursive: true });
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  workers:
    defaultDriver: claude
    verboseLogging: true
    drivers:
      claude:
        maxBudgetUsd: 5
`,
    "utf8",
  );

  const protocol = loadProtocol(target);

  assert.equal(protocol.protocol.workers.defaultDriver, "claude");
  assert.equal(protocol.protocol.workers.verboseLogging, true);
  assert.equal(protocol.protocol.workers.drivers.claude.maxBudgetUsd, 5);
  assert.equal(protocol.protocol.workers.drivers.claude.permissionMode, "acceptEdits");
  assert.equal(protocol.protocol.workers.drivers.codex.sandbox, "workspace-write");
});
