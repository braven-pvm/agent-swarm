import { z } from "zod";

export const heartbeatStateSchema = z.enum([
  "idle",
  "thinking",
  "reading",
  "editing",
  "testing",
  "verifying",
  "waiting",
  "blocked",
]);

export const sourceRefSchema = z.object({
  adapterId: z.string().min(1),
  kind: z.string().min(1),
  uri: z.string().min(1),
  title: z.string().optional(),
  version: z.string().optional(),
  hash: z.string().optional(),
  section: z.string().optional(),
});

export const targetConfigSchema = z.object({
  target: z.object({
    name: z.string().min(1),
    root: z.string().min(1),
    language: z.string().optional(),
    packageManager: z.string().optional(),
  }),
  commands: z.record(z.string(), z.string()),
  discovery: z.object({
    generatedAt: z.string(),
    sources: z.record(z.string(), z.string()),
  }),
});

export const workerResultSchema = z.object({
  status: z.enum(["passed", "failed", "blocked", "needs_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  commandsRun: z.array(z.string()),
  testsRun: z.array(z.string()),
  frAcCoverage: z.array(
    z.object({
      ref: z.string(),
      status: z.enum(["covered", "not_covered", "blocked"]),
      evidence: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  nextRecommendation: z.string(),
});

export type WorkerResult = z.infer<typeof workerResultSchema>;

export const reviewQualityDimensionSchema = z.object({
  dimension: z.enum([
    "runtime_path",
    "stub_or_hardcode",
    "test_meaningfulness",
    "error_handling",
    "integration_fit",
    "maintainability",
    "real_world_readiness",
  ]),
  status: z.enum(["passed", "warning", "failed", "not_applicable"]),
  risk: z.enum(["none", "low", "medium", "high"]),
  evidence: z.array(z.string()),
  finding: z.string(),
});

export const reviewQualityGateSchema = z.object({
  status: z.enum(["passed", "warning", "failed"]),
  summary: z.string(),
  dimensions: z.array(reviewQualityDimensionSchema),
  blockingConcerns: z.array(z.string()),
  residualRisks: z.array(z.string()),
});

export const reviewResultSchema = z.object({
  status: z.enum(["accepted", "repair_required", "blocked", "human_required"]),
  summary: z.string(),
  frAcFindings: z.array(
    z.object({
      ref: z.string(),
      status: z.enum(["passed", "failed", "missing_evidence", "uncertain"]),
      evidence: z.array(z.string()),
      finding: z.string(),
    }),
  ),
  testAssessment: z.string(),
  sourceMutationDetected: z.boolean(),
  stubOrHardcodeRisk: z.enum(["none", "low", "medium", "high"]),
  qualityGate: reviewQualityGateSchema.default(() => ({
    status: "passed",
    summary: "Legacy review result did not include the structured Sleuth Review Gate.",
    dimensions: [],
    blockingConcerns: [],
    residualRisks: [],
  } as z.infer<typeof reviewQualityGateSchema>)),
  requiredFixes: z.array(z.string()),
  escalations: z.array(
    z.object({
      level: z.enum(["warning", "blocker", "human_required", "critical"]),
      message: z.string(),
    }),
  ),
  recommendation: z.string(),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const skepticFindingVerdictSchema = z.object({
  ref: z.string().optional(), // FR/AC ref when challenging a frAcFinding (e.g. "AC-INV-001.1")
  dimension: z.string().optional(), // sleuth dimension when challenging a qualityGate dimension (e.g. "runtime_path")
  source: z.enum(["fr_ac_finding", "quality_dimension", "required_fix", "escalation"]),
  verdict: z.enum(["real", "refuted", "uncertain"]),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  reasoning: z.string(),
});

export const skepticResultSchema = z.object({
  status: z.enum(["upheld", "partially_refuted", "refuted", "uncertain"]),
  summary: z.string(),
  challengedReviewStatus: z.enum(["accepted", "repair_required", "blocked", "human_required"]),
  findingVerdicts: z.array(skepticFindingVerdictSchema),
  recommendation: z.string(),
});

export type SkepticFindingVerdict = z.infer<typeof skepticFindingVerdictSchema>;
export type SkepticResult = z.infer<typeof skepticResultSchema>;

export const overseerDecisionSchema = z.object({
  status: z.enum(["recommend_commands", "blocked", "human_required", "complete"]),
  summary: z.string(),
  scenario: z.string(),
  currentPriority: z.string(),
  recommendedCommands: z.array(
    z.object({
      command: z.string(),
      purpose: z.string(),
      expectedStateChange: z.string(),
      requiresHuman: z.boolean(),
    }),
  ),
  lanePlan: z.array(
    z.object({
      laneName: z.string(),
      purpose: z.string(),
      nextAction: z.string(),
    }),
  ),
  blockers: z.array(
    z.object({
      level: z.enum(["warning", "blocker", "human_required", "critical"]),
      message: z.string(),
      scope: z.string(),
    }),
  ),
  stopCondition: z.string(),
  nextAction: z.string(),
});

export type OverseerDecision = z.infer<typeof overseerDecisionSchema>;
