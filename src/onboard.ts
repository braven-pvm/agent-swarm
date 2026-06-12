import fs from "node:fs";
import path from "node:path";
import { SwarmStore } from "./storage.js";
import { initTarget } from "./target-init.js";
import { registerFileSource } from "./source-adapter.js";
import { sourceDomain, sourceFrAcRefs } from "./source-index.js";
import { createEvent } from "./events.js";

export const GITIGNORE_MARKER = "# agent-swarm harness runtime state (managed by `swarm onboard`)";

const GITIGNORE_BLOCK = `${GITIGNORE_MARKER}
.swarm/state.db*
.swarm/artifacts/
.swarm/*.log
/schemas/worker-result.schema.json
/schemas/overseer-decision.schema.json
/schemas/review-result.schema.json
`;

export function ensureGitignoreBlock(repoPath: string): { added: boolean } {
  const gitignorePath = path.join(repoPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, "utf8");
    if (existing.includes(GITIGNORE_MARKER)) return { added: false };
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
    fs.writeFileSync(gitignorePath, `${existing}${separator}${GITIGNORE_BLOCK}`, "utf8");
    return { added: true };
  }
  fs.writeFileSync(gitignorePath, GITIGNORE_BLOCK, "utf8");
  return { added: true };
}

const SAMPLE_SPEC = `# Onboarding Sample Spec

Domain: Onboarding
Tags: sample, onboarding
Priority: 100

> This is a SAMPLE spec created by \`swarm onboard\`. Replace it with your real
> requirements (or register them with \`swarm sources add-file\`), then delete this file.

## FR-ONB-001: Sample functional requirement

The harness can pull a slice from a registered immutable source spec.

### AC-ONB-001.1

Given this registered source, \`swarm slices pull\` forms a slice whose FR/AC scope
includes AC-ONB-001.1.
`;

export function scaffoldSampleSpec(repoPath: string): { path: string; created: boolean } {
  const specPath = path.join(repoPath, "docs", "specs", "onboarding-sample.md");
  if (fs.existsSync(specPath)) return { path: specPath, created: false };
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, SAMPLE_SPEC, "utf8");
  return { path: specPath, created: true };
}

export interface OnboardResult {
  workspace: string;
  isGitRepo: boolean;
  targetName: string;
  wroteTargetConfig: boolean;
  wroteProtocolConfig: boolean;
  gitignoreAdded: boolean;
  sourceUri: string;
  sourceTitle: string;
  refsIndexed: number;
  scaffoldedSample: boolean;
}

export function runOnboard(input: { workspace: string; source?: string; name?: string }): OnboardResult {
  const { workspace } = input;
  const isGitRepo = fs.existsSync(path.join(workspace, ".git"));

  if (input.source) {
    const resolved = path.resolve(input.source);
    if (!fs.existsSync(resolved)) throw new Error(`--source file does not exist: ${resolved}`);
  }

  const store = new SwarmStore(workspace);
  try {
    store.init();

    const target = initTarget(workspace);
    const targetName = input.name ?? target.config.target.name;
    const now = new Date().toISOString();
    store.addOrUpdateTarget({
      id: target.id,
      path: target.repoPath,
      name: targetName,
      config: target.config,
      now,
    });
    const persisted = store.listTargets().find((t) => t.path === workspace);
    const persistedId = persisted?.id ?? target.id;
    store.addEvent(
      createEvent({
        actor: "harness",
        type: "target.initialized",
        entityType: "target",
        entityId: persistedId,
        payload: {
          path: target.repoPath,
          wroteTargetConfig: target.wroteTargetConfig,
          wroteProtocolConfig: target.wroteProtocolConfig,
        },
      }),
    );
    const gitignore = ensureGitignoreBlock(workspace);

    let scaffoldedSample = false;
    let sourcePath: string;
    if (input.source) {
      sourcePath = path.resolve(input.source);
    } else {
      const scaffold = scaffoldSampleSpec(workspace);
      sourcePath = scaffold.path;
      scaffoldedSample = scaffold.created;
    }

    const source = registerFileSource(sourcePath, {});
    store.addOrUpdateSource(source);
    store.addEvent(
      createEvent({
        actor: "harness",
        type: "source.registered",
        entityType: "source",
        entityId: source.id,
        payload: { uri: source.uri, title: source.title, hash: source.hash, domain: sourceDomain(source) },
      }),
    );

    return {
      workspace,
      isGitRepo,
      targetName,
      wroteTargetConfig: target.wroteTargetConfig,
      wroteProtocolConfig: target.wroteProtocolConfig,
      gitignoreAdded: gitignore.added,
      sourceUri: source.uri,
      sourceTitle: source.title,
      refsIndexed: sourceFrAcRefs(source).length,
      scaffoldedSample,
    };
  } finally {
    store.close();
  }
}
