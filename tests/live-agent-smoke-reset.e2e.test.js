import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import YAML from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const resetScript = path.join(repoRoot, "scripts", "reset-live-agent-smoke.mjs");

test("live agent smoke reset creates a labeled resettable workspace", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-smoke-reset-${process.pid}-${Date.now()}`);
  const output = execFileSync(process.execPath, [resetScript, "--workspace", workspace, "--stop-related-processes"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const summary = JSON.parse(output);
  assert.equal(summary.workspace, workspace);
  assert.equal(summary.runMode, "live-agent-smoke");
  assert.equal(summary.counts.targets, 2);
  assert.equal(summary.counts.sources, 3);
  assert.equal(summary.counts.slices, 0);
  assert.ok(Array.isArray(summary.stoppedProcesses));
  assert.equal(summary.recovery.childIdleTimeoutSeconds, 300);
  assert.ok(fs.existsSync(summary.manifest));

  const manifest = JSON.parse(fs.readFileSync(summary.manifest, "utf8"));
  assert.equal(manifest.scenarioId, "live-agent-smoke");
  assert.equal(manifest.runMode, "live-agent-smoke");
  assert.equal(manifest.phase, "phase-1-reset-and-run-mode");
  assert.equal(manifest.targets.length, 2);
  assert.equal(manifest.sources.length, 3);
  assert.equal(manifest.fullProductMode.plannedCommand, "npm run smoke:live-agent:full");
  assert.ok(manifest.fullProductMode.productSpec.endsWith("live-smoke-invoice-dashboard-product-spec.md"));
  assert.equal(manifest.fullProductMode.maxTurns, 80);
  assert.equal(manifest.fullProductMode.maxSlices, 20);
  assert.equal(manifest.fullProductMode.maxAgentRuns, 150);
  assert.equal(manifest.fullProductMode.maxRuntimeMinutes, 120);
  assert.equal(manifest.fullProductMode.childIdleTimeoutSeconds, 300);
  assert.equal(manifest.commands.fullProduct, "npm run demo:live-agent:full");
  assert.equal(manifest.commands.resetAndFullProduct, "npm run smoke:live-agent:full");
  assert.equal(manifest.commands.cliReset, "swarm smoke live-agent reset");
  assert.equal(manifest.commands.cliRun, "swarm smoke live-agent run");
  assert.equal(manifest.commands.cliFullProduct, "swarm smoke live-agent full");

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "20"], workspace));
  assert.equal(snapshot.runMode, "live-agent-smoke");
  assert.equal(snapshot.targets.length, 2);
  assert.equal(snapshot.sources.length, 3);
  assert.ok(snapshot.sources.some((source) => source.title === "Live Smoke Product Spec: Invoice Operations Dashboard"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Product"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Backend"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Invoice Dashboard"));

  const productSpec = path.join(workspace, "source-specs", "live-smoke-invoice-dashboard-product-spec.md");
  const dashboardPackage = JSON.parse(fs.readFileSync(path.join(workspace, "invoice-dashboard", "package.json"), "utf8"));
  const backendProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "invoice-api", ".swarm", "protocol.yaml"), "utf8"));
  const dashboardProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "invoice-dashboard", ".swarm", "protocol.yaml"), "utf8"));
  assert.ok(fs.existsSync(productSpec));
  assert.equal(typeof dashboardPackage.scripts.test, "string");
  assert.equal(dashboardPackage.scripts.start, undefined);
  assert.equal(backendProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);
  assert.equal(dashboardProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);

  const status = runSwarm(["status"], workspace);
  assert.match(status, /Run mode: live-agent-smoke/);
});

test("support triage smoke reset creates scenario sources, targets, and skills", () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-smoke-h2-reset-${process.pid}-${Date.now()}`);
  const output = execFileSync(
    process.execPath,
    [resetScript, "--scenario", "live-agent-smoke-h2", "--workspace", workspace, "--stop-related-processes"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const summary = JSON.parse(output);
  assert.equal(summary.scenarioId, "live-agent-smoke-h2");
  assert.equal(summary.workspace, workspace);
  assert.equal(summary.runMode, "live-agent-smoke");
  assert.equal(summary.counts.targets, 2);
  assert.equal(summary.counts.sources, 4);
  assert.equal(summary.counts.slices, 0);
  assert.equal(summary.runnerStatus, "reset_scaffold_only");
  assert.deepEqual(summary.skillIds, [
    "support-accessibility-review",
    "support-triage-domain",
    "support-ui-design-system",
    "support-ui-implementation",
    "support-ui-review",
  ]);

  const manifest = JSON.parse(fs.readFileSync(summary.manifest, "utf8"));
  assert.equal(manifest.scenarioId, "live-agent-smoke-h2");
  assert.equal(manifest.phase, "phase-11b-scenario-reset-scaffold");
  assert.equal(manifest.fullProductMode.runnerStatus, "wired_phase_11d_real_run");
  assert.equal(manifest.fullProductMode.productReadinessProbe.workflow.kind, "configured-http-workflow");
  assert.equal(manifest.fullProductMode.productReadinessProbe.workflow.ticketId, "TCK-100");
  assert.deepEqual(manifest.targets.map((target) => target.name), ["support-api", "support-ui"]);
  assert.deepEqual(manifest.targets[0].skillHints.worker, ["support-triage-domain"]);
  assert.deepEqual(manifest.targets[1].skillHints.worker, [
    "support-triage-domain",
    "support-ui-implementation",
    "support-ui-design-system",
  ]);
  assert.equal(manifest.scenarioSources.length, 4);

  const snapshot = JSON.parse(runSwarm(["observe", "--events", "20"], workspace));
  assert.equal(snapshot.runMode, "live-agent-smoke");
  assert.equal(snapshot.targets.length, 2);
  assert.equal(snapshot.sources.length, 4);
  assert.ok(snapshot.sources.some((source) => source.title === "Live Smoke Product Spec: Customer Support Triage Board"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Support Product"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Support Backend"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Support Dashboard"));
  assert.ok(snapshot.domains.some((domain) => domain.domain === "Support Design System"));

  const apiProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "support-api", ".swarm", "protocol.yaml"), "utf8"));
  const uiProtocol = YAML.parse(fs.readFileSync(path.join(workspace, "support-ui", ".swarm", "protocol.yaml"), "utf8"));
  const uiPackage = JSON.parse(fs.readFileSync(path.join(workspace, "support-ui", "package.json"), "utf8"));
  assert.equal(apiProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);
  assert.equal(uiProtocol.protocol.recovery.childIdleTimeoutSeconds, 300);
  assert.deepEqual(apiProtocol.protocol.skills.roles.worker.optional, ["support-triage-domain"]);
  assert.deepEqual(uiProtocol.protocol.skills.roles.worker.optional, [
    "support-triage-domain",
    "support-ui-implementation",
    "support-ui-design-system",
  ]);
  assert.ok(fs.existsSync(path.join(workspace, "support-ui", ".swarm", "skills", "support-ui-review", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(workspace, "support-api", ".swarm", "skills", "support-triage-domain", "SKILL.md")));
  assert.equal(uiPackage.scripts.start, "node src/server.js");
  assert.ok(fs.existsSync(path.join(workspace, "support-ui", "src", "server.js")));
  assert.ok(fs.existsSync(path.join(workspace, "support-ui", "src", "browser-app.js")));
});

