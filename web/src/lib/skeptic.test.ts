import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import {
  challengedVerdictsOf, downgradesForSlice, verdictTone, severityLabel,
  type FindingDowngrade, type ChallengedVerdict,
} from "~/lib/skeptic";
import FindingDowngradeCallout from "~/components/FindingDowngradeCallout.svelte";
import type { HarnessEvent } from "~/lib/types";

// ── factory builders (tolerant payloads are loose Record<string,unknown>) ─────
const ev = (type: string, entityId: string, payload: Record<string, unknown> = {}, id = `E-${Math.random()}`): HarnessEvent => ({
  id, timestamp: "2026-06-14T08:00:00.000Z", actor: "skeptic-1", type, entityType: "slice", entityId, payload,
});

const downgradePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  dimension: "runtime_path", concern: undefined, targetKind: "dimension", fromSeverity: "blocker",
  skepticVerdict: "refuted", reasoning: "The flagged path is exercised by the e2e test.",
  skepticActor: "skeptic-1", challengeEvidenceId: "evidence-c", reviewEvidenceId: "evidence-r", ...over,
});

describe("downgradesForSlice", () => {
  it("collects review.finding_downgraded events for the slice, newest-first", () => {
    const events: HarnessEvent[] = [
      ev("review.finding_downgraded", "SLICE-1", downgradePayload({ dimension: "runtime_path" }), "A"),
      ev("review.started", "SLICE-1", {}, "B"),
      ev("review.finding_downgraded", "SLICE-2", downgradePayload(), "C"), // other slice
      ev("review.finding_downgraded", "SLICE-1", downgradePayload({ targetKind: "concern", dimension: undefined, concern: "Stub left in path" }), "D"),
    ];
    const got = downgradesForSlice(events, "SLICE-1");
    expect(got).toHaveLength(2);
    // newest-first: D comes after A in source order, so D first
    expect(got[0].label).toBe("Stub left in path");
    expect(got[1].label).toBe("runtime_path");
    expect(got[0].skepticActor).toBe("skeptic-1");
    expect(got[0].fromSeverity).toBe("blocker");
  });

  it("prefers concern text over dimension for the label, falls back gracefully", () => {
    const events = [ev("review.finding_downgraded", "S", downgradePayload({ concern: "X", dimension: "y" }))];
    expect(downgradesForSlice(events, "S")[0].label).toBe("X");
    const noText = [ev("review.finding_downgraded", "S", downgradePayload({ concern: undefined, dimension: undefined }))];
    expect(downgradesForSlice(noText, "S")[0].label).toBe("a blocking concern");
  });

  it("returns [] for a slice with no downgrades (neutral, never throws)", () => {
    expect(downgradesForSlice([ev("review.started", "S")], "S")).toEqual([]);
    expect(downgradesForSlice([], "S")).toEqual([]);
    expect(downgradesForSlice(undefined as unknown as HarnessEvent[], "S")).toEqual([]);
  });

  it("tolerates a malformed payload without throwing", () => {
    const bad = { ...ev("review.finding_downgraded", "S"), payload: undefined as unknown as Record<string, unknown> };
    const got = downgradesForSlice([bad], "S");
    expect(got).toHaveLength(1);
    expect(got[0].label).toBe("a blocking concern");
  });
});

describe("challengedVerdictsOf", () => {
  it("reads per-verdict skeptic.finding_challenged events for a run, in order", () => {
    const events: HarnessEvent[] = [
      ev("skeptic.finding_challenged", "S", { runId: "RUN-1", ref: "AC-1", dimension: "runtime_path", verdict: "real", severity: "blocker", reasoning: "still broken" }, "A"),
      ev("skeptic.finding_challenged", "S", { runId: "RUN-1", ref: "AC-2", verdict: "refuted", severity: "major", reasoning: "false alarm" }, "B"),
      ev("skeptic.finding_challenged", "S", { runId: "RUN-2", ref: "AC-9", verdict: "uncertain" }, "C"), // other run
    ];
    const got = challengedVerdictsOf(events, "RUN-1");
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ ref: "AC-1", verdict: "real", severity: "blocker" });
    expect(got[1]).toMatchObject({ ref: "AC-2", verdict: "refuted" });
  });

  it("falls back to the evidence findingVerdicts when no per-verdict events exist", () => {
    const evidence = [{
      id: "evidence-c", sliceId: "S", kind: "finding_challenge", summary: "Skeptic refuted: ok", ref: "p", createdAt: "",
      payload: { skepticActor: "skeptic-1", skepticResult: { status: "refuted", summary: "ok", findingVerdicts: [
        { ref: "AC-1", dimension: "runtime_path", verdict: "refuted", severity: "blocker", reasoning: "covered" },
      ] } },
    }];
    const got = challengedVerdictsOf([], "RUN-1", evidence as any);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ref: "AC-1", verdict: "refuted" });
  });

  it("returns [] when nothing matches (neutral)", () => {
    expect(challengedVerdictsOf([], "RUN-1")).toEqual([]);
    expect(challengedVerdictsOf(undefined as unknown as HarnessEvent[], "RUN-1")).toEqual([]);
  });
});

describe("verdictTone / severityLabel", () => {
  it("maps verdicts to glyph+class tones (colour always paired with a glyph)", () => {
    expect(verdictTone("real").cls).toBe("sk-verdict-real");
    expect(verdictTone("refuted").cls).toBe("sk-verdict-refuted");
    expect(verdictTone("uncertain").cls).toBe("sk-verdict-uncertain");
    expect(verdictTone("real").glyph).toBeTruthy();
    // unknown → neutral, never throws
    expect(verdictTone(undefined).cls).toBe("sk-verdict-uncertain");
  });
  it("labels severities readably", () => {
    expect(severityLabel("blocker")).toBe("blocker");
    expect(severityLabel(undefined)).toBe("");
  });
});

describe("FindingDowngradeCallout", () => {
  const dg = (over: Partial<FindingDowngrade> = {}): FindingDowngrade => ({
    label: "runtime_path", targetKind: "dimension", fromSeverity: "blocker", skepticVerdict: "refuted",
    reasoning: "The flagged path is exercised by the e2e test.", skepticActor: "skeptic-1", ...over,
  });

  it("renders an amber warning callout answering who / what / why", () => {
    const { getByText, container } = render(FindingDowngradeCallout, { props: { downgrades: [dg()] } });
    expect(container.querySelector(".downgrade-callout")).toBeTruthy();
    // it is a note role for assistive tech
    expect(container.querySelector('[role="note"]')).toBeTruthy();
    // WHO
    expect(getByText(/skeptic-1/)).toBeTruthy();
    // WHAT — dimension + fromSeverity
    expect(getByText(/runtime_path/)).toBeTruthy();
    expect(getByText(/blocker/)).toBeTruthy();
    // WHY
    expect(getByText(/exercised by the e2e test/)).toBeTruthy();
    // never colour-alone — an aria-hidden glyph plus the word "Override"
    expect(container.querySelector(".downgrade-glyph")).toBeTruthy();
  });

  it("renders nothing when there are no downgrades (neutral / default path)", () => {
    const { container } = render(FindingDowngradeCallout, { props: { downgrades: [] } });
    expect(container.querySelector(".downgrade-callout")).toBeNull();
  });

  it("pluralises the head count", () => {
    const { getByText } = render(FindingDowngradeCallout, { props: { downgrades: [dg(), dg({ label: "stub_or_hardcode" })] } });
    expect(getByText(/Quality gate overrides \(2\)/)).toBeTruthy();
  });
});
