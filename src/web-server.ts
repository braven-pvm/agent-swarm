import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactsDir } from "./paths.js";
import { readSourceText } from "./source-adapter.js";
import { sourceDomain, sourcePriority, sourceTags } from "./source-index.js";
import { EventTailer } from "./event-tailer.js";
import { createReviewCommandInvocation, resolveReviewEnvironment, type ReviewEnvironment } from "./review-target.js";
import { SwarmStore } from "./storage.js";
import {
  buildObservabilitySnapshot,
  buildCoverage,
  buildRunObservability,
  buildSliceReport,
  buildTimeline,
  buildGraph,
  findSource,
  searchSpecSections,
  parseOptionalPositiveInteger,
  listLiveRunHistory,
  loadLiveRunHistoryDetail,
  compareLiveRunHistory,
} from "./observability.js";
import { buildRunFocusPacket, buildSliceFocusPacket } from "./focus.js";
import { buildHumanActionQueue, clearHumanEscalation, recordHumanVerification } from "./human-actions.js";

type ControlCommandStatus = "running" | "completed" | "failed";

interface ControlCommandRecord {
  id: string;
  kind: string;
  status: ControlCommandStatus;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutHref: string;
  stderrHref: string;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  activity?: {
    checkedAt: string;
    stdoutBytes: number;
    stderrBytes: number;
    lastOutputAt?: string;
    latestArtifact?: {
      path: string;
      href: string;
      bytes: number;
      updatedAt: string;
    };
    latestAgentRun?: {
      id: string;
      role?: string;
      actor: string;
      status: string;
      entityType?: string;
      entityId?: string;
      sliceId?: string;
      updatedAt: string;
    };
    latestHeartbeat?: {
      actor: string;
      state: string;
      detail?: string;
      entityType?: string;
      entityId?: string;
      timestamp: string;
    };
    error?: string;
  };
}