test("live agent smoke reset stops listeners discovered from workspace artifacts", async () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-smoke-reset-port-${process.pid}-${Date.now()}`);
  const helperPath = path.join(repoRoot, ".swarm-demo", `test-port-listener-${process.pid}-${Date.now()}.mjs`);
  const portPath = path.join(repoRoot, ".swarm-demo", `test-port-listener-${process.pid}-${Date.now()}.txt`);
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(
    helperPath,
    `import fs from "node:fs";
import http from "node:http";
const portPath = process.argv[2];
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portPath, String(server.address().port), "utf8");
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const child = spawn(process.execPath, [helperPath, portPath], {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    const port = await waitForPortFile(portPath);
    const artifactDir = path.join(workspace, "support-triage-live-artifacts");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "product-probe.md"), `Manual URL: http://127.0.0.1:${port}\n`, "utf8");

    const output = execFileSync(
      process.execPath,
      [resetScript, "--scenario", "live-agent-smoke-h2", "--workspace", workspace, "--stop-related-processes"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const summary = JSON.parse(output);
    assert.ok(
      summary.stoppedProcesses.some((process) => process.pid === child.pid && process.reason === `workspace artifact port ${port}`),
      `expected reset to stop listener ${child.pid} on artifact port ${port}`,
    );
    await waitForProcessExit(child.pid);
  } finally {
    if (child.pid && isProcessRunning(child.pid)) child.kill("SIGKILL");
    fs.rmSync(helperPath, { force: true });
    fs.rmSync(portPath, { force: true });
  }
});

test("live agent smoke reset preserves excluded control server listeners", async () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-live-agent-smoke-reset-exclude-${process.pid}-${Date.now()}`);
  const helperPath = path.join(repoRoot, ".swarm-demo", `test-excluded-listener-${process.pid}-${Date.now()}.mjs`);
  const portPath = path.join(repoRoot, ".swarm-demo", `test-excluded-listener-${process.pid}-${Date.now()}.txt`);
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(
    helperPath,
    `import fs from "node:fs";
import http from "node:http";
const portPath = process.argv[2];
const server = http.createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portPath, String(server.address().port), "utf8");
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const child = spawn(process.execPath, [helperPath, portPath], {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
  });

  try {
    const port = await waitForPortFile(portPath);
    const artifactDir = path.join(workspace, "support-triage-live-artifacts");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "product-probe.md"), `Control URL: http://127.0.0.1:${port}\n`, "utf8");

    const output = execFileSync(
      process.execPath,
      [resetScript, "--scenario", "live-agent-smoke-h2", "--workspace", workspace, "--stop-related-processes"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          SWARM_RESET_EXCLUDE_PIDS: String(child.pid),
          SWARM_RESET_EXCLUDE_PORTS: String(port),
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const summary = JSON.parse(output);
    assert.equal(
      summary.stoppedProcesses.some((process) => process.pid === child.pid),
      false,
      `excluded listener ${child.pid} should not be stopped`,
    );
    assert.equal(isProcessRunning(child.pid), true, `excluded listener ${child.pid} should still be running`);
  } finally {
    if (child.pid && isProcessRunning(child.pid)) child.kill("SIGKILL");
    fs.rmSync(helperPath, { force: true });
    fs.rmSync(portPath, { force: true });
  }
});

test("live agent smoke reset refuses unsafe workspace overrides", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [resetScript, "--workspace", repoRoot], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /Refusing to reset workspace outside approved live smoke root|Refusing unsafe live smoke workspace/,
  );
});

function runSwarm(args, workspace) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForPortFile(filePath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const port = Number.parseInt(fs.readFileSync(filePath, "utf8"), 10);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for listener port file: ${filePath}`);
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await delay(50);
  }
  assert.equal(isProcessRunning(pid), false, `expected process ${pid} to exit`);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
