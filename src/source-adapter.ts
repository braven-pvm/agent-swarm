import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { makeId } from "./ids.js";
import type { SourceRecord } from "./types.js";

export function registerFileSource(fileInput: string): SourceRecord {
  const filePath = path.resolve(fileInput);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file does not exist: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Source path is not a file: ${filePath}`);
  }
  const content = fs.readFileSync(filePath);
  const now = new Date().toISOString();
  return {
    id: makeId("source"),
    adapterId: "file",
    kind: path.extname(filePath).replace(".", "") || "text",
    uri: filePath,
    title: deriveTitle(filePath, content.toString("utf8")),
    hash: createHash("sha256").update(content).digest("hex"),
    metadata: extractMetadata(content.toString("utf8")),
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
  return dependsOn.length > 0 ? { dependsOn } : {};
}
