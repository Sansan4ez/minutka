import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSafeVaultPath, assertUserId, legacyDocumentPath, type DocumentStore } from "./document-store.js";
import { countUnicodeCharacters, defaultContextBudget, sourceCharacterCeiling, type ContextBudgetConfig } from "./context-budget.js";
import { loadContextPriorityManifest, matchesContextPriority, type ContextPriorityManifest } from "./context-priority-manifest.js";
import type { IngestionService } from "./ingestion-service.js";

const allowedTopLevelEntries = new Set([
  "00_inbox",
  "07_rfcs",
  "08_entities",
  "10_user_memory",
  "20_work",
  "30_knowledge",
  "40_projects",
  "50_finance",
  "60_outbox",
  "90_agent_memory",
  "99_system",
  "INDEX.md",
]);
const allowedExtensions = new Set([".md", ".txt", ".vtt"]);
const destinationPrefix = "context";

export type PilotKnowledgeBaseFile = {
  sourcePath: string;
  path: string;
  size: number;
};

export type PilotKnowledgeBaseImportResult = {
  files: Array<{ path: string; size: number; status: "imported" | "updated" | "skipped" }>;
  imported: number;
  updated: number;
  skipped: number;
  bytes: number;
};

export type PilotKnowledgeBaseMigrationResult = {
  files: Array<{ from: string; to: string; status: "migrated" | "skipped" }>;
  migrated: number;
  skipped: number;
};

/**
 * Enumerates only the explicitly approved legacy tree. Symlinks and unknown
 * file types fail closed so the migration cannot accidentally ingest secrets.
 */
export async function discoverPilotKnowledgeBase(
  sourceRoot: string,
  options: { contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest } = {},
): Promise<PilotKnowledgeBaseFile[]> {
  const rootStat = await lstat(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("knowledge-base source must be a real directory");
  const rootEntries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!allowedTopLevelEntries.has(entry.name)) throw new Error(`knowledge-base entry is not allow-listed: ${entry.name}`);
  }

  const files: PilotKnowledgeBaseFile[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`knowledge-base symlinks are not allowed: ${relativePath(sourceRoot, path)}`);
    if (stat.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) await visit(join(path, entry.name));
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported knowledge-base entry: ${relativePath(sourceRoot, path)}`);
    if (!allowedExtensions.has(extname(path).toLowerCase())) throw new Error(`knowledge-base file type is not allow-listed: ${relativePath(sourceRoot, path)}`);

    const sourceRelativePath = relativePath(sourceRoot, path).normalize("NFC");
    files.push({
      sourcePath: path,
      path: assertSafeVaultPath(`${destinationPrefix}/${sourceRelativePath}`, "context/"),
      size: stat.size,
    });
  }

  for (const entry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) await visit(join(sourceRoot, entry.name));
  const sorted = files.sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  for (const file of sorted) {
    const collisionKey = file.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(collisionKey)) throw new Error(`knowledge-base paths collide after normalization: ${file.path}`);
    paths.add(collisionKey);
  }
  await validatePilotKnowledgeBaseIndexes(sourceRoot, sorted);
  await validatePilotKnowledgeBaseCoreDocuments({
    files: sorted,
    contextBudget: options.contextBudget ?? defaultContextBudget,
    contextPriorities: options.contextPriorities ?? loadContextPriorityManifest(),
  });
  return sorted;
}

/** Validates that exact-case INDEX.md links and path-like code spans resolve to direct children only. */
export async function validatePilotKnowledgeBaseIndexes(sourceRoot: string, files: PilotKnowledgeBaseFile[]): Promise<void> {
  for (const index of files.filter(({ sourcePath }) => sourcePath.endsWith(`${sep}INDEX.md`) || sourcePath === join(sourceRoot, "INDEX.md"))) {
    const content = await readFile(index.sourcePath, "utf8");
    const targets = [
      ...[...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => ({ target: match[1]?.trim() ?? "", kind: "link" as const })),
      ...[...content.matchAll(/`([^`\r\n]+)`/g)]
        .map((match) => match[1]?.trim() ?? "")
        .filter((target) => /(?:\.(?:md|txt|vtt)|\/)$/iu.test(target))
        .map((target) => ({ target, kind: "code-span" as const })),
    ];
    const uniqueTargets = new Map(targets.map((target) => [`${target.kind}:${target.target}`, target]));
    for (const { target, kind } of uniqueTargets.values()) await validateIndexTarget(index, target, kind);
  }
}