interface DevServerRecord {
  id: string;
  status: "starting" | "running" | "stopped" | "failed";
  targetName?: string;
  targetPath: string;
  commandName?: string;
  commandSource?: string;
  displayCommand?: string;
  command: string;
  args: string[];
  url: string;
  port: number;
  openable: boolean;
  readiness: {
    status: "checking" | "passed" | "failed" | "timeout" | "not_checked";
    url: string;
    timeoutMs?: number;
    checkedAt?: string;
    statusCode?: number;
    error?: string;
  };
  pid?: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutHref: string;
  stderrHref: string;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

const controlCommands = new Map<string, ControlCommandRecord>();
const devServers = new Map<string, DevServerRecord & { child?: ChildProcess }>();

export function createWebViewerServer(input: {
  workspace: string;
  defaultEventCount: number;
  historyRoot: string;
  webDistPath: string;
}): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST") {
        await handlePostRequest(request, response, requestUrl, input.workspace);
        return;
      }
      if (request.method !== "GET") {
        sendText(response, 405, "Method not allowed", "text/plain");
        return;
      }

      if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname.startsWith("/assets/"))) {
        const rel = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
        const filePath = path.join(input.webDistPath, rel);
        if (filePath.startsWith(input.webDistPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          sendText(response, 200, fs.readFileSync(filePath, "utf8"), contentTypeForPath(filePath));
        } else if (requestUrl.pathname === "/") {
          sendText(response, 503, "Command Bridge UI is not built. Run: npm run build:web", "text/plain");
        } else {
          sendText(response, 404, "Not found", "text/plain");
        }
        return;
      }
      if (requestUrl.pathname === "/api/history/runs") {
        sendJson(response, listLiveRunHistory(input.historyRoot));
        return;
      }
      if (requestUrl.pathname.startsWith("/api/history/run/")) {
        const runId = decodeURIComponent(requestUrl.pathname.slice("/api/history/run/".length));
        const detail = loadLiveRunHistoryDetail(input.historyRoot, runId);
        if (!detail) {
          sendJson(response, { error: "Archived run not found" }, 404);
          return;
        }
        sendJson(response, detail);
        return;
      }
      if (requestUrl.pathname === "/api/history/compare") {
        const comparison = compareLiveRunHistory(
          input.historyRoot,
          requestUrl.searchParams.get("left") ?? undefined,
          requestUrl.searchParams.get("right") ?? undefined,
        );
        if (!comparison) {
          sendJson(response, { error: "Need at least two archived runs to compare" }, 404);
          return;
        }
        sendJson(response, comparison);
        return;
      }
      if (requestUrl.pathname === "/api/control/commands") {
        sendJson(response, { commands: Array.from(controlCommands.values()).map(serializeControlCommand) });
        return;
      }
      if (requestUrl.pathname === "/api/control/dev-servers") {
        sendJson(response, { servers: Array.from(devServers.values()).map(serializeDevServer) });
        return;
      }

      // NOTE: /api/stream is handled here with an early return so the long-lived SSE
      // connection does NOT fall into the per-request SwarmStore block below, which
      // opens and closes a store in a finally — incompatible with a persistent SSE stream.
      if (requestUrl.pathname === "/api/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("retry: 3000\n\n");
        const streamStore = new SwarmStore(input.workspace);
        const send = (eventName: string, data: unknown) => {
          response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const tailer = new EventTailer(streamStore, {
          intervalMs: 400,
          onEvent: (event) => send("event.appended", event),
          onHeartbeat: (heartbeat) => send("heartbeat.changed", heartbeat),
        });
        tailer.start();
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15000);
        const cleanup = () => {
          clearInterval(keepAlive);
          tailer.stop();
          streamStore.close();
        };
        request.on("close", cleanup);
        response.on("close", cleanup);
        return;
      }

      const store = new SwarmStore(input.workspace);
      try {
        if (requestUrl.pathname === "/api/snapshot") {
          const events = parseOptionalPositiveInteger(requestUrl.searchParams.get("events")) ?? input.defaultEventCount;
          sendJson(response, buildObservabilitySnapshot(store, input.workspace, events));
          return;
        }
        if (requestUrl.pathname.startsWith("/api/timeline/")) {
          const entityId = decodeURIComponent(requestUrl.pathname.slice("/api/timeline/".length));
          if (!entityId) {
            sendJson(response, { error: "Missing timeline entity id" }, 400);
            return;
          }
          sendJson(response, buildTimeline(store, entityId));
          return;
        }
        if (requestUrl.pathname === "/api/coverage") {
          sendJson(response, buildCoverage(store));
          return;
        }
        if (requestUrl.pathname === "/api/run-observability") {
          sendJson(response, buildRunObservability(store, input.workspace));
          return;
        }
        if (requestUrl.pathname === "/api/human-actions") {
          sendJson(response, buildHumanActionQueue(store, input.workspace));
          return;
        }
        if (requestUrl.pathname === "/api/graph") {
          sendJson(response, buildGraph(store));
          return;
        }
        if (requestUrl.pathname.startsWith("/api/source/")) {
          const selector = decodeURIComponent(requestUrl.pathname.slice("/api/source/".length));
          const source = selector ? findSource(store, selector) : undefined;
          if (!source) {
            sendJson(response, { error: "Source not found" }, 404);
            return;
          }
          sendJson(response, {
            source,
            markdown: readSourceText(source),
          });
          return;
        }
        if (requestUrl.pathname === "/api/search/specs") {
          const query = requestUrl.searchParams.get("q") ?? "";
          const limit = parseOptionalPositiveInteger(requestUrl.searchParams.get("limit")) ?? 8;
          const domain = requestUrl.searchParams.get("domain") ?? undefined;
          const tag = requestUrl.searchParams.get("tag") ?? undefined;
          const source = requestUrl.searchParams.get("source") ?? undefined;
          const matches = query.trim()
            ? searchSpecSections(store, query, { domain, tag, source, limit }).map((match) => ({
                source: {
                  id: match.source.id,
                  title: match.source.title,
                  uri: match.source.uri,
                  domain: sourceDomain(match.source),
                  tags: sourceTags(match.source),
                  priority: sourcePriority(match.source),
                },
                section: match.section,
                score: match.score,
                snippet: match.snippet,
              }))
            : [];
          const selectedSource = source ? findSource(store, source) : undefined;
          sendJson(response, { query, source: selectedSource ? { id: selectedSource.id, title: selectedSource.title } : undefined, matches });
          return;
        }
        if (requestUrl.pathname === "/api/agent-events") {
          const actor = requestUrl.searchParams.get("actor") ?? "";
          const limit = parseOptionalPositiveInteger(requestUrl.searchParams.get("limit")) ?? 300;
          if (!actor) {
            sendJson(response, { actor: "", events: [] });
            return;
          }
          sendJson(response, { actor, events: store.eventsForActor(actor, limit) });
          return;
        }
        if (requestUrl.pathname.startsWith("/api/report/")) {
          const sliceId = decodeURIComponent(requestUrl.pathname.slice("/api/report/".length));
          if (!sliceId) {
            sendJson(response, { error: "Missing report slice id" }, 400);
            return;
          }
          sendText(response, 200, buildSliceReport(store, sliceId), "text/markdown; charset=utf-8");
          return;
        }
        if (requestUrl.pathname.startsWith("/api/focus/run/")) {
          const runId = decodeURIComponent(requestUrl.pathname.slice("/api/focus/run/".length));
          if (!runId) {
            sendJson(response, { error: "Missing focus run id" }, 400);
            return;
          }
          try {
            sendJson(response, buildRunFocusPacket(store, input.workspace, runId, { eventLimit: 16 }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not found/i.test(message)) {
              sendJson(response, { error: message }, 404);
              return;
            }
            throw error;
          }
          return;
        }
        if (requestUrl.pathname.startsWith("/api/focus/slice/")) {
          const sliceId = decodeURIComponent(requestUrl.pathname.slice("/api/focus/slice/".length));
          if (!sliceId) {
            sendJson(response, { error: "Missing focus slice id" }, 400);
            return;
          }
          try {
            sendJson(response, buildSliceFocusPacket(store, input.workspace, sliceId, { runLimit: 8, eventLimit: 16 }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/not found/i.test(message)) {
              sendJson(response, { error: message }, 404);
              return;
            }
            throw error;
          }
          return;
        }
        if (requestUrl.pathname.startsWith("/api/artifacts/")) {
          const artifactPath = decodeURIComponent(requestUrl.pathname.slice("/api/artifacts/".length));
          serveArtifact(response, input.workspace, artifactPath);
          return;
        }
      } finally {
        store.close();
      }

      sendText(response, 404, "Not found", "text/plain");
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}

async function handlePostRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  workspace: string,
): Promise<void> {
  if (requestUrl.pathname === "/api/control/continue") {
    const body = await readJsonBody(request);
    const scenario = stringBodyValue(body.scenario) ?? inferScenario(workspace);
    const runId = stringBodyValue(body.runId) ?? `CONT-${compactTimestamp(new Date())}-${process.pid}`;
    const args = ["smoke", "live-agent", "full", "--scenario", scenario, "--workspace", workspace, "--run-id", runId];
    if (body.reset === true) args.push("--reset");
    appendPositiveCliOption(args, "--max-turns", body.maxTurns);
    appendPositiveCliOption(args, "--execute-limit", body.executeLimit);
    appendPositiveCliOption(args, "--max-runtime-seconds", body.maxRuntimeSeconds);
    appendPositiveCliOption(args, "--max-slices", body.maxSlices);
    appendPositiveCliOption(args, "--max-agent-runs", body.maxAgentRuns);
    appendPositiveCliOption(args, "--max-repair-attempts", body.maxRepairAttempts);
    const command = startBackgroundCliCommand(workspace, "continue-run", args);
    sendJson(response, {
      ok: true,
      command,
      runId,
      scenario,
      message: "Continue command started. Watch /api/control/commands, /api/stream, and /api/snapshot for progress.",
    });
    return;
  }

  if (requestUrl.pathname === "/api/control/recovery/scan") {
    const body = await readJsonBody(request);
    const args = ["recovery", "scan"];
    const staleAfter = positiveBodyInteger(body.staleAfter);
    if (staleAfter !== undefined) args.push("--stale-after", String(staleAfter));
    if (body.markStale === true) args.push("--mark-stale");
    if (body.release === true) args.push("--release");
    const actor = stringBodyValue(body.actor);
    if (actor) args.push("--actor", actor);
    const result = await runCliCommandCapture(workspace, "recovery-scan", args, 60_000);
    sendJson(response, { ok: result.exitCode === 0, result });
    return;
  }

  if (requestUrl.pathname === "/api/control/recovery/revive") {
    const body = await readJsonBody(request);
    const runId = stringBodyValue(body.runId);
    if (!runId) {
      sendJson(response, { error: "runId is required" }, 400);
      return;
    }
    const args = ["recovery", "revive", runId];
    const actor = stringBodyValue(body.actor);
    const model = stringBodyValue(body.model);
    if (actor) args.push("--actor", actor);
    if (model) args.push("--model", model);
    const command = startBackgroundCliCommand(workspace, "recovery-revive", args);
    sendJson(response, { ok: true, command, message: "Recovery revive started." });
    return;
  }

  if (requestUrl.pathname === "/api/control/recovery/restart") {
    const body = await readJsonBody(request);
    const runId = stringBodyValue(body.runId);
    if (!runId) {
      sendJson(response, { error: "runId is required" }, 400);
      return;
    }
    const args = ["recovery", "restart", runId];
    const actor = stringBodyValue(body.actor);
    const driver = stringBodyValue(body.driver);
    const model = stringBodyValue(body.model);
    if (actor) args.push("--actor", actor);
    if (driver) args.push("--driver", driver);
    if (model) args.push("--model", model);
    const command = startBackgroundCliCommand(workspace, "recovery-restart", args);
    sendJson(response, { ok: true, command, message: "Recovery restart started." });
    return;
  }

  if (requestUrl.pathname === "/api/control/dev-server/start") {
    const body = await readJsonBody(request);
    const store = new SwarmStore(workspace);
    try {
      const target = resolveDevServerTarget(store, workspace, body);
      const reviewEnvironment = resolveReviewEnvironment(target, workspace, stringBodyValue(body.commandName));
      if (!reviewEnvironment.commandAvailable || !reviewEnvironment.command) {
        sendJson(response, {
          ok: false,
          error: reviewEnvironment.unavailableReason ?? "Target does not define a runnable review command.",
          reviewEnvironment,
        }, 400);
        return;
      }
      const port = positiveBodyInteger(body.port) ?? (await allocateLocalPort());
      const readinessTimeoutMs = positiveBodyInteger(body.readinessTimeoutMs) ?? 2500;
      const server = await startDevServer(workspace, target, port, reviewEnvironment, readinessTimeoutMs);
      sendJson(response, {
        ok: server.openable,
        server,
        message: server.openable
          ? "Dev server is running. Use the URL for human verification and stop it when done."
          : "Dev server start was attempted, but it is not openable yet. Inspect status and stdout/stderr before opening the URL.",
      });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, errorStatus(error));
    } finally {
      store.close();
    }
    return;
  }

  if (requestUrl.pathname.startsWith("/api/control/dev-server/") && requestUrl.pathname.endsWith("/stop")) {
    const serverId = decodeURIComponent(
      requestUrl.pathname.slice("/api/control/dev-server/".length, -"/stop".length),
    );
    const server = devServers.get(serverId);
    if (!server) {
      sendJson(response, { error: `Dev server not found: ${serverId}` }, 404);
      return;
    }
    stopDevServer(server);
    sendJson(response, { ok: true, server: serializeDevServer(server) });
    return;
  }

  if (requestUrl.pathname.startsWith("/api/escalations/") && requestUrl.pathname.endsWith("/clear")) {
    const escalationId = decodeURIComponent(
      requestUrl.pathname.slice("/api/escalations/".length, -"/clear".length),
    );
    if (!escalationId) {
      sendJson(response, { error: "Missing escalation id" }, 400);
      return;
    }
    const body = await readJsonBody(request);
    const reason = stringBodyValue(body.reason);
    if (!reason) {
      sendJson(response, { error: "reason is required" }, 400);
      return;
    }
    const store = new SwarmStore(workspace);
    try {
      const escalation = clearHumanEscalation(store, escalationId, {
        actor: stringBodyValue(body.actor) ?? "human",
        reason,
      });
      sendJson(response, {
        ok: true,
        escalation,
        humanActions: buildHumanActionQueue(store, workspace),
      });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, errorStatus(error));
    } finally {
      store.close();
    }
    return;
  }

  if (requestUrl.pathname === "/api/human-verify") {
    const body = await readJsonBody(request);
    const sliceId = stringBodyValue(body.sliceId);
    const ref = stringBodyValue(body.ref);
    const status = stringBodyValue(body.status);
    if (!sliceId || !ref || !status) {
      sendJson(response, { error: "sliceId, ref, and status are required" }, 400);
      return;
    }
    const store = new SwarmStore(workspace);
    try {
      const result = recordHumanVerification(store, {
        sliceId,
        ref,
        status,
        actor: stringBodyValue(body.actor) ?? "human",
        notes: stringBodyValue(body.notes) ?? "",
      });
      sendJson(response, {
        ok: true,
        result,
        humanActions: buildHumanActionQueue(store, workspace),
      });
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, errorStatus(error));
    } finally {
      store.close();
    }
    return;
  }

  sendText(response, 405, "Method not allowed", "text/plain");
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object body");
  }
  return parsed as Record<string, unknown>;
}

