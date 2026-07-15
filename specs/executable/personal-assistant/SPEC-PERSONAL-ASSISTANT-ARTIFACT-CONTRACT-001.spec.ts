import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  assertArtifactMediaType,
  assertArtifactSource,
  assertContentDigest,
  validateSaveArtifactInput,
  type ArtifactReference,
} from "../../../src/application/artifact-store.js";

describe("SPEC-PERSONAL-ASSISTANT-ARTIFACT-CONTRACT-001: durable artifact contract", () => {
  it("accepts owner-scoped typed Telegram provenance without persisting binary content", () => {
    const input = validateSaveArtifactInput({
      ownerId: "owner-1",
      artifactId: "artifact-1",
      originalFileName: "proposal.pdf",
      declaredMediaType: "application/pdf",
      source: {
        kind: "telegram",
        deliveryKey: "telegram:42:100:document:file-unique-1",
        chatId: "42",
        messageId: 100,
        payloadKind: "document",
        forwarded: true,
        fileId: "file-1",
        fileUniqueId: "file-unique-1",
      },
      caption: "Клиентское КП",
      body: { size: 3, openStream: () => Readable.from("pdf") },
    });

    const reference: ArtifactReference = {
      ownerId: input.ownerId,
      artifactId: input.artifactId,
      contentDigest: "a".repeat(64),
      originalFileName: input.originalFileName,
      declaredMediaType: input.declaredMediaType,
      size: input.body.size!,
      source: input.source,
      caption: input.caption,
      status: "active",
      createdAt: "2026-07-15T00:00:00.000Z",
    };

    expect(reference).not.toHaveProperty("body");
    expect(reference.source).not.toHaveProperty("downloadUrl");
  });

  it("requires the full canonical SHA-256 digest", () => {
    expect(assertContentDigest("a".repeat(64))).toBe("a".repeat(64));
    expect(() => assertContentDigest("a".repeat(16))).toThrow("full SHA-256");
    expect(() => assertContentDigest("A".repeat(64))).toThrow("full SHA-256");
  });

  it("rejects secret or arbitrary transport metadata", () => {
    expect(() => assertArtifactSource({
      kind: "telegram",
      deliveryKey: "telegram:42:100:photo:file-1",
      chatId: "42",
      messageId: 100,
      payloadKind: "photo",
      forwarded: false,
      downloadUrl: "https://api.telegram.org/file/bot-secret/private.jpg",
    } as never)).toThrow("unsupported metadata");
  });

  it("validates Telegram payload kinds and media types at runtime", () => {
    expect(assertArtifactMediaType("Text/Plain; charset=utf-8")).toBe("text/plain; charset=utf-8");
    expect(() => assertArtifactMediaType("text/plain\nsecret: value")).toThrow("invalid media type");
    expect(() => assertArtifactSource({
      kind: "telegram",
      deliveryKey: "delivery-1",
      chatId: "42",
      messageId: 100,
      payloadKind: "archive",
      forwarded: false,
    } as never)).toThrow("payloadKind");
  });
});
