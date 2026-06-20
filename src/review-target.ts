import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface ReviewableTarget {
  id?: string;
  name?: string;
  path: string;
}

export interface ReviewEnvironment {
  targetId?: string;
  targetName?: string;
  targetPath: string;
  targetPathRelative?: string;
  commandName?: string;
  command?: string;
  commandSource?: string;
  commandAvailable: boolean;
  unavailableReason?: string;
  suggestedUrl?: string;
  readinessPath: string;
  readinessContains?: string;
}

export interface ReviewCommandInvocation {
  command: string;
  args: string[];
  displayCommand: string;
  env: Record<string, string>;
  host: string;
  port: number;
  url: string;
}

const DEFAULT_REVIEW_COMMAND_NAMES = ["review", "dev", "start", "preview"];

export function resolveReviewEnvironment(
  target: ReviewableTarget,
  workspace?: string,
  requestedCommandName?: string,
): ReviewEnvironment {
  const targetConfig = readTargetYaml(target.path);
  const packageJson = readPackageJson(target.path);
  const targetMeta = objectValue(targetConfig?.target);
  const packageManager = stringValue(targetMeta?.packageManager) ?? inferPackageManager(target.path);
  const targetCommands = stringRecord(objectValue(targetConfig?.commands));
  const packageScripts = stringRecord(objectValue(packageJson?.scripts));
  const configuredReview = objectValue(targetConfig?.reviewEnvironment);
  const configuredCommandName = stringValue(configuredReview?.command);
  const readinessPath = stringValue(configuredReview?.readinessPath) ?? "/";
  const readinessContains = stringValue(configuredReview?.readinessContains);
  const selected = resolveReviewCommand({
    requestedCommandName,
    configuredCommandName,
    targetCommands,
    packageScripts,
    packageManager,
  });

  const targetLabel = target.name ?? path.basename(target.path);
  return {
    targetId: target.id,
    targetName: target.name,
    targetPath: target.path,
    targetPathRelative: workspace ? path.relative(workspace, target.path).replace(/\\/g, "/") : undefined,
    commandName: selected?.name,
    command: selected?.command,
    commandSource: selected?.source,
    commandAvailable: Boolean(selected),
    unavailableReason: selected
      ? undefined
      : requestedCommandName
        ? `Target ${targetLabel} does not define review command "${requestedCommandName}".`
        : `Target ${targetLabel} does not define a runnable review command. Add reviewEnvironment.command, a commands.review/dev/start/preview entry, or a package.json review/dev/start/preview script.`,
    readinessPath,
    readinessContains,
  };
}

export function createReviewCommandInvocation(input: {
  command: string;
  host?: string;
  port: number;
  readinessPath?: string;
}): ReviewCommandInvocation {
  const host = input.host ?? "127.0.0.1";
  const pathPart = input.readinessPath?.startsWith("/") ? input.readinessPath : `/${input.readinessPath ?? ""}`;
  const url = `http://${host}:${input.port}${pathPart}`;
  const commandText = interpolateCommand(input.command, { host, port: input.port, url });
  const shell = shellInvocation(commandText);
  return {
    ...shell,
    displayCommand: commandText,
    env: {
      HOST: host,
      PORT: String(input.port),
      URL: url,
    },
    host,
    port: input.port,
    url,
  };
}

function resolveReviewCommand(input: {
  requestedCommandName?: string;
  configuredCommandName?: string;
  targetCommands: Record<string, string>;
  packageScripts: Record<string, string>;
  packageManager: string;
}): { name: string; command: string; source: string } | undefined {
  if (input.requestedCommandName) {
    return commandForName(input.requestedCommandName, input);
  }
  if (input.configuredCommandName) {
    const configuredByName = commandForName(input.configuredCommandName, input);
    if (configuredByName) return configuredByName;
    if (looksLikeCommand(input.configuredCommandName)) {
      return {
        name: "reviewEnvironment.command",
        command: input.configuredCommandName,
        source: "target.reviewEnvironment.command",
      };
    }
  }
  for (const name of DEFAULT_REVIEW_COMMAND_NAMES) {
    const resolved = commandForName(name, input);
    if (resolved) return resolved;
  }
  return undefined;
}

function commandForName(
  name: string,
  input: { targetCommands: Record<string, string>; packageScripts: Record<string, string>; packageManager: string },
): { name: string; command: string; source: string } | undefined {
  const targetCommand = input.targetCommands[name];
  if (targetCommand) return { name, command: targetCommand, source: `target.commands.${name}` };
  const packageScript = input.packageScripts[name];
  if (packageScript) return { name, command: packageRunCommand(input.packageManager, name), source: `package.json.scripts.${name}` };
  return undefined;
}

function packageRunCommand(packageManager: string, scriptName: string): string {
  if (packageManager === "pnpm") return `pnpm run ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "bun") return `bun run ${scriptName}`;
  return `npm run ${scriptName}`;
}

function readTargetYaml(targetPath: string): Record<string, unknown> | undefined {
  const configPath = path.join(targetPath, ".swarm", "target.yaml");
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    return objectValue(parsed);
  } catch {
    return undefined;
  }
}

function readPackageJson(targetPath: string): Record<string, unknown> | undefined {
  const packagePath = path.join(targetPath, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  try {
    return objectValue(JSON.parse(fs.readFileSync(packagePath, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function inferPackageManager(targetPath: string): string {
  if (fs.existsSync(path.join(targetPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(targetPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(targetPath, "bun.lockb")) || fs.existsSync(path.join(targetPath, "bun.lock"))) return "bun";
  return "npm";
}

function shellInvocation(commandText: string): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", commandText] }
    : { command: "/bin/sh", args: ["-lc", commandText] };
}

function interpolateCommand(command: string, input: { host: string; port: number; url: string }): string {
  return command
    .replace(/\$\{HOST\}/g, input.host)
    .replace(/\$\{PORT\}/g, String(input.port))
    .replace(/\$\{URL\}/g, input.url);
}

function looksLikeCommand(value: string): boolean {
  return /\s|[\\/]/.test(value.trim());
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringRecord(value: Record<string, unknown> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
  );
}
