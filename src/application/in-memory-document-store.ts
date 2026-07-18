import {
  assertSafeVaultPath,
  assertUserId,
  canonicalDocumentPath,
  legacyDocumentPath,
  type DocumentStore,
  type UserDocument,
  type UserDocumentMetadata,
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
  const logicalEntries = <T extends UserDocument | UserDocumentMetadata>(
    userId: string,
    prefix: string | undefined,
    entries: Iterable<T>,
  ): T[] => {
    const safeUserId = assertUserId(userId);
    const safePrefix = prefix === undefined ? undefined : `${canonicalDocumentPath(prefix.replace(/\/+$/, ""))}/`;
    const selected = new Map<string, { entry: T; canonicalSource: boolean }>();
    for (const entry of entries) {
      if (entry.userId !== safeUserId) continue;
      const canonicalPath = canonicalDocumentPath(entry.path);
      if (safePrefix && !canonicalPath.startsWith(safePrefix)) continue;
      const canonicalSource = entry.path === canonicalPath;
      const existing = selected.get(canonicalPath);
      if (existing?.canonicalSource || (existing && !canonicalSource)) continue;
      selected.set(canonicalPath, { entry: { ...entry, path: canonicalPath }, canonicalSource });
    }
    return [...selected.values()]
      .map(({ entry }) => entry)
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
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
    async listMetadata(userId, prefix) {
      return logicalEntries(userId, prefix, [...documents.values()].map((document): UserDocumentMetadata => ({
        userId: document.userId,
        path: document.path,
        version: document.version,
        updatedAt: document.updatedAt,
        size: Buffer.byteLength(document.content, "utf8"),
      })));
    },
    async *iterate(userId, prefix) {
      for (const document of logicalEntries(userId, prefix, documents.values())) yield { ...document };
    },
    async list(userId, prefix) {
      const listed: UserDocument[] = [];
      for await (const document of this.iterate(userId, prefix)) listed.push(document);
      return listed;
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
