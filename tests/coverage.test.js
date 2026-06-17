import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// buildCoverage() — authoritative FR/AC requirement-coverage rollup.
//
// Seeds a real SwarmStore with:
//   - a source carrying 3 FR/AC refs (AC-COV-001, AC-COV-002, AC-COV-003)
//   - a slice owning 2 of them (001, 002), with a completed lease + command
//     evidence carrying frAcResults (001 passed -> "done", 002 failed -> "failed")
//   - AC-COV-003 is indexed but pulled into NO slice -> "not_started"
// ---------------------------------------------------------------------------
async function seedCoverageWorkspace() {
  const { SwarmStore } = await import("../dist/storage.js");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-coverage-"));
  const store = new SwarmStore(workspace);
  store.init();

  const now = new Date().toISOString();
  const targetId = "TARGET-cov";
  store.addOrUpdateTarget({
    id: targetId,
    path: path.join(workspace, "app"),
    name: "app",
    config: { verificationCommand: "npm test" },
    now,
  });

  const specsDir = path.join(workspace, "app", "specs");
  fs.mkdirSync(specsDir, { recursive: true });
  const specUri = path.join(specsDir, "coverage.md");
  fs.writeFileSync(specUri, "# Coverage Spec\n\nAC-COV-001, AC-COV-002, AC-COV-003.\n", "utf8");

  const sourceId = "SOURCE-cov-01";
  store.addOrUpdateSource({
    id: sourceId,
    adapterId: "file",
    kind: "spec",
    uri: specUri,
    title: "Coverage Spec",
    hash: "cov-hash",
    metadata: {
      domain: "Coverage",
      tags: ["cov"],
      priority: 1,
      frAcRefs: ["AC-COV-001", "AC-COV-002", "AC-COV-003"],
      sections: [
        {
          id: `${sourceId}#coverage-spec`,
          title: "Coverage Spec",
          level: 1,
          startLine: 1,
          endLine: 3,
          refs: ["AC-COV-001", "AC-COV-002", "AC-COV-003"],
          snippet: "AC-COV-001, AC-COV-002, AC-COV-003.",
        },
      ],
    },
    createdAt: now,
    updatedAt: now,
  });

  const laneId = "LANE-cov";
  store.insertLane({
    id: laneId,
    name: "main",
    purpose: "Implement coverage",
    focusLabels: ["cov"],
    targetId,
    orchestrator: "test-orchestrator",
    worktree: workspace,
    state: "active",
    createdAt: now,
    updatedAt: now,
  });

  const sliceId = "SLICE-cov-01";
  store.insertSlice({
    id: sliceId,
    laneId,
    targetId,
    title: "Coverage slice",
    status: "implementing",
    sourceRefs: [{ sourceId, frAcRef: "AC-COV-001" }],
    frAcRefs: ["AC-COV-001", "AC-COV-002"],
    deliveryQuestion: "Does it cover?",
    workPackageType: "component_pack",
    minimumMeaningfulOutcome: "changes_runtime_path",
    scope: ["src/cov.js"],
    outOfScope: [],
    expectedEvidence: ["tests pass"],
    unblockTargets: [],
    verificationRequirements: [],
    createdAt: now,
    updatedAt: now,
  });

  // Completed lease for the passing ref.
  store.insertLease({
    id: "LEASE-cov-001",
    frAcRef: "AC-COV-001",
    sliceId,
    laneId,
    status: "completed",
    createdAt: now,
    updatedAt: now,
  });
  // Active lease for the failing ref.
  store.insertLease({
    id: "LEASE-cov-002",
    frAcRef: "AC-COV-002",
    sliceId,
    laneId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  store.insertDependency({
    id: "DEP-cov-003",
    fromType: "slice",
    fromId: sliceId,
    target: "AC-COV-003",
    reason: "AC-COV-003 waits for the first coverage slice to settle.",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  store.insertAgentRun({
    id: "RUN-cov-worker",
    sliceId,
    role: "worker",
    entityType: "slice",
    entityId: sliceId,
    actor: "cov-worker",
    driver: "fixture",
    status: "completed",
    attempt: 1,
    startedAt: now,
    updatedAt: now,
  });
  store.insertAgentRun({
    id: "RUN-cov-reviewer",
    sliceId,
    role: "reviewer",
    entityType: "slice",
    entityId: sliceId,
    actor: "cov-reviewer",
    driver: "fixture",
    status: "completed",
    attempt: 1,
    startedAt: now,
    updatedAt: now,
  });

  // Command evidence carrying frAcResults (the shape latestFrAcResults() reads).
  const verifyEvidenceId = "EVID-cov-verify";
  store.insertEvidence({
    id: verifyEvidenceId,
    sliceId,
    kind: "command",
    summary: "verification run",
    payload: {
      passed: false,
      frAcResults: [
        {
          ref: "AC-COV-001",
          status: "passed",
          evidenceIds: [verifyEvidenceId],
          proof: "AC-COV-001 verified by tests.",
          verifiedBy: "verifier",
        },
        {
          ref: "AC-COV-002",
          status: "failed",
          evidenceIds: [verifyEvidenceId],
          proof: "AC-COV-002 assertion failed.",
          verifiedBy: "verifier",
        },
      ],
    },
    createdAt: now,
  });

  store.insertEvidence({
    id: "EVID-cov-review",
    sliceId,
    kind: "review_result",
    summary: "review run",
    payload: {
      reviewResult: {
        status: "repair_required",
        summary: "One ref still fails.",
        frAcFindings: [
          {
            ref: "AC-COV-001",
            status: "passed",
            evidence: [verifyEvidenceId],
            finding: "Coverage 001 has executable proof.",
          },
          {
            ref: "AC-COV-002",
            status: "failed",
            evidence: [verifyEvidenceId],
            finding: "Coverage 002 still fails.",
          },
        ],
        testAssessment: "Targeted command evidence exists.",
        sourceMutationDetected: false,
        stubOrHardcodeRisk: "low",
        qualityGate: {
          status: "warning",
          summary: "Coverage 002 still needs repair before acceptance.",
          dimensions: [
            {
              dimension: "runtime_path",
              status: "passed",
              risk: "none",
              evidence: [verifyEvidenceId],
              finding: "Executable coverage evidence exists for the runtime path.",
            },
            {
              dimension: "stub_or_hardcode",
              status: "warning",
              risk: "low",
              evidence: [verifyEvidenceId],
              finding: "Review found a low non-blocking stub/hardcode risk.",
            },
            {
              dimension: "test_meaningfulness",
              status: "failed",
              risk: "medium",
              evidence: [verifyEvidenceId],
              finding: "AC-COV-002 failed its targeted assertion.",
            },
            {
              dimension: "error_handling",
              status: "not_applicable",
              risk: "none",
              evidence: [],
              finding: "No separate error-handling path is in scope for this fixture.",
            },
            {
              dimension: "integration_fit",
              status: "passed",
              risk: "none",
              evidence: [verifyEvidenceId],
              finding: "The fixture integration path is visible in evidence.",
            },
            {
              dimension: "maintainability",
              status: "passed",
              risk: "none",
              evidence: [],
              finding: "No maintainability concern recorded in this fixture.",
            },
            {
              dimension: "real_world_readiness",
              status: "failed",
              risk: "medium",
              evidence: [verifyEvidenceId],
              finding: "The slice is not ready while AC-COV-002 fails.",
            },
          ],
          blockingConcerns: ["AC-COV-002 failed review."],
          residualRisks: [],
        },
        requiredFixes: ["Repair AC-COV-002 behavior."],
        escalations: [],
        recommendation: "Repair failed ref.",
      },
    },
    createdAt: now,
  });

  store.insertEscalation({
    id: "ESC-cov-002",
    level: "blocker",
    status: "active",
    entityType: "lease",
    entityId: "AC-COV-002",
    message: "AC-COV-002 is blocked by failing verification.",
    createdBy: "cov-reviewer",
    createdAt: now,
    updatedAt: now,
  });

  store.close();
  return { workspace, sourceId, sliceId };
}

test("buildCoverage enumerates every indexed FR/AC ref incl. not-started", async () => {
  const { buildCoverage } = await import("../dist/observability.js");
  const { SwarmStore } = await import("../dist/storage.js");
  const { workspace, sliceId } = await seedCoverageWorkspace();

  const store = new SwarmStore(workspace);
  try {
    const coverage = buildCoverage(store);

    // --- Shape ---
    assert.ok(typeof coverage.generatedAt === "string", "generatedAt should be a string");
    assert.ok(Array.isArray(coverage.refs), "refs should be an array");
    assert.ok(Array.isArray(coverage.byDomain), "byDomain should be an array");
    assert.equal(coverage.interpretation.state, "partial", "mixed coverage should be interpreted as partial");
    assert.equal(coverage.interpretation.completionPercent, 33, "interpretation should expose a rounded completion percent");
    assert.match(coverage.interpretation.headline, /1\/3 indexed requirements done/, "interpretation should expose a headline");
    assert.match(coverage.interpretation.warning, /partial/i, "partial interpretation should warn that coverage is incomplete");
    assert.ok(
      coverage.interpretation.nextActions.some((item) => item.action === "repair_or_review"),
      "interpretation should summarize next actions",
    );
    assert.ok(
      coverage.interpretation.topIncompleteDomains.some((item) => item.domain === "Coverage" && item.incomplete === 2),
      "interpretation should list incomplete domains",
    );

    // --- Denominator: all 3 indexed refs are counted ---
    assert.equal(coverage.totals.total, 3, "totals.total should count every indexed ref");
    assert.equal(coverage.refs.length, 3, "refs should enumerate every indexed ref");

    const byRef = Object.fromEntries(coverage.refs.map((r) => [r.ref, r]));

    // --- Started + passed -> done ---
    const done = byRef["AC-COV-001"];
    assert.equal(done.status, "done", "AC-COV-001 (passed verification) should be done");
    assert.equal(done.sliceId, sliceId, "done ref should carry owning sliceId");
    assert.equal(done.verification, "passed", "done ref should carry verification=passed");
    assert.equal(done.sourceTitle, "Coverage Spec", "done ref should carry source title");
    assert.equal(done.sourceSectionTitle, "Coverage Spec", "done ref should carry source section");
    assert.equal(done.laneName, "main", "done ref should carry lane name");
    assert.equal(done.targetName, "app", "done ref should carry target name");
    assert.equal(done.nextAction, "none", "done ref should need no next action");
    assert.match(done.statusReason, /Passed deterministic verification/, "done ref should explain why it is done");
    assert.deepEqual(done.actors.workers, ["cov-worker"], "done ref should expose worker actor");
    assert.deepEqual(done.actors.reviewers, ["cov-reviewer"], "done ref should expose reviewer actor");
    assert.deepEqual(done.actors.verifiers, ["verifier"], "done ref should expose verifier actor from evidence");
    assert.ok(done.proof, "done ref should carry proof");
    assert.deepEqual(done.evidenceIds, ["EVID-cov-verify"], "done ref should carry evidenceIds");
    assert.ok(done.lastChangedAt, "done ref should carry lastChangedAt");
    assert.ok(done.evidence.some((item) => item.id === "EVID-cov-verify"), "done ref should include evidence summaries");

    // --- Started + failed verification -> failed ---
    const failed = byRef["AC-COV-002"];
    assert.equal(failed.status, "failed", "AC-COV-002 (failed verification) should be failed");
    assert.equal(failed.sliceId, sliceId, "failed ref should carry owning sliceId");
    assert.equal(failed.verification, "failed", "failed ref should carry verification=failed");
    assert.equal(failed.reviewStatus, "failed", "failed ref should carry review status");
    assert.equal(failed.nextAction, "repair_or_review", "failed ref should point to repair/review");
    assert.ok(failed.activeEscalations.some((item) => item.level === "blocker"), "failed ref should expose blockers");
    assert.match(failed.statusReason, /blocker escalation is active/, "failed ref should explain the active blocker");

    // --- Unreferenced -> not_started ---
    const notStarted = byRef["AC-COV-003"];
    assert.equal(notStarted.status, "not_started", "AC-COV-003 (in no slice) should be not_started");
    assert.equal(notStarted.sliceId, undefined, "not_started ref should not carry a sliceId");
    assert.equal(notStarted.nextAction, "wait_for_dependency", "dependency-blocked not-started ref should wait");
    assert.ok(notStarted.dependencies.some((item) => item.target === "AC-COV-003"), "not-started ref should expose dependency context");
    assert.match(notStarted.statusReason, /waiting for prerequisite dependency/, "not-started ref should explain dependency wait");

    // --- totals consistency ---
    assert.equal(coverage.totals.done, 1, "exactly one done");
    assert.equal(coverage.totals.failed, 1, "exactly one failed");
    assert.equal(coverage.totals.notStarted, 1, "exactly one not_started");
    const totalsSum =
      coverage.totals.done +
      coverage.totals.inProgress +
      coverage.totals.blocked +
      coverage.totals.failed +
      coverage.totals.notStarted;
    assert.equal(totalsSum, coverage.totals.total, "status buckets should sum to total");

    // --- byDomain sums are consistent with totals ---
    const domain = coverage.byDomain.find((d) => d.domain === "Coverage");
    assert.ok(domain, "should have a Coverage domain");
    assert.equal(domain.total, 3, "Coverage domain should total 3 refs");
    const domainSum = domain.done + domain.inProgress + domain.blocked + domain.failed + domain.notStarted;
    assert.equal(domainSum, domain.total, "domain status buckets should sum to domain total");
    assert.equal(
      coverage.byDomain.reduce((sum, d) => sum + d.total, 0),
      coverage.totals.total,
      "byDomain totals should sum to grand total",
    );

    // --- refs sorted by domain then ref ---
    const sorted = [...coverage.refs].sort((a, b) => a.domain.localeCompare(b.domain) || a.ref.localeCompare(b.ref));
    assert.deepEqual(
      coverage.refs.map((r) => r.ref),
      sorted.map((r) => r.ref),
      "refs should be sorted by domain then ref",
    );
  } finally {
    store.close();
  }
});
