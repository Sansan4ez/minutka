export const maxPhotoFileSizeBytes = 10 * 1024 * 1024;
export const photoDownloadTimeoutMs = 30_000;

export class PhotoFileTooLargeError extends Error {}
export class PhotoDownloadTimeoutError extends Error {}
export class UnsupportedPhotoContentTypeError extends Error {}

export type TelegramPhotoFile = {
  body: Buffer;
  contentType: string;
  fileName: string;
};

/** Downloads a bounded Telegram photo without exposing its URL outside the transport adapter. */
export interface TelegramPhotoFileGateway {
  downloadPhoto(fileId: string): Promise<TelegramPhotoFile>;
}

export async function downloadBoundedTelegramPhoto(input: {
  url: URL | string;
  fileId: string;
  fetch?: typeof globalThis.fetch;
  maximumBytes?: number;
  timeoutMs?: number;
}): Promise<TelegramPhotoFile> {
  const fetchPhoto = input.fetch ?? globalThis.fetch;
  const maximumBytes = input.maximumBytes ?? maxPhotoFileSizeBytes;
  const timeoutMs = input.timeoutMs ?? photoDownloadTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchPhoto(input.url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Photo file download failed (${response.status})`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      void response.body.cancel().catch(() => undefined);
      throw new PhotoFileTooLargeError();
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "image/jpeg";
    if (contentType !== "image/jpeg" && contentType !== "image/png") {
      void response.body.cancel().catch(() => undefined);
      throw new UnsupportedPhotoContentTypeError();
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumBytes) throw new PhotoFileTooLargeError();
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    return { body: Buffer.concat(chunks, bytes), contentType, fileName: `telegram-${input.fileId}.${contentType === "image/png" ? "png" : "jpg"}` };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof PhotoFileTooLargeError)) throw new PhotoDownloadTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
