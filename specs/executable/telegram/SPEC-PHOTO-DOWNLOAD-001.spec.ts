import { describe, expect, it } from "vitest";
import {
  downloadBoundedTelegramPhoto,
  PhotoDownloadTimeoutError,
  PhotoFileTooLargeError,
  UnsupportedPhotoContentTypeError,
} from "../../../src/telegram/telegram-photo-file-gateway.js";

describe("SPEC-PHOTO-DOWNLOAD-001: bounded Telegram photo download", () => {
  it("accepts a bounded JPEG and rejects oversized or unsupported payloads", async () => {
    const fetchPhoto: typeof fetch = async () => new Response(Buffer.from("photo"), { headers: { "content-type": "image/jpeg", "content-length": "5" } });
    await expect(downloadBoundedTelegramPhoto({ url: "https://example.test/photo", fileId: "file", fetch: fetchPhoto, maximumBytes: 5 })).resolves.toMatchObject({
      body: Buffer.from("photo"), contentType: "image/jpeg", fileName: "telegram-file.jpg",
    });

    const oversized: typeof fetch = async () => new Response(Buffer.from("123456"), { headers: { "content-type": "image/jpeg" } });
    await expect(downloadBoundedTelegramPhoto({ url: "https://example.test/photo", fileId: "file", fetch: oversized, maximumBytes: 5 })).rejects.toBeInstanceOf(PhotoFileTooLargeError);

    const unsupported: typeof fetch = async () => new Response(Buffer.from("gif"), { headers: { "content-type": "image/gif" } });
    await expect(downloadBoundedTelegramPhoto({ url: "https://example.test/photo", fileId: "file", fetch: unsupported })).rejects.toBeInstanceOf(UnsupportedPhotoContentTypeError);
  });

  it("aborts a stalled download at the configured deadline", async () => {
    const stalled: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    await expect(downloadBoundedTelegramPhoto({ url: "https://example.test/photo", fileId: "file", fetch: stalled, timeoutMs: 5 })).rejects.toBeInstanceOf(PhotoDownloadTimeoutError);
  });
});
