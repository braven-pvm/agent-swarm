#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const historyRoot = path.resolve(args["history-root"] ?? path.join(repoRoot, ".swarm-demo", "live-agent-run-history"));
const format = args.format ?? "json";
if (!["json", "markdown"].includes(format)) {
  throw new Error(`Invalid --format ${format}; expected json or markdown`);
}
assertApprovedHistoryRoot(historyRoot);

const historyIndexPath = path.join(historyRoot, "runs.json");
if (!fs.existsSync(historyIndexPath)) {
  throw new Error(`Live agent run history not found: ${historyIndexPath}`);
}

const historyIndex = JSON.parse(fs.readFileSync(historyIndexPath, "utf8"));
const selected = selectRuns(historyIndex.runs ?? [], args.left, args.right);
const leftSummary = JSON.parse(fs.readFileSync(selected.left.summary, "utf8"));
const rightSummary = JSON.parse(fs.readFileSync(selected.right.summary, "utf8"));
const comparison = buildComparison({
  historyRoot,
  leftRecord: selected.left,
  rightRecord: selected.right,
  leftSummary,
  rightSummary,
});

const output = format === "markdown" ? renderMarkdown(comparison) : `${JSON.stringify(comparison, null, 2)}\n`;
if (args.output) {
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");
}
process.stdout.write(output);

function selectRuns(runs, leftId, rightId) {
  if (runs.length < 2 && (!leftId || !rightId)) {
    throw new Error(`Need at least two archived runs to compare; found ${runs.length}.`);
  }
  const sorted = [...runs].sort((left, right) => String(left.generatedAt ?? "").localeCompare(String(right.generatedAt ?? "")));
  if (!leftId && !rightId) {
    return {
      left: sorted.at(-2),
      right: sorted.at(-1),
      mode: "latest-two",
    };
  }
  if (!leftId || !rightId) {
    throw new Error("Pass both --left and --right, or neither to compare the latest two runs.");
  }
  const left = sorted.find((item) => item.runId === leftId);
  const right = sorted.find((item) => item.runId === rightId);
  if (!left) throw new Error(`Left run not found in history: ${leftId}`);
  if (!right) throw new Error(`Right run not found in history: ${rightId}`);
  return { left, right, mode: "explicit" };
}

function buildComparison({ historyRoot, leftRecord, rightRecord, leftSummary, rightSummary }) {
  const countKeys = [
    "turns",
    "verifyRuns",
    "lanes",
    "slices",
    "agentRuns",
    "evidence",
    "activeEscalations",
    "graphNodes",
    "graphEdges",
    "timelineItems",
  ];
  const left = summarizeRun(leftSummary, leftRecord);
  const right = summarizeRun(rightSummary, rightRecord);
  const countDeltas = Object.fromEntries(
    countKeys.map((key) => [key, (right.counts[key] ?? 0) - (left.counts[key] ?? 0)]),
  );
  const changes = {
    finalOutcomeChanged: left.finalOutcome !== right.finalOutcome,
    classificationChanged: left.classification.code !== right.classification.code,
    faultModeChanged: left.faultMode !== right.faultMode,
    phaseChanged: left.phase !== right.phase,
    finalSliceStatusChanged: left.finalSliceStatus !== right.finalSliceStatus,
  };
  return {
    generatedAt: new Date().toISOString(),
    historyRoot,
    left,
    right,
    changes,
    deltas: {
      counts: countDeltas,
      finalOutcome: `${left.finalOutcome} -> ${right.finalOutcome}`,
      classification: `${left.classification.code} -> ${right.classification.code}`,
      faultMode: `${left.faultMode} -> ${right.faultMode}`,
    },
    artifacts: {
      leftSummary: leftRecord.summary,
      rightSummary: rightRecord.summary,
      leftArtifactIndex: leftRecord.artifactIndex,
      rightArtifactIndex: rightRecord.artifactIndex,
      leftArtifactIndexMarkdown: leftRecord.artifactIndexMarkdown,
      rightArtifactIndexMarkdown: rightRecord.artifactIndexMarkdown,
    },
    interpretation: interpretChanges(left, right, changes, countDeltas),
    assertions: {
      hasTwoRuns: Boolean(left.runId && right.runId),
      runIdsDistinct: left.runId !== right.runId,
      archivedSummariesExist: fs.existsSync(leftRecord.summary) && fs.existsSync(rightRecord.summary),
      archivedArtifactIndexesExist: fs.existsSync(leftRecord.artifactIndex) && fs.existsSync(rightRecord.artifactIndex),
      comparesCoreMetrics: countKeys.every((key) => Object.hasOwn(countDeltas, key)),
      recordsOutcomeAndClassification: Boolean(left.finalOutcome && right.finalOutcome && left.classification.code && right.classification.code),
    },
  };
}

