// Local Control API client — the Command Bridge's lifecycle/control write surface.
//
// These are LOCAL, trusted, unauthenticated WRITE/control endpoints (see
// docs/architecture/local-control-api.md). They turn CLI-only lifecycle controls into UI
// actions: continue a stopped run, recover stale/failed agents (revive same-session / restart
// fresh), and manage human-review dev servers.
//
// Direct fetch on purpose — web/src/lib/api.ts is user-owned and must not be imported here. Every
// helper returns parsed JSON on success or a friendly { error } object on failure; nothing throws.
// "actor": "human-ui" is attached wherever the endpoint records who initiated the control action.

// ── Wire types (mirror the server's local-control-api responses) ──────────────────────────────

export type ControlCommandKind =
  | "continue-run"
  | "recovery-revive"
  | "recovery-restart"
  | "recovery-scan"
  | string;

export type ControlCommandStatus = "running" | "completed" | "failed" | "stopped" | string;

export interface ControlCommand {
  id: string;
  kind: ControlCommandKind;
  status: ControlCommandStatus;
  command: string;
  args: string[];
  cwd?: string;
  pid?: number;
  stdoutPath?: string;
  stderrPath?: string;
  // Already an "/api/artifacts/..." path — fetch directly, no derivation needed.
  stdoutHref?: string;
  stderrHref?: string;
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  exitCode?: number;
}

export type DevServerStatus = "running" | "failed" | "stopped" | string;

export interface DevServer {
  id: string;
  status: DevServerStatus;
  targetName: string;
  targetPath?: string;
  command: string;
  args: string[];
  url?: string;
  port?: number;
  pid?: number;
  stdoutPath?: string;
  stderrPath?: string;
  stdoutHref?: string;
  stderrHref?: string;
}

// Response envelopes are deliberately loose — we only depend on the documented fields, and surface
// the raw rest for inline display (e.g. the started `command`, scan-affected runs).
export interface ControlResult<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  data?: T;
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" } as const;

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.trim() ? `Could not reach the server — ${msg}` : "Could not reach the server.";
}

// One place for the POST round-trip: stringify the body, parse JSON, normalize ok/error. A non-ok
// HTTP status OR an explicit { ok: false } body both resolve to a friendly { ok: false, error }.
async function postJson<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<ControlResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (!res.ok || data.ok === false) {
    const serverMsg = typeof data.error === "string" && data.error.trim() ? data.error.trim() : undefined;
    return { ok: false, error: serverMsg ?? `Request failed (${res.status}).`, data: data as T };
  }
  return { ok: true, data: data as T };
}

async function getJson<T>(path: string, pluck: (d: Record<string, unknown>) => T, fallback: T): Promise<T> {
  try {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    if (!res.ok) return fallback;
    const data = (await res.json()) as Record<string, unknown>;
    return pluck(data);
  } catch {
    return fallback;
  }
}

// ── Polling reads (swallow errors → empty list so a transient failure never blanks the UI) ─────

/** GET /api/control/commands → background control commands, server order preserved. */
export async function fetchControlCommands(): Promise<ControlCommand[]> {
  return getJson<ControlCommand[]>(
    "/api/control/commands",
    (d) => (Array.isArray(d.commands) ? (d.commands as ControlCommand[]) : []),
    [],
  );
}

/** GET /api/control/dev-servers → active + historical dev-server records. */
export async function fetchDevServers(): Promise<DevServer[]> {
  return getJson<DevServer[]>(
    "/api/control/dev-servers",
    (d) => (Array.isArray(d.servers) ? (d.servers as DevServer[]) : []),
    [],
  );
}

// ── Write actions ──────────────────────────────────────────────────────────────────────────────

/** POST /api/control/continue — start a background `swarm smoke live-agent full`. */
export function postContinue(opts: { scenario: string; runId?: string; reset?: boolean }): Promise<ControlResult> {
  const body: Record<string, unknown> = { scenario: opts.scenario, reset: opts.reset ?? false };
  if (opts.runId) body.runId = opts.runId;
  return postJson("/api/control/continue", body);
}

