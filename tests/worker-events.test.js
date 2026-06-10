import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
    const heartbeat = store.listHeartbeats().find((item) => item.actor === "worker-events-test");
    assert.equal(heartbeat?.state, "editing");
    assert.equal(heartbeat?.entityId, "SLICE-test");
  } finally {
    store.close();
  }
});