function summarizeRun(summary, record) {
  return {
    runId: summary.runId ?? record.runId,
    scenario: summary.scenario ?? record.scenario,
    runMode: summary.runMode ?? record.runMode,
    phase: summary.phase ?? record.phase,
    driver: summary.driver ?? record.driver,
    faultMode: summary.fault?.mode ?? record.faultMode,
    startedAt: summary.startedAt ?? record.startedAt,
    generatedAt: summary.generatedAt ?? record.generatedAt,
    finalOutcome: summary.finalOutcome ?? record.finalOutcome,
    finalReason: summary.finalReason ?? record.finalReason,
    classification: {
      code: summary.outcomeClassification?.code ?? record.classificationCode,
      severity: summary.outcomeClassification?.severity ?? record.classificationSeverity,
      explanation: summary.outcomeClassification?.explanation,
    },
    sliceId: summary.sliceId ?? record.sliceId,
    finalSliceStatus: summary.finalSliceStatus ?? record.finalSliceStatus,
    counts: pickComparableCounts(summary.counts ?? record.counts),
    artifacts: {
      summary: record.summary,
      artifactIndex: record.artifactIndex,
      artifactIndexMarkdown: record.artifactIndexMarkdown,
      originalSummary: record.originalSummary,
      originalArtifactIndex: record.originalArtifactIndex,
      originalArtifactIndexMarkdown: record.originalArtifactIndexMarkdown,
    },
  };
}

function pickComparableCounts(counts = {}) {
  return {
    turns: counts.turns ?? 0,
    verifyRuns: counts.verifyRuns ?? 0,
    lanes: counts.lanes ?? 0,
    slices: counts.slices ?? 0,
    agentRuns: counts.agentRuns ?? 0,
    evidence: counts.evidence ?? 0,
    activeEscalations: counts.activeEscalations ?? 0,
    graphNodes: counts.graphNodes ?? 0,
    graphEdges: counts.graphEdges ?? 0,
    timelineItems: counts.timelineItems ?? 0,
  };
}

function interpretChanges(left, right, changes, countDeltas) {
  if (left.finalOutcome !== "accepted" && right.finalOutcome === "accepted") {
    return "Run outcome improved to accepted.";
  }
  if (left.finalOutcome === "accepted" && right.finalOutcome !== "accepted") {
    return "Run outcome moved away from accepted; inspect classification and blockers before treating this as progress.";
  }
  if (changes.classificationChanged) {
    return "Outcome classification changed; inspect the archived summaries for the new stop reason.";
  }
  if (Object.values(countDeltas).some((value) => value !== 0)) {
    return "Lifecycle shape changed while outcome stayed comparable; inspect count deltas and artifact indexes.";
  }
  return "No material outcome or lifecycle count changes detected.";
}

function renderMarkdown(comparison) {
  const lines = [
    "# Live Agent Smoke Run Comparison",
    "",
    `Generated: ${comparison.generatedAt}`,
    `History root: ${comparison.historyRoot}`,
    "",
    "## Runs",
    "",
    "| Side | Run | Fault | Outcome | Classification | Turns | Agent Runs | Verify Runs | Active Escalations |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    runTableRow("Left", comparison.left),
    runTableRow("Right", comparison.right),
    "",
    "## Count Deltas",
    "",
    "| Metric | Delta |",
    "| --- | ---: |",
  ];
  for (const [key, value] of Object.entries(comparison.deltas.counts)) {
    lines.push(`| ${key} | ${value} |`);
  }
  lines.push(
    "",
    "## Changes",
    "",
    ...Object.entries(comparison.changes).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Interpretation",
    "",
    comparison.interpretation,
    "",
    "## Artifacts",
    "",
    `- Left summary: ${comparison.artifacts.leftSummary}`,
    `- Right summary: ${comparison.artifacts.rightSummary}`,
    `- Left artifact index: ${comparison.artifacts.leftArtifactIndex}`,
    `- Right artifact index: ${comparison.artifacts.rightArtifactIndex}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function runTableRow(label, run) {
  return `| ${label} | ${run.runId} | ${run.faultMode} | ${run.finalOutcome} | ${run.classification.code} | ${
    run.counts.turns
  } | ${run.counts.agentRuns} | ${run.counts.verifyRuns} | ${run.counts.activeEscalations} |`;
}

function assertApprovedHistoryRoot(target) {
  const demoRoot = path.join(repoRoot, ".swarm-demo");
  const resolved = path.resolve(target);
  if (!resolved.toLowerCase().startsWith(`${demoRoot.toLowerCase()}${path.sep}`)) {
    throw new Error(`Refusing to read live smoke history outside ${demoRoot}: ${resolved}`);
  }
  if (samePath(resolved, repoRoot) || samePath(resolved, path.dirname(repoRoot)) || samePath(resolved, demoRoot)) {
    throw new Error(`Refusing unsafe live smoke history root: ${resolved}`);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}
