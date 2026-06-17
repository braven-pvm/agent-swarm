import { describe, it, expect, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import SpecDetail from "~/components/SpecDetail.svelte";
import type { SourceRecord, CoverageRef, SliceWithDetail } from "~/lib/types";

// jsdom has no IntersectionObserver; SpecDetail's scrollspy effect constructs one.
// A no-op stub lets the component mount without affecting the ledger behaviour under test.
beforeAll(() => {
  if (!("IntersectionObserver" in globalThis)) {
    class IO {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
  }
});

function source(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "S",
    adapterId: "a",
    kind: "spec",
    uri: "spec.md",
    title: "Demo spec",
    hash: "h",
    metadata: { domain: "invoices" },
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function ref(r: string, status: CoverageRef["status"], over: Partial<CoverageRef> = {}): CoverageRef {
  return {
    ref: r,
    domain: "invoices",
    sourceId: "S",
    sourceTitle: "Demo spec",
    sourceUri: "spec.md",
    status,
    statusReason: "",
    nextAction: "none",
    lastChangedAt: "",
    ...over,
  } as CoverageRef;
}

function refMapOf(refs: CoverageRef[]): Map<string, CoverageRef> {
  return new Map(refs.map((r) => [r.ref.toUpperCase(), r]));
}

// The same ref also renders as an inline chip inside the prose body; scope chip
// lookups to the ledger's family chip cloud so we always grab the expander chip.
function ledgerChip(container: HTMLElement, r: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`.spec-family-refs button[data-ref="${r}"]`)!;
}

// Force every family open (every family collapses by default) so a ledger chip
// is rendered regardless of its family's collapsed state.
async function expandAllFamilies(container: HTMLElement): Promise<void> {
  for (const head of container.querySelectorAll<HTMLButtonElement>("button.spec-family-head")) {
    if (head.getAttribute("aria-expanded") === "false") await fireEvent.click(head);
  }
}

// A markdown body that mentions every ref so extractFrAcRefs surfaces them in the ledger.
const MD = "## Spec\nWe deliver AC-API-1, AC-API-2 and FR-DATA-1 then FR-DATA-2.\n";

describe("SpecDetail roll-up + chip-as-expander", () => {
  it("starts every family collapsed by default", () => {
    const refs = [
      ref("AC-API-1", "done"),
      ref("AC-API-2", "done"),
      ref("FR-DATA-1", "blocked"),
      ref("FR-DATA-2", "done"),
    ];
    const { container } = render(SpecDetail, {
      props: { source: source(), markdown: MD, refMap: refMapOf(refs), slices: [] },
    });

    // Every family starts collapsed — the header (bar + count + status glyph) conveys
    // state at a glance; the operator expands the ones they want to drill into.
    const heads = Array.from(container.querySelectorAll<HTMLButtonElement>("button.spec-family-head"));
    const byName = (name: string) =>
      heads.find((h) => h.querySelector(".spec-family-name")?.textContent?.trim() === name)!;

    expect(byName("API").getAttribute("aria-expanded")).toBe("false"); // collapsed
    expect(byName("DATA").getAttribute("aria-expanded")).toBe("false"); // collapsed, even with a blocked ref

    // Collapsed families hide their chip clouds.
    expect(container.querySelector('.spec-family-refs [data-ref="FR-DATA-1"]')).toBeNull();
    expect(container.querySelector('.spec-family-refs [data-ref="AC-API-1"]')).toBeNull();
  });

  it("toggles a family open/closed on header click (override beats the default)", async () => {
    const refs = [ref("AC-API-1", "done"), ref("AC-API-2", "done")];
    const { container } = render(SpecDetail, {
      props: { source: source(), markdown: "## S\nAC-API-1 AC-API-2\n", refMap: refMapOf(refs), slices: [] },
    });
    const head = container.querySelector<HTMLButtonElement>("button.spec-family-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false"); // all done → collapsed default
    await fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true"); // override expands
    expect(container.querySelector('.spec-family-refs [data-ref="AC-API-1"]')).toBeTruthy();
  });

  it("expands a ref's RequirementDetail inline when its chip is clicked (chip IS the expander)", async () => {
    const refs = [
      ref("FR-DATA-1", "done", {
        proof: "listInvoices() returns all three seeded invoices.",
        reviewStatus: "passed",
        verification: "passed",
      }),
      ref("FR-DATA-2", "blocked"),
    ];
    const { container, getByText, queryByText } = render(SpecDetail, {
      props: { source: source(), markdown: MD, refMap: refMapOf(refs), slices: [] },
    });

    await expandAllFamilies(container); // families collapse by default — open them to reach the chip
    // detail not present until the chip is clicked
    expect(queryByText(/returns all three seeded invoices/)).toBeNull();
    const chip = ledgerChip(container, "FR-DATA-1");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    // RequirementDetail now rendered inline (proof + verdict eyebrow)
    expect(getByText(/returns all three seeded invoices/)).toBeTruthy();
    expect(getByText("Verdict")).toBeTruthy();
  });

  it("routes the in-detail 'View in coverage' link through onOpenRef (cross-link survives)", async () => {
    let opened = "";
    const refs = [ref("FR-DATA-1", "done", { reviewStatus: "passed" })];
    const { container, getByText } = render(SpecDetail, {
      props: {
        source: source(),
        markdown: "## S\nFR-DATA-1\n",
        refMap: refMapOf(refs),
        slices: [],
        onOpenRef: (r: string) => (opened = r),
      },
    });
    await expandAllFamilies(container);
    await fireEvent.click(ledgerChip(container, "FR-DATA-1"));
    (getByText(/View in coverage/) as HTMLButtonElement).click();
    expect(opened).toBe("FR-DATA-1");
  });

  it("resolves the per-AC reviewer finding from slices via sliceId", async () => {
    const refs = [ref("FR-DATA-1", "done", { sliceId: "slice-x", reviewStatus: "passed" })];
    const slices = [
      {
        id: "slice-x",
        reviewResult: {
          frAcFindings: [{ ref: "FR-DATA-1", status: "passed", evidence: [], finding: "Scoped review passed" }],
        },
      } as unknown as SliceWithDetail,
    ];
    const { container, getByText } = render(SpecDetail, {
      props: { source: source(), markdown: "## S\nFR-DATA-1\n", refMap: refMapOf(refs), slices },
    });
    await expandAllFamilies(container);
    await fireEvent.click(ledgerChip(container, "FR-DATA-1"));
    expect(getByText("Scoped review passed")).toBeTruthy();
    expect(getByText("Reviewer finding")).toBeTruthy();
  });
});
