import * as Minio from "minio";
import { assertSafeVaultPath, objectKey, type DocumentStore, type UserDocument } from "../../application/document-store.js";

export type MinioDocumentStoreOptions = {
  client: Minio.Client;
  bucket: string;
  now?: () => string;
};

/** MinIO adapter. Object keys are always derived from trusted `(userId, path)`. */
export function createMinioDocumentStore(options: MinioDocumentStoreOptions): DocumentStore {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async get(userId, path) {
      const safePath = assertSafeVaultPath(path);
      try {
        const stat = await options.client.statObject(options.bucket, objectKey(userId, safePath));
        const stream = await options.client.getObject(options.bucket, objectKey(userId, safePath));
        const content = await readUtf8(stream);
        return { userId, path: safePath, content, version: versionOf(stat), updatedAt: stat.lastModified.toISOString() };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async put(userId, path, content) {
      const safePath = assertSafeVaultPath(path);
      const result = await options.client.putObject(options.bucket, objectKey(userId, safePath), Buffer.from(content, "utf8"), Buffer.byteLength(content), {
        "Content-Type": "text/markdown; charset=utf-8",
      });
      return { userId, path: safePath, content, version: result.versionId ?? result.etag, updatedAt: now() };
    },
    async list(userId, prefix) {
      const safePrefix = prefix === undefined ? "" : `${assertSafeVaultPath(prefix.replace(/\/+$/, ""))}/`;
      const prefixKey = safePrefix ? `${objectKey(userId, safePrefix.slice(0, -1))}/` : `${userId}/`;
      const objects = await collectObjects(options.client.listObjectsV2(options.bucket, prefixKey, true));
      const documents: UserDocument[] = [];
      for (const object of objects) {
        if (!object.name || object.name.endsWith("/")) continue;
        const path = object.name.slice(`${userId}/`.length);
        const document = await this.get(userId, path);
        if (document) documents.push(document);
      }
      return documents.sort((left, right) => left.path.localeCompare(right.path));
    },
    async delete(userId, path) {
      await options.client.removeObject(options.bucket, objectKey(userId, path));
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
  return typeof error === "object" && error !== null && "code" in error && (error.code === "NoSuchKey" || error.code === "NoSuchObject");
}
