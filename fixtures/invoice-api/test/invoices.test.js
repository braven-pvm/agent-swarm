import test from "node:test";
import assert from "node:assert/strict";
import {
  getInvoiceById,
  getInvoiceSummary,
  listInvoices,
} from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

test("lists only open invoices when filtered by open status", () => {
  assert.deepEqual(
    listInvoices({ status: "open" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1003"],
  );
});

test("lists only invoices for the requested customer", () => {
  assert.deepEqual(
    listInvoices({ customerId: "CUST-1" }).map((invoice) => invoice.id),
    ["INV-1001", "INV-1002"],
  );
});

test("returns invoice dashboard summary values for seeded data", () => {
  assert.deepEqual(getInvoiceSummary(), {
    count: 3,
    openCount: 2,
    paidCount: 1,
    totalOpenCents: 17000,
  });
});

test("fetches a seeded invoice by id", () => {
  assert.deepEqual(getInvoiceById("INV-1001"), {
    id: "INV-1001",
    customerId: "CUST-1",
    status: "open",
    totalCents: 12500,
  });
});

test("returns null when fetching a missing invoice", () => {
  assert.equal(getInvoiceById("INV-9999"), null);
});
