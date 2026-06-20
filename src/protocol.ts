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
    skills: {
      catalogs: string[];
      roles: Record<string, { required?: string[]; optional?: string[] }>;
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
        childIdleTimeoutSeconds: 0,
      },
      workers: {
        defaultDriver: "codex",
        drivers: {
          codex: {
            sandbox: "workspace-write",
            ignoreUserConfig: true,
            ignoreRules: true,
            skillIsolation: "detect",
            bypassApprovalsAndSandbox: true,
          },
          claude: { permissionMode: "acceptEdits", settingSources: "", allowedTools: "Edit Write Read Glob Grep Bash" },
        },
      },
      skills: {
        catalogs: ["builtin", ".swarm/skills"],
        roles: {
          planner: { required: ["swarm-core", "planning-orchestration"] },
          overseer: { required: ["swarm-core", "planning-orchestration", "super-overseer", "recovery-focus"] },
          worker: { required: ["swarm-core", "implementation-worker", "verification-obligations"] },
          reviewer: { required: ["swarm-core", "verification-obligations", "sleuth-review"] },
          verifier: { required: ["swarm-core", "verification-obligations", "deterministic-verifier"] },
          recovery: { required: ["swarm-core", "implementation-worker", "recovery-focus"] },
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
    merged[driver] = { ...(merged[driver] ?? {}), ...config };
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
      skills: {
        ...base.protocol.skills,
        ...override.protocol?.skills,
        catalogs: override.protocol?.skills?.catalogs ?? base.protocol.skills.catalogs,
        roles: mergeSkillRoleConfigs(base.protocol.skills.roles, override.protocol?.skills?.roles),
      },
    },
  };
}

function mergeSkillRoleConfigs(
  base: Record<string, { required?: string[]; optional?: string[] }>,
  override?: Record<string, { required?: string[]; optional?: string[] }>,
): Record<string, { required?: string[]; optional?: string[] }> {
  const merged: Record<string, { required?: string[]; optional?: string[] }> = { ...base };
  for (const [role, config] of Object.entries(override ?? {})) {
    merged[role] = {
      ...(merged[role] ?? {}),
      ...config,
      required: config.required ?? merged[role]?.required,
      optional: config.optional ?? merged[role]?.optional,
    };
  }
  return merged;
}
