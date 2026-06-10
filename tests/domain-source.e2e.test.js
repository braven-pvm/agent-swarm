import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

test("domain source management indexes large specs and filters slice pulls", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-domain-source-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const specs = path.join(workspace, "domain-specs");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(specs, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.writeFileSync(
    path.join(specs, "billing.md"),
    `# Billing Domain Requirements

Domain: Billing
Tags: backend, ledger
Priority: 2

## Export Runtime

- AC-BILL-001.1: Billing exports include paid invoices.

## Overdue Runtime

- AC-BILL-001.2: Billing exports include overdue invoices.
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(specs, "accounts.md"),
    `# Accounts Domain Requirements

Domain: Accounts
Tags: backend, identity
Priority: 1

- AC-ACC-001.1: Accounts expose customer display names.
- AC-ACC-001.2: Accounts expose active billing profiles.
`,
    "utf8",
  );

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-dir", specs]);

  const billingSources = runSwarm(workspace, ["sources", "list", "--domain", "Billing"]);
  assert.match(billingSources, /Sources: 1/);
  assert.match(billingSources, /Billing Domain Requirements/);
  assert.match(billingSources, /domain: Billing/);
  assert.match(billingSources, /refs: 2/);

  const billingInspect = runSwarm(workspace, ["sources", "inspect", "billing.md"]);
  assert.match(billingInspect, /Sections: 3/);
  assert.match(billingInspect, /Export Runtime/);
  assert.match(billingInspect, /AC-BILL-001\.1/);
  assert.match(billingInspect, /Overdue Runtime/);
  assert.match(billingInspect, /AC-BILL-001\.2/);

  const search = runSwarm(workspace, ["search", "specs", "overdue", "--domain", "Billing"]);
  assert.match(search, /Spec matches: 1/);
  assert.match(search, /Billing Domain Requirements > Overdue Runtime/);
  assert.match(search, /AC-BILL-001\.2/);

  const domains = runSwarm(workspace, ["domains", "list"]);
  assert.match(domains, /Domains: 2/);
  assert.match(domains, /Accounts/);
  assert.match(domains, /Billing/);
  assert.match(domains, /available: 2/);

  const billingBefore = runSwarm(workspace, ["domains", "inspect", "Billing"]);
  assert.match(billingBefore, /Available: 2/);
  assert.match(billingBefore, /AC-BILL-001\.1: available/);
  assert.match(billingBefore, /AC-BILL-001\.2: available/);

  const pullOutput = runSwarm(workspace, [
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
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "40"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.ok(slice);
  assert.deepEqual(slice.frAcRefs, ["AC-BILL-001.1", "AC-BILL-001.2"]);
  assert.equal(slice.sourceRefs[0].title, "Billing Domain Requirements");
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Billing" && domain.active === 2));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Accounts" && domain.available === 2));

  const graph = JSON.parse(runSwarm(workspace, ["graph", "--format", "json"]));
  assert.ok(graph.nodes.some((node) => node.type === "domain" && node.label === "Billing"));
  assert.ok(graph.nodes.some((node) => node.type === "source_section" && node.label === "Overdue Runtime"));
  assert.ok(graph.edges.some((edge) => edge.type === "domain_source"));
  assert.ok(graph.edges.some((edge) => edge.type === "section_ref" && edge.to === "AC-BILL-001.2"));

  const billingAfter = runSwarm(workspace, ["domains", "inspect", "Billing"]);
  assert.match(billingAfter, /Active: 2/);
  assert.match(billingAfter, /AC-BILL-001\.1: active/);
  assert.match(billingAfter, /AC-BILL-001\.2: active/);
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
