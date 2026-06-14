import fs from "node:fs";
import http, { type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { artifactsDir } from "./paths.js";
import { readSourceText } from "./source-adapter.js";
import { sourceDomain, sourcePriority, sourceTags } from "./source-index.js";
import { EventTailer } from "./event-tailer.js";
import { SwarmStore } from "./storage.js";
import {
  buildObservabilitySnapshot,
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

export function createWebViewerServer(input: {
  workspace: string;
  defaultEventCount: number;
  historyRoot: string;
  webDistPath: string;
}): http.Server {
  return http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
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
        if (requestUrl.pathname.startsWith("/api/report/")) {
          const sliceId = decodeURIComponent(requestUrl.pathname.slice("/api/report/".length));
          if (!sliceId) {
            sendJson(response, { error: "Missing report slice id" }, 400);
            return;
          }
          sendText(response, 200, buildSliceReport(store, sliceId), "text/markdown; charset=utf-8");
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
