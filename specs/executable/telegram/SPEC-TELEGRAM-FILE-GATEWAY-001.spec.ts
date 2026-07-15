import { describe, expect, it } from "vitest";
import { createTelegramFileGateway } from "../../../src/telegram/telegram-file-gateway.js";

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("SPEC-TELEGRAM-FILE-GATEWAY-001: lazy Telegram file transport", () => {
  it("does not resolve or expose the Telegram URL until persistence opens the body", async () => {
    const calls: string[] = [];
    const gateway = createTelegramFileGateway({
      async getFileLink(fileId) { calls.push(`link:${fileId}`); return "https://telegram.test/private-file"; },
      fetch: async (url) => { calls.push(`fetch:${url}`); return new Response(Buffer.from("file")); },
    });
    const body = gateway.createFileBody({ fileId: "file-1", fileSizeBytes: 4 });
    expect(body.size).toBe(4);
    expect(calls).toEqual([]);
    await expect(read(body.openStream())).resolves.toEqual(Buffer.from("file"));
    expect(calls).toEqual(["link:file-1", "fetch:https://telegram.test/private-file"]);
  });

  it("aborts the network request when persistence destroys the stream", async () => {
    let aborted = false;
    const gateway = createTelegramFileGateway({
      async getFileLink() { return "https://telegram.test/stalled"; },
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
      }),
    });
    const stream = gateway.createFileBody({ fileId: "stalled" }).openStream();
    stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
  });

  it("surfaces transport failures through the body stream", async () => {
    const gateway = createTelegramFileGateway({
      async getFileLink() { return "https://telegram.test/missing"; },
      fetch: async () => new Response(null, { status: 404 }),
    });
    await expect(read(gateway.createFileBody({ fileId: "missing" }).openStream())).rejects.toThrow("Telegram file download failed (404)");
  });
});
