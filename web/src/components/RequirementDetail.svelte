<script lang="ts">
  import { humanizeToken, ledgerTone, ledgerStatusLabel, statusLabel, prettifyTarget } from "~/lib/format";
  import type { CoverageRef, ReviewFinding } from "~/lib/types";
  import ObligationView from "~/components/ObligationView.svelte";
  import Markdown from "~/components/Markdown.svelte";

  // The expected-vs-actual picture for a single requirement: what the verifier and
  // reviewer must prove (EXPECTED), the two gate verdicts, the verifier's proof
  // statement, the reviewer's richer per-AC finding (+ citations), and the raw
  // evidence trail. Every section guards on its own data so a bare ref (status only)
  // still renders the verdict row and nothing crashes on undefined.
  let {
    ref,
    finding,
    onOpenRef,
  }: {
    ref: CoverageRef;
    finding?: ReviewFinding;
    onOpenRef?: (ref: string) => void;
  } = $props();

  // Two distinct gates, each shown with glyph + colour + text (never colour alone).
  // Reviewer/verifier statuses share the same passed|failed|missing_evidence|… vocab,
  // mapped to a tone via a tiny local table so the badge carries a glyph + label.
  interface GateTone { cls: string; glyph: string; label: string; }
  const GATE_TONES: Record<string, GateTone> = {
    passed: { cls: "rq-gate-pass", glyph: "✓", label: "Passed" },
    failed: { cls: "rq-gate-fail", glyph: "✕", label: "Failed" },
    missing_evidence: { cls: "rq-gate-warn", glyph: "⚠", label: "Missing evidence" },
    uncertain: { cls: "rq-gate-warn", glyph: "?", label: "Uncertain" },
    awaiting_human_verification: { cls: "rq-gate-warn", glyph: "☐", label: "Awaiting human" },
    human_verified: { cls: "rq-gate-pass", glyph: "✓", label: "Human verified" },
    human_input_required: { cls: "rq-gate-warn", glyph: "☐", label: "Human input required" },
    overridden: { cls: "rq-gate-neutral", glyph: "↷", label: "Overridden" },
  };
  function gateTone(status: string | undefined): GateTone {
    if (!status) return { cls: "rq-gate-neutral", glyph: "–", label: "Not run" };
    return GATE_TONES[status] ?? { cls: "rq-gate-neutral", glyph: "•", label: humanizeToken(status) };
  }

  const reviewerGate = $derived(gateTone(ref.reviewStatus));
  const verifierGate = $derived(gateTone(ref.verification));
  const ledgerGate = $derived(ledgerTone(ref.ledgerStatus));
  const directLabel = $derived(statusLabel(ref.directStatus ?? ref.status));
  const verifiers = $derived(ref.actors?.verifiers ?? []);
  const humanPath = $derived(ref.humanPath);
  const humanPacket = $derived(ref.humanPath?.packet ?? ref.humanVerificationPacket);

  // Proof falls back to the status reason when the verifier left no proof statement.
  const proofText = $derived(ref.proof?.trim() || ref.statusReason?.trim() || "");

  // Evidence kind → subtle tint (review_result=blue, command=green, worker_result=violet,
  // else muted) + a humanized label. Color is paired with the label text, never alone.
  function evidenceTone(kind: string): string {
    switch (kind) {
      case "review_result": return "rq-ev-review";
      case "command": return "rq-ev-command";
      case "worker_result": return "rq-ev-worker";
      default: return "rq-ev-other";
    }
  }

  const evidence = $derived(ref.evidence ?? []);
  const EVIDENCE_CAP = 6;
  let showAllEvidence = $state(false);
  const visibleEvidence = $derived(showAllEvidence ? evidence : evidence.slice(0, EVIDENCE_CAP));

  // Reset the evidence disclosure when the ref changes so a long previous list never
  // shows pre-expanded for a different requirement.
  $effect(() => {
    void ref.ref;
    showAllEvidence = false;
  });
</script>

