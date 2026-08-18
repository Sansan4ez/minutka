import { z } from "zod";
import type { ModelTokenUsage } from "./usage-store.js";

export const researchTraceSchemaVersion = "research-trace/v1" as const;
export const researchTraceExportSchemaVersion = "research-trace-export/v1" as const;

export type ResearchTraceStatus = "completed" | "failed";

export type ResearchTraceAttempt = {
  attempt: number;
  context: string;
  modelSteps: unknown[];
  toolCalls: unknown[];
  toolResults: unknown[];
  model?: string;
  error?: ResearchTraceError;
};

export type ResearchTraceError = {
  code: string;
  message: string;
};

export type ResearchTraceRecord = {
  schemaVersion: typeof researchTraceSchemaVersion;
  traceId: string;
  requestId: string;
  messageId: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  processIds: string[];
  promptVersion: string;
  processVersion: string;
  taxonomyVersion: string;
  model: string;
  samplingRate: 1;
  input: {
    text: string;
    modality: "text" | "voice";
  };
  attempts: ResearchTraceAttempt[];
  output?: string;
  usage?: ModelTokenUsage;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  status: ResearchTraceStatus;
  error?: ResearchTraceError;
};

export type ResearchTraceScope = {
  companyId: string;
  groupId: string;
};

export type ResearchTraceStore = {
  append(trace: ResearchTraceRecord): Promise<void>;
  /** Research reads always require an exact tenant and group scope. */
  list(input: ResearchTraceScope & { limit?: number }): Promise<ResearchTraceRecord[]>;
};

const traceSchema = z.strictObject({
  schemaVersion: z.literal(researchTraceSchemaVersion),
  traceId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
  processIds: z.array(z.string().trim().min(1)),
  promptVersion: z.string().trim().min(1),
  processVersion: z.string().trim().min(1),
  taxonomyVersion: z.string().trim().min(1),
  model: z.string().trim().min(1),
  samplingRate: z.literal(1),
  input: z.strictObject({
    text: z.string(),
    modality: z.enum(["text", "voice"]),
  }),
  attempts: z.array(z.strictObject({
    attempt: z.number().int().positive(),
    context: z.string(),
    modelSteps: z.array(z.unknown()),
    toolCalls: z.array(z.unknown()),
    toolResults: z.array(z.unknown()),
    model: z.string().trim().min(1).optional(),
    error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
  })).min(1),
  output: z.string().optional(),
  usage: z.strictObject({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    llmSteps: z.number().int().positive().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
  }).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  latencyMs: z.number().int().nonnegative(),
  status: z.enum(["completed", "failed"]),
  error: z.strictObject({ code: z.string().min(1), message: z.string() }).optional(),
});

export function sanitizeResearchTrace(trace: ResearchTraceRecord): ResearchTraceRecord {
  return traceSchema.parse(sanitizeTraceValue(trace));
}

export function parseResearchTrace(value: unknown): ResearchTraceRecord {
  return traceSchema.parse(value);
}

export function researchTraceError(error: unknown): ResearchTraceError {
  const named = error instanceof Error ? error : undefined;
  const codeValue = typeof (error as { code?: unknown } | undefined)?.code === "string"
    ? (error as { code: string }).code
    : named?.name ?? "unknown_error";
  return {
    code: sanitizeTraceString(codeValue),
    message: sanitizeTraceString(named?.message ?? "Unknown agent error"),
  };
}

export function exportResearchTracesJson(
  scope: ResearchTraceScope,
  traces: readonly ResearchTraceRecord[],
  exportedAt: string,
): string {
  const scoped = traces.filter((trace) => trace.companyId === scope.companyId && trace.groupId === scope.groupId);
  return JSON.stringify({
    schemaVersion: researchTraceExportSchemaVersion,
    exportedAt,
    scope,
    traceCount: scoped.length,
    traces: scoped.map(sanitizeResearchTrace),
  }, null, 2);
}

function sanitizeTraceValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeTraceString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    safe[key] = isSecretKey(key) ? "[REDACTED]" : sanitizeTraceValue(entry, seen);
  }
  seen.delete(value);
  return safe;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return secretKeys.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("invitetoken")
    || normalized.endsWith("invitecode")
    || normalized.endsWith("password")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("encryptionkey");
}

const secretKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "secretkey",
  "invitecode",
  "databaseurl",
  "connectionstring",
  "integrationenckey",
  "telegrambottoken",
]);

function sanitizeTraceString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\b(postgres(?:ql)?):\/\/([^:\s/@]+):([^@\s/]+)@/giu, "$1://$2:[REDACTED]@")
    .replace(/\b(api[_-]?key|authorization|invite[_-]?code|password|access[_-]?token|refresh[_-]?token)\s*([:=])\s*([^\s,;]+)/giu, "$1$2[REDACTED]");
}
