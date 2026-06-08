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