function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveBodyInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function appendPositiveCliOption(args: string[], name: string, value: unknown): void {
  const parsed = positiveBodyInteger(value);
  if (parsed !== undefined) args.push(name, String(parsed));
}

function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

function commandArtifactsDir(workspace: string): string {
  const dir = path.join(artifactsDir(workspace), "control-actions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startBackgroundCliCommand(workspace: string, kind: string, args: string[]): ControlCommandRecord {
  const id = localControlId("CONTROL");
  const now = new Date().toISOString();
  const dir = commandArtifactsDir(workspace);
  const stdoutPath = path.join(dir, `${id}-${kind}.stdout.log`);
  const stderrPath = path.join(dir, `${id}-${kind}.stderr.log`);
  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  const child = spawn(process.execPath, [cliPath(), ...args], {
    cwd: workspace,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
    env: controlCommandEnv(),
  });
  const record: ControlCommandRecord = {
    id,
    kind,
    status: "running",
    command: process.execPath,
    args: [cliPath(), ...args],
    cwd: workspace,
    pid: child.pid,
    stdoutPath,
    stderrPath,
    stdoutHref: artifactHref(workspace, stdoutPath),
    stderrHref: artifactHref(workspace, stderrPath),
    startedAt: now,
    updatedAt: now,
  };
  controlCommands.set(id, record);
  refreshControlCommandActivity(workspace, record);
  const heartbeat = setInterval(() => refreshControlCommandActivity(workspace, record), 2000);
  child.on("exit", (code, signal) => {
    clearInterval(heartbeat);
    refreshControlCommandActivity(workspace, record);
    record.status = code === 0 ? "completed" : "failed";
    record.exitCode = code;
    record.signal = signal;
    record.updatedAt = new Date().toISOString();
  });
  child.on("error", (error) => {
    clearInterval(heartbeat);
    refreshControlCommandActivity(workspace, record);
    record.status = "failed";
    record.error = error.message;
    record.updatedAt = new Date().toISOString();
  });
  child.on("close", () => {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  });
  return serializeControlCommand(record);
}

function refreshControlCommandActivity(workspace: string, record: ControlCommandRecord): void {
  const checkedAt = new Date().toISOString();
  try {
    const stdoutStat = safeFileStat(record.stdoutPath);
    const stderrStat = safeFileStat(record.stderrPath);
    const latestArtifact = latestArtifactActivity(workspace);
    const signals = latestHarnessSignals(workspace);
    const lastOutputAt = latestIso(
      stdoutStat && stdoutStat.size > 0 ? stdoutStat.mtime.toISOString() : undefined,
      stderrStat && stderrStat.size > 0 ? stderrStat.mtime.toISOString() : undefined,
      latestArtifact?.updatedAt,
      signals.latestAgentRun?.updatedAt,
      signals.latestHeartbeat?.timestamp,
    );
    record.activity = {
      checkedAt,
      stdoutBytes: stdoutStat?.size ?? 0,
      stderrBytes: stderrStat?.size ?? 0,
      lastOutputAt,
      latestArtifact,
      latestAgentRun: signals.latestAgentRun,
      latestHeartbeat: signals.latestHeartbeat,
    };
    record.updatedAt = checkedAt;
  } catch (error) {
    record.activity = {
      checkedAt,
      stdoutBytes: safeFileStat(record.stdoutPath)?.size ?? 0,
      stderrBytes: safeFileStat(record.stderrPath)?.size ?? 0,
      error: error instanceof Error ? error.message : String(error),
    };
    record.updatedAt = checkedAt;
  }
}

function safeFileStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function latestArtifactActivity(workspace: string): NonNullable<ControlCommandRecord["activity"]>["latestArtifact"] | undefined {
  const root = artifactsDir(workspace);
  if (!fs.existsSync(root)) return undefined;
  let latest: { path: string; bytes: number; updatedAt: string; mtimeMs: number } | undefined;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = safeFileStat(fullPath);
      if (!stat) continue;
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = {
          path: fullPath,
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  };
  visit(root);
  if (!latest) return undefined;
  return {
    path: latest.path,
    href: artifactHref(workspace, latest.path),
    bytes: latest.bytes,
    updatedAt: latest.updatedAt,
  };
}

function latestHarnessSignals(workspace: string): {
  latestAgentRun?: NonNullable<ControlCommandRecord["activity"]>["latestAgentRun"];
  latestHeartbeat?: NonNullable<ControlCommandRecord["activity"]>["latestHeartbeat"];
} {
  const store = new SwarmStore(workspace);
  try {
    const latestRun = [...store.listAgentRuns()].sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt)).at(-1);
    const latestHeartbeat = [...store.listHeartbeats()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)).at(-1);
    return {
      latestAgentRun: latestRun
        ? {
            id: latestRun.id,
            role: latestRun.role,
            actor: latestRun.actor,
            status: latestRun.status,
            entityType: latestRun.entityType,
            entityId: latestRun.entityId,
            sliceId: latestRun.sliceId,
            updatedAt: latestRun.updatedAt,
          }
        : undefined,
      latestHeartbeat: latestHeartbeat
        ? {
            actor: latestHeartbeat.actor,
            state: latestHeartbeat.state,
            detail: latestHeartbeat.detail,
            entityType: latestHeartbeat.entityType,
            entityId: latestHeartbeat.entityId,
            timestamp: latestHeartbeat.timestamp,
          }
        : undefined,
    };
  } finally {
    store.close();
  }
}

