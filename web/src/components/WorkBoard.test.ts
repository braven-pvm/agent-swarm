import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import WorkBoard from "~/components/WorkBoard.svelte";
import { createConsoleStore } from "~/lib/console.svelte";

const ISO = "2026-06-14T08:00:00.000Z";
const slice = (id: string, status: string, updatedAt = ISO) => ({
  id, laneId: "L", targetId: "T", title: `Implement ${id}`, status,
  sourceRefs: [], frAcRefs: [], deliveryQuestion: "",
  leases: [], evidence: [], frAcResults: [], agentRuns: [],
  createdAt: ISO, updatedAt,
});

const hydrate = (slices: ReturnType<typeof slice>[]) => {
  const store = createConsoleStore();
  store.hydrate({
    workspace: "/w", runMode: "live-agent-smoke", generatedAt: "",
    targets: [{ id: "T", path: "/t", name: "billing" }],
    sources: [], domains: [], lanes: [], slices, dependencies: [],
    checkpoints: [], activeEscalations: [], heartbeats: [], recentEvents: [],
    agentRuns: [], focusQueue: [], agentFocusQueue: [],
  } as any);
  return store;
};

describe("WorkBoard", () => {
  it("renders the status overview strip with per-bucket counts", () => {
    const store = hydrate([
      slice("A", "blocked"), slice("B", "verifying"), slice("C", "implementing"),
      slice("D", "ready"), slice("E", "accepted"),
    ]);
    const { getByLabelText } = render(WorkBoard, { props: { store, onSelect: () => {} } });
    const strip = getByLabelText("Slice status overview");
    expect(strip.textContent).toContain("Queued");
    expect(strip.textContent).toContain("Implementing");
    expect(strip.textContent).toContain("Review");
    expect(strip.textContent).toContain("Blocked");
    expect(strip.textContent).toContain("Accepted");
  });

  it("shows only non-terminal slices in the active grid, urgency-sorted", () => {
    const store = hydrate([
      slice("Q", "ready", "2026-06-14T10:00:00.000Z"),
      slice("BL", "blocked", "2026-06-14T07:00:00.000Z"),
      slice("DONE", "accepted"),
    ]);
    const { container, queryByText } = render(WorkBoard, { props: { store, onSelect: () => {} } });
    const cards = container.querySelectorAll(".wb-section .wb-grid .slice-card .slice-title");
    // Active grid is rendered first; blocked sorts ahead of queued.
    const titles = Array.from(cards).map((c) => c.textContent);
    expect(titles[0]).toBe("BL");      // "Implement " prefix stripped
    expect(titles).toContain("Q");
    // Accepted slice is NOT in the active grid (it lives in the collapsed section).
    expect(queryByText("DONE")).toBeNull();
  });

  it("caps the active grid at 8 and expands on demand", async () => {
    const many = Array.from({ length: 10 }, (_, i) => slice(`S${i}`, "implementing", `2026-06-14T0${i % 9}:00:00.000Z`));
    const store = hydrate(many);
    const { container, getByText } = render(WorkBoard, { props: { store, onSelect: () => {} } });
    const grid = () => container.querySelector(".wb-section .wb-grid")!;
    expect(grid().querySelectorAll(".slice-card").length).toBe(8);
    await fireEvent.click(getByText("Show all active (10)"));
    expect(grid().querySelectorAll(".slice-card").length).toBe(10);
  });

  it("collapses the Accepted section by default and expands it", async () => {
    const store = hydrate([slice("A", "implementing"), slice("Z", "accepted")]);
    const { container } = render(WorkBoard, { props: { store, onSelect: () => {} } });
    // Header is present; its grid is not rendered until opened.
    const header = container.querySelector(".wb-accepted-head")!;
    expect(header.textContent).toContain("Accepted");
    expect(container.querySelectorAll(".wb-accepted .wb-grid").length).toBe(0);
    await fireEvent.click(header);
    expect(container.querySelectorAll(".wb-accepted .wb-grid .slice-card").length).toBe(1);
  });

  it("shows a calm note when there is no active work", () => {
    const store = hydrate([slice("A", "accepted"), slice("B", "closed")]);
    const { getByText } = render(WorkBoard, { props: { store, onSelect: () => {} } });
    expect(getByText("No active work — all 2 slices accepted.")).toBeTruthy();
  });

  it("invokes onSelect with the slice id when a card is clicked", async () => {
    let picked = "";
    const store = hydrate([slice("A", "implementing")]);
    const { container } = render(WorkBoard, { props: { store, onSelect: (id: string) => (picked = id) } });
    await fireEvent.click(container.querySelector(".slice-card")!);
    expect(picked).toBe("A");
  });
});