async function validateIndexTarget(index: PilotKnowledgeBaseFile, rawTarget: string, kind: "link" | "code-span"): Promise<void> {
  if (!rawTarget || rawTarget.startsWith("#") || /^(?:https?:|mailto:)/i.test(rawTarget)) return;
  const pathTarget = rawTarget.split("#", 1)[0]!.split("?", 1)[0]!;
  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(pathTarget);
  } catch {
    throw new Error(`knowledge-base INDEX.md has an invalid encoded path: ${index.path} -> ${rawTarget}`);
  }
  if (!decodedTarget || isAbsolute(decodedTarget)) throw new Error(`knowledge-base INDEX.md path must be relative: ${index.path} -> ${rawTarget}`);
  const targetPath = resolve(dirname(index.sourcePath), decodedTarget);
  const directChild = relative(dirname(index.sourcePath), targetPath).split(sep).filter(Boolean);
  if (directChild.length !== 1 || directChild[0] === "..") {
    throw new Error(`knowledge-base INDEX.md may reference only direct children: ${index.path} -> ${rawTarget}`);
  }
  const targetStat = await lstat(targetPath).catch(() => null);
  if (!targetStat) throw new Error(`knowledge-base INDEX.md ${kind} does not exist: ${index.path} -> ${rawTarget}`);
  if (targetStat.isSymbolicLink()) throw new Error(`knowledge-base INDEX.md ${kind} targets a symlink: ${index.path} -> ${rawTarget}`);
}

export async function validatePilotKnowledgeBaseCoreDocuments(input: {
  files: PilotKnowledgeBaseFile[];
  contextBudget: ContextBudgetConfig;
  contextPriorities: ContextPriorityManifest;
}): Promise<void> {
  const coreFiles = input.files.filter(({ path }) => matchesContextPriority(path, input.contextPriorities));
  const documentCeiling = input.contextBudget.projectionLimits.contextDocumentCharacters;
  const totalCeiling = sourceCharacterCeiling(input.contextBudget, "context");
  if (coreFiles.length > input.contextBudget.projectionLimits.contextDocuments) {
    throw new Error(`knowledge-base core documents exceed the ${input.contextBudget.projectionLimits.contextDocuments}-document projection limit`);
  }
  let totalCharacters = 0;
  for (const file of coreFiles) {
    const characters = countUnicodeCharacters(await readFile(file.sourcePath, "utf8"));
    if (characters > documentCeiling) {
      throw new Error(`knowledge-base core document ${file.path} has ${characters} Unicode characters and exceeds the ${documentCeiling}-character per-file ceiling`);
    }
    totalCharacters += characters;
  }
  if (totalCharacters > totalCeiling) {
    throw new Error(`knowledge-base core documents have ${totalCharacters} Unicode characters and exceed the ${totalCeiling}-character context ceiling`);
  }
}

