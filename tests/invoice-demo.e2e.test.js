import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { SwarmStore } from "../dist/storage.js";
import { buildCoverage } from "../dist/observability.js";
import { buildHumanActionQueue } from "../dist/human-actions.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");
const dashboardTemplate = path.join(repoRoot, "fixtures", "templates", "invoice-dashboard");

test("invoice demo runs end-to-end with deterministic fixture workers", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-invoice-${process.pid}`);
  execFileSync(process.execPath, [
    path.join(repoRoot, "scripts", "run-invoice-demo.mjs"),
    "--driver",
    "fixture",
    "--workspace",
    workspace,
  ], { cwd: repoRoot, encoding: "utf8" });

  const snapshotPath = path.join(workspace, "invoice-observability-snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const invoiceTargetId = snapshot.targets.find((target) => target.name === "invoice-api").id;
  const dashboardTargetId = snapshot.targets.find((target) => target.name === "invoice-dashboard").id;
  const invoiceSlices = snapshot.slices.filter((slice) => slice.targetId === invoiceTargetId);
  const dashboardSlices = snapshot.slices.filter((slice) => slice.targetId === dashboardTargetId);

  assert.equal(invoiceSlices.length, 3);
  assert.equal(dashboardSlices.length, 1);
  assert.deepEqual(invoiceSlices.map((slice) => slice.status), ["accepted", "accepted", "accepted"]);
  assert.equal(dashboardSlices[0].status, "accepted");
  assert.equal(snapshot.agentRuns.length, 4);
  assert.ok(snapshot.agentRuns.every((run) => run.status === "completed"));
  assert.equal(snapshot.activeEscalations.length, 0);
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "backend-worker-query"));
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "backend-verifier-lookup"));
  assert.ok(snapshot.heartbeats.some((heartbeat) => heartbeat.actor === "frontend-worker-dashboard"));
  assert.ok(
    snapshot.recentEvents.some((event) => event.type === "slice.blocked_by_dependencies"),
    "dashboard should have been blocked before backend readiness",
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "worker.agent_event" &&
        event.actor === "frontend-worker-dashboard" &&
        event.payload.agentEventType === "fixture.worker.completed",
    ),
    "worker JSONL output should be ingested as first-class harness events",
  );

  for (const slice of invoiceSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
    assert.deepEqual(slice.frAcResults.map((item) => item.status), slice.frAcRefs.map(() => "passed"));
  }

  for (const slice of dashboardSlices) {
    assert.ok(slice.frAcRefs.every((ref) => ref.startsWith("AC-UI-INV-")));
    assert.ok(slice.leases.every((lease) => lease.status === "completed"));
    assert.ok(slice.evidence.some((item) => item.kind === "worker_result"));
    assert.ok(slice.evidence.some((item) => item.kind === "command" && item.payload.passed === true));
    assert.deepEqual(slice.frAcResults.map((item) => item.status), slice.frAcRefs.map(() => "passed"));
  }

  const dashboardTimeline = JSON.parse(runSwarm(workspace, ["timeline", dashboardSlices[0].id, "--json"]));
  assert.equal(dashboardTimeline.entityType, "slice");
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.started")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "event" && item.label.includes("worker.agent_event")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "evidence" && item.label.includes("worker_result")));
  assert.ok(dashboardTimeline.items.some((item) => item.kind === "lease" && item.detail.includes("completed")));

  const graph = JSON.parse(runSwarm(workspace, ["graph", "--format", "json"]));
  assert.ok(graph.nodes.some((node) => node.type === "source" && node.label === "Invoice Dashboard Requirements"));
  assert.ok(graph.nodes.some((node) => node.type === "actor" && node.label === "frontend-worker-dashboard"));
  assert.ok(graph.edges.every((edge) => edge.type !== "dependency" || edge.status !== "blocked"));
  assert.ok(graph.edges.some((edge) => edge.type === "dependency" && edge.from === "AC-INV-001.1" && edge.status === "satisfied"));
  assert.ok(graph.edges.some((edge) => edge.type === "dependency" && edge.from === "target test command" && edge.status === "satisfied"));
  assert.ok(graph.edges.some((edge) => edge.type === "evidence" && edge.from === dashboardSlices[0].id));
  const completedBackendAc = graph.nodes.find((node) => node.id === "AC-INV-001.1");
  assert.equal(completedBackendAc?.type, "fr_ac");
  assert.equal(completedBackendAc?.status, "completed");

  const dot = runSwarm(workspace, ["graph", "--format", "dot"]);
  assert.match(dot, /digraph swarm/);
  assert.match(dot, /Frontend Lane: Invoice Dashboard/);

  const watch = runSwarm(workspace, ["watch", "--once", "--no-clear", "--events", "8"]);
  assert.match(watch, /Agent Swarm Watch/);
  assert.match(watch, /Frontend Lane: Invoice Dashboard/);
  assert.match(watch, /Heartbeats/);
  assert.match(watch, /Blocked dependencies: 0/);
  assert.match(watch, /Recent Events/);

  const agentWatch = runSwarm(workspace, ["watch", "--once", "--no-clear", "--view", "agents", "--events", "8"]);
  assert.match(agentWatch, /View: agents/);
  assert.match(agentWatch, /Agent Runs/);
  assert.match(agentWatch, /RUN-/);
  assert.doesNotMatch(agentWatch, /\nLanes\n/);

  const checkpointList = runSwarm(workspace, ["checkpoint", "list"]);
  assert.match(checkpointList, /Checkpoints:/);
  assert.match(checkpointList, /worker slice:/);
  assert.match(checkpointList, /verifier slice:/);

  const resumePacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `slice:${dashboardSlices[0].id}`,
    "--role",
    "worker",
  ]);
  assert.match(resumePacket, /Resume Packet: worker slice:/);
  assert.match(resumePacket, /Worker Focus/);
  assert.match(resumePacket, /Delivery Question/);
  assert.match(resumePacket, /AC-UI-INV-001.1/);
  assert.match(resumePacket, /Missing or failed FR\/AC proof/);
  assert.match(resumePacket, /Do not mutate immutable source specs/);

  const verifierPacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `slice:${dashboardSlices[0].id}`,
    "--role",
    "verifier",
  ]);
  assert.match(verifierPacket, /Verifier Focus/);
  assert.match(verifierPacket, /Per-FR\/AC checklist/);
  assert.match(verifierPacket, /Block acceptance unless every in-scope FR\/AC/);

  const plannerPacket = runSwarm(workspace, [
    "resume-context",
    "--entity",
    `lane:${dashboardSlices[0].laneId}`,
    "--role",
    "planner",
  ]);
  assert.match(plannerPacket, /Planner \/ Overseer Focus/);
  assert.match(plannerPacket, /Active slices/);
  assert.match(plannerPacket, /Recent planner decisions/);

  const dashboardRun = snapshot.agentRuns.find((run) => run.sliceId === dashboardSlices[0].id);
  assert.ok(dashboardRun);
  const runResumePacket = runSwarm(workspace, ["resume-context", "--run", dashboardRun.id]);
  assert.match(runResumePacket, /Resume Packet: recovery agent_run:/);
  assert.match(runResumePacket, /Recovery Focus/);
  assert.match(runResumePacket, /Revive\/restart recommendation/);
  assert.match(runResumePacket, /Artifacts/);
});

test("verification blocks acceptance when worker coverage evidence is missing", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--force"]);
  assert.match(verifyOutput, /worker gate: missing worker_result evidence/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.ok(slice.leases.every((lease) => lease.status === "active"));
});

test("manual checkpoint refresh keeps latest checkpoint per role and entity", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-checkpoint-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const first = runSwarm(workspace, ["checkpoint", "create", "--entity", `slice:${sliceId}`, "--role", "worker"]);
  const firstId = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(first)?.[1];
  assert.ok(firstId);
  const second = runSwarm(workspace, ["checkpoint", "create", "--entity", `slice:${sliceId}`, "--role", "worker"]);
  const secondId = /Refreshed checkpoint (CHK-[a-f0-9]+)/i.exec(second)?.[1];
  assert.equal(secondId, firstId);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const matching = snapshot.checkpoints.filter(
    (item) => item.role === "worker" && item.entityType === "slice" && item.entityId === sliceId,
  );
  assert.equal(matching.length, 1);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "checkpoint.refreshed"));

  const shown = runSwarm(workspace, ["checkpoint", "show", firstId]);
  assert.match(shown, /# Checkpoint/);
  assert.match(shown, /Payload:/);
});

test("planner creates read-only verification obligations that flow through prompts, coverage, and verifier evidence", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-obligation-flow-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  let store = new SwarmStore(workspace);
  let slice = store.listSlices().find((item) => item.id === sliceId);
  let events = store.listEvents();
  store.close();
  assert.ok(slice);
  assert.equal(slice.verificationObligations.length, 3);
  assert.deepEqual(
    slice.verificationObligations.map((item) => item.ref),
    slice.frAcRefs,
  );
  assert.equal(slice.verificationObligations[0].immutable, true);
  assert.match(slice.verificationObligations[0].sourceText, /AC-INV-001\.1/);
  assert.match(slice.verificationObligations[0].criteria[0].expectedOutcome, /AC-INV-001\.1/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "slice.created" &&
        event.entityId === sliceId &&
        Array.isArray(event.payload.verificationObligations) &&
        event.payload.verificationObligations.length === 3,
    ),
  );

  store = new SwarmStore(workspace);
  const coverageBefore = buildCoverage(store);
  store.close();
  const coveredRef = coverageBefore.refs.find((item) => item.ref === "AC-INV-001.1");
  assert.equal(coveredRef.obligation.status, "present");
  assert.equal(coveredRef.obligation.criteriaCount, 1);

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "obligation-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "obligation-reviewer"]);
  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "obligation-verifier"]);
  assert.match(verifyOutput, /Verification passed/);

  store = new SwarmStore(workspace);
  slice = store.listSlices().find((item) => item.id === sliceId);
  events = store.listEvents();
  const commandEvidence = store.listEvidence(sliceId).filter((item) => item.kind === "command").at(-1);
  store.close();
  assert.equal(slice?.status, "accepted");
  const workerStarted = events.find((event) => event.type === "worker.started" && event.payload.workerActor === "obligation-worker");
  const reviewStarted = events.find((event) => event.type === "review.started" && event.payload.reviewerActor === "obligation-reviewer");
  assert.ok(workerStarted?.payload.promptPath);
  assert.ok(reviewStarted?.payload.promptPath);
  assert.ok(workerStarted.payload.skillBindingPath);
  assert.ok(workerStarted.payload.skillPacketPath);
  assert.ok(reviewStarted.payload.skillBindingPath);
  assert.ok(Array.isArray(workerStarted.payload.skills.required));
  assert.ok(workerStarted.payload.skills.required.some((skill) => skill.id === "implementation-worker"));
  assert.ok(reviewStarted.payload.skills.required.some((skill) => skill.id === "sleuth-review"));
  assert.ok(fs.existsSync(String(workerStarted.payload.skillBindingPath)));
  assert.ok(fs.existsSync(String(workerStarted.payload.skillPacketPath)));
  const workerPrompt = fs.readFileSync(String(workerStarted.payload.promptPath), "utf8");
  assert.match(workerPrompt, /Harness-managed skills/);
  assert.match(workerPrompt, /implementation-worker/);
  assert.match(workerPrompt, /Verification obligations \(read-only\)/);
  assert.match(workerPrompt, /Return status "passed" when your implementation work and worker evidence are complete/);
  assert.match(workerPrompt, /Do not return "needs_human" merely because independent review/);
  // FR-CP-001: harness-authored settled facts section from the requirement ledger.
  assert.match(workerPrompt, /Settled facts from the requirement ledger/);
  assert.match(workerPrompt, /do NOT waive your evidence obligations/i);
  assert.match(workerPrompt, /Still-blocked \/ human-gated refs/);
  const reviewPrompt = fs.readFileSync(String(reviewStarted.payload.promptPath), "utf8");
  assert.match(reviewPrompt, /Harness-managed skills/);
  assert.match(reviewPrompt, /sleuth-review/);
  assert.match(reviewPrompt, /Judge evidence against the read-only verification obligations/);
  assert.ok(commandEvidence);
  const frAcResults = commandEvidence.payload.frAcResults;
  assert.ok(Array.isArray(frAcResults));
  assert.equal(frAcResults[0].criteriaResults[0].expectedOutcome, slice.verificationObligations[0].criteria[0].expectedOutcome);
  assert.match(frAcResults[0].criteriaResults[0].actualOutcome, /covered/i);
});

test("human-verification obligations produce packets and block acceptance", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-human-verification-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  let store = new SwarmStore(workspace);
  let slice = store.listSlices().find((item) => item.id === sliceId);
  store.close();
  assert.ok(slice);
  const humanRef = slice.frAcRefs[0];
  const obligations = slice.verificationObligations.map((obligation) =>
    obligation.ref === humanRef
      ? { ...obligation, mode: "human_verification_required", responsibleParty: "human-qa" }
      : obligation,
  );

  const db = new Database(path.join(workspace, ".swarm", "state.db"));
  try {
    db.prepare("update slices set verification_obligations_json = ? where id = ?").run(JSON.stringify(obligations), sliceId);
  } finally {
    db.close();
  }

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "human-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "human-reviewer"]);
  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "human-verifier"]);
  assert.match(verifyOutput, new RegExp(`awaiting human verification: ${humanRef.replace(".", "\\.")}`));
  assert.match(verifyOutput, /human packet/);

  store = new SwarmStore(workspace);
  slice = store.listSlices().find((item) => item.id === sliceId);
  const leases = store.listLeases().filter((lease) => lease.sliceId === sliceId);
  const commandEvidence = store.listEvidence(sliceId).filter((item) => item.kind === "command").at(-1);
  const packetEvidence = store.listEvidence(sliceId).find((item) => item.kind === "artifact" && item.ref === humanRef);
  const coverage = buildCoverage(store);
  store.close();

  assert.equal(slice?.status, "blocked", "human verification should block final acceptance");
  assert.ok(leases.every((lease) => lease.status === "active"), "leases should stay active until human verification is recorded");
  assert.ok(commandEvidence, "verification evidence should be recorded");
  assert.deepEqual(commandEvidence.payload.humanVerificationRefs, [humanRef]);
  assert.equal(commandEvidence.payload.humanInputRequiredRefs.length, 0);
  assert.equal(commandEvidence.payload.humanVerificationPackets.length, 1);
  const humanResult = commandEvidence.payload.frAcResults.find((item) => item.ref === humanRef);
  assert.equal(humanResult.status, "awaiting_human_verification");
  assert.ok(humanResult.evidenceIds.includes(commandEvidence.payload.humanVerificationPackets[0].evidenceId));

  assert.ok(packetEvidence, "human verification packet evidence should be recorded");
  assert.equal(packetEvidence.payload.type, "human_verification_packet");
  assert.equal(packetEvidence.payload.status, "awaiting_human_verification");
  assert.ok(fs.existsSync(packetEvidence.payload.markdownPath));
  assert.ok(fs.existsSync(packetEvidence.payload.jsonPath));
  const packetMarkdown = fs.readFileSync(packetEvidence.payload.markdownPath, "utf8");
  assert.match(packetMarkdown, new RegExp(`Human Verification Packet: ${humanRef.replace(".", "\\.")}`));
  assert.match(packetMarkdown, /Expected Outcomes/);
  assert.match(packetMarkdown, /Decision Options/);

  const coverageRef = coverage.refs.find((item) => item.ref === humanRef);
  assert.equal(coverageRef.ledgerStatus, "awaiting_human_verification");
  assert.equal(coverageRef.humanPath.state, "human_verification_required");
  assert.equal(coverageRef.humanPath.blocksAcceptance, true);
  assert.equal(coverageRef.humanPath.packet.markdownPath, packetEvidence.payload.markdownPath);

  const reworkOutput = runSwarm(workspace, [
    "human-verify",
    sliceId,
    humanRef,
    "--status",
    "needs_rework",
    "--actor",
    "human-qa",
    "--notes",
    "The display value did not match the expected acceptance note.",
  ]);
  assert.match(reworkOutput, /Human verification needs_rework recorded/);
  assert.match(reworkOutput, /final slice status: repairing/);

  store = new SwarmStore(workspace);
  slice = store.listSlices().find((item) => item.id === sliceId);
  const reworkLeases = store.listLeases().filter((lease) => lease.sliceId === sliceId);
  const reworkEvidence = store.listEvidence(sliceId).filter((item) => item.kind === "command").at(-1);
  const reworkCoverage = buildCoverage(store);
  store.close();

  assert.equal(slice?.status, "repairing", "needs_rework should keep the slice out of accepted state");
  assert.ok(reworkLeases.every((lease) => lease.status === "active"), "needs_rework should keep leases active");
  assert.equal(reworkEvidence.payload.humanVerificationResult.status, "needs_rework");
  assert.equal(reworkEvidence.payload.frAcResults.find((item) => item.ref === humanRef).status, "failed");
  const reworkCoverageRef = reworkCoverage.refs.find((item) => item.ref === humanRef);
  assert.equal(reworkCoverageRef.ledgerStatus, "failed");
  assert.equal(reworkCoverageRef.humanPath.packet.status, "needs_rework");

  const signedOutput = runSwarm(workspace, [
    "human-verify",
    sliceId,
    humanRef,
    "--status",
    "human_verified",
    "--actor",
    "human-qa",
    "--notes",
    "Rechecked against the packet and accepted.",
  ]);
  assert.match(signedOutput, /Human verification human_verified recorded/);
  assert.match(signedOutput, /final slice status: accepted/);

  store = new SwarmStore(workspace);
  slice = store.listSlices().find((item) => item.id === sliceId);
  const signedLeases = store.listLeases().filter((lease) => lease.sliceId === sliceId);
  const signedEvidence = store.listEvidence(sliceId).filter((item) => item.kind === "command").at(-1);
  const signedCoverage = buildCoverage(store);
  const humanRecorded = store.listEvents().find((event) => event.type === "human_verification.recorded" && event.entityId === sliceId);
  store.close();

  assert.equal(slice?.status, "accepted", "human_verified should accept the slice once all refs are satisfied");
  assert.ok(signedLeases.every((lease) => lease.status === "completed"), "accepted human verification should complete leases");
  assert.equal(signedEvidence.payload.humanVerificationResult.status, "human_verified");
  assert.equal(signedEvidence.payload.frAcResults.find((item) => item.ref === humanRef).status, "human_verified");
  const signedCoverageRef = signedCoverage.refs.find((item) => item.ref === humanRef);
  assert.equal(signedCoverageRef.status, "done");
  assert.equal(signedCoverageRef.ledgerStatus, "accepted");
  assert.equal(signedCoverageRef.verification, "human_verified");
  assert.equal(signedCoverageRef.humanPath.blocksAcceptance, false);
  assert.equal(signedCoverageRef.humanPath.packet.status, "human_verified");
  assert.ok(humanRecorded, "human verification result should be visible as an event");
});

test("human-required review gates become actionable visual verification packets", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-human-review-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  const packagePath = path.join(target, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.scripts = { ...packageJson.scripts, start: "node --version" };
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  let store = new SwarmStore(workspace);
  let slice = store.listSlices().find((item) => item.id === sliceId);
  store.close();
  assert.ok(slice);
  const humanRef = slice.frAcRefs[0];
  const obligations = slice.verificationObligations.map((obligation) =>
    obligation.ref === humanRef
      ? { ...obligation, mode: "human_verification_required", responsibleParty: "human-qa" }
      : obligation,
  );
  let db = new Database(path.join(workspace, ".swarm", "state.db"));
  try {
    db.prepare("update slices set verification_obligations_json = ? where id = ?").run(JSON.stringify(obligations), sliceId);
  } finally {
    db.close();
  }

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "human-gate-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "human-gate-reviewer"]);

  db = new Database(path.join(workspace, ".swarm", "state.db"));
  try {
    const reviewRow = db
      .prepare(
        "select id, payload_json from evidence where slice_id = ? and kind = 'review_result' order by created_at desc limit 1",
      )
      .get(sliceId);
    assert.ok(reviewRow, "review evidence should exist");
    const payload = JSON.parse(reviewRow.payload_json);
    payload.reviewResult = {
      ...payload.reviewResult,
      status: "human_required",
      summary: "Automated/reviewer evidence supports the implementation; final acceptance requires human visual verification.",
      requiredFixes: ["Complete and record human visual verification."],
      recommendation: "Proceed to human visual QA.",
      escalations: [
        {
          level: "human_required",
          message: "Human visual verification is explicitly required by the immutable obligations before final acceptance.",
        },
      ],
    };
    db.prepare("update evidence set payload_json = ? where id = ?").run(JSON.stringify(payload), reviewRow.id);
  } finally {
    db.close();
  }

  const escalationId = "ESC-human-review-gate";
  store = new SwarmStore(workspace);
  store.insertEscalation({
    id: escalationId,
    level: "human_required",
    status: "active",
    entityType: "slice",
    entityId: sliceId,
    message: "Human visual verification is explicitly required by the immutable obligations before final acceptance.",
    createdBy: "human-gate-reviewer",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.close();

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "human-gate-verifier"]);
  assert.match(verifyOutput, /review gate: latest review status is human_required/);
  assert.match(verifyOutput, new RegExp(`awaiting human verification: ${humanRef.replace(".", "\\.")}`));
  assert.match(verifyOutput, /human packet/);

  store = new SwarmStore(workspace);
  slice = store.listSlices().find((item) => item.id === sliceId);
  const coverage = buildCoverage(store);
  const queue = buildHumanActionQueue(store, workspace);
  store.close();

  assert.equal(slice?.status, "blocked", "human visual verification should block final acceptance");
  const coverageRef = coverage.refs.find((item) => item.ref === humanRef);
  assert.equal(coverageRef.ledgerStatus, "awaiting_human_verification");
  const humanAction = queue.actions.find((action) => action.kind === "human_verification" && action.ref === humanRef);
  assert.ok(humanAction, "human verification action should be surfaced for the operator");
  assert.equal(humanAction.reviewTarget.targetName, "invoice-api");
  assert.equal(humanAction.reviewTarget.startAvailable, true);
  assert.equal(humanAction.reviewTarget.startCommand, "npm run start");
  assert.equal(humanAction.reviewTarget.commandName, "start");
  assert.ok(humanAction.allowedActions.some((action) => action.kind === "record_human_verification"));
  assert.ok(
    queue.actions.every((action) => action.id !== `escalation:${escalationId}`),
    "generic slice human_required escalation should not duplicate the actionable visual QA packet",
  );
});

test("worker dispatch blocks explicit slices with missing verification obligations", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-obligation-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const db = new Database(path.join(workspace, ".swarm", "state.db"));
  try {
    db.prepare("update slices set verification_obligations_json = '[]' where id = ?").run(sliceId);
  } finally {
    db.close();
  }

  assert.throws(
    () => runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "obligation-gate-worker"]),
    /verificationObligations \(no obligations recorded\)/,
  );
});

test("dispatch rejects AC-sized proof work without an exception reason", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-meaningful-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const store = new SwarmStore(workspace);
  const slice = store.listSlices().find((item) => item.id === sliceId);
  store.close();
  assert.ok(slice);

  const dbPath = path.join(workspace, ".swarm", "state.db");
  const db = new Database(dbPath);
  try {
    const selectedRef = slice.frAcRefs[0];
    const selectedObligation = slice.verificationObligations.filter((item) => item.ref === selectedRef);
    db.prepare(
      `update slices
       set fr_ac_refs_json = ?,
           verification_obligations_json = ?,
           work_package_type = 'proof_pack',
           minimum_meaningful_outcome = 'proves_cutover_or_readiness',
           unblock_targets_json = '[]',
           ac_sized_exception_reason = null
       where id = ?`,
    ).run(JSON.stringify([selectedRef]), JSON.stringify(selectedObligation), sliceId);
  } finally {
    db.close();
  }

  assert.throws(
    () => runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "proof-worker"]),
    /AC-sized proof_pack work without an exception reason/,
  );
});

test("verification blocks acceptance when worker result omits one in-scope AC", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-partial-gate-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "partial-worker"]);

  const store = new SwarmStore(workspace);
  const workerEvidence = store.listEvidence(sliceId).find((item) => item.kind === "worker_result");
  store.close();
  assert.ok(workerEvidence?.ref);
  const workerResult = JSON.parse(fs.readFileSync(workerEvidence.ref, "utf8"));
  workerResult.frAcCoverage = workerResult.frAcCoverage.filter((item) => item.ref !== "AC-INV-001.3");
  fs.writeFileSync(workerEvidence.ref, `${JSON.stringify(workerResult)}\n`, "utf8");

  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "partial-verifier"]);
  assert.match(verifyOutput, /missing FR\/AC evidence: AC-INV-001\.3/);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "blocked");
  assert.ok(slice.leases.every((lease) => lease.status === "active"));
  const omitted = slice.frAcResults.find((item) => item.ref === "AC-INV-001.3");
  assert.equal(omitted.status, "missing_evidence");
});

test("planner blocks dashboard slices until backend dependencies are accepted", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-readiness-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const dashboard = path.join(workspace, "invoice-dashboard");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.cpSync(dashboardTemplate, dashboard, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["target", "init", dashboard]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  runSwarm(workspace, ["sources", "add-file", path.join(dashboard, "specs", "invoice-dashboard.md")]);

  assert.throws(
    () =>
      runSwarm(workspace, [
        "slices",
        "pull",
        "--target",
        "invoice-dashboard",
        "--source",
        "invoice-dashboard.md",
      ]),
    /Source dependencies are not satisfied/,
  );

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "10"]));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "slice.blocked_by_dependencies"));
});

test("planner raises low-signal warning after repeated accepted slices with no unblock target", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-low-signal-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  const genericSpec = path.join(target, "specs", "maintenance-proof.md");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });
  fs.writeFileSync(
    genericSpec,
    `# Maintenance Proof Requirements

- AC-MAINT-001.1: Record proof note one.
- AC-MAINT-001.2: Record proof note two.
- AC-MAINT-001.3: Record proof note three.
- AC-MAINT-002.1: Record proof note four.
- AC-MAINT-002.2: Record proof note five.
- AC-MAINT-002.3: Record proof note six.
`,
    "utf8",
  );

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", genericSpec]);

  const firstPull = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "maintenance-proof.md",
    "--batch-size",
    "3",
  ]);
  const firstSlice = /Created slice (SLICE-[a-f0-9]+)/i.exec(firstPull)?.[1];
  assert.ok(firstSlice);
  runSwarm(workspace, ["run", firstSlice, "--driver", "fixture", "--actor", "low-signal-worker-one"]);
  runSwarm(workspace, ["verify", firstSlice, "--actor", "low-signal-verifier-one"]);

  const secondPull = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "maintenance-proof.md",
    "--batch-size",
    "3",
  ]);
  const secondSlice = /Created slice (SLICE-[a-f0-9]+)/i.exec(secondPull)?.[1];
  assert.ok(secondSlice);
  runSwarm(workspace, ["run", secondSlice, "--driver", "fixture", "--actor", "low-signal-worker-two"]);
  runSwarm(workspace, ["verify", secondSlice, "--actor", "low-signal-verifier-two"]);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "30"]));
  assert.equal(snapshot.slices.filter((slice) => slice.status === "accepted").length, 2);
  assert.ok(
    snapshot.activeEscalations.some(
      (item) => item.level === "warning" && item.message.includes("Low-signal slice cadence detected"),
    ),
  );
  assert.ok(snapshot.recentEvents.some((event) => event.type === "planner.low_signal_work"));
});

test("recovery scan marks stale running agent runs and raises a scoped blocker", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-recovery-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  fs.writeFileSync(
    path.join(target, ".swarm", "protocol.yaml"),
    `protocol:
  planning:
    heartbeat:
      defaultStaleAfterSeconds: 60
  recovery:
    reviveRetries: 2
    highlightFinalAttempt: true
    releaseAfterRetries: false
`,
    "utf8",
  );
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const store = new SwarmStore(workspace);
  try {
    store.insertAgentRun({
      id: "RUN-stale001",
      sliceId,
      actor: "stale-worker",
      driver: "codex",
      status: "running",
      attempt: 1,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    store.upsertHeartbeat({
      id: "heartbeat:stale-worker",
      actor: "stale-worker",
      state: "thinking",
      detail: "Synthetic stale heartbeat",
      entityType: "slice",
      entityId: sliceId,
      timestamp: staleTimestamp,
    });
  } finally {
    store.close();
  }

  const scanOutput = runSwarm(workspace, ["recovery", "scan"]);
  assert.match(scanOutput, /Stale agent runs: 1/);
  assert.match(scanOutput, /stale after: 60s/);
  assert.match(scanOutput, /RUN-stale001/);

  runSwarm(workspace, ["recovery", "scan", "--mark-stale"]);
  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "20"]));
  const run = snapshot.agentRuns.find((item) => item.id === "RUN-stale001");
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(run.status, "stale");
  assert.equal(slice.status, "blocked");
  assert.ok(snapshot.activeEscalations.some((item) => item.entityId === sliceId && item.message.includes("RUN-stale001")));
  assert.ok(snapshot.recentEvents.some((event) => event.type === "recovery.marked_stale_run"));
  assert.throws(
    () => runSwarm(workspace, ["recovery", "revive", "RUN-stale001"]),
    /does not have a captured worker session id/,
  );

  const restartOutput = runSwarm(workspace, ["recovery", "restart", "RUN-stale001", "--driver", "fixture"]);
  assert.match(restartOutput, /Worker completed/);
  assert.match(restartOutput, /run: RUN-/);
  const restarted = JSON.parse(runSwarm(workspace, ["observe", "--events", "30"]));
  assert.ok(restarted.agentRuns.some((item) => item.id !== "RUN-stale001" && item.status === "completed"));
  assert.ok(restarted.recentEvents.some((event) => event.type === "recovery.restart_completed"));
  assert.ok(
    !restarted.activeEscalations.some((item) => item.entityId === sliceId && item.message.includes("RUN-stale001")),
    "successful recovery restart should clear the stale blocker for the previous run",
  );
  assert.ok(
    restarted.recentEvents.some((event) => event.type === "escalation.cleared" && event.payload?.clearedAfterRecovery),
    "successful recovery restart should record a recovery clearance event",
  );

  // FR-PI-002: recovery records that it consulted the focus/intervention packet BEFORE acting.
  const consult = restarted.recentEvents.find((event) => event.type === "recovery.focus_consulted");
  assert.ok(consult, "recovery restart should emit recovery.focus_consulted");
  assert.equal(consult.payload.recoveryKind, "restart");
  assert.ok(
    typeof consult.payload.recommendedAction === "string" && consult.payload.recommendedAction.length > 0,
    "focus_consulted carries an intervention recommendedAction",
  );
  assert.ok(typeof consult.payload.classification === "string");
  // Ordering ("consulted BEFORE acting") is a source-level guarantee; recentEvents collides
  // at ms resolution (storage.ts orders events by timestamp only), so we assert both the
  // consult and the restart_started events are recorded rather than a brittle list index.
  assert.ok(
    restarted.recentEvents.some((event) => event.type === "recovery.restart_started"),
    "recovery.restart_started present",
  );
});

test("verification clears stale worker blockers superseded by a later successful worker", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-invoice-stale-superseded-${process.pid}-${Date.now()}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);
  const pullOutput = runSwarm(workspace, [
    "slices",
    "pull",
    "--target",
    "invoice-api",
    "--source",
    "invoice-api.md",
    "--batch-size",
    "3",
  ]);
  const sliceId = /Created slice (SLICE-[a-f0-9]+)/i.exec(pullOutput)?.[1];
  assert.ok(sliceId);

  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const staleRunId = "RUN-staleverify001";
  const store = new SwarmStore(workspace);
  try {
    store.insertAgentRun({
      id: staleRunId,
      sliceId,
      role: "worker",
      entityType: "slice",
      entityId: sliceId,
      actor: "stale-worker",
      driver: "codex",
      status: "running",
      attempt: 1,
      startedAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });
    store.upsertHeartbeat({
      id: "heartbeat:stale-worker",
      actor: "stale-worker",
      state: "thinking",
      detail: "Synthetic stale heartbeat",
      entityType: "slice",
      entityId: sliceId,
      timestamp: staleTimestamp,
    });
  } finally {
    store.close();
  }

  runSwarm(workspace, ["recovery", "scan", "--mark-stale"]);
  runSwarm(workspace, ["run", sliceId, "--driver", "fixture", "--actor", "fresh-worker"]);
  runSwarm(workspace, ["review", sliceId, "--driver", "fixture", "--actor", "fresh-reviewer"]);
  const verifyOutput = runSwarm(workspace, ["verify", sliceId, "--actor", "fresh-verifier"]);
  assert.match(verifyOutput, /Verification passed/);

  const snapshot = JSON.parse(runSwarm(workspace, ["observe", "--events", "80"]));
  const slice = snapshot.slices.find((item) => item.id === sliceId);
  assert.equal(slice.status, "accepted");
  assert.ok(
    !snapshot.activeEscalations.some((item) => item.entityId === sliceId && item.message.includes(staleRunId)),
    "later successful worker/review/verification should clear the superseded stale worker blocker",
  );
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "escalation.cleared" &&
        event.payload?.staleRunId === staleRunId &&
        event.payload?.clearedAfterVerificationSupersededRun === true,
    ),
    "verification should record a visible stale-run blocker clearance",
  );
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