function latestIso(...values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function controlCommandEnv(): NodeJS.ProcessEnv {
  const existingPids = splitEnvList(process.env.SWARM_RESET_EXCLUDE_PIDS);
  const existingPorts = splitEnvList(process.env.SWARM_RESET_EXCLUDE_PORTS);
  const controlPort = process.env.SWARM_CONTROL_PORT;
  return {
    ...process.env,
    SWARM_RESET_EXCLUDE_PIDS: [...new Set([...existingPids, String(process.pid)])].join(","),
    SWARM_RESET_EXCLUDE_PORTS: [...new Set([...existingPorts, ...(controlPort ? [controlPort] : [])])].join(","),
  };
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function runCliCommandCapture(
  workspace: string,
  kind: string,
  args: string[],
  timeoutMs: number,
): Promise<ControlCommandRecord & { stdout: string; stderr: string }> {
  const id = localControlId("CONTROL");
  const now = new Date().toISOString();
  const dir = commandArtifactsDir(workspace);
  const stdoutPath = path.join(dir, `${id}-${kind}.stdout.log`);
  const stderrPath = path.join(dir, `${id}-${kind}.stderr.log`);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath(), ...args],
      { cwd: workspace, timeout: timeoutMs, windowsHide: true, env: process.env },
      (error, stdout, stderr) => {
        fs.writeFileSync(stdoutPath, stdout ?? "", "utf8");
        fs.writeFileSync(stderrPath, stderr ?? "", "utf8");
        const errorCode = (error as (Error & { code?: unknown }) | null)?.code;
        const exitCode = typeof errorCode === "number" ? errorCode : error ? 1 : 0;
        const record = {
          id,
          kind,
          status: exitCode === 0 ? "completed" as const : "failed" as const,
          command: process.execPath,
          args: [cliPath(), ...args],
          cwd: workspace,
          stdoutPath,
          stderrPath,
          stdoutHref: artifactHref(workspace, stdoutPath),
          stderrHref: artifactHref(workspace, stderrPath),
          startedAt: now,
          updatedAt: new Date().toISOString(),
          exitCode,
          error: error ? error.message : undefined,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        };
        controlCommands.set(id, record);
        resolve(record);
      },
    );
  });
}

