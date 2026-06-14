import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tail-"));
  const store = new SwarmStore(dir);
  store.init();
  return store;
}

test("eventsSince returns only rows after the cursor in order", () => {
  const store = tmpStore();
  store.addEvent(createEvent({ actor: "a", type: "x.one", entityType: "harness", entityId: "h" }));
  store.addEvent(createEvent({ actor: "a", type: "x.two", entityType: "harness", entityId: "h" }));
  const all = store.eventsSince({ lastRowid: 0 }, 100);
  assert.equal(all.length, 2);
  const rest = store.eventsSince({ lastRowid: all[0].rowid }, 100);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].type, "x.two");
  assert.ok(typeof rest[0].rowid === "number");
  store.close();
});

test("heartbeatsSince returns rows strictly after timestamp", () => {
  const store = tmpStore();
  const hb = store.upsertHeartbeat({ actor: "w", state: "thinking" });
  const since = store.heartbeatsSince(hb.timestamp);
  assert.equal(since.length, 0);
  const before = store.heartbeatsSince("");
  assert.equal(before.length, 1);
  store.close();
});
