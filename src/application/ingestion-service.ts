import { createHash } from "node:crypto";
import type { BlobStore, StoredBlob } from "./blob-store.js";
import { assertSafeBlobKey } from "./blob-store.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertSafeVaultPath, assertUserId } from "./document-store.js";
import { NO_PROJECT, type RecordType } from "../domain/classification.js";
import type { Idea, IdeaSource, IdeaStore } from "./idea-store.js";

/**
 * The only application write boundary for personal-vault content. Classification
 * into ideas/tasks/expenses deliberately belongs to Phase B.
 */
export type CaptureIdeaInput = {
  id: string;
  userId: string;
  project: string;
  type: RecordType;
  summary: string;
  suggestedNextStep: string;
  needsProjectClarification: boolean;
  source?: IdeaSource;
};

export type CaptureIdeaResult = {
  idea: Idea;
  response: string;
  needsProjectClarification: boolean;
};

export type IngestionService = {
  saveContextDocument(input: { userId: string; path: string; content: string }): Promise<UserDocument>;
  uploadInboxBlob(input: { userId: string; key: string; body: Buffer; contentType: string }): Promise<StoredBlob>;
  captureIdea(input: CaptureIdeaInput): Promise<CaptureIdeaResult>;
  captureInboxFile(input: { userId: string; fileName: string; body: Buffer; contentType: string }): Promise<StoredBlob>;
};

export function createIngestionService(deps: { documentStore: DocumentStore; blobStore: BlobStore; ideaStore?: IdeaStore }): IngestionService {
  const uploadInboxBlob: IngestionService["uploadInboxBlob"] = async (input) => {
    const userId = assertUserId(input.userId);
    const key = assertSafeBlobKey(input.key);
    if (!key.startsWith("inbox/")) throw new Error("inbox blob key must start with inbox/");
    return deps.blobStore.put(userId, key, input.body, input.contentType);
  };
  return {
    async saveContextDocument(input) {
      const userId = assertUserId(input.userId);
      const path = assertSafeVaultPath(input.path, "context/");
      if (!input.content.trim()) throw new Error("context document content is required");
      return deps.documentStore.put(userId, path, input.content);
    },
    uploadInboxBlob,
    async captureInboxFile(input) {
      const fileName = input.fileName.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "upload";
      const digest = createHash("sha256").update(input.body).digest("hex").slice(0, 16);
      return uploadInboxBlob({
        userId: input.userId,
        key: `inbox/${digest}-${fileName}`,
        body: input.body,
        contentType: input.contentType,
      });
    },
    async captureIdea(input) {
      const userId = assertUserId(input.userId);
      const summary = input.summary.trim();
      const suggestedNextStep = input.suggestedNextStep.trim();
      if (!summary) throw new Error("idea summary is required");
      if (!suggestedNextStep) throw new Error("suggested next step is required");
      const requestedProject = input.project.trim();
      const needsProjectClarification = input.needsProjectClarification || !requestedProject || requestedProject === NO_PROJECT;
      const project = needsProjectClarification ? NO_PROJECT : requestedProject;
      const ideaStore = deps.ideaStore;
      if (!ideaStore) throw new Error("ideaStore is required for idea capture");
      const idea = await ideaStore.add({
        id: input.id,
        userId,
        project,
        type: input.type,
        summary,
        source: input.source,
        status: "raw",
      });
      const nextStep = suggestedNextStep.replace(/[.!?…]+$/u, "");
      const response = needsProjectClarification
        ? `Сохранил идею: ${summary}. К какому проекту её отнести? Следующий шаг: ${nextStep}.`
        : `Сохранил идею: ${summary}. Следующий шаг: ${nextStep}.`;
      return { idea, response, needsProjectClarification };
    },
  };
}