function serializeControlCommand(record: ControlCommandRecord): ControlCommandRecord {
  return { ...record };
}

function resolveDevServerTarget(store: SwarmStore, workspace: string, body: Record<string, unknown>): { id?: string; name?: string; path: string } {
  const targetName = stringBodyValue(body.targetName);
  const targetPath = stringBodyValue(body.targetPath);
  const targets = store.listTargets();
  const target = targetName
    ? targets.find((item) => item.name === targetName || item.id === targetName)
    : targetPath
      ? targets.find((item) => samePath(item.path, path.resolve(workspace, targetPath)))
      : targets.find((item) => /ui|dashboard|product/i.test(item.name)) ?? targets.at(0);
  if (target) return { id: target.id, name: target.name, path: target.path };
  if (!targetPath) throw new Error("targetName or targetPath is required when no registered target exists.");
  const resolved = path.resolve(workspace, targetPath);
  if (!resolved.toLowerCase().startsWith(`${path.resolve(workspace).toLowerCase()}${path.sep}`)) {
    throw new Error("targetPath must be registered or stay inside the workspace.");
  }
  return { path: resolved };
}

async function startDevServer(
  workspace: string,
  target: { id?: string; name?: string; path: string },
  port: number,
  reviewEnvironment: ReviewEnvironment,
  readinessTimeoutMs: number,
): Promise<DevServerRecord> {
  const id = localControlId("SERVER");
  const now = new Date().toISOString();
  const dir = commandArtifactsDir(workspace);
  const stdoutPath = path.join(dir, `${id}-dev-server.stdout.log`);
  const stderrPath = path.join(dir, `${id}-dev-server.stderr.log`);
  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  if (!reviewEnvironment.command) throw new Error(reviewEnvironment.unavailableReason ?? "Target does not define a runnable review command.");
  const invocation = createReviewCommandInvocation({
    command: reviewEnvironment.command,
    port,
    readinessPath: reviewEnvironment.readinessPath,
  });
  const child = spawn(invocation.command, invocation.args, {
    cwd: target.path,
    stdio: ["ignore", stdout, stderr],
    windowsHide: true,
    env: { ...process.env, ...invocation.env },
  });
  const record: DevServerRecord & { child?: ChildProcess } = {
    id,
    status: "starting",
    targetName: target.name,
    targetPath: target.path,
    commandName: reviewEnvironment.commandName,
    commandSource: reviewEnvironment.commandSource,
    displayCommand: invocation.displayCommand,
    command: invocation.command,
    args: invocation.args,
    url: invocation.url,
    port,
    openable: false,
    readiness: {
      status: "checking",
      url: invocation.url,
      timeoutMs: readinessTimeoutMs,
    },
    pid: child.pid,
    stdoutPath,
    stderrPath,
    stdoutHref: artifactHref(workspace, stdoutPath),
    stderrHref: artifactHref(workspace, stderrPath),
    startedAt: now,
    updatedAt: now,
    child,
  };
  devServers.set(id, record);
  child.on("exit", (code, signal) => {
    record.status = code === 0 || signal ? "stopped" : "failed";
    record.openable = false;
    if (record.readiness.status === "checking") {
      record.readiness = {
        ...record.readiness,
        status: "failed",
        checkedAt: new Date().toISOString(),
        error: code === 0 || signal ? "Process exited before readiness passed." : `Process failed before readiness passed with exit code ${code}.`,
      };
    }
    record.exitCode = code;
    record.signal = signal;
    record.updatedAt = new Date().toISOString();
  });
  child.on("error", (error) => {
    record.status = "failed";
    record.error = error.message;
    record.updatedAt = new Date().toISOString();
  });
  child.on("close", () => {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  });
  await waitForDevServerReadiness(record, readinessTimeoutMs);
  return serializeDevServer(record);
}

