import { describe, it, expect } from "vitest";
import {
  sliceStatusGroup, isTerminalSlice, activeSlicePriority, sortActiveSlices,
  sliceStatusGroupTone, sliceStatusChip, statusOverviewCounts,
} from "~/lib/format";

const slice = (status: string, updatedAt = "2026-06-14T08:00:00.000Z") => ({ status, updatedAt });

describe("sliceStatusGroup", () => {
  it("collapses the 11 statuses into the 5 operator buckets", () => {
    expect(sliceStatusGroup("candidate")).toBe("queued");
    expect(sliceStatusGroup("ready")).toBe("queued");
    expect(sliceStatusGroup("claimed")).toBe("queued");
    expect(sliceStatusGroup("implementing")).toBe("implementing");
    expect(sliceStatusGroup("implemented")).toBe("implementing");
    expect(sliceStatusGroup("repairing")).toBe("implementing");
    expect(sliceStatusGroup("verifying")).toBe("review");
    expect(sliceStatusGroup("ready_for_review")).toBe("review");
    expect(sliceStatusGroup("blocked")).toBe("blocked");
    expect(sliceStatusGroup("accepted")).toBe("accepted");
    expect(sliceStatusGroup("closed")).toBe("accepted");
  });
});

describe("isTerminalSlice", () => {
  it("treats only accepted + closed as terminal", () => {
    expect(isTerminalSlice("accepted")).toBe(true);
    expect(isTerminalSlice("closed")).toBe(true);
    expect(isTerminalSlice("blocked")).toBe(false);
    expect(isTerminalSlice("implementing")).toBe(false);
  });
});

describe("activeSlicePriority + sortActiveSlices", () => {
  it("ranks blocked > review > implementing > queued", () => {
    expect(activeSlicePriority("blocked")).toBeLessThan(activeSlicePriority("verifying"));
    expect(activeSlicePriority("verifying")).toBeLessThan(activeSlicePriority("implementing"));
    expect(activeSlicePriority("implementing")).toBeLessThan(activeSlicePriority("ready"));
  });

  it("sorts urgency-first, newest updatedAt as the tiebreak", () => {
    const sorted = sortActiveSlices([
      slice("ready", "2026-06-14T10:00:00.000Z"),
      slice("implementing", "2026-06-14T09:00:00.000Z"),
      slice("verifying", "2026-06-14T08:00:00.000Z"),
      slice("blocked", "2026-06-14T07:00:00.000Z"),
    ]);
    expect(sorted.map((s) => s.status)).toEqual(["blocked", "verifying", "implementing", "ready"]);
  });

  it("breaks ties on newest updatedAt within the same group", () => {
    const sorted = sortActiveSlices([
      slice("ready_for_review", "2026-06-14T08:00:00.000Z"),
      slice("verifying", "2026-06-14T12:00:00.000Z"),
    ]);
    // both are the "review" group → newest (verifying @12:00) first
    expect(sorted[0].updatedAt).toBe("2026-06-14T12:00:00.000Z");
  });

  it("does not mutate the input array", () => {
    const input = [slice("ready"), slice("blocked")];
    const before = input.map((s) => s.status);
    sortActiveSlices(input);
    expect(input.map((s) => s.status)).toEqual(before);
  });
});

describe("status tones + chip labels", () => {
  it("pairs each group with a glyph (never colour-alone)", () => {
    expect(sliceStatusGroupTone("blocked").glyph).toBe("✕");
    expect(sliceStatusGroupTone("accepted").glyph).toBe("✓");
    expect(sliceStatusGroupTone("verifying").cls).toBe("wb-chip-review");
  });

  it("chip label is the precise humanized status, tone stays the group's", () => {
    const chip = sliceStatusChip("ready_for_review");
    expect(chip.label).toBe("Ready for review");
    expect(chip.cls).toBe("wb-chip-review"); // group colour, not a sixth hue
  });
});

describe("statusOverviewCounts", () => {
  it("returns all five buckets in display order with zeros included", () => {
    const counts = statusOverviewCounts([
      slice("ready"), slice("implementing"), slice("verifying"), slice("verifying"),
      slice("blocked"), slice("accepted"), slice("closed"), slice("accepted"),
    ]);
    expect(counts.map((c) => c.group)).toEqual(["queued", "implementing", "review", "blocked", "accepted"]);
    const byGroup = Object.fromEntries(counts.map((c) => [c.group, c.count]));
    expect(byGroup).toEqual({ queued: 1, implementing: 1, review: 2, blocked: 1, accepted: 3 });
  });

  it("yields all-zero buckets for an empty slice list", () => {
    const counts = statusOverviewCounts([]);
    expect(counts.every((c) => c.count === 0)).toBe(true);
    expect(counts).toHaveLength(5);
  });
});
