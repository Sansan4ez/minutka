import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSafeVaultPath, assertUserId, legacyDocumentPath, type DocumentStore } from "./document-store.js";
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
export async function discoverPilotKnowledgeBase(sourceRoot: string): Promise<PilotKnowledgeBaseFile[]> {
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
  return sorted;
}

/** Validates that exact-case INDEX.md links resolve to direct children only. */
export async function validatePilotKnowledgeBaseIndexes(sourceRoot: string, files: PilotKnowledgeBaseFile[]): Promise<void> {
  for (const index of files.filter(({ sourcePath }) => sourcePath.endsWith(`${sep}INDEX.md`) || sourcePath === join(sourceRoot, "INDEX.md"))) {
    const content = await readFile(index.sourcePath, "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawTarget = match[1]?.trim() ?? "";
      if (!rawTarget || rawTarget.startsWith("#") || /^(?:https?:|mailto:)/i.test(rawTarget)) continue;
      const pathTarget = rawTarget.split("#", 1)[0]!.split("?", 1)[0]!;
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(pathTarget);
      } catch {
        throw new Error(`knowledge-base INDEX.md has an invalid encoded link: ${index.path} -> ${rawTarget}`);
      }
      if (!decodedTarget || isAbsolute(decodedTarget)) throw new Error(`knowledge-base INDEX.md link must be relative: ${index.path} -> ${rawTarget}`);
      const targetPath = resolve(dirname(index.sourcePath), decodedTarget);
      const directChild = relative(dirname(index.sourcePath), targetPath).split(sep).filter(Boolean);
      if (directChild.length !== 1 || directChild[0] === "..") {
        throw new Error(`knowledge-base INDEX.md may link only direct children: ${index.path} -> ${rawTarget}`);
      }
      const targetStat = await lstat(targetPath).catch(() => null);
      if (!targetStat) throw new Error(`knowledge-base INDEX.md link does not exist: ${index.path} -> ${rawTarget}`);
      if (targetStat.isSymbolicLink()) throw new Error(`knowledge-base INDEX.md link targets a symlink: ${index.path} -> ${rawTarget}`);
    }
  }
}

/** Writes only through IngestionService and skips byte-identical documents. */
export async function importPilotKnowledgeBase(input: {
  userId: string;
  files: PilotKnowledgeBaseFile[];
  documentStore: Pick<DocumentStore, "getExact">;
  ingestionService: Pick<IngestionService, "saveContextDocument">;
}): Promise<PilotKnowledgeBaseImportResult> {
  const userId = assertUserId(input.userId);
  const prepared = await Promise.all(input.files.map(async (file) => {
    const content = await readFile(file.sourcePath, "utf8");
    if (!content.trim()) throw new Error(`knowledge-base file is empty: ${file.path}`);
    return { ...file, content };
  }));

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

export function pilotUserIdFromEnv(env: NodeJS.ProcessEnv): string {
  const userId = env.PILOT_USER_ID?.trim();
  if (!userId) throw new Error("PILOT_USER_ID is required");
  return assertUserId(userId);
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
