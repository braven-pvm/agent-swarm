import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { makeId } from "./ids.js";
import { defaultProtocol } from "./protocol.js";
import type { TargetConfig } from "./types.js";

export interface TargetInitResult {
  id: string;
  repoPath: string;
  config: TargetConfig;
  wroteTargetConfig: boolean;
  wroteProtocolConfig: boolean;
}

export function initTarget(repoInput: string): TargetInitResult {
  const repoPath = path.resolve(repoInput);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Target repo does not exist: ${repoPath}`);
  }

  const swarmPath = path.join(repoPath, ".swarm");
  fs.mkdirSync(swarmPath, { recursive: true });

  const config = discoverTargetConfig(repoPath);
  const targetYamlPath = path.join(swarmPath, "target.yaml");
  const protocolYamlPath = path.join(swarmPath, "protocol.yaml");

  const wroteTargetConfig = writeIfMissing(
    targetYamlPath,
    YAML.stringify(config, { lineWidth: 0 }),
  );

  const wroteProtocolConfig = writeIfMissing(
    protocolYamlPath,
    YAML.stringify(defaultProtocol(), { lineWidth: 0 }),
  );

  return {
    id: makeId("target"),
    repoPath,
    config,
    wroteTargetConfig,
    wroteProtocolConfig,
  };
}

function discoverTargetConfig(repoPath: string): TargetConfig {
  const packageJsonPath = path.join(repoPath, "package.json");
  const name = path.basename(repoPath);
  const commands: Record<string, string> = {};
  const sources: Record<string, string> = {};
  let language: string | undefined;
  let packageManager: string | undefined;

  if (fs.existsSync(packageJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
      type?: string;
    };
    language = "javascript";
    packageManager = detectPackageManager(repoPath, raw.packageManager);
    const runner = packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : "npm";
    const scripts = raw.scripts ?? {};
    for (const key of ["build", "test", "lint", "typecheck"]) {
      if (scripts[key]) {
        commands[key] = runner === "npm" ? `npm run ${key}` : `${runner} ${key}`;
        sources[`commands.${key}`] = "package.json";
      }
    }
    if (scripts.test && !commands.test) {
      commands.test = runner === "npm" ? "npm test" : `${runner} test`;
      sources["commands.test"] = "package.json";
    }
  }

  return {
    target: {
      name,
      root: ".",
      language,
      packageManager,
    },
    commands,
    discovery: {
      generatedAt: new Date().toISOString(),
      sources,
    },
  };
}

function detectPackageManager(repoPath: string, packageManagerField?: string): string | undefined {
  if (packageManagerField) {
    return packageManagerField.split("@")[0];
  }
  if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoPath, "package-lock.json"))) return "npm";
  return "npm";
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}