function stopDevServer(record: DevServerRecord & { child?: ChildProcess }): void {
  if (record.child?.pid && record.status === "running") {
    terminateProcessTree(record.child);
    record.status = "stopped";
    record.openable = false;
    record.updatedAt = new Date().toISOString();
  }
}

function serializeDevServer(record: DevServerRecord & { child?: ChildProcess }): DevServerRecord {
  const { child: _child, ...serializable } = record;
  return { ...serializable };
}

function terminateProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForDevServerReadiness(
  record: DevServerRecord & { child?: ChildProcess },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    if (record.status === "failed" || record.status === "stopped") return;
    try {
      const response = await fetchWithTimeout(record.readiness.url, 750);
      const text = await response.text();
      if (response.ok) {
        record.status = "running";
        record.openable = true;
        record.readiness = {
          ...record.readiness,
          status: "passed",
          checkedAt: new Date().toISOString(),
          statusCode: response.status,
          error: undefined,
        };
        record.updatedAt = new Date().toISOString();
        return;
      }
      lastError = `HTTP ${response.status}: ${text.slice(0, 160)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (record.status === "failed" || record.status === "stopped") return;
  record.status = "starting";
  record.openable = false;
  record.readiness = {
    ...record.readiness,
    status: "timeout",
    checkedAt: new Date().toISOString(),
    error: lastError ?? `Timed out after ${timeoutMs}ms waiting for readiness.`,
  };
  record.updatedAt = new Date().toISOString();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function inferScenario(workspace: string): string {
  const manifestPath = path.join(workspace, "live-agent-smoke.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const scenario = stringBodyValue(manifest.scenario) ?? stringBodyValue(manifest.liveScenario);
      if (scenario) return scenario;
      if (stringBodyValue(manifest.productSpec)?.includes("support-triage")) return "live-agent-smoke-h2";
    } catch {
      // fall through to path-based inference
    }
  }
  return workspace.toLowerCase().includes("h2") ? "live-agent-smoke-h2" : "live-agent-smoke";
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function artifactHref(workspace: string, filePath: string): string {
  const root = path.resolve(artifactsDir(workspace));
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return `/api/artifacts/${encodeURIComponent(relative.replace(/\\/g, "/"))}`;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function localControlId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 404;
  return 400;
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  sendText(response, statusCode, `${JSON.stringify(value, null, 2)}\n`, "application/json; charset=utf-8");
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function serveArtifact(response: ServerResponse, workspace: string, relativePath: string): void {
  const root = artifactsDir(workspace);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.toLowerCase().startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`)) {
    sendJson(response, { error: "Artifact path escapes workspace artifacts directory" }, 400);
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendJson(response, { error: "Artifact not found" }, 404);
    return;
  }
  sendText(response, 200, fs.readFileSync(resolved, "utf8"), contentTypeForPath(resolved));
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".log" || ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}
