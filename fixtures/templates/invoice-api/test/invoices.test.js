import test from "node:test";
import assert from "node:assert/strict";
import { getInvoiceSummary, listInvoices } from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});
