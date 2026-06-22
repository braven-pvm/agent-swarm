// Shared LAZY AUTO-SKEPTIC eligibility for the live runners (run-live-agent-demo.mjs +
// run-support-triage-live-demo.mjs). Extracted so the runner wiring and its focused test assert the SAME
// predicate instead of duplicated copies.
//
// RE-1 (skeptic dispatch) and RE-2 (the gate) are NOT touched by this module — it only decides WHETHER the
// runner should call the existing `swarm skeptic` command before `swarm verify`.
//
// The predicate mirrors cli.ts reviewQualityBlockingReasons: a slice's accepted review is only worth an
// independent skeptic challenge when its qualityGate carries a DOWNGRADABLE BLOCKING concern
// (status=failed | a non-empty blockingConcern | a failed/high-risk dimension) — the only case where RE-2's
// gate has anything to consult. Happy-path accepted reviews emit a clean gate, so this returns []/false and
// NO skeptic runs (existing live/H2 tests are byte-unaffected). We also require that no finding_challenge
// evidence exists yet so the skeptic fires at most once per review.

export function skepticDowngradableReasons(slice) {
  const gate = slice?.reviewResult?.qualityGate;
  if (!gate) return [];
  const reasons = [];
  if (gate.status === "failed") reasons.push(`qualityGate.status=${gate.status}`);
  if (Array.isArray(gate.blockingConcerns)) {
    for (const concern of gate.blockingConcerns) {
      if (String(concern).trim()) reasons.push(String(concern).trim());
    }
  }
  if (Array.isArray(gate.dimensions)) {
    for (const dimension of gate.dimensions) {
      if (dimension.status === "failed" || dimension.risk === "high") {
        reasons.push(`${dimension.dimension} ${dimension.status}/${dimension.risk}: ${dimension.finding}`);
      }
    }
  }
  return reasons;
}

export function shouldDispatchSkeptic(slice) {
  const reasons = skepticDowngradableReasons(slice);
  if (reasons.length === 0) return { dispatch: false, reasons };
  const alreadyChallenged = Array.isArray(slice?.evidence) && slice.evidence.some((item) => item.kind === "finding_challenge");
  return { dispatch: !alreadyChallenged, reasons };
}
