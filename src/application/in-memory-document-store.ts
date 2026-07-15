import { assertSafeVaultPath, assertUserId, type DocumentStore, type UserDocument } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";

/** Hermetic adapter for executable specs; production composition must use MinIO. */
export function createInMemoryDocumentStore(clock: Clock): DocumentStore {
  const documents = new Map<string, UserDocument>();
  let version = 0;
  const key = (userId: string, path: string) => `${assertUserId(userId)}\u0000${assertSafeVaultPath(path)}`;
  return {
    async get(userId, path) {
      const document = documents.get(key(userId, path));
      return document ? { ...document } : null;
    },
    async put(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const safePath = assertSafeVaultPath(path);
      const document: UserDocument = { userId: safeUserId, path: safePath, content, version: `memory-${++version}`, updatedAt: clock.now() };
      documents.set(key(safeUserId, safePath), document);
      return { ...document };
    },
    async list(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? undefined : `${assertSafeVaultPath(prefix.replace(/\/+$/, ""))}/`;
      return [...documents.values()]
        .filter((document) => document.userId === safeUserId && (!safePrefix || document.path.startsWith(safePrefix)))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((document) => ({ ...document }));
    },
    async delete(userId, path) {
      documents.delete(key(userId, path));
    },
  };
}
