import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SwarmStore } from "../dist/storage.js";
import { createEvent } from "../dist/events.js";
import { EventTailer } from "../dist/event-tailer.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tailer-"));
  const store = new SwarmStore(dir);
  store.init();
  return store;
}

test("tailer emits new events and changed heartbeats, not duplicates", async () => {
  const store = tmpStore();
  const events = [];
  const heartbeats = [];
  const tailer = new EventTailer(store, { intervalMs: 20, onEvent: (e) => events.push(e), onHeartbeat: (h) => heartbeats.push(h) });
  tailer.start();
  store.addEvent(createEvent({ actor: "a", type: "x.one", entityType: "harness", entityId: "h" }));
  store.upsertHeartbeat({ actor: "w", state: "thinking" });
  await new Promise((r) => setTimeout(r, 80));
  store.upsertHeartbeat({ actor: "w", state: "thinking" }); // unchanged → no new emit
  store.upsertHeartbeat({ actor: "w", state: "editing" });  // changed → emit
  await new Promise((r) => setTimeout(r, 80));
  tailer.stop();
  assert.equal(events.filter((e) => e.type === "x.one").length, 1);
  const states = heartbeats.filter((h) => h.actor === "w").map((h) => h.state);
  assert.deepEqual(states, ["thinking", "editing"]);
  store.close();
});
