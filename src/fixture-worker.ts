import fs from "node:fs";
import path from "node:path";
import type { SliceRecord } from "./types.js";
import type { WorkerResult } from "./schemas.js";

export function runFixtureWorker(input: {
  slice: SliceRecord;
  targetPath: string;
}): WorkerResult {
  const packageJsonPath = path.join(input.targetPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Fixture worker requires a package.json target: ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
  if (packageJson.name === "invoice-api-fixture") {
    return implementInvoiceSlice(input);
  }
  if (packageJson.name === "invoice-dashboard-fixture") {
    return implementDashboardSlice(input);
  }
  throw new Error(`Fixture worker does not support ${packageJson.name ?? "unknown"}`);
}

function implementInvoiceSlice(input: {
  slice: SliceRecord;
  targetPath: string;
}): WorkerResult {
  const srcPath = path.join(input.targetPath, "src", "invoices.js");
  const testPath = path.join(input.targetPath, "test", "invoices.test.js");
  const refs = new Set(input.slice.frAcRefs);
  const wantsQuery = hasAny(refs, ["AC-INV-001.1", "AC-INV-001.2", "AC-INV-001.3"]);
  const wantsSummary = hasAny(refs, ["AC-INV-002.1", "AC-INV-002.2"]);
  const wantsLookup = hasAny(refs, ["AC-INV-003.1", "AC-INV-003.2"]);

  const currentSource = fs.readFileSync(srcPath, "utf8");
  const currentTests = fs.readFileSync(testPath, "utf8");
  fs.writeFileSync(srcPath, renderInvoiceSource({ currentSource, wantsQuery, wantsSummary, wantsLookup }), "utf8");
  fs.writeFileSync(testPath, renderInvoiceTests({ currentTests, wantsQuery, wantsSummary, wantsLookup }), "utf8");

  return {
    status: "passed",
    summary: `Fixture worker implemented ${input.slice.frAcRefs.join(", ")}.`,
    changedFiles: ["src/invoices.js", "test/invoices.test.js"],
    commandsRun: ["fixture-worker"],
    testsRun: ["npm test"],
    frAcCoverage: input.slice.frAcRefs.map((ref) => ({
      ref,
      status: "covered",
      evidence: coverageEvidence(ref),
    })),
    risks: [],
    nextRecommendation: "Run harness verification.",
  };
}

function renderInvoiceSource(input: {
  currentSource: string;
  wantsQuery: boolean;
  wantsSummary: boolean;
  wantsLookup: boolean;
}): string {
  const hasQuery = input.wantsQuery || input.currentSource.includes("listInvoices(filters");
  const hasSummary = input.wantsSummary || input.currentSource.includes("openCount");
  const hasLookup = input.wantsLookup || input.currentSource.includes("getInvoiceById");
  return `const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(${hasQuery ? "filters = {}" : ""}) {
${hasQuery ? `  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) {
      return false;
    }

    if (filters.customerId && invoice.customerId !== filters.customerId) {
      return false;
    }

    return true;
  });` : "  return invoices;"}
}

${hasLookup ? `export function getInvoiceById(id) {
  return invoices.find((invoice) => invoice.id === id) ?? null;
}

` : ""}export function getInvoiceSummary() {
${hasSummary ? `  const openInvoices = invoices.filter((invoice) => invoice.status === "open");

  return {
    count: invoices.length,
    openCount: openInvoices.length,
    paidCount: invoices.filter((invoice) => invoice.status === "paid").length,
    totalOpenCents: openInvoices.reduce(
      (total, invoice) => total + invoice.totalCents,
      0,
    ),
  };` : `  return {
    count: invoices.length,
  };`}
}
`;
}

function renderInvoiceTests(input: {
  currentTests: string;
  wantsQuery: boolean;
  wantsSummary: boolean;
  wantsLookup: boolean;
}): string {
  const needsLookupImport = input.wantsLookup || input.currentTests.includes("getInvoiceById");
  return `import test from "node:test";
import assert from "node:assert/strict";
import {
${needsLookupImport ? "  getInvoiceById,\n" : ""}  getInvoiceSummary,
  listInvoices,
} from "../src/invoices.js";

test("lists seeded invoices", () => {
  assert.equal(listInvoices().length, 3);
});

${input.wantsQuery || input.currentTests.includes("lists only open invoices") ? `test("lists only open invoices when filtered by open status", () => {
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

` : ""}${input.wantsSummary || input.currentTests.includes("dashboard summary") ? `test("returns invoice dashboard summary values for seeded data", () => {
  assert.deepEqual(getInvoiceSummary(), {
    count: 3,
    openCount: 2,
    paidCount: 1,
    totalOpenCents: 17000,
  });
});

` : `test("returns baseline invoice count summary", () => {
  assert.deepEqual(getInvoiceSummary(), { count: 3 });
});

`}${needsLookupImport ? `test("fetches a seeded invoice by id", () => {
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
` : ""}`;
}

function hasAny(values: Set<string>, expected: string[]): boolean {
  return expected.some((value) => values.has(value));
}

function coverageEvidence(ref: string): string {
  if (ref.startsWith("AC-INV-001")) return "Invoice listing behavior is covered by listInvoices tests.";
  if (ref.startsWith("AC-INV-002")) return "Invoice summary behavior is covered by getInvoiceSummary tests.";
  if (ref.startsWith("AC-INV-003")) return "Invoice lookup behavior is covered by getInvoiceById tests.";
  return "Fixture worker marked this ref covered.";
}

function implementDashboardSlice(input: {
  slice: SliceRecord;
  targetPath: string;
}): WorkerResult {
  const srcPath = path.join(input.targetPath, "src", "dashboard.js");
  const testPath = path.join(input.targetPath, "test", "dashboard.test.js");
  fs.writeFileSync(srcPath, `export function getDashboardModel() {
  return {
    title: "Invoice dashboard",
    summaryCards: {
      count: 3,
      openCount: 2,
      paidCount: 1,
      totalOpenCents: 17000,
    },
    openInvoiceIds: ["INV-1001", "INV-1003"],
    featuredInvoice: {
      id: "INV-1001",
      customerId: "CUST-1",
      status: "open",
      totalCents: 12500,
    },
  };
}
`, "utf8");
  fs.writeFileSync(testPath, `import test from "node:test";
import assert from "node:assert/strict";
import { getDashboardModel } from "../src/dashboard.js";

test("returns dashboard model composed from accepted invoice capabilities", () => {
  assert.deepEqual(getDashboardModel(), {
    title: "Invoice dashboard",
    summaryCards: {
      count: 3,
      openCount: 2,
      paidCount: 1,
      totalOpenCents: 17000,
    },
    openInvoiceIds: ["INV-1001", "INV-1003"],
    featuredInvoice: {
      id: "INV-1001",
      customerId: "CUST-1",
      status: "open",
      totalCents: 12500,
    },
  });
});
`, "utf8");

  return {
    status: "passed",
    summary: `Fixture worker implemented dashboard model for ${input.slice.frAcRefs.join(", ")}.`,
    changedFiles: ["src/dashboard.js", "test/dashboard.test.js"],
    commandsRun: ["fixture-worker"],
    testsRun: ["npm test"],
    frAcCoverage: input.slice.frAcRefs.map((ref) => ({
      ref,
      status: "covered",
      evidence: "Dashboard model behavior is covered by dashboard tests.",
    })),
    risks: [],
    nextRecommendation: "Run harness verification.",
  };
}
