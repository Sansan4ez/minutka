import {
  assertSafeVaultPath,
  assertUserId,
  canonicalDocumentPath,
  legacyDocumentPath,
  type DocumentStore,
  type UserDocument,
} from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";

/** Hermetic adapter for executable specs; production composition must use MinIO. */
export function createInMemoryDocumentStore(
  clock: Clock,
  initialDocuments: ReadonlyArray<Pick<UserDocument, "userId" | "path" | "content">> = [],
): DocumentStore {
  const documents = new Map<string, UserDocument>();
  let version = 0;
  const key = (userId: string, path: string) => `${assertUserId(userId)}\u0000${assertSafeVaultPath(path)}`;
  for (const initial of initialDocuments) {
    const userId = assertUserId(initial.userId);
    const path = assertSafeVaultPath(initial.path);
    documents.set(key(userId, path), {
      userId,
      path,
      content: initial.content,
      version: `memory-${++version}`,
      updatedAt: clock.now(),
    });
  }
  const readExact = (userId: string, path: string): UserDocument | null => {
    const document = documents.get(key(userId, path));
    return document ? { ...document } : null;
  };
  return {
    async get(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const document = readExact(safeUserId, canonicalPath) ?? (() => {
        const legacyPath = legacyDocumentPath(canonicalPath);
        return legacyPath ? readExact(safeUserId, legacyPath) : null;
      })();
      return document ? { ...document, path: canonicalPath } : null;
    },
    async getExact(userId, path) {
      return readExact(userId, path);
    },
    async listExact(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? undefined : `${assertSafeVaultPath(prefix.replace(/\/+$/, ""))}/`;
      return [...documents.values()]
        .filter((document) => document.userId === safeUserId && (!safePrefix || document.path.startsWith(safePrefix)))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((document) => ({ ...document }));
    },
    async put(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const document: UserDocument = { userId: safeUserId, path: canonicalPath, content, version: `memory-${++version}`, updatedAt: clock.now() };
      documents.set(key(safeUserId, canonicalPath), document);
      return { ...document };
    },
    async putIfAbsent(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const existing = readExact(safeUserId, canonicalPath) ?? (() => {
        const legacyPath = legacyDocumentPath(canonicalPath);
        return legacyPath ? readExact(safeUserId, legacyPath) : null;
      })();
      if (existing) return { ...existing, path: canonicalPath };
      const document: UserDocument = { userId: safeUserId, path: canonicalPath, content, version: `memory-${++version}`, updatedAt: clock.now() };
      documents.set(key(safeUserId, canonicalPath), document);
      return { ...document };
    },
    async list(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? undefined : `${canonicalDocumentPath(prefix.replace(/\/+$/, ""))}/`;
      const logicalDocuments = new Map<string, { document: UserDocument; canonicalSource: boolean }>();
      for (const document of documents.values()) {
        if (document.userId !== safeUserId) continue;
        const canonicalPath = canonicalDocumentPath(document.path);
        if (safePrefix && !canonicalPath.startsWith(safePrefix)) continue;
        const canonicalSource = document.path === canonicalPath;
        const existing = logicalDocuments.get(canonicalPath);
        if (existing?.canonicalSource || (existing && !canonicalSource)) continue;
        logicalDocuments.set(canonicalPath, { document: { ...document, path: canonicalPath }, canonicalSource });
      }
      return [...logicalDocuments.values()]
        .map(({ document }) => document)
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    async delete(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      documents.delete(key(safeUserId, canonicalPath));
      const legacyPath = legacyDocumentPath(canonicalPath);
      if (legacyPath) documents.delete(key(safeUserId, legacyPath));
    },
  };
}
