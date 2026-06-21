import test from "node:test";
import assert from "node:assert/strict";
import {
  workerResultSchema,
  reviewResultSchema,
  overseerDecisionSchema,
} from "../dist/schemas.js";
import {
  zodToDriverJsonSchema,
  serializeDriverJsonSchema,
} from "../dist/schema-json.js";

// The single source of truth for each role's contract is the Zod schema in
// src/schemas.ts. The driver-facing JSON Schema is GENERATED from it. These tests
// assert the generated JSON Schema is equivalent-or-stricter than the Zod oracle and
// that generation is deterministic.

/** Minimal recursive JSON-Schema validator covering the constructs our schemas use:
 * object (with required + additionalProperties:false + properties), array (items),
 * string (+ enum), boolean. Returns true if `value` is valid against `schema`. */
function validateAgainstJsonSchema(schema, value) {
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) return false;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return false;
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value && !validateAgainstJsonSchema(sub, value[key])) return false;
    }
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.items) {
      for (const item of value) {
        if (!validateAgainstJsonSchema(schema.items, item)) return false;
      }
    }
    return true;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    return true;
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") return typeof value === "number";
  return true; // unconstrained
}

const validWorker = {
  status: "passed",
  summary: "implemented slice",
  changedFiles: ["src/app.ts"],
  commandsRun: ["npm test"],
  testsRun: ["npm test"],
  frAcCoverage: [{ ref: "AC-1", status: "covered", evidence: "test output" }],
  risks: [],
  nextRecommendation: "ship it",
};

const validReview = {
  status: "accepted",
  summary: "looks good",
  frAcFindings: [{ ref: "AC-1", status: "passed", evidence: ["log line"], finding: "ok" }],
  testAssessment: "tests exercise the runtime path",
  sourceMutationDetected: false,
  stubOrHardcodeRisk: "none",
  qualityGate: {
    status: "passed",
    summary: "all dimensions clear",
    dimensions: [
      { dimension: "runtime_path", status: "passed", risk: "none", evidence: ["x"], finding: "ok" },
    ],
    blockingConcerns: [],
    residualRisks: [],
  },
  requiredFixes: [],
  escalations: [{ level: "warning", message: "watch this" }],
  recommendation: "merge",
};

const validOverseer = {
  status: "recommend_commands",
  summary: "next steps",
  scenario: "invoice",
  currentPriority: "implement AC-1",
  recommendedCommands: [
    { command: "swarm work", purpose: "do work", expectedStateChange: "slice done", requiresHuman: false },
  ],
  lanePlan: [{ laneName: "lane-1", purpose: "build", nextAction: "start" }],
  blockers: [{ level: "warning", message: "tight", scope: "lane-1" }],
  stopCondition: "all FR/AC covered",
  nextAction: "run worker",
};

const roles = [
  {
    name: "worker",
    zodSchema: workerResultSchema,
    valid: validWorker,
    // The hand-written schema's top-level `required` set — the contract the driver is
    // held to. The generated schema must match this exactly.
    expectedRequired: [
      "status", "summary", "changedFiles", "commandsRun", "testsRun",
      "frAcCoverage", "risks", "nextRecommendation",
    ],
    // Malformed inputs both Zod safeParse AND the JSON Schema must reject.
    zodRejects: [
      { label: "missing required field", make: (v) => { const c = structuredClone(v); delete c.summary; return c; } },
      { label: "bad enum value", make: (v) => ({ ...structuredClone(v), status: "done" }) },
      { label: "wrong nested enum", make: (v) => { const c = structuredClone(v); c.frAcCoverage[0].status = "yes"; return c; } },
      { label: "wrong type for array", make: (v) => ({ ...structuredClone(v), risks: "none" }) },
      { label: "missing nested required field", make: (v) => { const c = structuredClone(v); delete c.frAcCoverage[0].evidence; return c; } },
    ],
    // Inputs Zod safeParse LENIENTLY accepts (it strips unknown keys) but the stricter
    // JSON Schema (additionalProperties:false) must reject — equivalent-or-stricter.
    stricterThanZod: [
      { label: "extra unknown top-level field", make: (v) => ({ ...structuredClone(v), bogus: true }) },
      { label: "extra unknown nested field", make: (v) => { const c = structuredClone(v); c.frAcCoverage[0].bogus = 1; return c; } },
    ],
  },
  {
    name: "review",
    zodSchema: reviewResultSchema,
    valid: validReview,
    expectedRequired: [
      "status", "summary", "frAcFindings", "testAssessment", "sourceMutationDetected",
      "stubOrHardcodeRisk", "qualityGate", "requiredFixes", "escalations", "recommendation",
    ],
    zodRejects: [
      { label: "missing required field", make: (v) => { const c = structuredClone(v); delete c.recommendation; return c; } },
      { label: "bad enum value", make: (v) => ({ ...structuredClone(v), status: "ok" }) },
      { label: "bad nested risk enum", make: (v) => { const c = structuredClone(v); c.qualityGate.dimensions[0].risk = "extreme"; return c; } },
      { label: "wrong type for boolean", make: (v) => ({ ...structuredClone(v), sourceMutationDetected: "no" }) },
    ],
    stricterThanZod: [
      { label: "extra unknown top-level field", make: (v) => ({ ...structuredClone(v), bogus: true }) },
      { label: "extra unknown nested qualityGate dimension field", make: (v) => { const c = structuredClone(v); c.qualityGate.dimensions[0].bogus = 1; return c; } },
      // qualityGate carries a Zod .default(), so Zod fills it when absent and accepts;
      // the JSON Schema keeps it required (matching the hand-written contract) and rejects.
      { label: "missing defaulted qualityGate", make: (v) => { const c = structuredClone(v); delete c.qualityGate; return c; } },
    ],
  },
  {
    name: "overseer",
    zodSchema: overseerDecisionSchema,
    valid: validOverseer,
    expectedRequired: [
      "status", "summary", "scenario", "currentPriority", "recommendedCommands",
      "lanePlan", "blockers", "stopCondition", "nextAction",
    ],
    zodRejects: [
      { label: "missing required field", make: (v) => { const c = structuredClone(v); delete c.nextAction; return c; } },
      { label: "bad enum value", make: (v) => ({ ...structuredClone(v), status: "go" }) },
      { label: "missing nested required field", make: (v) => { const c = structuredClone(v); delete c.recommendedCommands[0].requiresHuman; return c; } },
      { label: "bad nested blocker enum", make: (v) => { const c = structuredClone(v); c.blockers[0].level = "panic"; return c; } },
    ],
    stricterThanZod: [
      { label: "extra unknown top-level field", make: (v) => ({ ...structuredClone(v), bogus: true }) },
      { label: "extra unknown nested blocker field", make: (v) => { const c = structuredClone(v); c.blockers[0].bogus = true; return c; } },
    ],
  },
];

