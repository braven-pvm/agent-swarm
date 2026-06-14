import test from "node:test";
import assert from "node:assert/strict";
import { interpretAgentEvent } from "../dist/activity-interpreter.js";

test("codex command_execution → testing with command target + label", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "npm test", status: "completed", exit_code: 0 },
  });
  assert.equal(a.state, "testing");
  assert.equal(a.target, "npm test");
  assert.match(a.label, /npm test/);
});

test("codex file_change → editing with file target", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "file_change", status: "completed", changes: [{ path: "src/invoices.js" }] },
  });
  assert.equal(a.state, "editing");
  assert.equal(a.target, "src/invoices.js");
});

test("codex failure → blocked", () => {
  const a = interpretAgentEvent({
    type: "item.completed",
    item: { type: "command_execution", command: "npm test", status: "failed", exit_code: 1 },
  });
  assert.equal(a.state, "blocked");
});

test("codex thread.started → thinking", () => {
  assert.equal(interpretAgentEvent({ type: "thread.started" }).state, "thinking");
});

test("codex regex fallback for unstructured apply_patch → editing", () => {
  assert.equal(interpretAgentEvent({ type: "apply_patch", detail: "x" }).state, "editing");
});

test("claude tool_use is honored via driverClassify", () => {
  const driverClassify = (e) => (e.type === "assistant" ? "editing" : undefined);
  const a = interpretAgentEvent(
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } },
    { driver: "claude", driverClassify },
  );
  assert.equal(a.state, "editing");
  assert.equal(a.target, "a.ts");
});

test("unknown event defaults to thinking with a generic label", () => {
  const a = interpretAgentEvent({ type: "mystery" });
  assert.equal(a.state, "thinking");
  assert.ok(a.label.length > 0);
});
