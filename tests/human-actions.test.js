import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// buildHumanActionQueue() — the worker repair-proof blocker is AGENT-RESOLVABLE
// and must NOT enter the human-action queue (nor be counted in totals.blockers),
// while every OTHER blocker is unchanged and still surfaces as a clear_blocker.
//
// Lifecycle (src/cli.ts): a repair-proof failure raises a single blocker whose
// message === WORKER_REPAIR_PROOF_BLOCKER_MESSAGE; it auto-clears when a later
// worker result passes the gate. So it belongs on the concerns surface
// (activeEscalations) but never in the human queue.
// ---------------------------------------------------------------------------
async function seedStore() {
  const { SwarmStore } = await import("../dist/storage.js");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-human-actions-"));
  const store = new SwarmStore(workspace);
  store.init();
  return store;
}

function makeEscalation(overrides) {
  const now = new Date().toISOString();
  return {
    id: "ESC",
    level: "blocker",
    status: "active",
    entityType: "slice",
    entityId: "SLICE-1",
    message: "msg",
    reason: "reason",
    createdBy: "worker",
    clearedBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("buildHumanActionQueue excludes the worker repair-proof blocker but keeps a generic blocker", async () => {
  const { buildHumanActionQueue, WORKER_REPAIR_PROOF_BLOCKER_MESSAGE } = await import("../dist/human-actions.js");
  const store = await seedStore();

  const repairId = "ESC-repair-proof";
  const genericId = "ESC-generic";

  store.insertEscalation(
    makeEscalation({
      id: repairId,
      message: WORKER_REPAIR_PROOF_BLOCKER_MESSAGE,
      reason: "missing repair acknowledgement for AC-1",
    }),
  );
  store.insertEscalation(
    makeEscalation({
      id: genericId,
      entityId: "SLICE-2",
      message: "Generic blocker that needs a human to clear it.",
      reason: "something is stuck",
    }),
  );

  const queue = buildHumanActionQueue(store);

  const repairAction = queue.actions.find((a) => a.id === `escalation:${repairId}`);
  assert.equal(repairAction, undefined, "repair-proof blocker must NOT be in the queue");
  assert.ok(
    !queue.actions.some((a) => a.summary === WORKER_REPAIR_PROOF_BLOCKER_MESSAGE),
    "no action should carry the repair-proof message",
  );

  const genericAction = queue.actions.find((a) => a.id === `escalation:${genericId}`);
  assert.ok(genericAction, "the generic blocker must still be present");
  assert.equal(genericAction.kind, "clear_blocker");

  assert.equal(queue.totals.blockers, 1, "only the generic blocker is counted");

  // The repair-proof escalation must remain on the concerns surface (active list).
  const active = store.listEscalations("active");
  assert.ok(active.some((e) => e.id === repairId), "repair-proof escalation stays active");
});
