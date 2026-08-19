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
  get(input: ResearchTraceScope & { traceId: string }): Promise<ResearchTraceRecord | undefined>;
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
  const withoutPersonalProfileContext: ResearchTraceRecord = {
    ...trace,
    attempts: trace.attempts.map((attempt) => ({ ...attempt, context: omitPersonalProfileContext(attempt.context) })),
  };
  return traceSchema.parse(sanitizeTraceValue(withoutPersonalProfileContext));
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
    code: sanitizeResearchText(codeValue),
    message: sanitizeResearchText(named?.message ?? "Unknown agent error"),
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
  if (typeof value === "string") return sanitizeResearchText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitizeTraceValue(entry, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const record = value as Record<string, unknown>;
  const payloadToolName = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? (record.payload as Record<string, unknown>).toolName
    : undefined;
  const personalContextTool = record.toolName === "updatePersonalContext" || payloadToolName === "updatePersonalContext";
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) continue;
    if (personalContextTool && key === "payload" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      safe[key] = sanitizePersonalContextToolPayload(entry as Record<string, unknown>, seen);
      continue;
    }
    if (personalContextTool && (key === "args" || key === "input")) {
      safe[key] = { fields: personalProfileFieldNames(entry) };
      continue;
    }
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

const personalProfileContextPrefixes = [
  "- Регулярные задачи:",
  "- Уровень знакомства с ИИ:",
  "- Личная цель программы:",
] as const;

function omitPersonalProfileContext(context: string): string {
  return context.split("\n").filter((line) => !personalProfileContextPrefixes.some((prefix) => line.startsWith(prefix))).join("\n");
}

function sanitizePersonalContextToolPayload(payload: Record<string, unknown>, seen: WeakSet<object>): unknown {
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(payload)) {
    if (entry === undefined) continue;
    if (key === "args" || key === "input") safe[key] = { fields: personalProfileFieldNames(entry) };
    else safe[key] = isSecretKey(key) ? "[REDACTED]" : sanitizeTraceValue(entry, seen);
  }
  return safe;
}

function personalProfileFieldNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const allowed = new Set(["preferredName", "persona", "responseLength", "timezone", "role", "typicalTasks", "typicalTasksMode", "aiLevel", "programGoal"]);
  const existing = (value as { fields?: unknown }).fields;
  if (Array.isArray(existing)) return existing.filter((field): field is string => typeof field === "string" && allowed.has(field));
  return Object.keys(value).filter((key) => allowed.has(key));
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

export function sanitizeResearchText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\b(postgres(?:ql)?):\/\/([^:\s/@]+):([^@\s/]+)@/giu, "$1://$2:[REDACTED]@")
    .replace(/\b(api[_-]?key|authorization|invite[_-]?code|password|access[_-]?token|refresh[_-]?token)\s*([:=])\s*([^\s,;]+)/giu, "$1$2[REDACTED]");
}
