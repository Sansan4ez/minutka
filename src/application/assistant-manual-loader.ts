import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { findRepoRoot } from "./agent-manual-loader.js";
import { renderRuntimeProcessContent } from "./agent-manual-types.js";

const registrySchema = z.strictObject({
  version: z.literal(1),
  manualId: z.string().min(1),
  core: z.strictObject({ id: z.literal("core"), path: z.string().min(1) }),
  index: z.strictObject({ path: z.string().min(1) }),
  runtimeDocs: z.array(z.strictObject({ id: z.string().min(1), path: z.string().min(1) })),
  processes: z.array(z.strictObject({
    id: z.string().min(1),
    path: z.string().min(1),
    appliesTo: z.array(z.string().min(1)).optional(),
    dependencies: z.array(z.string().min(1)).optional(),
  })),
});

export function loadAssistantAgentInstructions(input: { repoRoot?: string } = {}): string {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const registryPath = safeRepoPath(repoRoot, "vault/assistant/processes/registry.json");
  const registry = registrySchema.parse(JSON.parse(readFileSync(registryPath, "utf8")));
  const duplicate = registry.processes.find((process, index) => registry.processes.findIndex(({ id }) => id === process.id) !== index);
  if (duplicate) throw new Error(`duplicate assistant process id: ${duplicate.id}`);
  const duplicateRuntimeDoc = registry.runtimeDocs.find((document, index) => registry.runtimeDocs.findIndex(({ id }) => id === document.id) !== index);
  if (duplicateRuntimeDoc) throw new Error(`duplicate assistant runtime document id: ${duplicateRuntimeDoc.id}`);
  assertAllowlistedPath(registry.core.path, "vault/assistant/AGENTS.md", "assistant core");
  assertAllowlistedPath(registry.index.path, "vault/assistant/processes/index.md", "assistant process index");
  for (const document of registry.runtimeDocs) assertDirectChild(document.path, "vault/assistant/docs/", `assistant runtime document ${document.id}`);
  for (const process of registry.processes) assertDirectChild(process.path, "vault/assistant/processes/", `assistant process ${process.id}`);
  const index = readFileSync(safeRepoPath(repoRoot, registry.index.path), "utf8").trim();
  for (const process of registry.processes) {
    if (!index.includes(`\`${process.id}\``)) throw new Error(`assistant process index does not reference: ${process.id}`);
  }
  return [
    readFileSync(safeRepoPath(repoRoot, registry.core.path), "utf8").trim(),
    "# Runtime documents",
    ...registry.runtimeDocs.map((document) => `## Runtime document: /docs/${document.id}\n\n${readFileSync(safeRepoPath(repoRoot, document.path), "utf8").trim()}`),
    "# Process index",
    index,
    "# Process files",
    ...registry.processes.map((process) => `## Process file: ${process.id}\n\n${renderRuntimeProcessContent(readFileSync(safeRepoPath(repoRoot, process.path), "utf8"))}`),
  ].join("\n\n");
}

function assertAllowlistedPath(path: string, expected: string, label: string): void {
  if (path !== expected) throw new Error(`${label} path is not allow-listed: ${path}`);
}

function assertDirectChild(path: string, prefix: string, label: string): void {
  const relativePath = path.slice(prefix.length);
  if (!path.startsWith(prefix) || !relativePath || relativePath.includes("/")) throw new Error(`${label} path is not allow-listed: ${path}`);
}

function safeRepoPath(repoRoot: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`assistant manual path must be repository-relative: ${path}`);
  const absolute = resolve(repoRoot, path);
  const pathFromRoot = relative(repoRoot, absolute);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) throw new Error(`assistant manual path escapes repository: ${path}`);
  return absolute;
}
