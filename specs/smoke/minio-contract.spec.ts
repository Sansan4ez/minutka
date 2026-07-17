import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerScopedArtifactContentKey } from "../../src/application/artifact-content-store.js";
import { createMinioArtifactContentStore } from "../../src/infrastructure/minio/minio-artifact-content-store.js";
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
  let artifactContents: ReturnType<typeof createMinioArtifactContentStore>;
  let setupComplete = false;
  const suffix = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = `owner-${suffix}`;
  const otherOwner = `other-${suffix}`;

  beforeAll(async () => {
    config = minioConfigFromEnv(process.env);
    client = createMinioClient(config);
    documents = createMinioDocumentStore({ client, bucket: config.bucket });
    blobs = createMinioBlobStore({ client, bucket: config.bucket });
    artifactContents = createMinioArtifactContentStore({ client, bucket: config.bucket });
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

  it("canonicalizes legacy document aliases, prefers canonical copies, and lists without a prefix", async () => {
    const legacyPath = "context/imported-knowledge-base/10_user_memory/01_Persona.md";
    const canonicalPath = "context/10_user_memory/01_Persona.md";
    const legacyOnlyPath = "context/imported-knowledge-base/10_user_memory/02_Goals_and_priorities.md";
    const canonicalLegacyOnlyPath = "context/10_user_memory/02_Goals_and_priorities.md";
    await client.putObject(config.bucket, `${owner}/${legacyPath}`, Buffer.from("legacy persona"));
    await documents.put(owner, canonicalPath, "canonical persona");
    await client.putObject(config.bucket, `${owner}/${legacyOnlyPath}`, Buffer.from("legacy goals"));

    expect(await documents.get(owner, canonicalPath)).toMatchObject({ path: canonicalPath, content: "canonical persona" });
    expect(await documents.get(owner, canonicalLegacyOnlyPath)).toMatchObject({
      path: canonicalLegacyOnlyPath,
      content: "legacy goals",
    });

    const listed = await documents.list(owner);
    expect(listed.filter(({ path }) => path === canonicalPath)).toHaveLength(1);
    expect(listed.find(({ path }) => path === canonicalPath)?.content).toBe("canonical persona");
    expect(listed.find(({ path }) => path === canonicalLegacyOnlyPath)?.content).toBe("legacy goals");
    expect(listed.some(({ path }) => path.startsWith("context/imported-knowledge-base/"))).toBe(false);

    const listedContext = await documents.list(owner, "context/");
    expect(listedContext.map(({ path }) => path)).toContain(canonicalLegacyOnlyPath);
    expect(listedContext.find(({ path }) => path === canonicalPath)?.content).toBe("canonical persona");
  });

  it("canonicalizes logical writes and deletes while preserving legacy owner content on create", async () => {
    const legacyPath = "context/imported-knowledge-base/10_user_memory/03_Preferences.md";
    const canonicalPath = "context/10_user_memory/03_Preferences.md";
    await client.putObject(config.bucket, `${owner}/${legacyPath}`, Buffer.from("legacy owner content"));

    await expect(documents.putIfAbsent(owner, canonicalPath, "scaffold")).resolves.toMatchObject({
      path: canonicalPath,
      content: "legacy owner content",
    });
    await expect(documents.getExact(owner, canonicalPath)).resolves.toBeNull();

    await expect(documents.put(owner, legacyPath, "canonical update")).resolves.toMatchObject({ path: canonicalPath });
    await expect(documents.getExact(owner, canonicalPath)).resolves.toMatchObject({ content: "canonical update" });

    await documents.delete(owner, legacyPath);
    await expect(documents.get(owner, canonicalPath)).resolves.toBeNull();
    await expect(documents.getExact(owner, legacyPath)).resolves.toBeNull();
  });

  it("creates a context document once without overwriting concurrent or repeated onboarding writes", async () => {
    const path = "context/onboarding-once.md";
    const [first, second] = await Promise.all([
      documents.putIfAbsent(owner, path, "first"),
      documents.putIfAbsent(owner, path, "second"),
    ]);
    const stored = await documents.get(owner, path);
    const repeated = await documents.putIfAbsent(owner, path, "third");

    expect(first.version).toBe(second.version);
    expect(repeated.version).toBe(first.version);
    expect(stored?.content).toBe(first.content);
    expect(["first", "second"]).toContain(stored?.content);
  });

  it("does not create another CAS object version when the same owner retries identical content", async () => {
    const body = Buffer.from("immutable artifact");
    const contentDigest = createHash("sha256").update(body).digest("hex");
    const key = ownerScopedArtifactContentKey(owner, contentDigest);
    const first = await artifactContents.put({ ownerId: owner, contentDigest, size: body.byteLength, openStream: () => Readable.from(body) });
    const second = await artifactContents.put({ ownerId: owner, contentDigest, size: body.byteLength, openStream: () => Readable.from(body) });
    const stat = await client.statObject(config.bucket, key);
    expect(second.versionId).toBe(first.versionId);
    expect(stat.versionId).toBe(first.versionId);
    await expect(artifactContents.stat(otherOwner, contentDigest)).resolves.toBeNull();
    await expect(artifactContents.presignGet(owner, contentDigest, 60)).resolves.toMatch(/^https?:\/\//);
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
