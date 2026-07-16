import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentManual,
  AgentManualLoader,
  AgentManualProcess,
  AgentManualProcessId,
  AgentManualPurpose,
  AgentManualValidationResult,
} from "./agent-manual-types.js";
import {
  agentManualProcessIds,
  requiredAgentManualProcessIds,
  requiredProcessSections,
} from "./agent-manual-types.js";

type RegistryProcess = {
  id: string;
  path: string;
  appliesTo?: string[];
  dependencies?: string[];
};

type Registry = {
  version: number;
  manualId: string;
  core: { id: string; path: string };
  index: { path: string };
  runtimeDocs: Array<{ id: string; path: string }>;
  processes: RegistryProcess[];
};

export type LoadAgentManualOptions = {
  repoRoot?: string;
  registryPath?: string;
};

export function createAgentManualLoader(
  options: LoadAgentManualOptions = {},
): AgentManualLoader {
  return {
    load: () => loadAgentManualFromDisk(options),
    validate: (manual) => validateAgentManual(manual, options.repoRoot),
  };
}

export function loadAgentManualFromDisk(
  options: LoadAgentManualOptions = {},
): AgentManual {
  const repoRoot = findRepoRoot(options.repoRoot ?? process.cwd());
  const registryPath = options.registryPath ?? "vault/assistant/processes/legacy-registry.json";
  const absoluteRegistryPath = resolveRepoPath(repoRoot, registryPath);
  if (!existsSync(absoluteRegistryPath)) {
    throw new Error(`missing agent vault registry: ${registryPath}`);
  }

  const registry = JSON.parse(
    readFileSync(absoluteRegistryPath, "utf8"),
  ) as Registry;

  const manual: AgentManual = {
    version: registry.version,
    manualId: registry.manualId,
    core: {
      id: "core",
      path: registry.core.path,
      content: readManualFile(repoRoot, registry.core.path, "core file"),
    },
    runtimeDocs: registry.runtimeDocs.map((document) => ({
      id: document.id,
      path: document.path,
      content: readManualFile(repoRoot, document.path, `runtime document ${document.id}`),
    })),
    processIndex: {
      path: registry.index.path,
      content: readManualFile(repoRoot, registry.index.path, "process index"),
    },
    processes: registry.processes.map((process) => ({ 
      id: assertProcessId(process.id),
      path: process.path,
      content: readManualFile(repoRoot, process.path, `process file ${process.id}`),
      appliesTo: process.appliesTo?.map(assertPurpose),
      dependencies: process.dependencies ?? [],
    })),
  };

  const validation = validateAgentManual(manual, repoRoot);
  if (!validation.ok) {
    throw new Error(`agent vault validation failed:\n- ${validation.errors.join("\n- ")}`);
  }
  return manual;
}

export function validateAgentManual(
  manual: AgentManual,
  repoRoot = findRepoRoot(process.cwd()),
): AgentManualValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (manual.version !== 1) errors.push(`registry.version must be 1`);
  if (!manual.manualId) errors.push(`manualId is required`);
  if (manual.core.id !== "core") errors.push(`core id must be core`);
  if (!manual.core.path) errors.push(`core path is required`);
  if (manual.core.path !== "vault/assistant/AGENTS.md") errors.push(`core path is not allow-listed: ${manual.core.path}`);
  if (!existsRepoPath(repoRoot, manual.core.path)) {
    errors.push(`missing core file: ${manual.core.path}`);
  }

  const indexPath = manual.processIndex?.path ?? "vault/assistant/processes/legacy-index.md";
  if (indexPath !== "vault/assistant/processes/legacy-index.md") errors.push(`process index path is not allow-listed: ${indexPath}`);

  const runtimeDocIds = new Set<string>();
  for (const document of manual.runtimeDocs) {
    if (runtimeDocIds.has(document.id)) errors.push(`duplicate runtime document id: ${document.id}`);
    runtimeDocIds.add(document.id);
    if (!document.id || !/^[a-z0-9][a-z0-9.-]*$/.test(document.id)) errors.push(`invalid runtime document id: ${document.id}`);
    if (!isFileUnder(document.path, "vault/assistant/docs/")) errors.push(`runtime document is outside curated docs: ${document.path}`);
    if (!existsRepoPath(repoRoot, document.path)) errors.push(`missing runtime document: ${document.path}`);
  }

  const ids = new Set<string>();
  for (const process of manual.processes) {
    if (ids.has(process.id)) errors.push(`duplicate process id: ${process.id}`);
    ids.add(process.id);

    if (!isFileUnder(process.path, "vault/assistant/processes/")) {
      errors.push(`process file is outside curated processes: ${process.path}`);
    }
    if (!existsRepoPath(repoRoot, process.path)) {
      errors.push(`missing process file: ${process.path}`);
    }

    for (const section of requiredProcessSections) {
      if (!process.content.includes(section)) {
        errors.push(`process ${process.id} missing section: ${section}`);
      }
    }

    if (containsPlaceholder(process.content)) {
      errors.push(`process ${process.id} contains placeholder marker`);
    }

    const lines = process.content.split(/\r?\n/).length;
    if (lines > 200) {
      warnings.push(`process ${process.id} is longer than 200 lines`);
    }

    for (const dependency of process.dependencies) {
      const dependencyFile = dependency.split("#", 1)[0];
      if (!dependencyFile) {
        errors.push(`process ${process.id} dependency is empty`);
      } else if (!existsRepoPath(repoRoot, dependencyFile)) {
        errors.push(`dependency does not exist: ${dependency}`);
      }
    }
  }

  for (const requiredId of requiredAgentManualProcessIds) {
    if (!ids.has(requiredId)) errors.push(`missing required process id: ${requiredId}`);
  }

  if (!existsRepoPath(repoRoot, indexPath)) {
    errors.push(`missing process index: ${indexPath}`);
  } else {
    const index = manual.processIndex?.content ?? readFileSync(resolveRepoPath(repoRoot, indexPath), "utf8");
    for (const process of manual.processes) {
      if (!index.includes(`\`${process.id}\``)) {
        errors.push(`process index does not reference: ${process.id}`);
      }
    }
  }

  for (const handle of ["/AGENTS.md", "/processes", "/docs", "/proc", "/bin", "/run"]) {
    if (!manual.core.content.includes(handle)) {
      errors.push(`AGENTS.md missing vault namespace handle: ${handle}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function readManualFile(repoRoot: string, path: string, label: string) {
  const absolutePath = resolveRepoPath(repoRoot, path);
  if (!existsSync(absolutePath)) throw new Error(`missing ${label}: ${path}`);
  return readFileSync(absolutePath, "utf8");
}

function resolveRepoPath(repoRoot: string, path: string) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function existsRepoPath(repoRoot: string, path: string) {
  return existsSync(resolveRepoPath(repoRoot, path));
}

function assertProcessId(id: string): AgentManualProcess["id"] {
  if (id === "core" || !agentManualProcessIds.includes(id as AgentManualProcessId)) {
    throw new Error(`unknown agent vault process id: ${id}`);
  }
  return id as AgentManualProcess["id"];
}

function assertPurpose(purpose: string): AgentManualPurpose {
  if (["chat", "onboarding_first_response", "feedback", "inbound_record"].includes(purpose)) {
    return purpose as AgentManualPurpose;
  }
  throw new Error(`unknown agent vault appliesTo purpose: ${purpose}`);
}

function isFileUnder(path: string, prefix: string) {
  return path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes("/");
}

function containsPlaceholder(content: string) {
  return /\b(TODO|TBD|lorem ipsum)\b/i.test(content);
}
