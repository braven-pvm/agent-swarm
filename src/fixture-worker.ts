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
  if (packageJson.name === "support-api-fixture") {
    return implementSupportApiSlice(input);
  }
  if (packageJson.name === "support-ui-fixture") {
    return implementSupportUiSlice(input);
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

function implementSupportApiSlice(input: {
  slice: SliceRecord;
  targetPath: string;
}): WorkerResult {
  const srcDir = path.join(input.targetPath, "src");
  const testDir = path.join(input.targetPath, "test");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "support-api.js"), renderSupportApiSource(), "utf8");
  fs.writeFileSync(path.join(testDir, "support-api.test.js"), renderSupportApiTests(), "utf8");
  ensurePackageScripts(input.targetPath, { test: "node --test" });

  return {
    status: "passed",
    summary: `Fixture worker implemented support API behavior for ${input.slice.frAcRefs.join(", ")}.`,
    changedFiles: ["package.json", "src/support-api.js", "test/support-api.test.js"],
    commandsRun: ["fixture-worker"],
    testsRun: ["npm test"],
    frAcCoverage: input.slice.frAcRefs.map((ref) => ({
      ref,
      status: "covered",
      evidence: supportEvidence(ref),
    })),
    risks: [],
    nextRecommendation: "Run independent review and deterministic verification.",
  };
}

function implementSupportUiSlice(input: {
  slice: SliceRecord;
  targetPath: string;
}): WorkerResult {
  const srcDir = path.join(input.targetPath, "src");
  const testDir = path.join(input.targetPath, "test");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "support-board.js"), renderSupportBoardSource(), "utf8");
  fs.writeFileSync(path.join(srcDir, "server.js"), renderSupportServerSource(), "utf8");
  fs.writeFileSync(path.join(testDir, "support-board.test.js"), renderSupportBoardTests(), "utf8");
  ensurePackageScripts(input.targetPath, {
    test: "node --test",
    start: "node src/server.js",
  });

  return {
    status: "passed",
    summary: `Fixture worker implemented support triage UI/product behavior for ${input.slice.frAcRefs.join(", ")}.`,
    changedFiles: ["package.json", "src/support-board.js", "src/server.js", "test/support-board.test.js"],
    commandsRun: ["fixture-worker"],
    testsRun: ["npm test"],
    frAcCoverage: input.slice.frAcRefs.map((ref) => ({
      ref,
      status: "covered",
      evidence: supportEvidence(ref),
    })),
    risks: [],
    nextRecommendation: "Run independent review, deterministic verification, and human verification where required.",
  };
}

