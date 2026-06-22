import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRunGuards } from "../dist/orchestrator.js";

// H1 acceptance-loop defaults; the function is limit-agnostic — limits are inputs.
const limits = { maxRuntimeSeconds: 600, maxSlices: 5, maxAgentRuns: 12 };

/** Below-all-limits base input (at the equal boundary for runtime/slices/agent-runs). */
function baseInput(overrides = {}) {
  return {
    elapsedSeconds: 600,
    sourceMutated: false,
    sliceCount: 5,
    agentRunCount: 12,
    limits,
    ...overrides,
  };
}

test("below all limits returns {stop:false} (strict > boundary, equal does not trip)", () => {
  assert.deepEqual(evaluateRunGuards(baseInput()), { stop: false });
});

test("runtime boundary trips at elapsed > maxRuntimeSeconds with exact reason", () => {
  assert.deepEqual(evaluateRunGuards(baseInput({ elapsedSeconds: 601 })), {
    stop: true,
    kind: "runtime",
    outcome: "blocked",
    reason: "Max runtime exceeded: 601s > 600s.",
  });
});

test("slices boundary trips at sliceCount > maxSlices with exact reason", () => {
  assert.deepEqual(evaluateRunGuards(baseInput({ sliceCount: 6 })), {
    stop: true,
    kind: "slices",
    outcome: "blocked",
    reason: "Max slices exceeded: 6 > 5.",
  });
});

test("agent-runs boundary trips at agentRunCount > maxAgentRuns with exact reason", () => {
  assert.deepEqual(evaluateRunGuards(baseInput({ agentRunCount: 13 })), {
    stop: true,
    kind: "agent-runs",
    outcome: "blocked",
    reason: "Max agent runs exceeded: 13 > 12.",
  });
});

test("source-mutation trips on boolean with human_required and NO baked reason string", () => {
  const decision = evaluateRunGuards(baseInput({ sourceMutated: true }));
  assert.equal(decision.stop, true);
  assert.equal(decision.kind, "source-mutation");
  assert.equal(decision.outcome, "human_required");
  // The divergent runner literals must NOT leak into src — runner supplies finalReason.
  assert.equal(decision.reason, "");
  assert.ok(!decision.reason.includes("live acceptance loop"));
  assert.ok(!decision.reason.includes("H2 live run"));
});

test("order: runtime is evaluated before slices", () => {
  const decision = evaluateRunGuards(baseInput({ elapsedSeconds: 601, sliceCount: 999 }));
  assert.equal(decision.kind, "runtime");
});

test("order: source-mutation is unconditional, winning over slices and agent-runs", () => {
  const decision = evaluateRunGuards(
    baseInput({ sourceMutated: true, sliceCount: 999, agentRunCount: 999 }),
  );
  assert.equal(decision.kind, "source-mutation");
});

test("order: runtime is evaluated before source-mutation", () => {
  const decision = evaluateRunGuards(baseInput({ elapsedSeconds: 601, sourceMutated: true }));
  assert.equal(decision.kind, "runtime");
});

test("limit-agnostic: H2 defaults produce reasons from the supplied limits", () => {
  const h2Limits = { maxRuntimeSeconds: 9000, maxSlices: 24, maxAgentRuns: 180 };
  const decision = evaluateRunGuards({
    elapsedSeconds: 9001,
    sourceMutated: false,
    sliceCount: 0,
    agentRunCount: 0,
    limits: h2Limits,
  });
  assert.deepEqual(decision, {
    stop: true,
    kind: "runtime",
    outcome: "blocked",
    reason: "Max runtime exceeded: 9001s > 9000s.",
  });
});
