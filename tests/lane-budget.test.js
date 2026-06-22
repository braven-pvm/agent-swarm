import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmStore } from "../dist/storage.js";
import { pullNextSlice } from "../dist/planner.js";
import { loadProtocol, defaultProtocol } from "../dist/protocol.js";

// ---------------------------------------------------------------------------
// SC-2 — per-target active-lane budget enforcement at the planner lane-creation
// point. Below the cap, --new-lane creates a fresh lane (behavior unchanged).
// At/over the cap, a new-lane request is DEFERRED to reuse the oldest active
// lane, and a visible `scheduling.budget_applied` event is emitted.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env },
    encoding: "utf8",
  });
}

// Build a workspace with a registered target and a spec source carrying enough
// distinct FR/AC refs that several --new-lane pulls can each claim fresh refs.
function setupWorkspace(prefix, refs) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const target = path.join(workspace, "target");
  fs.mkdirSync(path.join(target, "specs"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ name: "budget-fixture", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);

  const store = new SwarmStore(workspace);
  try {
    const now = new Date().toISOString();
    const specUri = path.join(target, "specs", "budget.md");
    const body = refs.map((ref) => `- ${ref}: Behavior required by ${ref}.`).join("\n");
    fs.writeFileSync(specUri, `# Budget spec\n\n${body}\n`, "utf8");
    store.addOrUpdateSource({
      id: "SOURCE-budget",
      adapterId: "file",
      kind: "spec",
      uri: specUri,
      title: "Budget Spec",
      hash: "budget-hash",
      metadata: { domain: "Budget", tags: ["budget"], priority: 1, frAcRefs: refs },
      createdAt: now,
      updatedAt: now,
    });
    const targetName = store.listTargets()[0].name;
    return { workspace, store, targetName };
  } catch (error) {
    store.close();
    throw error;
  }
}

function budgetEvents(store) {
  return store.listEvents().filter((event) => event.type === "scheduling.budget_applied");
}

test("below the active-lane cap, --new-lane creates a fresh lane and emits no budget event", () => {
  // Default protocol cap is 3. Two --new-lane pulls stay below the cap.
  const refs = ["AC-BUD-001.1", "AC-BUD-002.1", "AC-BUD-003.1", "AC-BUD-004.1"];
  const { workspace, store, targetName } = setupWorkspace("swarm-budget-below", refs);
  try {
    const protocol = loadProtocol(workspace); // defaults: maxActiveLanes = 3
    const first = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });
    const second = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });

    assert.equal(first.reusedExistingLane, false);
    assert.equal(second.reusedExistingLane, false, "second --new-lane below cap must create a distinct lane");
    assert.notEqual(first.lane.id, second.lane.id);
    assert.equal(store.countActiveLanesForTarget(first.lane.targetId), 2);
    assert.equal(budgetEvents(store).length, 0, "no budget event should fire below the cap");
  } finally {
    store.close();
  }
});

test("at the active-lane cap, a --new-lane request is deferred to reuse the oldest active lane and emits a visible budget event", () => {
  // Per-target override pins the cap to 1 so the second --new-lane request is at cap.
  const refs = ["AC-BUD-001.1", "AC-BUD-002.1", "AC-BUD-003.1"];
  const { workspace, store, targetName } = setupWorkspace("swarm-budget-atcap", refs);
  try {
    const protocol = defaultProtocol();
    protocol.protocol.lanes.projectOverrides = { [targetName]: { maxActiveLanes: 1 } };

    const first = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });
    assert.equal(first.reusedExistingLane, false);
    assert.equal(budgetEvents(store).length, 0, "first lane is below cap; no budget event yet");

    // Second --new-lane request is now at cap (1 active lane, cap 1): defer + reuse.
    const second = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });
    assert.equal(second.reusedExistingLane, true, "at cap, the new-lane request must reuse the oldest active lane");
    assert.equal(second.lane.id, first.lane.id, "reused lane must be the oldest active lane for the target");
    assert.equal(store.countActiveLanesForTarget(first.lane.targetId), 1, "cap must hold the active lane count at 1");

    const events = budgetEvents(store);
    assert.equal(events.length, 1, "exactly one budget event should be emitted at cap");
    const payload = events[0].payload;
    assert.equal(payload.targetName, targetName);
    assert.equal(payload.requestedNewLane, true);
    assert.equal(payload.activeLaneCount, 1);
    assert.equal(payload.maxActiveLanes, 1);
    assert.equal(payload.reusedLaneId, first.lane.id);
    assert.equal(typeof payload.reason, "string");
    assert.ok(payload.reason.length > 0);
  } finally {
    store.close();
  }
});