<div class="rq">
  <!-- EXPECTED — what must be proven to accept this AC/FR -->
  {#if ref.obligation}
    <div class="rq-section">
      <div class="rq-eyebrow">Expected</div>
      <ObligationView obligation={ref.obligation} />
    </div>
  {/if}

  <!-- LEDGER — authoritative requirement state vs direct row/slice state -->
  {#if ref.ledgerStatus || ref.directStatus || ref.rollup || ref.ledgerReason}
    <div class="rq-section">
      <div class="rq-eyebrow">Ledger</div>
      <div class="rq-ledger">
        <div class="rq-ledger-head">
          {#if ref.ledgerStatus}
            <span class="rq-gate {ledgerGate.cls}" title="Ledger status: {ledgerGate.label.toLowerCase()}">
              <span class="rq-gate-label">Ledger</span>
              <span class="rq-gate-glyph">{ledgerGate.glyph}</span>{ledgerGate.label}
            </span>
          {/if}
          <span class="rq-direct muted">Direct {directLabel}</span>
          {#if ref.rollup}
            <span class="rq-rollup-chip" title={ref.rollup.reason}>{humanizeToken(ref.rollup.rule)}</span>
          {/if}
        </div>
        {#if ref.ledgerReason}
          <div class="rq-ledger-reason"><Markdown md={ref.ledgerReason} /></div>
        {/if}
        {#if ref.rollup?.childRefs?.length}
          <div class="rq-rollup">
            <span class="rq-rollup-label muted">Children</span>
            <span class="rq-rollup-refs mono">{ref.rollup.childRefs.join(", ")}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- HUMAN PATH — pending/recorded human verification without hiding the packet -->
  {#if humanPath && humanPath.state !== "none"}
    <div class="rq-section">
      <div class="rq-eyebrow">Human path</div>
      <div class="rq-human">
        <div class="rq-human-head">
          <span class="rq-human-state {humanPath.blocksAcceptance ? 'blocks' : 'clear'}">
            {humanizeToken(humanPath.state)}
          </span>
          {#if humanPath.responsibleParty}
            <span class="muted">{humanPath.responsibleParty}</span>
          {/if}
          {#if humanPacket}
            <span class="rq-human-packet-status">{ledgerStatusLabel(humanPacket.status)}</span>
          {/if}
        </div>
        {#if humanPath.reason}
          <div class="rq-human-reason">{humanPath.reason}</div>
        {/if}
        {#if humanPacket}
          <div class="rq-human-packet">
            <span class="muted">Packet</span>
            <code title={humanPacket.markdownPath}>{prettifyTarget(humanPacket.markdownPath)}</code>
            <code title={humanPacket.jsonPath}>{prettifyTarget(humanPacket.jsonPath)}</code>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- VERDICT — the two independent gates, always shown (minimum render) -->
  <div class="rq-section">
    <div class="rq-eyebrow">Verdict</div>
    <div class="rq-verdict">
      <span class="rq-gate {reviewerGate.cls}" title="Reviewer gate: {reviewerGate.label.toLowerCase()}">
        <span class="rq-gate-label">Reviewer</span>
        <span class="rq-gate-glyph">{reviewerGate.glyph}</span>{reviewerGate.label}
      </span>
      <span class="rq-gate {verifierGate.cls}" title="Verifier gate: {verifierGate.label.toLowerCase()}">
        <span class="rq-gate-label">Verifier</span>
        <span class="rq-gate-glyph">{verifierGate.glyph}</span>{verifierGate.label}
      </span>
      {#if verifiers.length}
        <span class="rq-verifiers muted">by {verifiers.join(", ")}</span>
      {/if}
    </div>
  </div>

  <!-- PROOF — the verifier's proof statement + test result (may carry inline code) -->
  {#if proofText}
    <div class="rq-section">
      <div class="rq-eyebrow">Proof</div>
      <div class="rq-proof"><Markdown md={proofText} /></div>
    </div>
  {/if}

  <!-- REVIEWER FINDING — the richest per-AC reviewer narrative + its citations -->
  {#if finding?.finding}
    <div class="rq-section">
      <div class="rq-eyebrow">Reviewer finding</div>
      <div class="rq-finding"><Markdown md={finding.finding} /></div>
      {#if finding.evidence?.length}
        <ul class="rq-citations">
          {#each finding.evidence as c}
            <li><Markdown inline md={c} /></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <!-- EVIDENCE — the raw artifact trail, kind-tinted, capped with a show-more -->
  {#if evidence.length}
    <div class="rq-section">
      <div class="rq-eyebrow">Evidence</div>
      <ul class="rq-evidence">
        {#each visibleEvidence as e (e.id)}
          <li class="rq-ev-row">
            <span class="rq-ev-kind {evidenceTone(e.kind)}">{humanizeToken(e.kind)}</span>
            <span class="rq-ev-summary" title={e.summary}>{e.summary}</span>
          </li>
        {/each}
      </ul>
      {#if evidence.length > EVIDENCE_CAP}
        <button type="button" class="rq-more" onclick={() => (showAllEvidence = !showAllEvidence)}>
          {showAllEvidence ? "Show fewer" : `Show ${evidence.length - EVIDENCE_CAP} more`}
        </button>
      {/if}
    </div>
  {/if}

  <!-- Cross-link back to the Coverage table for this ref -->
  {#if onOpenRef}
    <button type="button" class="rq-open" onclick={() => onOpenRef?.(ref.ref)}>View in coverage →</button>
  {/if}
</div>
