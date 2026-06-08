import test from "node:test";
import assert from "node:assert/strict";
import { extractFrAcRefs } from "../dist/planner.js";

test("extracts hyphenated invoice FR/AC refs precisely", () => {
  const refs = extractFrAcRefs(`
    - AC-INV-001.1: Listing invoices without filters returns all seeded invoices.
    - AC-INV-001.2: Listing invoices with status filter returns open invoices.
    - FR-INV-001: The service supports invoice listing.
  `);

  assert.deepEqual(refs, ["AC-INV-001.1", "AC-INV-001.2", "FR-INV-001"]);
});
