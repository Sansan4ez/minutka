import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMinioBlobStore } from "../../src/infrastructure/minio/minio-blob-store.js";
import { loadDotEnv } from "../../src/config/env.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../../src/infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../../src/infrastructure/minio/minio-document-store.js";

// Unlike the runtime entry point, Vitest does not load local configuration.
// Preserve shell-provided values while making `MINIO_SMOKE=true npm run …`
// use the project's ignored .env file as documented.
loadDotEnv();

const smokeEnabled = process.env.MINIO_SMOKE === "true";
const describeMinio = smokeEnabled ? describe : describe.skip;

/**
 * Opt-in contract smoke test against a real MinIO deployment. Run it with
 * `MINIO_SMOKE=true npm run specs:minio`; it never runs in hermetic specs.
 */
describeMinio("MinIO personal-vault contracts", () => {
  let config: ReturnType<typeof minioConfigFromEnv>;
  let client: ReturnType<typeof createMinioClient>;
  let documents: ReturnType<typeof createMinioDocumentStore>;
  let blobs: ReturnType<typeof createMinioBlobStore>;
  let setupComplete = false;
  const suffix = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = `owner-${suffix}`;
  const otherOwner = `other-${suffix}`;

  beforeAll(async () => {
    config = minioConfigFromEnv(process.env);
    client = createMinioClient(config);
    documents = createMinioDocumentStore({ client, bucket: config.bucket });
    blobs = createMinioBlobStore({ client, bucket: config.bucket });
    await prepareMinioBucket(client, config.bucket);
    setupComplete = true;
  });

  afterAll(async () => {
    // Do not mask a configuration or connection failure in beforeAll with a
    // second exception from cleanup against an uninitialised client.
    if (!setupComplete) return;
    const objects = await collectObjectNames(client.listObjectsV2(config.bucket, `${owner}/`, true));
    const otherObjects = await collectObjectNames(client.listObjectsV2(config.bucket, `${otherOwner}/`, true));
    await Promise.all([...objects, ...otherObjects].map((object) => client.removeObject(config.bucket, object, { forceDelete: true })));
  });

  it("isolates owner-scoped documents, returns content, and exposes a versioned bucket", async () => {
    const first = await documents.put(owner, "context/01_profile.md", "first");
    const second = await documents.put(owner, "context/01_profile.md", "second");
    await documents.put(otherOwner, "context/private.md", "other owner's document");

    expect(first.version).toBeTruthy();
    expect(second.version).toBeTruthy();
    expect(await documents.get(owner, "context/01_profile.md")).toMatchObject({ content: "second" });
    expect((await documents.list(owner, "context/")).map((document) => document.path)).toEqual(["context/01_profile.md"]);
    expect((await documents.list(otherOwner, "context/")).map((document) => document.path)).toEqual(["context/private.md"]);
    expect((await client.getBucketVersioning(config.bucket)).Status).toBe("Enabled");
  });

  it("returns null for missing documents and validates blob presigning against stored objects", async () => {
    expect(await documents.get(owner, "context/missing.md")).toBeNull();
    await blobs.put(owner, "inbox/note.txt", Buffer.from("private blob"), "text/plain");
    await blobs.put(otherOwner, "inbox/private.txt", Buffer.from("other owner's blob"), "text/plain");

    await expect(blobs.presignGet(owner, "inbox/missing.txt", 60)).rejects.toThrow("blob_not_found");
    await expect(blobs.presignGet(owner, "inbox/note.txt", 60)).resolves.toMatch(/^https?:\/\//);
    expect(await blobs.get(owner, "inbox/note.txt")).toMatchObject({ body: Buffer.from("private blob") });
    await expect(blobs.get(owner, "inbox/missing.txt")).resolves.toBeNull();
    expect((await blobs.list(owner, "inbox/")).map((blob) => blob.key)).toEqual(["inbox/note.txt"]);
  });
});

function collectObjectNames(stream: NodeJS.ReadableStream): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    stream.on("data", (object: { name?: string }) => { if (object.name) names.push(object.name); });
    stream.once("error", reject);
    stream.once("end", () => resolve(names));
  });
}