function ensurePackageScripts(targetPath: string, scripts: Record<string, string>): void {
  const packageJsonPath = path.join(targetPath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  packageJson.scripts = { ...(packageJson.scripts ?? {}), ...scripts };
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

function supportEvidence(ref: string): string {
  if (/^AC-SUP-API-001|^FR-SUP-API-001/i.test(ref)) return "Ticket listing filters, joined display fields, SLA state, and sorting are covered by support API tests.";
  if (/^AC-SUP-API-002|^FR-SUP-API-002/i.test(ref)) return "Summary metrics and mutation refresh behavior are covered by support API tests.";
  if (/^AC-SUP-API-003|^FR-SUP-API-003/i.test(ref)) return "Ticket detail and missing-record behavior are covered by support API tests.";
  if (/^AC-SUP-API-004|^FR-SUP-API-004/i.test(ref)) return "Assignment mutation and validation behavior are covered by support API tests.";
  if (/^AC-SUP-API-005|^FR-SUP-API-005/i.test(ref)) return "Allowed status transitions and invalid transition handling are covered by support API tests.";
  if (/^AC-SUP-API-006|^FR-SUP-API-006/i.test(ref)) return "Internal note append and validation behavior are covered by support API tests.";
  if (/^AC-SUP-UI|^FR-SUP-UI/i.test(ref)) return "Support board UI model, HTTP routes, filters, workflow actions, and rendered HTML are covered by UI tests.";
  if (/^AC-DS|^FR-DS/i.test(ref)) return "Design-token usage, dense layout structure, non-color-only indicators, and human-verification packet inputs are represented in the rendered board and UI tests.";
  if (/^AC-PROD|^FR-PROD|^AC-HUMAN|^FR-HUMAN|^AC-QUALITY|^FR-QUALITY/i.test(ref)) return "Runnable product, workflow, readiness, human review, and quality expectations are covered by the support board app and tests.";
  return "Support triage fixture recorded behavior evidence for this ref.";
}

function renderSupportApiSource(): string {
  return `const now = new Date("2026-06-18T12:00:00.000Z");

const customers = [
  { id: "cust-acme", displayName: "Acme Logistics", tier: "enterprise" },
  { id: "cust-northwind", displayName: "Northwind Health", tier: "growth" },
  { id: "cust-summit", displayName: "Summit Finance", tier: "enterprise" },
  { id: "cust-river", displayName: "River Retail", tier: "starter" },
];

const agents = [
  { id: "agent-ava", displayName: "Ava" },
  { id: "agent-ben", displayName: "Ben" },
  { id: "agent-cyra", displayName: "Cyra" },
];

const seedTickets = [
  ticket("TCK-100", "cust-acme", "Checkout outage", "urgent", "new", null, -2),
  ticket("TCK-101", "cust-northwind", "API latency spike", "high", "assigned", "agent-ava", 3),
  ticket("TCK-102", "cust-summit", "Invoice export mismatch", "normal", "waiting_customer", "agent-ben", 28),
  ticket("TCK-103", "cust-river", "Password reset confusion", "low", "resolved", "agent-cyra", -12),
  ticket("TCK-104", "cust-acme", "Webhook retries failing", "urgent", "assigned", "agent-ava", 8),
  ticket("TCK-105", "cust-northwind", "Billing contact update", "normal", "new", null, 20),
  ticket("TCK-106", "cust-summit", "SOC report request", "high", "assigned", "agent-cyra", 52),
  ticket("TCK-107", "cust-river", "Mobile layout issue", "low", "new", null, 72),
];

let tickets = clone(seedTickets);
let noteCounter = 1;

export function resetSupportData() {
  tickets = clone(seedTickets);
  noteCounter = 1;
}

export function listAgents() {
  return clone(agents);
}

export function listTickets(filters = {}) {
  return tickets
    .filter((item) => !filters.status || item.status === filters.status)
    .filter((item) => !filters.priority || item.priority === filters.priority)
    .filter((item) => {
      if (!filters.assigneeId) return true;
      if (filters.assigneeId === "unassigned") return item.assigneeId === null;
      return item.assigneeId === filters.assigneeId;
    })
    .filter((item) => !filters.sla || slaState(item) === filters.sla)
    .map(enrichTicket)
    .sort(compareTickets);
}

export function getSummary() {
  return {
    ticketCount: tickets.length,
    openTicketCount: tickets.filter((item) => item.status !== "resolved").length,
    urgentTicketCount: tickets.filter((item) => item.priority === "urgent" && item.status !== "resolved").length,
    breachedSlaCount: tickets.filter((item) => slaState(item) === "breached").length,
    dueSoonCount: tickets.filter((item) => slaState(item) === "due_soon").length,
    unassignedTicketCount: tickets.filter((item) => item.assigneeId === null && item.status !== "resolved").length,
    resolvedTicketCount: tickets.filter((item) => item.status === "resolved").length,
  };
}

export function getTicketById(id) {
  const found = tickets.find((item) => item.id === id);
  return found ? enrichTicket(found) : undefined;
}

export function assignTicket(id, assigneeId) {
  const item = tickets.find((ticket) => ticket.id === id);
  if (!item) return { status: 404, error: "ticket_not_found" };
  if (!agents.some((agent) => agent.id === assigneeId)) return { status: 400, error: "unknown_agent" };
  item.assigneeId = assigneeId;
  if (item.status === "new") item.status = "assigned";
  return { status: 200, ticket: enrichTicket(item) };
}

export function updateTicketStatus(id, status) {
  const item = tickets.find((ticket) => ticket.id === id);
  if (!item) return { status: 404, error: "ticket_not_found" };
  if (!allowedNextStatuses(item).includes(status)) return { status: 400, error: "invalid_transition" };
  item.status = status;
  return { status: 200, ticket: enrichTicket(item) };
}

export function addInternalNote(id, input) {
  const item = tickets.find((ticket) => ticket.id === id);
  if (!item) return { status: 404, error: "ticket_not_found" };
  if (!String(input.body ?? "").trim()) return { status: 400, error: "empty_note" };
  item.internalNotes.push({
    id: "note-" + String(noteCounter++).padStart(3, "0"),
    author: input.author || "Ava",
    body: String(input.body).trim(),
    createdAt: new Date(now.getTime() + noteCounter * 60000).toISOString(),
  });
  return { status: 200, ticket: enrichTicket(item) };
}

export function allowedNextStatuses(item) {
  if (item.status === "new") return item.assigneeId ? ["assigned"] : [];
  if (item.status === "assigned") return ["waiting_customer", "resolved"];
  if (item.status === "waiting_customer") return ["resolved", "assigned"];
  return [];
}

export function slaState(item) {
  if (item.status === "resolved") return "ok";
  const due = new Date(item.slaDueAt).getTime();
  if (due < now.getTime()) return "breached";
  if (due <= now.getTime() + 24 * 60 * 60 * 1000) return "due_soon";
  return "ok";
}

function enrichTicket(item) {
  const customer = customers.find((candidate) => candidate.id === item.customerId);
  const assignee = agents.find((candidate) => candidate.id === item.assigneeId);
  return {
    ...clone(item),
    customerDisplayName: customer?.displayName ?? "Unknown customer",
    customerTier: customer?.tier ?? "starter",
    assigneeDisplayName: assignee?.displayName ?? "Unassigned",
    slaState: slaState(item),
    allowedNextStatuses: allowedNextStatuses(item),
  };
}

function compareTickets(left, right) {
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  const slaOrder = { breached: 0, due_soon: 1, ok: 2 };
  return (
    priorityOrder[left.priority] - priorityOrder[right.priority] ||
    slaOrder[left.slaState] - slaOrder[right.slaState] ||
    left.slaDueAt.localeCompare(right.slaDueAt) ||
    left.id.localeCompare(right.id)
  );
}

function ticket(id, customerId, title, priority, status, assigneeId, slaHoursFromNow) {
  return {
    id,
    customerId,
    title,
    description: title + " requires support follow-up.",
    status,
    priority,
    assigneeId,
    slaDueAt: new Date(now.getTime() + slaHoursFromNow * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
    internalNotes: [{ id: id + "-note-1", author: "system", body: "Ticket imported.", createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() }],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
`;
}

function renderSupportApiTests(): string {
  return `import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  addInternalNote,
  assignTicket,
  getSummary,
  getTicketById,
  listTickets,
  resetSupportData,
  updateTicketStatus,
} from "../src/support-api.js";

beforeEach(() => resetSupportData());

test("lists tickets with joined display fields, SLA state, filters, and sorting", () => {
  const all = listTickets();
  assert.equal(all.length, 8);
  assert.equal(all[0].id, "TCK-100");
  assert.equal(all[0].customerDisplayName, "Acme Logistics");
  assert.equal(all[0].assigneeDisplayName, "Unassigned");
  assert.equal(all[0].slaState, "breached");
  assert.deepEqual(listTickets({ status: "new" }).map((item) => item.id), ["TCK-100", "TCK-105", "TCK-107"]);
  assert.deepEqual(listTickets({ priority: "urgent" }).map((item) => item.id), ["TCK-100", "TCK-104"]);
  assert.deepEqual(listTickets({ assigneeId: "agent-ava" }).map((item) => item.id), ["TCK-104", "TCK-101"]);
  assert.deepEqual(listTickets({ assigneeId: "unassigned" }).map((item) => item.id), ["TCK-100", "TCK-105", "TCK-107"]);
  assert.deepEqual(listTickets({ sla: "breached" }).map((item) => item.id), ["TCK-100"]);
});

test("returns startup summary and updates after mutations", () => {
  assert.deepEqual(getSummary(), {
    ticketCount: 8,
    openTicketCount: 7,
    urgentTicketCount: 2,
    breachedSlaCount: 1,
    dueSoonCount: 3,
    unassignedTicketCount: 3,
    resolvedTicketCount: 1,
  });
  assert.equal(assignTicket("TCK-100", "agent-ava").status, 200);
  assert.equal(getSummary().unassignedTicketCount, 2);
  assert.equal(updateTicketStatus("TCK-100", "resolved").status, 200);
  assert.equal(getSummary().resolvedTicketCount, 2);
});

test("returns detail, assignment, status, note, and error behavior", () => {
  const detail = getTicketById("TCK-100");
  assert.equal(detail.customerTier, "enterprise");
  assert.equal(detail.internalNotes[0].body, "Ticket imported.");
  assert.equal(getTicketById("missing"), undefined);
  assert.deepEqual(assignTicket("missing", "agent-ava"), { status: 404, error: "ticket_not_found" });
  assert.deepEqual(assignTicket("TCK-100", "agent-missing"), { status: 400, error: "unknown_agent" });
  assert.equal(assignTicket("TCK-100", "agent-ava").ticket.status, "assigned");
  assert.equal(assignTicket("TCK-101", "agent-ben").ticket.status, "assigned");
  assert.equal(updateTicketStatus("TCK-101", "waiting_customer").status, 200);
  assert.equal(updateTicketStatus("TCK-101", "resolved").status, 200);
  assert.deepEqual(updateTicketStatus("TCK-100", "new"), { status: 400, error: "invalid_transition" });
  assert.deepEqual(updateTicketStatus("missing", "resolved"), { status: 404, error: "ticket_not_found" });
  assert.deepEqual(addInternalNote("TCK-100", { author: "Ava", body: "" }), { status: 400, error: "empty_note" });
  const noteResult = addInternalNote("TCK-100", { author: "Ava", body: "Contacted customer." });
  assert.equal(noteResult.status, 200);
  assert.equal(noteResult.ticket.internalNotes.at(-1).body, "Contacted customer.");
});
`;
}

function renderSupportBoardSource(): string {
  const apiSource = renderSupportApiSource();
  return `${apiSource}

export const designTokens = {
  background: "#f7f8fa",
  surface: "#ffffff",
  surfaceMuted: "#eef2f6",
  border: "#d8dee8",
  text: "#172033",
  textMuted: "#667085",
  accent: "#2563eb",
  urgent: "#b42318",
  high: "#b54708",
  success: "#067647",
  warning: "#b54708",
  focus: "#1d4ed8",
  radius: "6px",
};

export function getBoardModel(filters = {}) {
  const tickets = listTickets(filters);
  return {
    title: "Customer Support Triage Board",
    summary: getSummary(),
    tickets,
    agents: listAgents(),
    selectedTicket: getTicketById(tickets[0]?.id ?? "TCK-100"),
    filters,
    designTokens,
  };
}

export function renderBoardHtml(model = getBoardModel()) {
  const rows = model.tickets.map((ticket) => {
    const selected = ticket.id === model.selectedTicket?.id ? " selected" : "";
    return "<tr class='ticket-row" + selected + "' tabindex='0'><td>" + ticket.id + "</td><td>" + ticket.customerDisplayName + " <span class='tier'>" + ticket.customerTier + "</span></td><td>" + ticket.title + "</td><td><span class='chip priority-" + ticket.priority + "'>" + ticket.priority.toUpperCase() + "</span></td><td><span class='chip status'>" + ticket.status + "</span></td><td>" + ticket.assigneeDisplayName + "</td><td><span class='chip sla-" + ticket.slaState + "'>SLA " + ticket.slaState.replace("_", " ") + "</span></td></tr>";
  }).join("");
  const detail = model.selectedTicket;
  return "<!doctype html><html><head><title>Customer Support Triage Board</title><style>" + renderCss() + "</style></head><body><main class='app-shell'><header><h1>Customer Support Triage Board</h1></header><section class='summary' aria-label='Board summary'>" + metric("Open", model.summary.openTicketCount) + metric("Urgent", model.summary.urgentTicketCount) + metric("SLA breached", model.summary.breachedSlaCount) + metric("Due soon", model.summary.dueSoonCount) + metric("Unassigned", model.summary.unassignedTicketCount) + metric("Resolved", model.summary.resolvedTicketCount) + "</section><section class='filters' aria-label='Ticket filters'><label>Status <select name='status'><option>all</option><option>new</option><option>assigned</option></select></label><label>Priority <select name='priority'><option>all</option><option>urgent</option><option>high</option></select></label><label>Assignee <select name='assigneeId'><option>all</option><option>unassigned</option><option>agent-ava</option></select></label><label>SLA <select name='sla'><option>all</option><option>breached</option><option>due soon</option></select></label></section><section class='board'><div class='queue'><table><thead><tr><th>ID</th><th>Customer</th><th>Title</th><th>Priority</th><th>Status</th><th>Assignee</th><th>SLA</th></tr></thead><tbody>" + rows + "</tbody></table></div><aside class='detail'><h2>" + detail.title + "</h2><p>" + detail.description + "</p><dl><dt>Customer</dt><dd>" + detail.customerDisplayName + " (" + detail.customerTier + ")</dd><dt>Status</dt><dd>" + detail.status + "</dd><dt>Priority</dt><dd>" + detail.priority + "</dd><dt>SLA</dt><dd>" + detail.slaState + "</dd></dl><label>Assignee <select><option>" + detail.assigneeDisplayName + "</option></select></label><label>Status <select><option>" + detail.allowedNextStatuses.join("</option><option>") + "</option></select></label><label>Internal note <textarea></textarea></label><button>Add note</button><ol>" + detail.internalNotes.map((note) => "<li>" + note.body + "</li>").join("") + "</ol></aside></section></main></body></html>";
}

export function createApp() {
  return async function app(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, renderBoardHtml());
    if (request.method === "GET" && url.pathname === "/api/summary") return sendJson(response, getSummary());
    if (request.method === "GET" && url.pathname === "/api/agents") return sendJson(response, { agents: listAgents() });
    if (request.method === "GET" && url.pathname === "/api/tickets") {
      return sendJson(response, {
        tickets: listTickets({
          status: url.searchParams.get("status") || undefined,
          priority: url.searchParams.get("priority") || undefined,
          assigneeId: url.searchParams.get("assigneeId") || undefined,
          sla: url.searchParams.get("sla") || undefined,
        }),
      });
    }
    const ticketMatch = /^\\/api\\/tickets\\/([^/]+)$/.exec(url.pathname);
    const assignmentMatch = /^\\/api\\/tickets\\/([^/]+)\\/assignment$/.exec(url.pathname);
    const statusMatch = /^\\/api\\/tickets\\/([^/]+)\\/status$/.exec(url.pathname);
    const noteMatch = /^\\/api\\/tickets\\/([^/]+)\\/notes$/.exec(url.pathname);
    if (request.method === "GET" && ticketMatch) {
      const ticket = getTicketById(ticketMatch[1]);
      return ticket ? sendJson(response, { ticket }) : sendJson(response, { error: "ticket_not_found" }, 404);
    }
    if (request.method === "PATCH" && assignmentMatch) {
      const body = await readBody(request);
      const result = assignTicket(assignmentMatch[1], body.assigneeId);
      return result.ticket ? sendJson(response, result.ticket) : sendJson(response, { error: result.error }, result.status);
    }
    if (request.method === "PATCH" && statusMatch) {
      const body = await readBody(request);
      const result = updateTicketStatus(statusMatch[1], body.status);
      return result.ticket ? sendJson(response, result.ticket) : sendJson(response, { error: result.error }, result.status);
    }
    if (request.method === "POST" && noteMatch) {
      const body = await readBody(request);
      const result = addInternalNote(noteMatch[1], body);
      return result.ticket ? sendJson(response, result.ticket) : sendJson(response, { error: result.error }, result.status);
    }
    return sendJson(response, { error: "not_found" }, 404);
  };
}

function metric(label, value) {
  return "<article class='metric'><span>" + label + "</span><strong>" + value + "</strong></article>";
}

function renderCss() {
  return ":root{--bg:#f7f8fa;--surface:#ffffff;--muted:#eef2f6;--border:#d8dee8;--text:#172033;--text-muted:#667085;--accent:#2563eb;--urgent:#b42318;--high:#b54708;--success:#067647;--warning:#b54708;--focus:#1d4ed8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;letter-spacing:0}.app-shell{width:100%;padding:16px}h1{font-size:22px;margin:0 0 12px}.summary{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:8px}.metric,.detail,.filters,.queue{background:var(--surface);border:1px solid var(--border);border-radius:6px}.metric{padding:12px}.metric span{display:block;color:var(--text-muted);font-size:12px}.metric strong{font-size:22px}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;padding:8px}.filters label,.detail label{display:grid;gap:4px;font-size:12px;color:var(--text-muted)}select,textarea,button{border:1px solid var(--border);border-radius:6px;padding:8px;background:white;color:var(--text);font:inherit}.board{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:12px}.queue{overflow:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid var(--border);padding:8px;min-height:44px;white-space:nowrap}.ticket-row.selected{outline:2px solid var(--focus);outline-offset:-2px;background:var(--muted)}.chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border);border-radius:6px;padding:2px 6px;background:var(--muted);font-size:12px}.priority-urgent,.sla-breached{border-color:var(--urgent);color:var(--urgent);font-weight:700}.priority-high,.sla-due_soon{border-color:var(--high);color:var(--high);font-weight:700}.detail{padding:12px}.detail h2{font-size:14px;margin:0 0 8px}.detail dl{display:grid;grid-template-columns:88px 1fr;gap:4px}.detail textarea{min-height:72px;resize:vertical}.tier{color:var(--text-muted)}@media(max-width:860px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.board{grid-template-columns:1fr}.app-shell{padding:12px}th,td{white-space:normal}}";
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(html);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
`;
}

function renderSupportServerSource(): string {
  return `import http from "node:http";
import { createApp } from "./support-board.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4321);
const server = http.createServer(createApp());

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log("Customer Support Triage Board listening at http://" + host + ":" + actualPort);
});
`;
}

function renderSupportBoardTests(): string {
  return `import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  addInternalNote,
  assignTicket,
  createApp,
  designTokens,
  getBoardModel,
  getSummary,
  listTickets,
  renderBoardHtml,
  resetSupportData,
  updateTicketStatus,
} from "../src/support-board.js";

beforeEach(() => resetSupportData());

test("board model and rendered shell expose summary, filters, queue, detail, and design tokens", () => {
  const model = getBoardModel();
  const html = renderBoardHtml(model);
  assert.equal(model.title, "Customer Support Triage Board");
  assert.equal(model.summary.openTicketCount, 7);
  assert.equal(model.tickets[0].id, "TCK-100");
  assert.equal(designTokens.radius, "6px");
  assert.match(html, /Customer Support Triage Board/);
  assert.match(html, /SLA breached/);
  assert.match(html, /priority-urgent/);
  assert.match(html, /textarea/);
  assert.match(html, /@media\\(max-width:860px\\)/);
});

test("UI model uses backend-style filters, detail, and workflow refresh behavior", () => {
  assert.deepEqual(listTickets({ priority: "urgent" }).map((item) => item.id), ["TCK-100", "TCK-104"]);
  assert.equal(getBoardModel({ assigneeId: "unassigned" }).tickets.length, 3);
  assert.equal(assignTicket("TCK-100", "agent-ava").ticket.status, "assigned");
  assert.equal(getSummary().unassignedTicketCount, 2);
  assert.equal(updateTicketStatus("TCK-100", "waiting_customer").status, 200);
  assert.equal(addInternalNote("TCK-100", { author: "Ava", body: "Contacted customer." }).ticket.internalNotes.at(-1).body, "Contacted customer.");
});

test("HTTP app serves board, summary, list filters, detail, and mutations", async () => {
  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;
  try {
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /Customer Support Triage Board/);
    const summary = await (await fetch(base + "/api/summary")).json();
    assert.equal(summary.openTicketCount, 7);
    const urgent = await (await fetch(base + "/api/tickets?priority=urgent")).json();
    assert.deepEqual(urgent.tickets.map((item) => item.id), ["TCK-100", "TCK-104"]);
    const detail = await (await fetch(base + "/api/tickets/TCK-100")).json();
    assert.equal(detail.ticket.customerDisplayName, "Acme Logistics");
    const assigned = await fetch(base + "/api/tickets/TCK-100/assignment", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assigneeId: "agent-ava" }),
    });
    assert.equal(assigned.status, 200);
    const status = await fetch(base + "/api/tickets/TCK-100/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "waiting_customer" }),
    });
    assert.equal(status.status, 200);
    const note = await fetch(base + "/api/tickets/TCK-100/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "Ava", body: "Contacted customer." }),
    });
    assert.equal(note.status, 200);
    const missing = await fetch(base + "/api/tickets/missing");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
`;
}
