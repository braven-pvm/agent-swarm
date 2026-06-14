import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwarmStore } from "../dist/storage.js";
import { ingestWorkerJsonl } from "../dist/worker-events.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("ingests worker JSONL as events, heartbeat updates, parse failures, and session id", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-worker-events-${process.pid}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  const store = new SwarmStore(workspace);
  try {
    store.init();
    const result = ingestWorkerJsonl({
      store,
      actor: "worker-events-test",
      sliceId: "SLICE-test",
      driver: "codex",
      jsonl: [
        JSON.stringify({ type: "session.started", session_id: "session-123" }),
        JSON.stringify({ type: "apply_patch", detail: "editing files" }),
        "not-json",
      ].join("\n"),
    });

    assert.equal(result.eventCount, 2);
    assert.equal(result.parseErrorCount, 1);
    assert.equal(result.sessionId, "session-123");
    assert.deepEqual(result.inferredStates, ["thinking", "editing"]);

    const events = store.listEvents();
    const agentEvents = events.filter((event) => event.type === "worker.agent_event");
    assert.equal(agentEvents.length, 2);
    assert.equal(agentEvents[0].payload.driver, "codex");
    assert.ok(agentEvents.some((event) => event.payload.agentEventType === "session.started"));
    assert.equal(events.filter((event) => event.type === "worker.agent_event.parse_failed").length, 1);
    assert.equal(
      events.find((event) => event.type === "worker.agent_event.parse_failed")?.payload.driver,
      "codex",
    );
    const heartbeat = store.listHeartbeats().find((item) => item.actor === "worker-events-test");
    assert.equal(heartbeat?.state, "editing");
    assert.equal(heartbeat?.entityId, "SLICE-test");
  } finally {
    store.close();
  }
});

test("classifies structured command events before text fallback", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-worker-events-structured-${process.pid}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  const store = new SwarmStore(workspace);
  try {
    store.init();
    const result = ingestWorkerJsonl({
      store,
      actor: "worker-events-structured-test",
      sliceId: "SLICE-test",
      driver: "codex",
      jsonl: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test",
            status: "completed",
            exit_code: 0,
            aggregated_output: "fail 0\\nfailed assertions []",
          },
        }),
      ].join("\n"),
    });

    assert.deepEqual(result.inferredStates, ["testing"]);
    const heartbeat = store.listHeartbeats().find((item) => item.actor === "worker-events-structured-test");
    assert.equal(heartbeat?.state, "testing");
    assert.match(heartbeat?.detail ?? "", /npm test/);
  } finally {
    store.close();
  }
});

test("classifies nonzero structured command events as blocked", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-worker-events-blocked-${process.pid}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  const store = new SwarmStore(workspace);
  try {
    store.init();
    const result = ingestWorkerJsonl({
      store,
      actor: "worker-events-blocked-test",
      sliceId: "SLICE-test",
      driver: "codex",
      jsonl: [
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test",
            status: "completed",
            exit_code: 1,
          },
        }),
      ].join("\n"),
    });

    assert.deepEqual(result.inferredStates, ["blocked"]);
    const heartbeat = store.listHeartbeats().find((item) => item.actor === "worker-events-blocked-test");
    assert.equal(heartbeat?.state, "blocked");
    assert.match(heartbeat?.detail ?? "", /npm test/);
  } finally {
    store.close();
  }
});

test("ingest stores interpreted activity on the agent_event payload", () => {
  // self-contained store — do not depend on a helper that may be named differently in this file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-wev-activity-"));
  const store = new SwarmStore(dir);
  store.init();
  const result = ingestWorkerJsonl({
    store,
    actor: "activity-test",
    sliceId: "SLICE-test",
    driver: "codex",
    jsonl: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test", status: "completed", exit_code: 0 } }),
  });
  assert.ok(result.eventCount >= 1);
  const events = store.recentEvents(10).filter((e) => e.type.endsWith("agent_event"));
  const activity = events[0].payload.activity;
  assert.equal(activity.state, "testing");
  assert.equal(activity.target, "npm test");
  assert.match(activity.label, /npm test/);
  store.close();
});
