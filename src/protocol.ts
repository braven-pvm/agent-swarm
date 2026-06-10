import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface ProtocolConfig {
  protocol: {
    name?: string;
    version?: string;
    slice?: Record<string, unknown>;
    lanes?: Record<string, unknown>;
    planning: {
      [key: string]: unknown;
      heartbeat: {
        defaultStaleAfterSeconds: number;
        [key: string]: unknown;
      };
    };
    verification?: Record<string, unknown>;
    recovery: {
      reviveRetries: number;
      highlightFinalAttempt: boolean;
      releaseAfterRetries: boolean;
      [key: string]: unknown;
    };
    workers: {
      defaultDriver: string;
      drivers: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export function defaultProtocol(): ProtocolConfig {
  return {
    protocol: {
      name: "default",
      version: "0.1",
      slice: {
        preferredBatchSize: 3,
        maxBatchSize: 5,
        allowDynamicLeaseExpansion: true,
      },
      lanes: {
        oneOrchestratorPerLane: true,
        avoidMainWorktree: true,
        allowPlannerCreateLanes: true,
        maxActiveLanes: 3,
        requireName: true,
        requirePurpose: true,
        requireFocusLabels: true,
        requireLifecycleReasons: true,
      },
      planning: {
        allowBackendEnablerSlices: true,
        allowBackendLaneForFrontendStarvation: true,
        coordinateLaneReadiness: true,
        frontendUnblockStrategy: "infer_from_completed_fr_ac",
        allowFrontendAgainstMocks: false,
        showLaneStarvationReasons: true,
        dependencyView: "graph_preferred",
        heartbeat: {
          enabled: true,
          inferFromEvents: true,
          requireExplicitWhenStale: true,
          staleFlow: "stale_then_poll_then_recover",
          defaultStaleAfterSeconds: 300,
        },
      },
      verification: {
        cadence: "hybrid",
        behaviorFirst: true,
        requireEvidencePerAc: true,
      },
      recovery: {
        reviveRetries: 2,
        highlightFinalAttempt: true,
        releaseAfterRetries: false,
      },
      workers: {
        defaultDriver: "codex",
        drivers: {
          codex: { sandbox: "workspace-write" },
          claude: { permissionMode: "acceptEdits", settingSources: "" },
        },
      },
    },
  };
}

export function loadProtocol(targetPath?: string): ProtocolConfig {
  const base = defaultProtocol();
  if (!targetPath) return base;
  const protocolPath = path.join(targetPath, ".swarm", "protocol.yaml");
  if (!fs.existsSync(protocolPath)) return base;
  const parsed = YAML.parse(fs.readFileSync(protocolPath, "utf8")) as Partial<ProtocolConfig> | undefined;
  return mergeProtocol(base, parsed ?? {});
}

function mergeDriverConfigs(
  base: Record<string, Record<string, unknown>>,
  override?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = { ...base };
  for (const [driver, config] of Object.entries(override ?? {})) {
    merged[driver] = { ...(merged[driver] ?? {}), ...(config ?? {}) };
  }
  return merged;
}

function mergeProtocol(base: ProtocolConfig, override: Partial<ProtocolConfig>): ProtocolConfig {
  return {
    protocol: {
      ...base.protocol,
      ...override.protocol,
      planning: {
        ...base.protocol.planning,
        ...override.protocol?.planning,
        heartbeat: {
          ...base.protocol.planning.heartbeat,
          ...override.protocol?.planning?.heartbeat,
          defaultStaleAfterSeconds:
            override.protocol?.planning?.heartbeat?.defaultStaleAfterSeconds ??
            base.protocol.planning.heartbeat.defaultStaleAfterSeconds,
        },
      },
      recovery: {
        ...base.protocol.recovery,
        ...override.protocol?.recovery,
        reviveRetries: override.protocol?.recovery?.reviveRetries ?? base.protocol.recovery.reviveRetries,
        highlightFinalAttempt:
          override.protocol?.recovery?.highlightFinalAttempt ?? base.protocol.recovery.highlightFinalAttempt,
        releaseAfterRetries: override.protocol?.recovery?.releaseAfterRetries ?? base.protocol.recovery.releaseAfterRetries,
      },
      workers: {
        ...base.protocol.workers,
        ...override.protocol?.workers,
        defaultDriver: override.protocol?.workers?.defaultDriver ?? base.protocol.workers.defaultDriver,
        drivers: mergeDriverConfigs(base.protocol.workers.drivers, override.protocol?.workers?.drivers),
      },
    },
  };
}
