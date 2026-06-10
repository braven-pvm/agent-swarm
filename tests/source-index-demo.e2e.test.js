import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("source index demo proves inspect, search, graph, and domain-filtered slicing are useful", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-source-index-${process.pid}`);
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-source-index-demo.mjs"),
    "--workspace",
    workspace,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);

  assert.equal(summary.counts.sources, 2);
  assert.equal(summary.counts.domains, 2);
  assert.ok(summary.counts.graphNodes > 0);
  assert.ok(summary.counts.graphEdges > 0);
  assert.deepEqual(summary.selected.billingRefs, ["AC-BILL-001.1", "AC-BILL-001.2"]);
  assert.deepEqual(summary.usefulnessAssertions, {
    sourceListShowsDomains: true,
    inspectMapsRefsToSections: true,
    searchFindsRelevantSection: true,
    tagSearchFindsBillingOnly: true,
    domainBeforeShowsAvailability: true,
    pullUsesOnlyFilteredDomain: true,
    domainAfterShowsActiveAndRemaining: true,
    unrelatedDomainUnaffected: true,
    graphConnectsDomainSectionRefSlice: true,
    observeIncludesDomainSummaries: true,
  });

  const inspect = fs.readFileSync(summary.artifacts.billingInspect, "utf8");
  assert.match(inspect, /Sections: 4/);
  assert.match(inspect, /Adjustment Runtime/);
  assert.match(inspect, /AC-BILL-002\.1/);

  const search = fs.readFileSync(summary.artifacts.overdueSearch, "utf8");
  assert.match(search, /Spec matches: 1/);
  assert.match(search, /lines:/);

  const graph = JSON.parse(fs.readFileSync(summary.artifacts.graph, "utf8"));
  assert.ok(graph.edges.some((edge) => edge.type === "domain_source"));
  assert.ok(graph.edges.some((edge) => edge.type === "source_section"));
  assert.ok(graph.edges.some((edge) => edge.type === "section_ref"));
  assert.ok(graph.edges.some((edge) => edge.type === "ref_slice" && edge.to === summary.selected.sliceId));
});
