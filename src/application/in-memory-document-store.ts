import {
  assertSafeVaultPath,
  assertUserId,
  attachDocumentReadReference,
  canonicalDocumentPath,
  documentReadReference,
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
  const versions = new Map<string, Map<string, UserDocument>>();
  let version = 0;
  const key = (userId: string, path: string) => `${assertUserId(userId)}\u0000${assertSafeVaultPath(path)}`;
  const saveVersion = (document: UserDocument): UserDocument => {
    documents.set(key(document.userId, document.path), document);
    const history = versions.get(key(document.userId, document.path)) ?? new Map<string, UserDocument>();
    history.set(document.version, { ...document });
    versions.set(key(document.userId, document.path), history);
    return { ...document };
  };
  for (const initial of initialDocuments) {
    const userId = assertUserId(initial.userId);
    const path = assertSafeVaultPath(initial.path);
    saveVersion({ userId, path, content: initial.content, version: `memory-${++version}`, updatedAt: clock.now() });
  }
  const readExact = (userId: string, path: string): UserDocument | null => {
    const document = documents.get(key(userId, path));
    return document ? { ...document } : null;
  };
  const metadataOf = (document: UserDocument, logicalPath = document.path): UserDocumentMetadata => attachDocumentReadReference({
    userId: document.userId,
    path: logicalPath,
    version: document.version,
    updatedAt: document.updatedAt,
    size: Buffer.byteLength(document.content, "utf8"),
  }, document.path);
  const currentLogical = (userId: string, path: string): UserDocument | null => {
    const canonicalPath = canonicalDocumentPath(path);
    return readExact(userId, canonicalPath) ?? (() => {
      const legacyPath = legacyDocumentPath(canonicalPath);
      return legacyPath ? readExact(userId, legacyPath) : null;
    })();
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
    async get(userId, path, metadata) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      if (metadata) {
        const reference = documentReadReference(metadata);
        if (!reference || reference.userId !== safeUserId || reference.logicalPath !== canonicalPath) return null;
        const pinned = readExact(safeUserId, reference.storagePath);
        return pinned?.version === reference.version ? { ...pinned, path: canonicalPath } : null;
      }
      const document = readExact(safeUserId, canonicalPath) ?? (() => {
        const legacyPath = legacyDocumentPath(canonicalPath);
        return legacyPath ? readExact(safeUserId, legacyPath) : null;
      })();
      return document ? { ...document, path: canonicalPath } : null;
    },
    async head(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const document = readExact(safeUserId, canonicalPath) ?? (() => {
        const legacyPath = legacyDocumentPath(canonicalPath);
        return legacyPath ? readExact(safeUserId, legacyPath) : null;
      })();
      return document ? attachDocumentReadReference({
        userId: safeUserId,
        path: canonicalPath,
        version: document.version,
        updatedAt: document.updatedAt,
        size: Buffer.byteLength(document.content, "utf8"),
      }, document.path) : null;
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
      return saveVersion(document);
    },
    async putIfAbsent(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const existing = currentLogical(safeUserId, canonicalPath);
      if (existing) return { ...existing, path: canonicalPath };
      const document: UserDocument = { userId: safeUserId, path: canonicalPath, content, version: `memory-${++version}`, updatedAt: clock.now() };
      return saveVersion(document);
    },
    async putIfVersion(userId, path, expectedVersion, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const current = currentLogical(safeUserId, canonicalPath);
      if (!current) return { outcome: "not_found" };
      if (current.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(current, canonicalPath) };
      const document: UserDocument = { userId: safeUserId, path: canonicalPath, content, version: `memory-${++version}`, updatedAt: clock.now() };
      return { outcome: "updated", document: saveVersion(document) };
    },
    async moveIfVersion(userId, sourcePath, destinationPath, expectedVersion) {
      const safeUserId = assertUserId(userId);
      const canonicalSource = canonicalDocumentPath(sourcePath);
      const canonicalDestination = canonicalDocumentPath(destinationPath);
      const source = currentLogical(safeUserId, canonicalSource);
      if (!source) return { outcome: "not_found" };
      if (source.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(source, canonicalSource) };
      const destination = currentLogical(safeUserId, canonicalDestination);
      if (destination) return { outcome: "destination_conflict", current: metadataOf(destination, canonicalDestination) };
      const moved: UserDocument = { userId: safeUserId, path: canonicalDestination, content: source.content, version: `memory-${++version}`, updatedAt: clock.now() };
      saveVersion(moved);
      documents.delete(key(safeUserId, canonicalSource));
      const legacyPath = legacyDocumentPath(canonicalSource);
      if (legacyPath) documents.delete(key(safeUserId, legacyPath));
      return { outcome: "moved", document: { ...moved }, sourceVersion: source.version };
    },
    async deleteIfVersion(userId, path, expectedVersion) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const current = currentLogical(safeUserId, canonicalPath);
      if (!current) return { outcome: "not_found" };
      if (current.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(current, canonicalPath) };
      documents.delete(key(safeUserId, canonicalPath));
      const legacyPath = legacyDocumentPath(canonicalPath);
      if (legacyPath) documents.delete(key(safeUserId, legacyPath));
      return { outcome: "deleted", path: canonicalPath, version: current.version };
    },
    async restoreVersion(userId, path, requestedVersion) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const storagePaths = [canonicalPath, legacyDocumentPath(canonicalPath)].filter((item): item is string => item !== null);
      let historical: UserDocument | undefined;
      for (const storagePath of storagePaths) {
        historical = versions.get(key(safeUserId, storagePath))?.get(requestedVersion);
        if (historical) break;
      }
      if (!historical) return null;
      const restored: UserDocument = { userId: safeUserId, path: canonicalPath, content: historical.content, version: `memory-${++version}`, updatedAt: clock.now() };
      return saveVersion(restored);
    },
    async listMetadata(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const safePrefix = prefix === undefined ? undefined : `${canonicalDocumentPath(prefix.replace(/\/+$/, ""))}/`;
      const selected = new Map<string, { document: UserDocument; canonicalSource: boolean }>();
      for (const document of documents.values()) {
        if (document.userId !== safeUserId) continue;
        const canonicalPath = canonicalDocumentPath(document.path);
        if (safePrefix && !canonicalPath.startsWith(safePrefix)) continue;
        const canonicalSource = document.path === canonicalPath;
        const existing = selected.get(canonicalPath);
        if (existing?.canonicalSource || (existing && !canonicalSource)) continue;
        selected.set(canonicalPath, { document, canonicalSource });
      }
      return [...selected.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, { document }]): UserDocumentMetadata => attachDocumentReadReference({
          userId: safeUserId,
          path,
          version: document.version,
          updatedAt: document.updatedAt,
          size: Buffer.byteLength(document.content, "utf8"),
        }, document.path));
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
