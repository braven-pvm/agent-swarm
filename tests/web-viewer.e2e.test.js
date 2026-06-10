import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const template = path.join(repoRoot, "fixtures", "templates", "invoice-api");

test("web viewer serves read-only observability HTML and APIs", async () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-web-viewer-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["run-mode", "set", "scripted-codex"]);
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

  const port = await getFreePort();
  const server = spawn(process.execPath, [cli, "serve", "--workspace", workspace, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(port);
    const html = await text(`http://127.0.0.1:${port}/`);
    assert.match(html, /Agent Swarm Observability/);
    assert.match(html, /data-tab="overview"/);
    assert.match(html, /data-tab="specs"/);
    assert.match(html, /Domain Readiness/);
    assert.match(html, />Specs</);
    assert.match(html, /Search Results/);
    assert.match(html, /Selected spec only/);
    assert.match(html, /Registered Specs/);
    assert.match(html, /data-source-view="markdown"/);
    assert.match(html, /Spec Detail/);
    assert.match(html, /assets\/app\.js/);

    const snapshot = await json(`http://127.0.0.1:${port}/api/snapshot?events=5`);
    assert.equal(snapshot.runMode, "scripted-codex");
    assert.equal(snapshot.targets.length, 1);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.domains.length, 1);
    assert.equal(snapshot.domains[0].domain, "Unassigned");
    assert.ok(snapshot.sources[0].metadata.sections.length > 0);
    assert.ok(snapshot.sources[0].metadata.frAcRefs.includes("AC-INV-001.1"));
    assert.equal(snapshot.slices.length, 1);
    assert.equal(snapshot.slices[0].id, sliceId);

    const search = await json(`http://127.0.0.1:${port}/api/search/specs?q=invoices&limit=5`);
    assert.equal(search.query, "invoices");
    assert.ok(search.matches.length > 0);
    assert.ok(search.matches.some((match) => match.source.title === "Invoice Operations Backend Requirements"));
    assert.ok(search.matches.some((match) => match.section.refs.includes("AC-INV-001.1")));

    const sourceSearch = await json(
      `http://127.0.0.1:${port}/api/search/specs?q=invoices&source=${encodeURIComponent(snapshot.sources[0].id)}&limit=5`,
    );
    assert.equal(sourceSearch.source.id, snapshot.sources[0].id);
    assert.ok(sourceSearch.matches.length > 0);

    const missingSourceSearch = await json(`http://127.0.0.1:${port}/api/search/specs?q=invoices&source=missing-source&limit=5`);
    assert.equal(missingSourceSearch.source, undefined);
    assert.equal(missingSourceSearch.matches.length, 0);

    const sourceDetail = await json(`http://127.0.0.1:${port}/api/source/${encodeURIComponent(snapshot.sources[0].id)}`);
    assert.equal(sourceDetail.source.id, snapshot.sources[0].id);
    assert.match(sourceDetail.markdown, /Invoice Operations Backend Requirements/);
    assert.match(sourceDetail.markdown, /AC-INV-001.1/);

    const timeline = await json(`http://127.0.0.1:${port}/api/timeline/${encodeURIComponent(sliceId)}`);
    assert.equal(timeline.entityType, "slice");
    assert.ok(timeline.items.some((item) => item.kind === "slice"));

    const graph = await json(`http://127.0.0.1:${port}/api/graph`);
    assert.ok(graph.nodes.some((node) => node.id === sliceId));

    const report = await text(`http://127.0.0.1:${port}/api/report/${encodeURIComponent(sliceId)}`);
    assert.match(report, /# Slice Report:/);
    assert.match(report, /AC-INV-001.1/);

    const writeAttempt = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: "POST" });
    assert.equal(writeAttempt.status, 405);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
  }
});

test("web viewer can bind an automatically selected free port", async () => {
  const workspace = path.join(repoRoot, ".swarm-demo", `test-web-viewer-port-zero-${process.pid}`);
  const target = path.join(workspace, "invoice-api");
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(template, target, { recursive: true });

  runSwarm(workspace, ["init"]);
  runSwarm(workspace, ["target", "init", target]);
  runSwarm(workspace, ["sources", "add-file", path.join(target, "specs", "invoice-api.md")]);

  const server = spawn(process.execPath, [cli, "serve", "--workspace", workspace, "--host", "127.0.0.1", "--port", "0"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const output = await waitForStdout(server, /url: http:\/\/127\.0\.0\.1:(\d+)\//);
    const port = Number(/url: http:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1]);
    assert.ok(port > 0);
    const snapshot = await json(`http://127.0.0.1:${port}/api/snapshot`);
    assert.equal(snapshot.sources.length, 1);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("close", resolve));
  }
});

function runSwarm(workspace, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Could not allocate free port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for web viewer server");
}

function waitForStdout(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for stdout pattern ${pattern}`)), 5000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!pattern.test(output)) {
        clearTimeout(timeout);
        reject(new Error(`Process exited before stdout matched ${pattern}; code ${code}; output: ${output}`));
      }
    });
  });
}

async function json(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function text(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.text();
}