test("lanes are created up to maxActiveLanes, then the next new-lane request reuses an active lane (count never exceeds the cap)", () => {
  // Single boundary, cap = 2, proving all three properties against one cap value:
  //   (a) creating lanes UP TO the cap works (2 distinct lanes, no budget event),
  //   (b) the next --new-lane request AT the cap reuses an existing active lane and
  //       emits exactly one scheduling.budget_applied event (count stays <= cap),
  //   (c) below-cap behavior is unchanged (no event for the first two creations).
  const refs = ["AC-BUD-001.1", "AC-BUD-002.1", "AC-BUD-003.1", "AC-BUD-004.1"];
  const { workspace, store, targetName } = setupWorkspace("swarm-budget-boundary", refs);
  try {
    const protocol = defaultProtocol();
    protocol.protocol.lanes.projectOverrides = { [targetName]: { maxActiveLanes: 2 } };
    const cap = 2;

    // (a)+(c) Create lanes up to the cap: each --new-lane below the cap creates a
    // fresh, distinct lane and emits no budget event.
    const created = [];
    for (let i = 0; i < cap; i += 1) {
      const result = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });
      assert.equal(result.reusedExistingLane, false, `lane #${i + 1} (below/at-boundary creation) must be a fresh lane`);
      created.push(result.lane.id);
    }
    const distinct = new Set(created);
    assert.equal(distinct.size, cap, "each below-cap --new-lane must yield a distinct lane");
    const targetId = pullNextSliceTargetId(store, targetName);
    assert.equal(store.countActiveLanesForTarget(targetId), cap, "active lane count must equal the cap after filling it");
    assert.equal(budgetEvents(store).length, 0, "no budget event should fire while at/under the cap during creation");

    // (b) The next --new-lane request is AT the cap: it must be deferred to reuse the
    // oldest active lane, the active count must NOT exceed the cap, and exactly one
    // scheduling.budget_applied event must be emitted.
    const oldest = store.firstActiveLaneForTarget(targetId);
    const overCap = pullNextSlice(store, { target: targetName, newLane: true, batchSize: 1, protocol });
    assert.equal(overCap.reusedExistingLane, true, "at cap, the new-lane request must reuse an existing active lane");
    assert.equal(overCap.lane.id, oldest.id, "reused lane must be the oldest active lane for the target");
    assert.ok(created.includes(overCap.lane.id), "reused lane must be one of the lanes created up to the cap");
    assert.equal(
      store.countActiveLanesForTarget(targetId),
      cap,
      "active lane count must stay <= cap after the at-cap reuse",
    );

    const events = budgetEvents(store);
    assert.equal(events.length, 1, "exactly one budget event should be emitted by the at-cap request");
    const payload = events[0].payload;
    assert.equal(payload.targetName, targetName);
    assert.equal(payload.requestedNewLane, true);
    assert.equal(payload.activeLaneCount, cap);
    assert.equal(payload.maxActiveLanes, cap);
    assert.equal(payload.reusedLaneId, oldest.id);
    assert.ok(typeof payload.reason === "string" && payload.reason.length > 0);
  } finally {
    store.close();
  }
});

// Resolve the registered target's id from its name without depending on planner internals.
function pullNextSliceTargetId(store, targetName) {
  const target = store.listTargets().find((t) => t.name === targetName);
  return target.id;
}
