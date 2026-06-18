import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import { skillsOf, sourceTone, shortHash, type SkillBindingSummary } from "~/lib/skills";
import SkillStacks from "~/components/SkillStacks.svelte";

const skill = (id: string, requirement: "required" | "optional", source: string, hash: string, extra: Partial<{ title: string; description: string; sourcePath: string }> = {}) => ({
  id, requirement, source, hash, sourcePath: extra.sourcePath ?? `/cat/${source}/${id}/SKILL.md`, boundPath: `/run/${id}/SKILL.md`,
  ...(extra.title ? { title: extra.title } : {}), ...(extra.description ? { description: extra.description } : {}),
});

const binding = (over: Partial<SkillBindingSummary> = {}): SkillBindingSummary => ({
  role: "worker", runId: "R1", bindingPath: "/w/.swarm/skill-bindings-R1.json", packetPath: "/w/.swarm/skill-packet-R1.md",
  boundRoot: "/w/.swarm/run-skills/R1",
  required: [skill("swarm-core", "required", "builtin", "abcdef0123456789aa", { title: "Swarm core" })],
  optional: [],
  count: 1,
  ...over,
});

describe("skillsOf", () => {
  it("returns the binding when run.skills is a populated object", () => {
    const b = binding();
    const got = skillsOf({ id: "R1", skills: b });
    expect(got).toBeTruthy();
    expect(got!.required.length).toBe(1);
    expect(got!.count).toBe(1);
  });

  it("derives count from the stacks when count is absent", () => {
    const b = binding({ count: undefined as unknown as number, optional: [skill("opt-a", "optional", "project", "deadbeefcafe00")] });
    const got = skillsOf({ skills: b });
    expect(got!.count).toBe(2); // 1 required + 1 optional
  });

  it("returns undefined when the run has no skills field", () => {
    expect(skillsOf({ id: "R1" })).toBeUndefined();
  });

  it("returns undefined for null / non-object runs", () => {
    expect(skillsOf(null)).toBeUndefined();
    expect(skillsOf(undefined)).toBeUndefined();
    expect(skillsOf("nope")).toBeUndefined();
    expect(skillsOf(42)).toBeUndefined();
  });

  it("returns undefined when skills is malformed (non-object) or empty", () => {
    expect(skillsOf({ skills: "x" })).toBeUndefined();
    expect(skillsOf({ skills: 7 })).toBeUndefined();
    // empty binding (no required, no optional, count 0) → treated as absent
    expect(skillsOf({ skills: { required: [], optional: [], count: 0 } })).toBeUndefined();
  });

  it("tolerates missing stack arrays without throwing", () => {
    const got = skillsOf({ skills: { count: 3, role: "worker" } });
    expect(got).toBeTruthy();
    expect(got!.required).toEqual([]);
    expect(got!.optional).toEqual([]);
    expect(got!.count).toBe(3);
  });
});

describe("sourceTone", () => {
  it("maps builtin to a neutral tone + sentence-case label", () => {
    expect(sourceTone("builtin")).toEqual({ cls: "skill-src-builtin", label: "Builtin" });
  });
  it("maps project to the blue tone", () => {
    expect(sourceTone("project")).toEqual({ cls: "skill-src-project", label: "Project" });
  });
  it("maps path to the violet tone", () => {
    expect(sourceTone("path")).toEqual({ cls: "skill-src-path", label: "Path" });
  });
  it("falls back to the neutral tone for unknown sources, keeping the raw label", () => {
    expect(sourceTone("custom")).toEqual({ cls: "skill-src-builtin", label: "custom" });
  });
  it("falls back to an em dash for an empty source", () => {
    expect(sourceTone("")).toEqual({ cls: "skill-src-builtin", label: "—" });
  });
});

describe("shortHash", () => {
  it("returns the first 12 chars of a hash", () => {
    expect(shortHash("abcdef0123456789aabbcc")).toBe("abcdef012345");
  });
  it("returns the whole string when shorter than 12", () => {
    expect(shortHash("abc")).toBe("abc");
  });
  it("returns an empty string when absent", () => {
    expect(shortHash(undefined)).toBe("");
    expect(shortHash()).toBe("");
  });
});

describe("SkillStacks", () => {
  it("renders required + optional stacks with source chips and short hashes", () => {
    const b = binding({
      required: [skill("swarm-core", "required", "builtin", "abcdef0123456789", { title: "Swarm core" })],
      optional: [skill("impl-worker", "optional", "project", "0011223344556677ff", { title: "Implementation worker", description: "Worker discipline." })],
      count: 2,
    });
    const { getByText, container } = render(SkillStacks, { props: { binding: b } });
    // Both stack eyebrows with counts.
    expect(getByText("Required (1)")).toBeTruthy();
    expect(getByText("Optional (1)")).toBeTruthy();
    // Skill ids + titles.
    expect(getByText("swarm-core")).toBeTruthy();
    expect(getByText("Swarm core")).toBeTruthy();
    expect(getByText("impl-worker")).toBeTruthy();
    // Source chip tones (builtin neutral, project blue).
    expect(container.querySelector(".skill-src-builtin")).toBeTruthy();
    expect(container.querySelector(".skill-src-project")).toBeTruthy();
    // Short hash (12 chars).
    expect(getByText("abcdef012345")).toBeTruthy();
    expect(getByText("001122334455")).toBeTruthy();
  });

  it("omits the optional stack entirely when there are no optional skills", () => {
    const b = binding({ optional: [], count: 1 });
    const { getByText, queryByText } = render(SkillStacks, { props: { binding: b } });
    expect(getByText("Required (1)")).toBeTruthy();
    expect(queryByText("Optional (0)")).toBeNull();
  });
});
