import { resolve } from "node:path";
import { loadDotEnv } from "../config/env.js";
import type { BlobStore } from "../application/blob-store.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { contextBudgetConfigFromEnv } from "../application/context-budget.js";
import { loadContextPriorityManifest } from "../application/context-priority-manifest.js";
import { discoverPilotKnowledgeBase, importPilotKnowledgeBase, migrateLegacyPilotKnowledgeBase, pilotUserIdFromEnv } from "../application/pilot-knowledge-base-import.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../infrastructure/minio/minio-config.js";
import { createMinioDocumentStore } from "../infrastructure/minio/minio-document-store.js";

export type PilotKnowledgeBaseImportRuntimeDependencies = {
  prepareDocumentStore?: (env: NodeJS.ProcessEnv) => Promise<ReturnType<typeof createMinioDocumentStore>>;
  loadContextPriorities?: () => ReturnType<typeof loadContextPriorityManifest>;
};

export async function runPilotKnowledgeBaseImport(input: {
  env?: NodeJS.ProcessEnv;
  sourceRoot?: string;
  dryRun?: boolean;
  migrateLegacy?: boolean;
  dependencies?: PilotKnowledgeBaseImportRuntimeDependencies;
} = {}): Promise<void> {
  const env = input.env ?? process.env;
  const userId = pilotUserIdFromEnv(env);
  const sourceRoot = resolve(input.sourceRoot ?? "vault/user/knowledge_base");
  const contextBudget = contextBudgetConfigFromEnv(env);
  const contextPriorities = input.dependencies?.loadContextPriorities?.() ?? loadContextPriorityManifest();
  const files = await discoverPilotKnowledgeBase(sourceRoot, { contextBudget, contextPriorities });
  if (files.length === 0) throw new Error("pilot knowledge-base source is empty");

  if (input.dryRun ?? false) {
    printJson({ dryRun: true, files: files.map(({ path, size }) => ({ path, size })), count: files.length, bytes: sumSizes(files) });
    return;
  }

  const documentStore = input.dependencies?.prepareDocumentStore
    ? await input.dependencies.prepareDocumentStore(env)
    : await prepareProductionDocumentStore(env);
  const ingestionService = createIngestionService({
    documentStore,
    blobStore: unusedBlobStore,
    maximumContextDocumentBytes: contextBudget.documentTools.maximumDocumentBytes,
  });
  if (input.migrateLegacy ?? false) {
    const result = await migrateLegacyPilotKnowledgeBase({ userId, documentStore, ingestionService, contextBudget, contextPriorities });
    printJson({ dryRun: false, migration: true, ...result });
    return;
  }
  const result = await importPilotKnowledgeBase({ userId, files, documentStore, ingestionService, contextBudget, contextPriorities });
  printJson({ dryRun: false, migration: false, ...result });
}

async function prepareProductionDocumentStore(env: NodeJS.ProcessEnv): Promise<ReturnType<typeof createMinioDocumentStore>> {
  const config = minioConfigFromEnv(env);
  const client = createMinioClient(config);
  await prepareMinioBucket(client, config.bucket);
  return createMinioDocumentStore({ client, bucket: config.bucket });
}

const unusedBlobStore: BlobStore = {
  async put() { throw new Error("blob storage is unavailable during knowledge-base import"); },
  async get() { throw new Error("blob storage is unavailable during knowledge-base import"); },
  async presignGet() { throw new Error("blob storage is unavailable during knowledge-base import"); },
  async list() { throw new Error("blob storage is unavailable during knowledge-base import"); },
};

function sumSizes(files: Array<{ size: number }>): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArguments(args: string[]): { dryRun: boolean; migrateLegacy: boolean; sourceRoot?: string } {
  let dryRun = false;
  let migrateLegacy = false;
  let sourceRoot: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--migrate-legacy") migrateLegacy = true;
    else if (argument === "--source") {
      sourceRoot = args[++index];
      if (!sourceRoot) throw new Error("--source requires a directory");
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (dryRun && migrateLegacy) throw new Error("--dry-run and --migrate-legacy cannot be combined");
  return { dryRun, migrateLegacy, sourceRoot };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  loadDotEnv();
  runPilotKnowledgeBaseImport({ ...parseArguments(process.argv.slice(2)), env: process.env }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "pilot knowledge-base import failed");
    process.exitCode = 1;
  });
}