/** POST /api/control/recovery/scan — quick recovery scan, optionally mark/release stale runs. */
export function postRecoveryScan(opts: {
  staleAfter?: number;
  markStale?: boolean;
  release?: boolean;
}): Promise<ControlResult> {
  const body: Record<string, unknown> = {
    markStale: opts.markStale ?? false,
    release: opts.release ?? false,
    actor: "human-ui",
  };
  if (opts.staleAfter != null) body.staleAfter = opts.staleAfter;
  return postJson("/api/control/recovery/scan", body);
}

/** POST /api/control/recovery/revive — background same-session revive for a captured run. */
export function postRecoveryRevive(opts: { runId: string; model?: string }): Promise<ControlResult> {
  const body: Record<string, unknown> = { runId: opts.runId, actor: "human-ui" };
  if (opts.model) body.model = opts.model;
  return postJson("/api/control/recovery/revive", body);
}

/** POST /api/control/recovery/restart — fresh worker for the same slice. */
export function postRecoveryRestart(opts: {
  runId: string;
  driver?: string;
  model?: string;
}): Promise<ControlResult> {
  const body: Record<string, unknown> = { runId: opts.runId, actor: "human-ui" };
  if (opts.driver) body.driver = opts.driver;
  if (opts.model) body.model = opts.model;
  return postJson("/api/control/recovery/restart", body);
}

/** POST /api/control/dev-server/start — start the registered review command for a target. */
export function postDevServerStart(opts: { targetName: string; commandName?: string; port?: number }): Promise<ControlResult> {
  const body: Record<string, unknown> = { targetName: opts.targetName };
  if (opts.commandName) body.commandName = opts.commandName;
  if (opts.port != null) body.port = opts.port;
  return postJson("/api/control/dev-server/start", body);
}

/** POST /api/control/dev-server/:id/stop — stop the spawned process tree. */
export function postDevServerStop(id: string): Promise<ControlResult> {
  return postJson(`/api/control/dev-server/${encodeURIComponent(id)}/stop`, {});
}

// ── Humanizers / tones (UI-facing, pure) ─────────────────────────────────────────────────────

const COMMAND_KIND_LABELS: Record<string, string> = {
  "continue-run": "Continue run",
  "recovery-revive": "Recovery revive",
  "recovery-restart": "Recovery restart",
  "recovery-scan": "Recovery scan",
};

/** Sentence-case label for a control command kind (kebab → words, known kinds mapped). */
export function commandKindLabel(kind: string | undefined): string {
  if (!kind) return "Command";
  if (COMMAND_KIND_LABELS[kind]) return COMMAND_KIND_LABELS[kind];
  const words = kind.split(/[-_]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 0) return "Command";
  return words.join(" ").replace(/^./, (c) => c.toUpperCase());
}

export interface StatusTone {
  cls: string;   // cov-badge-* family suffix, reused for fill + text
  glyph: string; // paired with colour so state never relies on hue alone
  label: string;
  pulse?: boolean;
}

/** Tone (class + glyph + label) for a control command / dev-server status. */
export function statusTone(status: string | undefined): StatusTone {
  switch (status) {
    case "running":
      return { cls: "cov-badge-in_progress", glyph: "●", label: "Running", pulse: true };
    case "completed":
      return { cls: "cov-badge-done", glyph: "✓", label: "Completed" };
    case "ok":
      return { cls: "cov-badge-done", glyph: "✓", label: "Ok" };
    case "failed":
      return { cls: "cov-badge-failed", glyph: "✕", label: "Failed" };
    case "stale":
      return { cls: "ctl-badge-stale", glyph: "⚠", label: "Stale" };
    case "stopped":
      return { cls: "cov-badge-not_started", glyph: "○", label: "Stopped" };
    default:
      return { cls: "cov-badge-not_started", glyph: "•", label: status ? status : "Unknown" };
  }
}
