import { resolve } from "node:path";
import { loadDotEnv } from "../config/env.js";
import type { BlobStore } from "../application/blob-store.js";
import { createIngestionService } from "../application/ingestion-service.js";
import { contextBudgetConfigFromEnv } from "../application/context-budget.js";
import { loadContextPriorityManifest } from "../application/context-priority-manifest.js";
import {
  defaultPilotKnowledgeBaseLimits,
  discoverPilotKnowledgeBase,
  importPilotKnowledgeBase,
  migrateLegacyPilotKnowledgeBase,
  pilotUserIdFromEnv,
  type PilotKnowledgeBaseLimits,
} from "../application/pilot-knowledge-base-import.js";
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
  const sourceRoot = resolve(input.sourceRoot ?? knowledgeBaseRootFromEnv(env) ?? "vault/user/knowledge_base");
  const contextBudget = contextBudgetConfigFromEnv(env);
  const contextPriorities = input.dependencies?.loadContextPriorities?.() ?? loadContextPriorityManifest();
  const limits = pilotKnowledgeBaseLimitsFromEnv(env);
  const files = await discoverPilotKnowledgeBase(sourceRoot, { contextBudget, contextPriorities, limits });
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
    const result = await migrateLegacyPilotKnowledgeBase({ userId, documentStore, ingestionService, contextBudget, contextPriorities, limits });
    printJson({ dryRun: false, migration: true, ...result });
    return;
  }
  const result = await importPilotKnowledgeBase({ userId, files, documentStore, ingestionService, contextBudget, contextPriorities, limits });
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

export function knowledgeBaseRootFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const sourceRoot = env.PILOT_KNOWLEDGE_BASE_ROOT?.trim();
  return sourceRoot || undefined;
}

export function pilotKnowledgeBaseLimitsFromEnv(env: NodeJS.ProcessEnv): PilotKnowledgeBaseLimits {
  return {
    maximumDocuments: optionalPositiveEnvInteger(
      env.PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS,
      "PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS",
      defaultPilotKnowledgeBaseLimits.maximumDocuments,
    ),
    maximumTotalBytes: optionalPositiveEnvInteger(
      env.PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES,
      "PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES",
      defaultPilotKnowledgeBaseLimits.maximumTotalBytes,
    ),
  };
}

function sumSizes(files: Array<{ size: number }>): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function optionalPositiveEnvInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
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
