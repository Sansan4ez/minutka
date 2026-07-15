import { pipeline, PassThrough, Readable } from "node:stream";
import type { ArtifactBody } from "../application/artifact-store.js";

export interface TelegramFileGateway {
  /** Creates a lazy body. Network I/O starts only if persistence opens the stream. */
  createFileBody(input: { fileId: string; fileSizeBytes?: number; signal?: AbortSignal }): ArtifactBody;
}

export function createTelegramFileGateway(input: {
  getFileLink(fileId: string): Promise<URL | string>;
  fetch?: typeof globalThis.fetch;
}): TelegramFileGateway {
  const fetchFile = input.fetch ?? globalThis.fetch;
  return {
    createFileBody(file) {
      return {
        ...(file.fileSizeBytes === undefined ? {} : { size: file.fileSizeBytes }),
        openStream() {
          const output = new PassThrough();
          const controller = new AbortController();
          const abortFromCaller = () => controller.abort(file.signal?.reason);
          file.signal?.addEventListener("abort", abortFromCaller, { once: true });
          let source: Readable | undefined;
          const closeSource = () => { controller.abort(); source?.destroy(); };
          output.once("close", closeSource);
          void (async () => {
            const url = await input.getFileLink(file.fileId);
            const response = await fetchFile(url, { signal: controller.signal });
            if (!response.ok || !response.body) {
              void response.body?.cancel().catch(() => undefined);
              throw new Error(`Telegram file download failed (${response.status})`);
            }
            source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
            pipeline(source, output, (error) => {
              output.removeListener("close", closeSource);
              file.signal?.removeEventListener("abort", abortFromCaller);
              if (error && !output.destroyed) output.destroy(error);
            });
          })().catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error("Telegram file download failed")));
          return output;
        },
      };
    },
  };
}
