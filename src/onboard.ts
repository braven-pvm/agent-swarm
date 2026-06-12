import fs from "node:fs";
import path from "node:path";

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
