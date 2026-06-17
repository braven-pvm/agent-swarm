// Human Action queue — the Command Bridge's first write/control surface.
//
// The contract mirrors src/human-actions.ts (the trusted local server). The UI never
// hardcodes endpoints: each HumanActionItem carries its own `allowedActions`, and every
// allowedAction supplies the method + path + bodyTemplate to POST. The resolution form
// fills operator inputs OVER the bodyTemplate and posts to that path, so adding a new
// action kind on the server needs no endpoint wiring here.
//
// Direct fetch on purpose — web/src/lib/api.ts is user-owned and must not be imported here.

export type HumanActionKind =
  | "decision_required"
  | "clear_blocker"
  | "human_verification"
  | "human_verification_rework"
  | "blocked_requirement";

export type HumanActionSeverity = "info" | "warning" | "danger";

export type HumanActionCommandKind = "clear_escalation" | "record_human_verification";

export interface HumanActionLink {
  label: string;
  href: string;
}

export interface HumanActionCommand {
  kind: HumanActionCommandKind;
  method: "POST";
  path: string;
  bodyTemplate: Record<string, unknown>;
}

export interface HumanActionSource {
  id: string;
  title: string;
  uri: string;
}

export interface HumanActionItem {
  id: string;
  kind: HumanActionKind;
  severity: HumanActionSeverity;
  title: string;
  summary: string;
  status: string;
  entityType: string;
  entityId: string;
  ref?: string;
  sliceId?: string;
  domain?: string;
  source?: HumanActionSource;
  packet?: unknown;
  evidenceIds?: string[];
  links: HumanActionLink[];
  allowedActions: HumanActionCommand[];
  createdAt?: string;
  updatedAt?: string;
}

export interface HumanActionTotals {
  total: number;
  decisionRequired: number;
  humanVerification: number;
  blockers: number;
}

export interface HumanActionQueue {
  generatedAt: string;
  totals: HumanActionTotals;
  actions: HumanActionItem[];
}

export interface RunActionResult {
  ok: boolean;
  humanActions: HumanActionQueue;
  error?: string;
}

const EMPTY_QUEUE: HumanActionQueue = {
  generatedAt: "",
  totals: { total: 0, decisionRequired: 0, humanVerification: 0, blockers: 0 },
  actions: [],
};

/** GET /api/human-actions → the normalized operator queue. */
export async function fetchHumanActions(): Promise<HumanActionQueue> {
  const res = await fetch("/api/human-actions", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`/api/human-actions → ${res.status}`);
  return (await res.json()) as HumanActionQueue;
}

/**
 * Run an allowedAction's command: POST cmd.path with { ...bodyTemplate, ...overrides, actor: "human" }.
 * The server returns the REFRESHED queue under `humanActions`; we surface that so the caller can
 * replace the store queue in one hop. On failure we return a friendly message, preferring the
 * server's own `error` field when present.
 */
export async function runActionCommand(
  cmd: HumanActionCommand,
  overrides: Record<string, unknown>,
): Promise<RunActionResult> {
  const body = { ...cmd.bodyTemplate, ...overrides, actor: "human" };
  let res: Response;
  try {
    res = await fetch(cmd.path, {
      method: cmd.method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, humanActions: EMPTY_QUEUE, error: friendly(e) };
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const data = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {});

  if (!res.ok || data.ok === false) {
    const serverMsg = typeof data.error === "string" && data.error.trim() ? data.error.trim() : undefined;
    return {
      ok: false,
      humanActions: (data.humanActions as HumanActionQueue) ?? EMPTY_QUEUE,
      error: serverMsg ?? `Request failed (${res.status}).`,
    };
  }

  return {
    ok: true,
    humanActions: (data.humanActions as HumanActionQueue) ?? EMPTY_QUEUE,
  };
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.trim() ? `Could not reach the server — ${msg}` : "Could not reach the server.";
}