/** Writes only through IngestionService and skips byte-identical documents. */
export async function importPilotKnowledgeBase(input: {
  userId: string;
  files: PilotKnowledgeBaseFile[];
  documentStore: Pick<DocumentStore, "getExact">;
  ingestionService: Pick<IngestionService, "saveContextDocument">;
  contextBudget?: ContextBudgetConfig;
  contextPriorities?: ContextPriorityManifest;
}): Promise<PilotKnowledgeBaseImportResult> {
  const userId = assertUserId(input.userId);
  const prepared = await Promise.all(input.files.map(async (file) => {
    const content = await readFile(file.sourcePath, "utf8");
    if (!content.trim()) throw new Error(`knowledge-base file is empty: ${file.path}`);
    return { ...file, content };
  }));

  validatePreparedCoreDocuments({
    files: prepared,
    contextBudget: input.contextBudget ?? defaultContextBudget,
    contextPriorities: input.contextPriorities ?? loadContextPriorityManifest(),
  });

  const result: PilotKnowledgeBaseImportResult = { files: [], imported: 0, updated: 0, skipped: 0, bytes: 0 };
  for (const file of prepared) {
    const existing = await input.documentStore.getExact(userId, file.path);
    const status = existing?.content === file.content ? "skipped" : existing ? "updated" : "imported";
    if (status !== "skipped") {
      await input.ingestionService.saveContextDocument({ userId, path: file.path, content: file.content });
    }
    result[status] += 1;
    result.bytes += file.size;
    result.files.push({ path: file.path, size: file.size, status });
  }
  return result;
}

/**
 * Copies legacy objects to canonical keys without deleting legacy versions.
 * A differing canonical collision fails closed instead of overwriting either document.
 */
export async function migrateLegacyPilotKnowledgeBase(input: {
  userId: string;
  documentStore: Pick<DocumentStore, "getExact" | "listExact">;
  ingestionService: Pick<IngestionService, "saveContextDocument">;
}): Promise<PilotKnowledgeBaseMigrationResult> {
  const userId = assertUserId(input.userId);
  const result: PilotKnowledgeBaseMigrationResult = { files: [], migrated: 0, skipped: 0 };
  const legacyDocuments = await input.documentStore.listExact(userId, "context/imported-knowledge-base/");
  for (const legacy of legacyDocuments) {
    const filePath = `context/${legacy.path.slice("context/imported-knowledge-base/".length)}`;
    const canonicalPath = assertSafeVaultPath(filePath, "context/");
    const legacyPath = legacyDocumentPath(canonicalPath);
    if (!legacyPath || legacyPath !== legacy.path) throw new Error(`invalid legacy knowledge-base path: ${legacy.path}`);
    const canonical = await input.documentStore.getExact(userId, canonicalPath);
    if (canonical && canonical.content !== legacy.content) {
      throw new Error(`knowledge-base migration collision: ${canonicalPath}`);
    }
    const status = canonical ? "skipped" : "migrated";
    if (!canonical) {
      await input.ingestionService.saveContextDocument({ userId, path: canonicalPath, content: legacy.content });
    }
    result[status] += 1;
    result.files.push({ from: legacyPath, to: canonicalPath, status });
  }
  return result;
}

function validatePreparedCoreDocuments(input: {
  files: Array<PilotKnowledgeBaseFile & { content: string }>;
  contextBudget: ContextBudgetConfig;
  contextPriorities: ContextPriorityManifest;
}): void {
  const coreFiles = input.files.filter(({ path }) => matchesContextPriority(path, input.contextPriorities));
  const documentCeiling = input.contextBudget.projectionLimits.contextDocumentCharacters;
  const totalCeiling = sourceCharacterCeiling(input.contextBudget, "context");
  if (coreFiles.length > input.contextBudget.projectionLimits.contextDocuments) {
    throw new Error(`knowledge-base core documents exceed the ${input.contextBudget.projectionLimits.contextDocuments}-document projection limit`);
  }
  let totalCharacters = 0;
  for (const file of coreFiles) {
    const characters = countUnicodeCharacters(file.content);
    if (characters > documentCeiling) {
      throw new Error(`knowledge-base core document ${file.path} has ${characters} Unicode characters and exceeds the ${documentCeiling}-character per-file ceiling`);
    }
    totalCharacters += characters;
  }
  if (totalCharacters > totalCeiling) {
    throw new Error(`knowledge-base core documents have ${totalCharacters} Unicode characters and exceed the ${totalCeiling}-character context ceiling`);
  }
}

export function pilotUserIdFromEnv(env: NodeJS.ProcessEnv): string {
  const userId = env.PILOT_USER_ID?.trim();
  if (!userId) throw new Error("PILOT_USER_ID is required");
  return assertUserId(userId);
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
