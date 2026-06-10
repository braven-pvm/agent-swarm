import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeId } from "./ids.js";
import { extractFrAcRefs, extractMarkdownSections } from "./source-index.js";
import type { SourceRecord } from "./types.js";

export interface RegisterFileSourceOptions {
  domain?: string;
  tags?: string[];
  priority?: number;
}

export function registerFileSource(fileInput: string, options: RegisterFileSourceOptions = {}): SourceRecord {
  const filePath = path.resolve(fileInput);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file does not exist: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Source path is not a file: ${filePath}`);
  }
  const content = fs.readFileSync(filePath);
  const text = content.toString("utf8");
  const now = new Date().toISOString();
  const id = makeId("source");
  return {
    id,
    adapterId: "file",
    kind: path.extname(filePath).replace(".", "") || "text",
    uri: filePath,
    title: deriveTitle(filePath, text),
    hash: createHash("sha256").update(content).digest("hex"),
    metadata: {
      ...extractMetadata(text),
      ...metadataFromOptions(options),
      frAcRefs: extractFrAcRefs(text),
      sections: extractMarkdownSections(text, id),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function readSourceText(source: SourceRecord): string {
  return fs.readFileSync(source.uri, "utf8");
}

function deriveTitle(filePath: string, text: string): string {
  const heading = text.split(/\r?\n/).find((line) => line.trim().startsWith("# "));
  if (heading) return heading.replace(/^#\s+/, "").trim();
  return path.basename(filePath);
}

function extractMetadata(text: string): Record<string, unknown> {
  const dependsOn = [...text.matchAll(/^\s*Depends-On:\s*(.+)$/gim)].flatMap((match) =>
    match[1]
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  );
  const domain = firstMetadataValue(text, "Domain");
  const tags = firstMetadataValue(text, "Tags")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const priorityRaw = firstMetadataValue(text, "Priority");
  const priority = priorityRaw === undefined ? undefined : Number.parseInt(priorityRaw, 10);
  return {
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(domain ? { domain } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(Number.isFinite(priority) ? { priority } : {}),
  };
}

function firstMetadataValue(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+)$`, "im");
  const match = pattern.exec(text);
  return match?.[1]?.trim();
}

function metadataFromOptions(options: RegisterFileSourceOptions): Record<string, unknown> {
  return {
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.tags?.length ? { tags: options.tags } : {}),
    ...(typeof options.priority === "number" && Number.isFinite(options.priority) ? { priority: options.priority } : {}),
  };
}
