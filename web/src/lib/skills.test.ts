import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import {
  skillsOf, sourceTone, shortHash, cleanLeakText, leakSkillName,
  normalizeFindings, isolationFindingsOf, dedupeFindings,
  type SkillBindingSummary, type SkillIsolationFinding,
} from "~/lib/skills";
import SkillStacks from "~/components/SkillStacks.svelte";
import SkillIsolationFindings from "~/components/SkillIsolationFindings.svelte";

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

const ESC = String.fromCharCode(27); // ESC / 0x1b — ASCII-safe so it cannot be stripped
const finding = (over: Partial<SkillIsolationFinding> = {}): SkillIsolationFinding => ({
  kind: "global_user_skill_reference", severity: "warning",
  path: "C:\\Users\\Marius\\.codex\\skills\\.system\\project-overseer\\SKILL.md",
  snippet: "Get-Content -Raw C:\\Users\\Marius\\.codex\\skills\\...", lineNumber: 5, ...over,
});

describe("cleanLeakText", () => {
  it("strips ANSI/VT colour codes captured from raw output", () => {
    const raw = `${ESC}[31;1m${ESC}[36;1mGet-Content C:\\x\\.codex\\skills\\foo${ESC}[0m`;
    expect(cleanLeakText(raw)).toBe("Get-Content C:\\x\\.codex\\skills\\foo");
  });
  it("strips stray control chars and collapses whitespace", () => {
    expect(cleanLeakText("ab   c\n\nd")).toBe("ab c d");
  });
  it("returns an empty string for non-string input", () => {
    expect(cleanLeakText(undefined)).toBe("");
    expect(cleanLeakText(42 as unknown as string)).toBe("");
  });
});

describe("leakSkillName", () => {
  it("climbs past a SKILL.md leaf (and dotted scaffolding dirs) to the identifying folder", () => {
    expect(leakSkillName("C:\\Users\\x\\.codex\\skills\\.system\\project-overseer\\SKILL.md")).toBe("project-overseer");
    expect(leakSkillName("/home/x/.codex/skills/triage-helper/SKILL.md")).toBe("triage-helper");
  });
  it("returns the last segment when the leaf is not a SKILL.<ext> file", () => {
    expect(leakSkillName("/home/x/.codex/skills/foo")).toBe("foo");
  });
  it("trims trailing separators before extracting the segment", () => {
    expect(leakSkillName("/home/x/.codex/skills/foo/")).toBe("foo");
    expect(leakSkillName("C:\\a\\b\\triage-helper\\SKILL.md\\")).toBe("triage-helper");
  });
  it("strips ANSI before extracting the segment", () => {
    expect(leakSkillName(`/a/b/leaky${ESC}[0m`)).toBe("leaky");
  });
  it("falls back to the whole cleaned string when there is no separator", () => {
    expect(leakSkillName("plain")).toBe("plain");
    expect(leakSkillName(undefined)).toBe("");
  });
});

describe("normalizeFindings / isolationFindingsOf", () => {
  it("normalizes a raw array, defaulting severity and dropping junk", () => {
    const got = normalizeFindings([
      finding(),
      null,
      "nope",
      { path: "/a/b" },                       // missing severity → defaults to "warning"
      { kind: "x" },                          // neither path nor snippet → dropped
    ]);
    expect(got.length).toBe(2);
    expect(got[1].severity).toBe("warning");
    expect(got[1].path).toBe("/a/b");
  });
  it("isolationFindingsOf reads run.skillIsolationFindings safely", () => {
    expect(isolationFindingsOf({ skillIsolationFindings: [finding()] }).length).toBe(1);
    expect(isolationFindingsOf({ skillIsolationFindings: "bad" })).toEqual([]);
    expect(isolationFindingsOf(null)).toEqual([]);
    expect(isolationFindingsOf({})).toEqual([]);
  });
});

describe("dedupeFindings", () => {
  it("dedupes by cleaned path + lineNumber, preserving order", () => {
    const a = finding({ path: "/x/skills/a", lineNumber: 1 });
    const b = finding({ path: "/x/skills/b", lineNumber: 2 });
    const aGain = finding({ path: `/x/skills/a${ESC}[0m`, lineNumber: 1 }); // same after cleaning
    const got = dedupeFindings([a, b, aGain]);
    expect(got.map((f) => f.path)).toEqual(["/x/skills/a", "/x/skills/b"]);
  });
});

describe("SkillIsolationFindings", () => {
  it("renders the heading with count, the skill name, and the cleaned snippet", () => {
    const f = finding({ path: "/x/.codex/skills/project-overseer/SKILL.md", snippet: `${ESC}[31;1mleaky read${ESC}[0m`, lineNumber: 5 });
    const { getByText, container } = render(SkillIsolationFindings, { props: { findings: [f] } });
    expect(getByText("Skill isolation (1)")).toBeTruthy();
    expect(getByText("project-overseer")).toBeTruthy();   // identifying folder, not the SKILL.md leaf
    expect(getByText("line 5")).toBeTruthy();
    // snippet rendered without escape codes
    expect(getByText("leaky read")).toBeTruthy();
    expect(container.textContent).not.toContain(ESC);
  });
  it("renders nothing when there are no findings", () => {
    const { container } = render(SkillIsolationFindings, { props: { findings: [] } });
    expect(container.querySelector(".skill-leak")).toBeNull();
  });
  it("honours a custom heading", () => {
    const { getByText } = render(SkillIsolationFindings, { props: { findings: [finding()], heading: "Global skill references" } });
    expect(getByText("Global skill references (1)")).toBeTruthy();
  });
});
