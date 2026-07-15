import type { BlobStore, StoredBlob } from "./blob-store.js";
import { assertSafeBlobKey } from "./blob-store.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertSafeVaultPath, assertUserId } from "./document-store.js";

/**
 * The only application write boundary for personal-vault content. Classification
 * into ideas/tasks/expenses deliberately belongs to Phase B.
 */
export type IngestionService = {
  saveContextDocument(input: { userId: string; path: string; content: string }): Promise<UserDocument>;
  uploadInboxBlob(input: { userId: string; key: string; body: Buffer; contentType: string }): Promise<StoredBlob>;
};

export function createIngestionService(deps: { documentStore: DocumentStore; blobStore: BlobStore }): IngestionService {
  return {
    async saveContextDocument(input) {
      const userId = assertUserId(input.userId);
      const path = assertSafeVaultPath(input.path, "context/");
      if (!input.content.trim()) throw new Error("context document content is required");
      return deps.documentStore.put(userId, path, input.content);
    },
    async uploadInboxBlob(input) {
      const userId = assertUserId(input.userId);
      const key = assertSafeBlobKey(input.key);
      if (!key.startsWith("inbox/")) throw new Error("inbox blob key must start with inbox/");
      return deps.blobStore.put(userId, key, input.body, input.contentType);
    },
  };
}
