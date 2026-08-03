import * as Minio from "minio";
import {
  assertSafeVaultPath,
  assertUserId,
  attachDocumentReadReference,
  canonicalDocumentPath,
  documentReadReference,
  legacyDocumentPath,
  objectKey,
  type DocumentDeleteResult,
  type DocumentMoveResult,
  type DocumentStore,
  type DocumentUpdateResult,
  type UserDocument,
  type UserDocumentMetadata,
} from "../../application/document-store.js";

export type MinioDocumentStoreOptions = {
  client: Minio.Client;
  bucket: string;
  now?: () => string;
};

/** MinIO adapter. Object keys are always derived from trusted `(userId, path)`. */
export function createMinioDocumentStore(options: MinioDocumentStoreOptions): DocumentStore {
  const now = options.now ?? (() => new Date().toISOString());
  const getExact = async (userId: string, path: string, expectedMetadata?: UserDocumentMetadata): Promise<UserDocument | null> => {
    const safeUserId = assertUserId(userId);
    const safePath = assertSafeVaultPath(path);
    try {
      const key = objectKey(safeUserId, safePath);
      const stat = expectedMetadata === undefined ? await options.client.statObject(options.bucket, key) : null;
      const stream = await options.client.getObject(options.bucket, key, expectedMetadata ? { versionId: expectedMetadata.version } : stat?.versionId ? { versionId: stat.versionId } : undefined);
      const content = await readUtf8(stream);
      return {
        userId: safeUserId,
        path: safePath,
        content,
        version: expectedMetadata?.version ?? versionOf(stat!),
        updatedAt: expectedMetadata?.updatedAt ?? stat!.lastModified.toISOString(),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const headExact = async (userId: string, path: string): Promise<UserDocumentMetadata | null> => {
    const safeUserId = assertUserId(userId);
    const safePath = assertSafeVaultPath(path);
    try {
      const stat = await options.client.statObject(options.bucket, objectKey(safeUserId, safePath));
      return attachDocumentReadReference({ userId: safeUserId, path: safePath, version: versionOf(stat), updatedAt: stat.lastModified.toISOString(), size: stat.size }, safePath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  const metadataOf = (document: UserDocument, logicalPath = document.path): UserDocumentMetadata => attachDocumentReadReference({
    userId: document.userId,
    path: logicalPath,
    version: document.version,
    updatedAt: document.updatedAt,
    size: Buffer.byteLength(document.content, "utf8"),
  }, document.path);
  const readLogical = async (userId: string, path: string): Promise<UserDocument | null> => {
    const canonicalPath = canonicalDocumentPath(path);
    const canonical = await getExact(userId, canonicalPath);
    if (canonical) return canonical;
    const legacyPath = legacyDocumentPath(canonicalPath);
    const legacy = legacyPath ? await getExact(userId, legacyPath) : null;
    return legacy ? { ...legacy, path: canonicalPath } : null;
  };
  const writeCanonical = async (userId: string, path: string, content: string): Promise<UserDocument> => {
    const result = await options.client.putObject(options.bucket, objectKey(userId, path), Buffer.from(content, "utf8"), Buffer.byteLength(content), {
      "Content-Type": "text/markdown; charset=utf-8",
    });
    return { userId, path, content, version: result.versionId ?? result.etag, updatedAt: now() };
  };
  const readAfterFailedCreate = async (userId: string, path: string): Promise<UserDocument | null> => {
    for (const delayMs of [0, 10, 25]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const existing = await getExact(userId, path).catch(() => null);
      if (existing) return existing;
    }
    return null;
  };
  const listExact = async (userId: string, prefix?: string): Promise<UserDocument[]> => {
    const safeUserId = assertUserId(userId);
    const safePrefix = prefix === undefined ? "" : `${assertSafeVaultPath(prefix.replace(/\/+$/, ""))}/`;
    const prefixKey = safePrefix ? `${objectKey(safeUserId, safePrefix.slice(0, -1))}/` : `${safeUserId}/`;
    const objects = await collectObjects(options.client.listObjectsV2(options.bucket, prefixKey, true));
    const documents = await Promise.all(objects
      .filter((object) => object.name && !object.name.endsWith("/"))
      .map(async (object): Promise<UserDocument> => {
        const path = object.name!.slice(`${safeUserId}/`.length);
        const [stat, stream] = await Promise.all([
          options.client.statObject(options.bucket, object.name!),
          options.client.getObject(options.bucket, object.name!),
        ]);
        const content = await readUtf8(stream);
        return { userId: safeUserId, path, content, version: versionOf(stat), updatedAt: stat.lastModified.toISOString() };
      }));
    return documents.sort((left, right) => left.path.localeCompare(right.path));
  };
  const logicalObjects = async (userId: string, prefix?: string): Promise<Array<{ name: string; path: string }>> => {
    const safeUserId = assertUserId(userId);
    const canonicalPrefix = prefix === undefined ? undefined : `${canonicalDocumentPath(prefix.replace(/\/+$/, ""))}/`;
    const storagePrefixes = new Set<string | undefined>([canonicalPrefix]);
    const legacyPrefix = canonicalPrefix === undefined ? null : legacyDocumentPath(canonicalPrefix.slice(0, -1));
    if (legacyPrefix && !`${legacyPrefix}/`.startsWith(canonicalPrefix!)) storagePrefixes.add(`${legacyPrefix}/`);

    const objectGroups = await Promise.all([...storagePrefixes].map(async (storagePrefix) => {
      const prefixKey = storagePrefix
        ? `${objectKey(safeUserId, storagePrefix.slice(0, -1))}/`
        : `${safeUserId}/`;
      return collectObjects(options.client.listObjectsV2(options.bucket, prefixKey, true));
    }));
    const selectedObjects = new Map<string, { name: string; path: string; canonicalSource: boolean }>();
    const seenObjectNames = new Set<string>();
    for (const object of objectGroups.flat()) {
      if (!object.name || object.name.endsWith("/") || seenObjectNames.has(object.name)) continue;
      seenObjectNames.add(object.name);
      const storagePath = object.name.slice(`${safeUserId}/`.length);
      const canonicalPath = canonicalDocumentPath(storagePath);
      if (canonicalPrefix && !canonicalPath.startsWith(canonicalPrefix)) continue;
      const canonicalSource = storagePath === canonicalPath;
      const existing = selectedObjects.get(canonicalPath);
      if (existing?.canonicalSource || (existing && !canonicalSource)) continue;
      selectedObjects.set(canonicalPath, { name: object.name, path: canonicalPath, canonicalSource });
    }
    return [...selectedObjects.values()]
      .map(({ name, path }) => ({ name, path }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  };
  const listMetadata = async (userId: string, prefix?: string): Promise<UserDocumentMetadata[]> => {
    const safeUserId = assertUserId(userId);
    return Promise.all((await logicalObjects(safeUserId, prefix)).map(async (object): Promise<UserDocumentMetadata> => {
      const stat = await options.client.statObject(options.bucket, object.name);
      return attachDocumentReadReference({
        userId: safeUserId,
        path: object.path,
        version: versionOf(stat),
        updatedAt: stat.lastModified.toISOString(),
        size: stat.size,
      }, object.name.slice(`${safeUserId}/`.length));
    }));
  };
  return {
    async get(userId, path, metadata) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      if (metadata) {
        const reference = documentReadReference(metadata);
        if (!reference || reference.userId !== safeUserId || reference.logicalPath !== canonicalPath) return null;
        const pinned = await getExact(safeUserId, reference.storagePath, metadata);
        return pinned ? { ...pinned, path: canonicalPath } : null;
      }
      const canonical = await getExact(safeUserId, canonicalPath);
      if (canonical) return canonical;
      const legacyPath = legacyDocumentPath(canonicalPath);
      const legacy = legacyPath ? await getExact(safeUserId, legacyPath) : null;
      return legacy ? { ...legacy, path: canonicalPath } : null;
    },
    async head(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const canonical = await headExact(safeUserId, canonicalPath);
      if (canonical) return canonical;
      const legacyPath = legacyDocumentPath(canonicalPath);
      const legacy = legacyPath ? await headExact(safeUserId, legacyPath) : null;
      return legacy ? attachDocumentReadReference({ ...legacy, path: canonicalPath }, legacyPath!) : null;
    },
    getExact,
    listExact,
    async put(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      return writeCanonical(safeUserId, canonicalPath, content);
    },
    async putIfAbsent(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const canonical = await getExact(safeUserId, canonicalPath);
      if (canonical) return canonical;
      const legacyPath = legacyDocumentPath(canonicalPath);
      const legacy = legacyPath ? await getExact(safeUserId, legacyPath) : null;
      if (legacy) return { ...legacy, path: canonicalPath };
      try {
        const result = await options.client.putObject(options.bucket, objectKey(safeUserId, canonicalPath), Buffer.from(content, "utf8"), Buffer.byteLength(content), {
          "Content-Type": "text/markdown; charset=utf-8",
          "If-None-Match": "*",
        });
        return { userId: safeUserId, path: canonicalPath, content, version: result.versionId ?? result.etag, updatedAt: now() };
      } catch (error) {
        // A losing conditional PUT may be reported either as an S3
        // precondition error or as a dropped connection by older gateways.
        // Reconcile from storage before deciding that the create failed.
        const concurrent = await readAfterFailedCreate(safeUserId, canonicalPath);
        if (concurrent) return concurrent;
        throw error;
      }
    },
    async putIfVersion(userId, path, expectedVersion, content): Promise<DocumentUpdateResult> {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const current = await readLogical(safeUserId, canonicalPath);
      if (!current) return { outcome: "not_found" };
      if (current.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(current, canonicalPath) };
      return { outcome: "updated", document: await writeCanonical(safeUserId, canonicalPath, content) };
    },
    async moveIfVersion(userId, sourcePath, destinationPath, expectedVersion): Promise<DocumentMoveResult> {
      const safeUserId = assertUserId(userId);
      const canonicalSource = canonicalDocumentPath(sourcePath);
      const canonicalDestination = canonicalDocumentPath(destinationPath);
      const source = await readLogical(safeUserId, canonicalSource);
      if (!source) return { outcome: "not_found" };
      if (source.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(source, canonicalSource) };
      const destination = await readLogical(safeUserId, canonicalDestination);
      if (destination) return { outcome: "destination_conflict", current: metadataOf(destination, canonicalDestination) };
      const moved = await writeCanonical(safeUserId, canonicalDestination, source.content);
      await Promise.all([canonicalSource, legacyDocumentPath(canonicalSource)]
        .filter((item): item is string => item !== null)
        .map((documentPath) => options.client.removeObject(options.bucket, objectKey(safeUserId, documentPath))));
      return { outcome: "moved", document: moved, sourceVersion: source.version };
    },
    async deleteIfVersion(userId, path, expectedVersion): Promise<DocumentDeleteResult> {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const current = await readLogical(safeUserId, canonicalPath);
      if (!current) return { outcome: "not_found" };
      if (current.version !== expectedVersion) return { outcome: "conflict", current: metadataOf(current, canonicalPath) };
      await Promise.all([canonicalPath, legacyDocumentPath(canonicalPath)]
        .filter((item): item is string => item !== null)
        .map((documentPath) => options.client.removeObject(options.bucket, objectKey(safeUserId, documentPath))));
      return { outcome: "deleted", path: canonicalPath, version: current.version };
    },
    async restoreVersion(userId, path, requestedVersion) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      for (const storagePath of [canonicalPath, legacyDocumentPath(canonicalPath)].filter((item): item is string => item !== null)) {
        const historical = await getExact(safeUserId, storagePath, attachDocumentReadReference({
          userId: safeUserId,
          path: canonicalPath,
          version: requestedVersion,
          updatedAt: now(),
          size: 0,
        }, storagePath));
        if (historical) return writeCanonical(safeUserId, canonicalPath, historical.content);
      }
      return null;
    },
    listMetadata,
    async *iterate(userId, prefix) {
      const safeUserId = assertUserId(userId);
      for (const object of await logicalObjects(safeUserId, prefix)) {
        const [stat, stream] = await Promise.all([
          options.client.statObject(options.bucket, object.name),
          options.client.getObject(options.bucket, object.name),
        ]);
        yield {
          userId: safeUserId,
          path: object.path,
          content: await readUtf8(stream),
          version: versionOf(stat),
          updatedAt: stat.lastModified.toISOString(),
        };
      }
    },
    async list(userId, prefix) {
      const documents: UserDocument[] = [];
      for await (const document of this.iterate(userId, prefix)) documents.push(document);
      return documents;
    },
    async delete(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const paths = [canonicalPath];
      const legacyPath = legacyDocumentPath(canonicalPath);
      if (legacyPath) paths.push(legacyPath);
      await Promise.all(paths.map((documentPath) => options.client.removeObject(options.bucket, objectKey(safeUserId, documentPath))));
    },
  };
}

function readUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function collectObjects(stream: NodeJS.ReadableStream): Promise<Minio.BucketItem[]> {
  return new Promise((resolve, reject) => {
    const objects: Minio.BucketItem[] = [];
    stream.on("data", (object: Minio.BucketItem) => objects.push(object));
    stream.once("error", reject);
    stream.once("end", () => resolve(objects));
  });
}

function versionOf(stat: Minio.BucketItemStat): string {
  return stat.versionId ?? stat.etag;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isNotFound(error: unknown): boolean {
  // MinIO returns `NotFound` for a missing object on HEAD/statObject, while
  // S3-compatible providers may use the more specific NoSuch* codes.
  const code = errorCode(error);
  return code === "NotFound" || code === "NoSuchKey" || code === "NoSuchObject" || code === "NoSuchVersion";
}
