import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import Coverage from "~/routes/Coverage.svelte";
import type { ConsoleStore } from "~/lib/console.svelte";
import type { CoverageSummary } from "~/lib/types";

const ledgerTotals = {
  total: 2,
  accepted: 1,
  verified: 0,
  human_verified: 0,
  review_passed: 0,
  implemented_unverified: 0,
  in_progress: 0,
  planned: 0,
  not_started: 0,
  awaiting_human_verification: 1,
  human_input_required: 0,
  failed: 0,
  blocked: 0,
};

function coverage(): CoverageSummary {
  return {
    generatedAt: "",
    totals: { total: 2, done: 1, inProgress: 0, blocked: 1, failed: 0, notStarted: 0 },
    interpretation: {
      completionPercent: 50,
      state: "partial",
      headline: "1/2 indexed requirements done",
      detail: "partial",
      nextActions: [],
      topIncompleteDomains: [],
    },
    byDomain: [{ domain: "Invoices", total: 2, done: 1, inProgress: 0, blocked: 1, failed: 0, notStarted: 0 }],
    refs: [
      {
        ref: "AC-LEDGER-1",
        domain: "Invoices",
        sourceId: "SRC-1",
        sourceTitle: "Spec",
        sourceUri: "spec.md",
        status: "done",
        directStatus: "not_started",
        statusReason: "Accepted through child rollup.",
        kind: "fr",
        ledgerStatus: "accepted",
        ledgerReason: "Container parent accepted by child AC rollup.",
        childRefs: ["AC-HUMAN-1"],
        rollup: {
          rule: "children",
          status: "accepted",
          reason: "Child ACs accepted.",
          directStatus: "not_started",
          directLedgerStatus: "not_started",
          childRefs: ["AC-HUMAN-1"],
          childStatusCounts: { accepted: 1 } as any,
        },
        humanPath: { state: "none", blocksAcceptance: false, reason: "" },
        nextAction: "none",
        lastChangedAt: "",
      },
      {
        ref: "AC-HUMAN-1",
        domain: "Invoices",
        sourceId: "SRC-1",
        sourceTitle: "Spec",
        sourceUri: "spec.md",
        status: "blocked",
        directStatus: "done",
        statusReason: "Awaiting human sign-off.",
        kind: "ac",
        ledgerStatus: "awaiting_human_verification",
        ledgerReason: "Human verification is required.",
        humanPath: {
          state: "human_verification_required",
          blocksAcceptance: true,
          reason: "Visual check required.",
          responsibleParty: "human-reviewer",
          packet: {
            evidenceId: "EVID-1",
            markdownPath: "packet.md",
            jsonPath: "packet.json",
            status: "awaiting_human_verification",
            generatedAt: "",
          },
        },
        nextAction: "await_verification",
        lastChangedAt: "",
      },
    ],
    ledger: {
      generatedAt: "",
      totals: ledgerTotals,
      entries: [],
      rollups: [
        {
          rule: "children",
          status: "accepted",
          reason: "Child ACs accepted.",
          directStatus: "not_started",
          directLedgerStatus: "not_started",
          childRefs: ["AC-HUMAN-1"],
          childStatusCounts: { accepted: 1 } as any,
        },
      ],
    },
  };
}

function store(cov: CoverageSummary): ConsoleStore {
  return {
    coverage: cov,
    snapshot: { runObservability: { outcomeVsCoverage: { truthRows: [] } }, slices: [] },
  } as unknown as ConsoleStore;
}

describe("Coverage route ledger view", () => {
  it("renders ledger summary fields and filters by ledger status", async () => {
    const { getByText, getByLabelText, queryByText } = render(Coverage, {
      props: { store: store(coverage()) },
    });

    expect(getByText("Requirement ledger")).toBeTruthy();
    expect(getByText(/1 Accepted/)).toBeTruthy();
    expect(getByText(/1 Awaiting human/)).toBeTruthy();
    expect(getByText("All ledger")).toBeTruthy();

    await fireEvent.change(getByLabelText("Filter by ledger status"), {
      target: { value: "awaiting_human_verification" },
    });

    expect(queryByText("AC-LEDGER-1")).toBeNull();
    expect(getByText("AC-HUMAN-1")).toBeTruthy();
  });
});
