#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const workspace = path.resolve(args.workspace ?? path.join(repoRoot, ".swarm-demo", "source-index"));
const summaryPath = path.resolve(args.summary ?? path.join(workspace, "source-index-summary.json"));
const artifactsDir = path.resolve(args.artifacts ?? path.join(workspace, "source-index-artifacts"));
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const target = path.join(workspace, "invoice-api");
const specs = path.join(workspace, "domain-specs");

resetWorkspace();
runSwarm(["init"]);
runSwarm(["target", "init", target]);
runSwarm(["sources", "add-dir", specs]);

const sourcesAll = runSwarm(["sources", "list"]);
const sourcesBilling = runSwarm(["sources", "list", "--domain", "Billing"]);
const billingInspect = runSwarm(["sources", "inspect", "billing.md"]);
const overdueSearch = runSwarm(["search", "specs", "overdue", "--domain", "Billing"]);
const ledgerSearch = runSwarm(["search", "specs", "ledger", "--tag", "ledger"]);
const domainsList = runSwarm(["domains", "list"]);
const billingBefore = runSwarm(["domains", "inspect", "Billing"]);
const pullOutput = runSwarm([
  "slices",
  "pull",
  "--target",
  "invoice-api",
  "--domain",
  "Billing",
  "--tag",
  "ledger",
  "--batch-size",
  "2",
  "--new-lane",
  "--lane-name",
  "Backend Lane: Billing Ledger",
  "--lane-purpose",
  "Implement the next coherent Billing ledger source section without reading unrelated domains",
  "--lane-labels",
  "backend,billing,ledger",
]);
const sliceId = parseSliceId(pullOutput);
const snapshot = JSON.parse(runSwarm(["observe", "--events", "80"]));
const graph = JSON.parse(runSwarm(["graph", "--format", "json"]));
const billingAfter = runSwarm(["domains", "inspect", "Billing"]);
const accountsAfter = runSwarm(["domains", "inspect", "Accounts"]);

fs.mkdirSync(artifactsDir, { recursive: true });
const artifacts = {
  sourcesAll: path.join(artifactsDir, "sources-all.txt"),
  sourcesBilling: path.join(artifactsDir, "sources-billing.txt"),
  billingInspect: path.join(artifactsDir, "source-inspect-billing.txt"),
  overdueSearch: path.join(artifactsDir, "search-overdue.txt"),
  ledgerSearch: path.join(artifactsDir, "search-ledger.txt"),
  domainsList: path.join(artifactsDir, "domains-list.txt"),
  billingBefore: path.join(artifactsDir, "domain-billing-before.txt"),
  billingAfter: path.join(artifactsDir, "domain-billing-after.txt"),
  accountsAfter: path.join(artifactsDir, "domain-accounts-after.txt"),
  graph: path.join(artifactsDir, "graph.json"),
  snapshot: path.join(artifactsDir, "observe.json"),
  summary: summaryPath,
};

fs.writeFileSync(artifacts.sourcesAll, sourcesAll, "utf8");
fs.writeFileSync(artifacts.sourcesBilling, sourcesBilling, "utf8");
fs.writeFileSync(artifacts.billingInspect, billingInspect, "utf8");
fs.writeFileSync(artifacts.overdueSearch, overdueSearch, "utf8");
fs.writeFileSync(artifacts.ledgerSearch, ledgerSearch, "utf8");
fs.writeFileSync(artifacts.domainsList, domainsList, "utf8");
fs.writeFileSync(artifacts.billingBefore, billingBefore, "utf8");
fs.writeFileSync(artifacts.billingAfter, billingAfter, "utf8");
fs.writeFileSync(artifacts.accountsAfter, accountsAfter, "utf8");
fs.writeFileSync(artifacts.graph, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
fs.writeFileSync(artifacts.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

const billingSlice = snapshot.slices.find((slice) => slice.id === sliceId);
const summary = {
  workspace,
  generatedAt: new Date().toISOString(),
  selected: {
    sliceId,
    billingRefs: billingSlice?.frAcRefs ?? [],
  },
  counts: {
    sources: snapshot.sources.length,
    domains: snapshot.domains.length,
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
  },
  usefulnessAssertions: {
    sourceListShowsDomains: sourcesAll.includes("domain: Billing") && sourcesAll.includes("domain: Accounts"),
    inspectMapsRefsToSections:
      billingInspect.includes("Export Runtime") &&
      billingInspect.includes("AC-BILL-001.1") &&
      billingInspect.includes("Overdue Runtime") &&
      billingInspect.includes("AC-BILL-001.2"),
    searchFindsRelevantSection:
      overdueSearch.includes("Billing Domain Requirements > Overdue Runtime") &&
      overdueSearch.includes("AC-BILL-001.2"),
    tagSearchFindsBillingOnly: ledgerSearch.includes("Billing Domain Requirements") && !ledgerSearch.includes("Accounts Domain Requirements"),
    domainBeforeShowsAvailability: billingBefore.includes("Available: 3") && billingBefore.includes("AC-BILL-002.1: available"),
    pullUsesOnlyFilteredDomain:
      Array.isArray(billingSlice?.frAcRefs) &&
      billingSlice.frAcRefs.length === 2 &&
      billingSlice.frAcRefs.every((ref) => ref.startsWith("AC-BILL-")),
    domainAfterShowsActiveAndRemaining:
      billingAfter.includes("Active: 2") &&
      billingAfter.includes("Available: 1") &&
      billingAfter.includes("AC-BILL-002.1: available"),
    unrelatedDomainUnaffected:
      accountsAfter.includes("Available: 2") &&
      accountsAfter.includes("Active: 0") &&
      !/AC-ACC-[^\n]+: active\b/.test(accountsAfter),
    graphConnectsDomainSectionRefSlice:
      graph.nodes.some((node) => node.type === "domain" && node.label === "Billing") &&
      graph.nodes.some((node) => node.type === "source_section" && node.label === "Overdue Runtime") &&
      graph.edges.some((edge) => edge.type === "section_ref" && edge.to === "AC-BILL-001.2") &&
      graph.edges.some((edge) => edge.type === "ref_slice" && edge.from === "AC-BILL-001.2" && edge.to === sliceId),
    observeIncludesDomainSummaries: snapshot.domains.some((domain) => domain.domain === "Billing" && domain.active === 2),
  },
  artifacts,
};

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

function resetWorkspace() {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(specs, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.writeFileSync(
    path.join(specs, "billing.md"),
    `# Billing Domain Requirements

Domain: Billing
Tags: backend, ledger
Priority: 1

## Export Runtime

- AC-BILL-001.1: Billing exports include paid invoices.

## Overdue Runtime

- AC-BILL-001.2: Billing exports include overdue invoices.

## Adjustment Runtime

- AC-BILL-002.1: Billing exports include manual adjustments.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(specs, "accounts.md"),
    `# Accounts Domain Requirements

Domain: Accounts
Tags: backend, identity
Priority: 2

## Customer Identity

- AC-ACC-001.1: Accounts expose customer display names.
- AC-ACC-001.2: Accounts expose active billing profiles.
`,
    "utf8",
  );
}

function runSwarm(commandArgs) {
  return execFileSync(process.execPath, [cli, ...commandArgs], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function parseSliceId(output) {
  const match = /Created slice (SLICE-[a-f0-9]+)/i.exec(output);
  if (!match) throw new Error(`Could not parse created slice from output:\n${output}`);
  return match[1];
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}
