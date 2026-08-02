import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import type { ContextBudgetResult } from "./context-budget.js";
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from "./runtime-primitives.js";
import {
  estimateUsageCostUsdMicros,
  usageMonth,
  type ModelTokenUsage,
  type UsageCostPolicy,
  type UsageSource,
  type UsageStore,
} from "./usage-store.js";

/**
 * `assistant_turn_usage` keeps its name because the calibration runbook reads
 * it out of the runtime journal; it now carries `source`, so one owner turn
 * shows up as several attributed lines instead of one chat-only line.
 */
export type UsageOperationalWarning =
  | ({
    type: "assistant_turn_usage";
    userId: string;
    requestId: string;
    source: UsageSource;
    contextSourceCharacters?: ContextBudgetResult["contextSourceCharacters"];
  } & ModelTokenUsage)
  | { type: "usage_soft_limit_exceeded"; userId: string; month: string; estimatedCostUsdMicros: number; softLimitUsdMicros: number };

export type UsageRecordingInput = {
  userId: string;
  requestId: string;
  source: UsageSource;
  usage: ModelTokenUsage;
  threadId?: string;
  messageId?: string;
  /** Chat-only: the Unicode sizes of the sections actually assembled into the prompt. */
  contextSourceCharacters?: ContextBudgetResult["contextSourceCharacters"];
};

/** `overSoftLimit` reports the state of the month, not this single call. */
export type UsageRecordingOutcome = { overSoftLimit: boolean };

export type UsageRecorder = { record(input: UsageRecordingInput): Promise<UsageRecordingOutcome> };

export type UsageRecorderDeps = {
  usageStore?: UsageStore;
  usageCostPolicy?: UsageCostPolicy;
  auditEventStore?: AuditEventStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
  operationalLogger?: (warning: UsageOperationalWarning) => void;
};

/**
 * Single write path for every LLM call of the owner contour. Persistence is
 * best-effort by design: a lost usage row must never discard an answer that the
 * owner already received, so failures are logged and reported as "not over the
 * limit" rather than thrown.
 */
export function createUsageRecorder(deps: UsageRecorderDeps): UsageRecorder {
  const clock = deps.clock ?? systemClock;
  const ids = deps.idGenerator ?? randomIdGenerator;
  return {
    async record(input) {
      warnOperationally(deps, {
        type: "assistant_turn_usage",
        userId: input.userId,
        requestId: input.requestId,
        source: input.source,
        ...(input.contextSourceCharacters ? { contextSourceCharacters: input.contextSourceCharacters } : {}),
        ...input.usage,
      });
      const store = deps.usageStore;
      const policy = deps.usageCostPolicy;
      if (!store || !policy) return { overSoftLimit: false };
      const occurredAt = clock.now();
      try {
        const estimatedCostUsdMicros = estimateUsageCostUsdMicros(input.usage, policy);
        const { monthly, inserted } = await store.record({
          id: (ids.usageId ?? randomIdGenerator.usageId!)(),
          userId: input.userId,
          requestId: input.requestId,
          source: input.source,
          month: usageMonth(occurredAt),
          ...input.usage,
          estimatedCostUsdMicros,
          occurredAt,
        });
        const overSoftLimit = monthly.estimatedCostUsdMicros > policy.monthlySoftLimitUsdMicros;
        // A turn now writes several rows, so "the month is over the limit" would
        // fire the operator alert repeatedly within one turn. Alert on the row
        // that actually crossed the threshold; the user-facing warning still
        // follows the month-level state on every turn.
        const crossedSoftLimit = inserted
          && overSoftLimit
          && monthly.estimatedCostUsdMicros - estimatedCostUsdMicros <= policy.monthlySoftLimitUsdMicros;
        if (!crossedSoftLimit) return { overSoftLimit };
        await auditSafely(deps, {
          id: ids.auditEventId(),
          requestId: input.requestId,
          type: "usage_soft_limit_exceeded",
          employeeId: input.userId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          occurredAt,
          metadata: safeAuditMetadata("usage_soft_limit_exceeded", {
            month: monthly.month,
            source: input.source,
            inputTokens: monthly.inputTokens,
            outputTokens: monthly.outputTokens,
            totalTokens: monthly.totalTokens,
            cachedInputTokens: monthly.cachedInputTokens,
            cachedInputUnknownRecords: monthly.cachedInputUnknownRecords,
            estimatedCostUsdMicros: monthly.estimatedCostUsdMicros,
            softLimitUsdMicros: policy.monthlySoftLimitUsdMicros,
          }),
        });
        warnOperationally(deps, {
          type: "usage_soft_limit_exceeded",
          userId: input.userId,
          month: monthly.month,
          estimatedCostUsdMicros: monthly.estimatedCostUsdMicros,
          softLimitUsdMicros: policy.monthlySoftLimitUsdMicros,
        });
        return { overSoftLimit };
      } catch (error) {
        logUsageOperationalError("usage persistence", error);
        return { overSoftLimit: false };
      }
    },
  };
}

async function auditSafely(deps: UsageRecorderDeps, event: Parameters<AuditEventStore["append"]>[0]): Promise<void> {
  if (!deps.auditEventStore) return;
  try { await deps.auditEventStore.append(event); }
  catch (error) { logUsageOperationalError("usage soft-limit audit", error); }
}

function warnOperationally(deps: UsageRecorderDeps, warning: UsageOperationalWarning): void {
  try { (deps.operationalLogger ?? logUsageOperationalWarning)(warning); }
  catch (error) { logUsageOperationalError("operational warning", error); }
}

/** Operational logs stay metadata-only: no owner text ever reaches them. */
function logUsageOperationalWarning(warning: UsageOperationalWarning): void {
  console.warn("Usage warning.", warning);
}

function logUsageOperationalError(operation: string, error: unknown): void {
  console.warn(`${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`);
}