for (const role of roles) {
  test(`${role.name}: generated schema accepts what Zod accepts (valid fixture)`, () => {
    const json = zodToDriverJsonSchema(role.zodSchema);
    assert.equal(role.zodSchema.safeParse(role.valid).success, true, "fixture should be Zod-valid");
    assert.equal(validateAgainstJsonSchema(json, role.valid), true, "generated schema must accept the valid fixture");
  });

  test(`${role.name}: generated schema rejects what Zod rejects (malformed fixtures)`, () => {
    const json = zodToDriverJsonSchema(role.zodSchema);
    for (const inv of role.zodRejects) {
      const candidate = inv.make(role.valid);
      assert.equal(role.zodSchema.safeParse(candidate).success, false, `Zod oracle should reject: ${inv.label}`);
      // Equivalent-or-stricter: the generated JSON Schema must NOT accept anything the
      // Zod oracle rejects.
      assert.equal(
        validateAgainstJsonSchema(json, candidate),
        false,
        `generated schema must reject (Zod rejects it): ${inv.label}`,
      );
    }
  });

  test(`${role.name}: generated schema is STRICTER than lenient Zod safeParse`, () => {
    // Zod's object safeParse strips unknown keys and applies defaults, so it accepts a
    // few shapes the driver contract must NOT. The generated JSON Schema (the gate the
    // CLI is handed) must reject them — proving it is at least as strict as before.
    const json = zodToDriverJsonSchema(role.zodSchema);
    for (const inv of role.stricterThanZod) {
      const candidate = inv.make(role.valid);
      assert.equal(role.zodSchema.safeParse(candidate).success, true, `Zod leniently accepts: ${inv.label}`);
      assert.equal(
        validateAgainstJsonSchema(json, candidate),
        false,
        `generated schema must reject (stricter than Zod): ${inv.label}`,
      );
    }
  });

  test(`${role.name}: structural parity (additionalProperties:false + required matches contract)`, () => {
    const json = zodToDriverJsonSchema(role.zodSchema);
    assert.equal(json.type, "object");
    assert.equal(json.additionalProperties, false, "top-level object must forbid additional properties");
    assert.ok(json.properties && typeof json.properties === "object");

    // Property names cover the Zod shape exactly.
    const zodKeys = Object.keys(role.zodSchema.shape).sort();
    const jsonKeys = Object.keys(json.properties).sort();
    assert.deepEqual(jsonKeys, zodKeys, "generated property names must cover the Zod shape exactly");

    // required matches the hand-written contract (the proven driver-facing set). Note
    // this is a SUPERSET of Zod's strictly-required keys: reviewResultSchema.qualityGate
    // carries a .default() (so Zod would treat it optional) yet the contract requires it.
    assert.deepEqual([...json.required].sort(), [...role.expectedRequired].sort(), "required set must match the driver contract");

    // Every nested object must also forbid additional properties (strictness invariant).
    assertNoOpenObjects(json);
  });

  test(`${role.name}: generation is deterministic`, () => {
    const a = serializeDriverJsonSchema(role.zodSchema);
    const b = serializeDriverJsonSchema(role.zodSchema);
    assert.equal(a, b, "serialized schema must be byte-stable across calls");
    assert.equal(a.includes('"$schema"'), false, "generated schema omits the $schema draft pointer (matches proven shape)");
    assert.equal(a.endsWith("\n"), true, "serialized schema ends with a trailing newline");
  });
}

/** Assert every object node in a JSON Schema sets additionalProperties:false. */
function assertNoOpenObjects(node) {
  if (Array.isArray(node)) {
    for (const item of node) assertNoOpenObjects(item);
    return;
  }
  if (node && typeof node === "object") {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, "every object node must forbid additional properties");
    }
    for (const value of Object.values(node)) assertNoOpenObjects(value);
  }
}
