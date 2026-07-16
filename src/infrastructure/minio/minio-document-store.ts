import * as Minio from "minio";
import {
  assertSafeVaultPath,
  assertUserId,
  canonicalDocumentPath,
  legacyDocumentPath,
  objectKey,
  type DocumentStore,
  type UserDocument,
} from "../../application/document-store.js";

export type MinioDocumentStoreOptions = {
  client: Minio.Client;
  bucket: string;
  now?: () => string;
};

/** MinIO adapter. Object keys are always derived from trusted `(userId, path)`. */
export function createMinioDocumentStore(options: MinioDocumentStoreOptions): DocumentStore {
  const now = options.now ?? (() => new Date().toISOString());
  const getExact = async (userId: string, path: string): Promise<UserDocument | null> => {
    const safeUserId = assertUserId(userId);
    const safePath = assertSafeVaultPath(path);
    try {
      const key = objectKey(safeUserId, safePath);
      const stat = await options.client.statObject(options.bucket, key);
      const stream = await options.client.getObject(options.bucket, key);
      const content = await readUtf8(stream);
      return { userId: safeUserId, path: safePath, content, version: versionOf(stat), updatedAt: stat.lastModified.toISOString() };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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
  return {
    async get(userId, path) {
      const safeUserId = assertUserId(userId);
      const canonicalPath = canonicalDocumentPath(path);
      const canonical = await getExact(safeUserId, canonicalPath);
      if (canonical) return canonical;
      const legacyPath = legacyDocumentPath(canonicalPath);
      const legacy = legacyPath ? await getExact(safeUserId, legacyPath) : null;
      return legacy ? { ...legacy, path: canonicalPath } : null;
    },
    getExact,
    listExact,
    async put(userId, path, content) {
      const safeUserId = assertUserId(userId);
      const safePath = assertSafeVaultPath(path);
      const result = await options.client.putObject(options.bucket, objectKey(safeUserId, safePath), Buffer.from(content, "utf8"), Buffer.byteLength(content), {
        "Content-Type": "text/markdown; charset=utf-8",
      });
      return { userId: safeUserId, path: safePath, content, version: result.versionId ?? result.etag, updatedAt: now() };
    },
    async list(userId, prefix) {
      const safeUserId = assertUserId(userId);
      const canonicalPrefix = prefix === undefined ? "" : `${canonicalDocumentPath(prefix.replace(/\/+$/, ""))}/`;
      const storagePrefixes = new Set<string>([canonicalPrefix]);
      const legacyPrefix = canonicalPrefix ? legacyDocumentPath(canonicalPrefix.slice(0, -1)) : null;
      if (legacyPrefix) storagePrefixes.add(`${legacyPrefix}/`);
      const documentGroups = await Promise.all([...storagePrefixes].map((storagePrefix) => listExact(safeUserId, storagePrefix)));
      const selectedDocuments = new Map<string, { document: UserDocument; canonicalSource: boolean }>();
      for (const document of documentGroups.flat()) {
        const canonicalPath = canonicalDocumentPath(document.path);
        if (canonicalPrefix && !canonicalPath.startsWith(canonicalPrefix)) continue;
        const canonicalSource = document.path === canonicalPath;
        const existing = selectedDocuments.get(canonicalPath);
        if (existing?.canonicalSource || (existing && !canonicalSource)) continue;
        selectedDocuments.set(canonicalPath, { document: { ...document, path: canonicalPath }, canonicalSource });
      }
      return [...selectedDocuments.values()]
        .map(({ document }) => document)
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    async delete(userId, path) {
      await options.client.removeObject(options.bucket, objectKey(assertUserId(userId), path));
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

function isNotFound(error: unknown): boolean {
  // MinIO returns `NotFound` for a missing object on HEAD/statObject, while
  // S3-compatible providers may use the more specific NoSuch* codes.
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "NotFound" || error.code === "NoSuchKey" || error.code === "NoSuchObject");
}
