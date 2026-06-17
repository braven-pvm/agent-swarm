import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import RequirementDetail from "~/components/RequirementDetail.svelte";
import type { CoverageRef, ReviewFinding } from "~/lib/types";

function baseRef(over: Partial<CoverageRef> = {}): CoverageRef {
  return {
    ref: "AC-INV-001.1",
    domain: "invoices",
    sourceId: "S",
    sourceTitle: "Spec",
    sourceUri: "spec.md",
    status: "done",
    statusReason: "verified",
    nextAction: "none",
    lastChangedAt: "",
    ...over,
  } as CoverageRef;
}

describe("RequirementDetail", () => {
  it("renders both gate verdicts, proof, finding, citations and evidence", () => {
    const ref = baseRef({
      reviewStatus: "passed",
      verification: "passed",
      proof: "listInvoices() returns all three seeded invoices. `npm test` passed: 4 tests, 4 pass.",
      actors: { workers: [], reviewers: [], verifiers: ["live-deterministic-verifier-4"], overseers: [] },
      obligation: { status: "present", mode: "automated", criteriaCount: 2, expectedOutcomes: ["all invoices returned"] },
      evidence: [
        { id: "e1", kind: "review_result", summary: "Independent review accepted", createdAt: "" },
        { id: "e2", kind: "command", summary: "Verification command passed: npm run test", createdAt: "" },
      ],
    });
    const finding: ReviewFinding = { ref: "AC-INV-001.1", status: "passed", evidence: ["spec quote", "`listInvoices()` asserted"], finding: "Scoped review passed" };

    const { getByText, getAllByText } = render(RequirementDetail, { props: { ref, finding } });

    // two distinct gates
    expect(getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(getAllByText("Verifier").length).toBeGreaterThan(0);
    // verifier attribution
    expect(getByText(/live-deterministic-verifier-4/)).toBeTruthy();
    // proof + finding + evidence
    expect(getByText(/returns all three seeded invoices/)).toBeTruthy();
    expect(getByText("Scoped review passed")).toBeTruthy();
    expect(getByText("Review result")).toBeTruthy();
    expect(getByText("Command")).toBeTruthy();
    // eyebrow sub-heads
    expect(getByText("Expected")).toBeTruthy();
    expect(getByText("Proof")).toBeTruthy();
  });

  it("renders the verdict row at minimum for a bare ref with no detail", () => {
    // truly bare: no proof, no statusReason, no evidence, no obligation, no finding
    const ref = baseRef({ status: "not_started", statusReason: "", proof: undefined, evidence: undefined });
    const { getByText, queryByText } = render(RequirementDetail, { props: { ref } });
    // verdict is always present (falls back to "Not run")
    expect(getByText("Verdict")).toBeTruthy();
    expect(getByText("Reviewer")).toBeTruthy();
    expect(getByText("Verifier")).toBeTruthy();
    // empty sections are guarded out
    expect(queryByText("Proof")).toBeNull();
    expect(queryByText("Evidence")).toBeNull();
    expect(queryByText("Expected")).toBeNull();
  });

  it("falls back to statusReason when proof is empty", () => {
    const ref = baseRef({ proof: undefined, statusReason: "Blocked on dependency" });
    const { getByText } = render(RequirementDetail, { props: { ref } });
    expect(getByText("Proof")).toBeTruthy();
    expect(getByText("Blocked on dependency")).toBeTruthy();
  });

  it("renders ledger rollup state and human verification packet state", () => {
    const ref = baseRef({
      directStatus: "not_started",
      ledgerStatus: "awaiting_human_verification",
      ledgerReason: "Automated checks passed, but a human verification packet is still open.",
      rollup: {
        rule: "children",
        status: "awaiting_human_verification",
        reason: "Child AC rollup is awaiting human verification.",
        directStatus: "not_started",
        directLedgerStatus: "not_started",
        childRefs: ["AC-INV-001.1", "AC-INV-001.2"],
        childStatusCounts: { awaiting_human_verification: 1, accepted: 1 } as any,
      },
      humanPath: {
        state: "human_verification_required",
        blocksAcceptance: true,
        reason: "Visual acceptance is required.",
        responsibleParty: "human-reviewer",
        packet: {
          evidenceId: "EVID-1",
          markdownPath: "C:\\tmp\\packet.md",
          jsonPath: "C:\\tmp\\packet.json",
          status: "awaiting_human_verification",
          generatedAt: "",
        },
      },
    });

    const { getByText, getAllByText } = render(RequirementDetail, { props: { ref } });

    expect(getAllByText("Ledger").length).toBeGreaterThan(0);
    expect(getAllByText("Awaiting human").length).toBeGreaterThan(0);
    expect(getByText(/Automated checks passed/)).toBeTruthy();
    expect(getByText("Human path")).toBeTruthy();
    expect(getByText("human-reviewer")).toBeTruthy();
    expect(getByText("packet.md")).toBeTruthy();
    expect(getByText("packet.json")).toBeTruthy();
  });

  it("invokes onOpenRef from the coverage cross-link", async () => {
    let opened = "";
    const ref = baseRef();
    const { getByText } = render(RequirementDetail, { props: { ref, onOpenRef: (r: string) => (opened = r) } });
    (getByText(/View in coverage/) as HTMLButtonElement).click();
    expect(opened).toBe("AC-INV-001.1");
  });
});
