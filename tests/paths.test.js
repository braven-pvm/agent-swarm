import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveWorkspace } from "../dist/paths.js";

test("resolveWorkspace honors SWARM_WORKSPACE override", () => {
  const previous = process.env.SWARM_WORKSPACE;
  try {
    process.env.SWARM_WORKSPACE = "X:\\repositories\\agent-swarm\\.swarm-demo\\example";
    assert.equal(
      resolveWorkspace("X:\\repositories\\agent-swarm\\.swarm-demo\\example\\target"),
      path.resolve("X:\\repositories\\agent-swarm\\.swarm-demo\\example"),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.SWARM_WORKSPACE;
    } else {
      process.env.SWARM_WORKSPACE = previous;
    }
  }
});
