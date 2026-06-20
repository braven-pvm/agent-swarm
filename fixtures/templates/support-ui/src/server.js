import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const srcRoot = path.dirname(currentFile);
const targetRoot = path.dirname(srcRoot);

let apiServer;
let apiBaseUrl;

export async function createReviewServer() {
  await ensureApiServer();

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        sendHtml(response, reviewHtml());
        return;
      }
      if (url.pathname.startsWith("/src/")) {
        serveStaticSource(response, url.pathname);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await proxyApiRequest(request, response);
        return;
      }
      sendText(response, 404, "Not found", "text/plain; charset=utf-8");
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function ensureApiServer() {
  if (apiServer && apiBaseUrl) return;

  const apiServerPath = path.resolve(targetRoot, "..", "support-api", "src", "server.js");
  if (!fs.existsSync(apiServerPath)) {
    throw new Error(`Support API server is required for review mode: ${apiServerPath}`);
  }

  const apiModule = await import(pathToFileURL(apiServerPath).href);
  if (typeof apiModule.createServer !== "function") {
    throw new Error("Support API module does not export createServer().");
  }

  apiServer = apiModule.createServer();
  await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  const address = apiServer.address();
  if (!address || typeof address === "string") throw new Error("Support API server did not bind to a local port.");
  apiBaseUrl = `http://127.0.0.1:${address.port}`;
}

async function proxyApiRequest(request, response) {
  const targetUrl = `${apiBaseUrl}${request.url}`;
  const body = await readRequestBody(request);
  const proxyResponse = await fetch(targetUrl, {
    method: request.method,
    headers: forwardedHeaders(request),
    body: body.length > 0 && request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
  });
  const responseBody = Buffer.from(await proxyResponse.arrayBuffer());
  response.writeHead(proxyResponse.status, {
    "content-type": proxyResponse.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  response.end(responseBody);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function forwardedHeaders(request) {
  const headers = {};
  for (const name of ["accept", "content-type"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function serveStaticSource(response, requestPath) {
  const relativePath = decodeURIComponent(requestPath.slice("/src/".length));
  const resolved = path.resolve(srcRoot, relativePath);
  if (!resolved.startsWith(`${srcRoot}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendText(response, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  sendText(response, 200, fs.readFileSync(resolved, "utf8"), contentTypeForPath(resolved));
}

function reviewHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Customer Support Triage Board</title>
    <link rel="stylesheet" href="/src/supportBoard.css">
    <link rel="stylesheet" href="/src/summaryMetrics.css">
    <link rel="stylesheet" href="/src/filterToolbar.css">
    <link rel="stylesheet" href="/src/ticketQueue.css">
    <link rel="stylesheet" href="/src/detailPanel.css">
  </head>
  <body>
    <div id="app" aria-live="polite">
      <main class="support-board">
        <h1 class="support-board__title">Customer Support Triage Board</h1>
        <p>Loading support queue...</p>
      </main>
    </div>
    <script type="module" src="/src/browser-app.js"></script>
  </body>
</html>`;
}

function sendHtml(response, body) {
  sendText(response, 200, body, "text/html; charset=utf-8");
}

function sendJson(response, statusCode, body) {
  sendText(response, statusCode, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function main() {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 0);
  const server = await createReviewServer();
  server.listen(port, host, () => {
    const address = server.address();
    const selectedPort = typeof address === "object" && address ? address.port : port;
    console.log(`Customer Support Triage Board running at http://${host}:${selectedPort}/`);
  });

  const stop = () => {
    server.close();
    apiServer?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && currentFile === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
