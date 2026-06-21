import fs from "node:fs";
import path from "node:path";
import { z, type ZodType } from "zod";

/**
 * Derive the driver-facing JSON Schema for a role from its canonical Zod schema.
 *
 * The contract a worker/reviewer/overseer is HELD TO (this JSON Schema, handed to
 * codex via `--output-schema` and to claude via `--json-schema`) must equal the
 * contract its evidence is JUDGED BY (the Zod schema in src/schemas.ts, applied via
 * safeParse). Generating both from the same Zod source keeps them in lockstep.
 *
 * Configured to be at least as strict as the previous hand-written schemas:
 *  - `additionalProperties: false` on every object (z.toJSONSchema default for
 *    z.object in the default "output" io mode).
 *  - per-role `required` sets that match the Zod shape. NOTE: we deliberately use the
 *    default io mode ("output"), NOT "input": in "input" mode a field carrying a Zod
 *    `.default()` (reviewResultSchema.qualityGate) is dropped from `required`, which
 *    would be LOOSER than the hand-written schema. "output" keeps it required.
 *
 * The `$schema` draft pointer that z.toJSONSchema emits is stripped: the proven,
 * CLI-accepted hand-written schemas omitted it, so we preserve that exact shape.
 */
export function zodToDriverJsonSchema(zodSchema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Serialize a generated JSON Schema using the same byte format the drivers expect
 * (2-space indent, trailing newline). Deterministic for a given Zod schema. */
export function serializeDriverJsonSchema(zodSchema: ZodType): string {
  return `${JSON.stringify(zodToDriverJsonSchema(zodSchema), null, 2)}\n`;
}

/** Write the driver-facing JSON Schema for `zodSchema` to `schemaPath`. */
export function writeSchemaFromZod(schemaPath: string, zodSchema: ZodType): void {
  fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
  fs.writeFileSync(schemaPath, serializeDriverJsonSchema(zodSchema), "utf8");
}
