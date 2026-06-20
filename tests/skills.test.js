import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultProtocol } from "../dist/protocol.js";
import { prepareSkillBindings, resolveSkillBindings } from "../dist/skills.js";

function tempWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-skills-"));
  fs.mkdirSync(path.join(workspace, ".git", "info"), { recursive: true });
  const target = path.join(workspace, "target");
  fs.mkdirSync(target, { recursive: true });
  return { workspace, target };
}

test("default protocol resolves built-in role skills and writes bound skill artifacts", () => {
  const { workspace, target } = tempWorkspace();
  const artifactPath = path.join(workspace, ".swarm", "artifacts", "slice-1");
  const binding = prepareSkillBindings({
    workspace,
    targetPath: target,
    artifactPath,
    runId: "RUN-skill-default",
    role: "reviewer",
    protocol: defaultProtocol(),
  });

  assert.deepEqual(
    binding.required.map((skill) => skill.id),
    ["swarm-core", "verification-obligations", "sleuth-review"],
  );
  assert.equal(binding.optional.length, 0);
  assert.ok(fs.existsSync(binding.bindingPath));
  assert.ok(fs.existsSync(binding.packetPath));
  assert.match(fs.readFileSync(path.join(workspace, ".git", "info", "exclude"), "utf8"), /target\/\.swarm\/run-skills\//);
  for (const skill of binding.required) {
    assert.ok(fs.existsSync(skill.boundPath), `${skill.id} should be copied into the target workspace`);
    assert.equal(skill.hash.length, 64);
  }
  const packet = fs.readFileSync(binding.packetPath, "utf8");
  assert.match(packet, /Read every required skill file before acting/);
  assert.match(packet, /skill_isolation_conflict/);
  assert.match(packet, /sleuth-review/);
});

test("project catalogs can provide optional or required skills", () => {
  const { workspace, target } = tempWorkspace();
  const projectSkill = path.join(target, ".swarm", "skills", "frontend-design-system");
  fs.mkdirSync(projectSkill, { recursive: true });
  fs.writeFileSync(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: frontend-design-system\ndescription: Project design tokens.\n---\n# Frontend Design System\n\nUse tokens.\n",
    "utf8",
  );
  const protocol = defaultProtocol();
  protocol.protocol.skills.roles.worker = {
    required: ["swarm-core", "frontend-design-system"],
    optional: ["accessibility-review"],
  };
  const binding = prepareSkillBindings({
    workspace,
    targetPath: target,
    artifactPath: path.join(workspace, ".swarm", "artifacts", "slice-2"),
    runId: "RUN-skill-project",
    role: "worker",
    protocol,
  });

  const designSkill = binding.required.find((skill) => skill.id === "frontend-design-system");
  assert.ok(designSkill);
  assert.equal(designSkill.source, "project");
  assert.match(fs.readFileSync(designSkill.boundPath, "utf8"), /Use tokens/);
  assert.ok(binding.optional.some((skill) => skill.id === "accessibility-review"));
});

test("missing required skills block dispatch before agent launch", () => {
  const { workspace, target } = tempWorkspace();
  const protocol = defaultProtocol();
  protocol.protocol.skills.roles.worker = { required: ["skill-that-does-not-exist"] };

  assert.throws(
    () =>
      resolveSkillBindings({
        workspace,
        targetPath: target,
        role: "worker",
        protocol,
      }),
    /Missing required worker skill\(s\): skill-that-does-not-exist/,
  );
});
