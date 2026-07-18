import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { findRepoRoot } from "./agent-manual-loader.js";

const contextPriorityRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  pattern: z.string().min(1),
});

const contextPriorityManifestSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(contextPriorityRuleSchema).min(1),
});

export type ContextPriorityRule = {
  id: string;
  pattern: string;
  matcher: RegExp;
};

export type ContextPriorityManifest = {
  version: 1;
  rules: readonly ContextPriorityRule[];
};

const contextPriorityManifestPath = "vault/assistant/proc/context-priorities.json";

/** Loads trusted product policy from the repository, never from owner documents. */
export function loadContextPriorityManifest(input: { repoRoot?: string } = {}): ContextPriorityManifest {
  const repoRoot = findRepoRoot(input.repoRoot ?? process.cwd());
  const manifest = contextPriorityManifestSchema.parse(JSON.parse(readFileSync(resolve(repoRoot, contextPriorityManifestPath), "utf8")));

  const duplicateId = manifest.rules.find((rule, index) => manifest.rules.findIndex(({ id }) => id === rule.id) !== index);
  if (duplicateId) throw new Error(`duplicate context priority rule id: ${duplicateId.id}`);
  const duplicatePattern = manifest.rules.find((rule, index) => manifest.rules.findIndex(({ pattern }) => pattern === rule.pattern) !== index);
  if (duplicatePattern) throw new Error(`duplicate context priority rule pattern: ${duplicatePattern.pattern}`);

  return {
    version: manifest.version,
    rules: manifest.rules.map((rule) => ({
      ...rule,
      matcher: compileAnchoredPattern(rule.id, rule.pattern),
    })),
  };
}

function compileAnchoredPattern(id: string, pattern: string): RegExp {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
    throw new Error(`context priority rule must be anchored: ${id}`);
  }
  try {
    return new RegExp(pattern, "iu");
  } catch (error) {
    throw new Error(`invalid context priority rule pattern: ${id}`, { cause: error });
  }
}
