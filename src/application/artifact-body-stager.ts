import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { ArtifactBody } from "./artifact-store.js";

export type ArtifactSaveLimits = {
  maximumBytes: number;
  timeoutMs: number;
  temporaryDirectory?: string;
};

export class ArtifactTooLargeError extends Error {}
export class ArtifactSaveTimeoutError extends Error {}

export type ArtifactSaveDeadline = {
  signal: AbortSignal;
  cleanup(): void;
};

export type StagedArtifactBody = {
  contentDigest: string;
  size: number;
  openStream(): ReturnType<typeof createReadStream>;
  cleanup(): Promise<void>;
};

export function createArtifactSaveDeadline(timeoutMs: number, signal?: AbortSignal): ArtifactSaveDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ArtifactSaveTimeoutError()), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

export async function stageArtifactBody(body: ArtifactBody, limits: ArtifactSaveLimits, signal?: AbortSignal): Promise<StagedArtifactBody> {
  validateLimits(limits);
  if (body.size !== undefined && body.size > limits.maximumBytes) throw new ArtifactTooLargeError();
  const directory = limits.temporaryDirectory ?? join(tmpdir(), "personal-assistant-artifacts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${process.pid}-${randomUUID()}.part`);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new ArtifactSaveTimeoutError()), limits.timeoutMs);
  timer.unref();
  const source = body.openStream();
  const destination = createWriteStream(path, { flags: "wx" });
  const abort = () => {
    source.destroy(abortReason(controller.signal));
    // The source error wakes the async iterator. Destroy the staging writer
    // without an error so EventEmitter does not surface a second uncaught error.
    destination.destroy();
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of source) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > limits.maximumBytes) throw new ArtifactTooLargeError();
      hash.update(bytes);
      if (!destination.write(bytes)) await once(destination, "drain");
    }
    if (body.size !== undefined && size !== body.size) throw new Error("artifact_body_size_mismatch");
    destination.end();
    await once(destination, "close");
    const contentDigest = hash.digest("hex");
    return {
      contentDigest,
      size,
      openStream: () => createReadStream(path),
      cleanup: () => rm(path, { force: true }),
    };
  } catch (error) {
    source.destroy();
    destination.destroy();
    await rm(path, { force: true }).catch(() => undefined);
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", abort);
  }
}

function validateLimits(limits: ArtifactSaveLimits): void {
  if (!Number.isSafeInteger(limits.maximumBytes) || limits.maximumBytes <= 0) throw new Error("maximumBytes must be a positive safe integer");
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) throw new Error("timeoutMs must be a positive safe integer");
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof ArtifactSaveTimeoutError) return signal.reason;
  const error = signal.reason instanceof Error ? signal.reason : new Error("artifact_save_aborted");
  error.name = "AbortError";
  return error;
}
