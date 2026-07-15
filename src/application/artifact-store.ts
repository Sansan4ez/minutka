import type { Readable } from "node:stream";
import { assertUserId } from "./document-store.js";

export type ArtifactReferenceStatus = "active" | "deleted";

export type TelegramArtifactPayloadKind =
  | "document"
  | "photo"
  | "video"
  | "audio"
  | "animation"
  | "sticker"
  | "voice"
  | "video_note";

/**
 * Provenance is persisted without download URLs or transport credentials.
 * `deliveryKey` is opaque and unique only inside the owner scope.
 */
export type ArtifactSource =
  | {
      kind: "telegram";
      deliveryKey: string;
      chatId: string;
      messageId: number;
      payloadKind: TelegramArtifactPayloadKind;
      forwarded: boolean;
      fileId?: string;
      fileUniqueId?: string;
      mediaGroupId?: string;
    }
  | { kind: "http_upload"; deliveryKey: string }
  | { kind: "generated"; deliveryKey: string; generatorId: string }
  | { kind: "legacy_blob"; deliveryKey: string; blobKey: string };

/** A logical owner-visible reference to immutable content. */
export type ArtifactReference = {
  ownerId: string;
  artifactId: string;
  /** Canonical lowercase, full SHA-256 hex digest. */
  contentDigest: string;
  originalFileName: string;
  declaredMediaType?: string;
  detectedMediaType?: string;
  size: number;
  source: ArtifactSource;
  caption?: string;
  status: ArtifactReferenceStatus;
  createdAt: string;
  deletedAt?: string;
};

export type ArtifactBody = {
  /** Known transport size enables rejection before the first byte is read. */
  size?: number;
  /** Must return a fresh stream; save may read once for hashing and once for upload. */
  openStream(): Readable;
};

export type SaveArtifactInput = {
  ownerId: string;
  artifactId: string;
  originalFileName: string;
  declaredMediaType?: string;
  detectedMediaType?: string;
  source: ArtifactSource;
  caption?: string;
  /** Transient input. Implementations must not persist it in PostgreSQL or audit. */
  body: ArtifactBody;
  signal?: AbortSignal;
};

export type SaveArtifactResult = {
  artifact: ArtifactReference;
  deliveryDisposition: "created" | "duplicate_delivery";
  contentDisposition: "stored" | "reused";
};

export type ArtifactListOptions = {
  status?: ArtifactReferenceStatus;
  limit?: number;
};

/**
 * Durable save boundary. It owns content hashing, owner-scoped CAS storage,
 * delivery idempotency, and the logical reference index. It never invokes an
 * LLM or an artifact processor.
 */
export interface ArtifactStore {
  save(input: SaveArtifactInput): Promise<SaveArtifactResult>;
  get(ownerId: string, artifactId: string): Promise<ArtifactReference | null>;
  list(ownerId: string, options?: ArtifactListOptions): Promise<ArtifactReference[]>;
  /** Logical deletion; physical CAS cleanup is asynchronous and implementation-owned. */
  delete(ownerId: string, artifactId: string): Promise<ArtifactReference | null>;
}

export type ArtifactProcessingStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ArtifactProcessingJob = {
  ownerId: string;
  artifactId: string;
  jobId: string;
  processorId: string;
  status: ArtifactProcessingStatus;
  createdAt: string;
  updatedAt: string;
};

/** Optional asynchronous boundary, deliberately separate from ArtifactStore.save. */
export interface ArtifactProcessingQueue {
  enqueue(input: { ownerId: string; artifactId: string; processorId: string }): Promise<ArtifactProcessingJob>;
}

export function assertArtifactId(artifactId: string): string {
  return assertOpaqueIdentifier(artifactId, "artifactId");
}

export function assertContentDigest(contentDigest: string): string {
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error("contentDigest must be a lowercase full SHA-256 hex digest");
  return contentDigest;
}

export function assertArtifactFileName(originalFileName: string): string {
  const normalized = originalFileName.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("invalid originalFileName");
  return normalized;
}

export function assertArtifactMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized.length > 255 || /[\u0000-\u001f\u007f]/.test(normalized)
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[^;]+(?:;\s*[^;]+)*)?$/.test(normalized)) {
    throw new Error("invalid media type");
  }
  return normalized;
}

export function assertArtifactSource(source: ArtifactSource): ArtifactSource {
  assertDeliveryKey(source.deliveryKey);
  switch (source.kind) {
    case "telegram":
      assertExactKeys(source, ["kind", "deliveryKey", "chatId", "messageId", "payloadKind", "forwarded", "fileId", "fileUniqueId", "mediaGroupId"]);
      assertOpaqueIdentifier(source.chatId, "chatId");
      if (!Number.isSafeInteger(source.messageId) || source.messageId <= 0) throw new Error("invalid Telegram messageId");
      if (!TELEGRAM_PAYLOAD_KINDS.has(source.payloadKind)) throw new Error("invalid Telegram payloadKind");
      if (typeof source.forwarded !== "boolean") throw new Error("invalid Telegram forwarded flag");
      if (source.fileId !== undefined) assertOpaqueIdentifier(source.fileId, "fileId");
      if (source.fileUniqueId !== undefined) assertOpaqueIdentifier(source.fileUniqueId, "fileUniqueId");
      if (source.mediaGroupId !== undefined) assertOpaqueIdentifier(source.mediaGroupId, "mediaGroupId");
      return source;
    case "http_upload":
      assertExactKeys(source, ["kind", "deliveryKey"]);
      return source;
    case "generated":
      assertExactKeys(source, ["kind", "deliveryKey", "generatorId"]);
      assertOpaqueIdentifier(source.generatorId, "generatorId");
      return source;
    case "legacy_blob":
      assertExactKeys(source, ["kind", "deliveryKey", "blobKey"]);
      assertOpaqueIdentifier(source.blobKey, "blobKey");
      return source;
    default:
      throw new Error("unsupported artifact source kind");
  }
}

export function validateSaveArtifactInput(input: SaveArtifactInput): SaveArtifactInput {
  assertUserId(input.ownerId);
  assertArtifactId(input.artifactId);
  assertArtifactFileName(input.originalFileName);
  if (input.declaredMediaType !== undefined) assertArtifactMediaType(input.declaredMediaType);
  if (input.detectedMediaType !== undefined) assertArtifactMediaType(input.detectedMediaType);
  assertArtifactSource(input.source);
  if (input.caption !== undefined && /[\u0000]/.test(input.caption)) throw new Error("invalid artifact caption");
  if (!input.body || typeof input.body.openStream !== "function") throw new Error("artifact body must provide openStream");
  if (input.body.size !== undefined && (!Number.isSafeInteger(input.body.size) || input.body.size < 0)) {
    throw new Error("artifact body size must be a non-negative safe integer");
  }
  return input;
}

const TELEGRAM_PAYLOAD_KINDS = new Set<TelegramArtifactPayloadKind>([
  "document", "photo", "video", "audio", "animation", "sticker", "voice", "video_note",
]);

function assertDeliveryKey(deliveryKey: string): string {
  const normalized = deliveryKey.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("invalid deliveryKey");
  return normalized;
}

function assertOpaqueIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid ${field}`);
  return normalized;
}

function assertExactKeys(value: object, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("artifact source contains unsupported metadata");
}
