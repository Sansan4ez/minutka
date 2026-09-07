import { z } from "zod";
import type { CollectActivitiesResult, CollectActivityService } from "./activity-collection.js";
import type { ActivityCorrectionService, ActivityMutationResult } from "./activity-correction.js";
import {
  activityTransactionModes,
  type ActivityTransactionContextMeasurement,
  type ActivityTransactionDecision,
  type ActivityTransactionExtractor,
  type ActivityTransactionFailureCode,
  type ActivityTransactionGenerationTrace,
  type ActivityTransactionMode,
} from "./activity-transaction-extractor.js";
import {
  DurationEvidenceValidationError,
  extractDurationEvidence,
  isDurationOnlyActivityReply,
  RequestDurationEvidence,
} from "./activity-duration-evidence.js";
import { PersistenceError, PersistenceOutcomeUnknownError } from "./persistence-error.js";
import type { RecentOwnActivitiesService } from "./recent-own-activities.js";
import type { RoutineDirectorySectionProvider } from "./routine-directory.js";
import { systemClock, type Clock } from "./runtime-primitives.js";
import type { ModelTokenUsage } from "./usage-store.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";

export const activityTransactionServiceFailureCodes = [
  "context_budget_error",
  "provider_error",
  "schema_error",
  "validation_error",
  "persistence_conflict",
  "persistence_unavailable",
  "persistence_error",
] as const;
export type ActivityTransactionServiceFailureCode = typeof activityTransactionServiceFailureCodes[number];

export type ActivityTransactionTrustedRequest = {
  employeeId: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  sourceMessageId: string;
  roleId: string;
  timezone: string;
  currentText: string;
  signal?: AbortSignal;
};

export type ActivityTransactionExtractionMetadata = {
  context: ActivityTransactionContextMeasurement;
  usage?: ModelTokenUsage;
  trace?: ActivityTransactionGenerationTrace;
  decision?: ActivityTransactionDecision;
  latencyMs?: number;
};

export type ActivityTransactionServiceResult =
  | { status: "no_write"; reason: "no_factual_activity"; extraction: ActivityTransactionExtractionMetadata }
  | {
    status: "needs_clarification";
    reason: "activity_status_ambiguous" | "correction_target_ambiguous" | "duplicate_pair_ambiguous" | "repair_target_not_found";
    extraction: ActivityTransactionExtractionMetadata;
  }
  | ({ status: "completed"; operation: "collect"; savedCount: number; activityIds: string[] } & { extraction: ActivityTransactionExtractionMetadata })
  | ({ status: "completed"; operation: "correct" | "supersede" } & ActivityMutationResult & { extraction: ActivityTransactionExtractionMetadata })
  | {
    status: "partial";
    operation: "collect";
    savedCount: number;
    activityIds: string[];
    code: Exclude<ActivityTransactionServiceFailureCode, ActivityTransactionFailureCode>;
    extraction: ActivityTransactionExtractionMetadata;
  }
  | {
    status: "failed";
    phase: "validation" | "extract" | "read" | "write";
    code: ActivityTransactionServiceFailureCode;
    extraction?: ActivityTransactionExtractionMetadata;
  }
  | { status: "outcome_unknown"; phase: "write"; extraction: ActivityTransactionExtractionMetadata };

const trustedRequestSchema = z.strictObject({
  employeeId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
  sourceMessageId: z.string().trim().min(1),
  roleId: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  currentText: z.string().trim().min(1),
  signal: z.custom<AbortSignal>().optional(),
});

const transactionCommandSchema = trustedRequestSchema.extend({
  mode: z.enum(activityTransactionModes),
});

type ActivityTransactionDependencies = {
  extractor: ActivityTransactionExtractor;
  collection: Pick<CollectActivityService, "collectBatch">;
  recentActivities: Pick<RecentOwnActivitiesService, "read">;
  corrections: Pick<ActivityCorrectionService, "correct" | "supersede">;
  routineDirectorySectionProvider?: RoutineDirectorySectionProvider;
  clock?: Clock;
};

/**
 * One request-bound activity transaction over the existing canonical use-cases.
 * Identity and message evidence enter through the trusted closure; the extractor
 * sees only the current text, request-local duration refs, the matching role-directory
 * section when configured, and (for repair) a bounded projection of recent own activities.
 */
export class ActivityTransactionService {
  private readonly clock: Clock;

  constructor(private readonly deps: ActivityTransactionDependencies) {
    this.clock = deps.clock ?? systemClock;
  }

  bind(request: ActivityTransactionTrustedRequest): (input: { mode: ActivityTransactionMode }) => Promise<ActivityTransactionServiceResult> {
    return ({ mode }) => this.process({ ...request, mode });
  }

  async process(command: ActivityTransactionTrustedRequest & { mode: ActivityTransactionMode }): Promise<ActivityTransactionServiceResult> {
    const parsed = transactionCommandSchema.safeParse(command);
    if (!parsed.success) return { status: "failed", phase: "validation", code: "validation_error" };
    const input = parsed.data;
    const durationEvidence = new RequestDurationEvidence(extractDurationEvidence(input.currentText));
    const durationOnlyReply = isDurationOnlyActivityReply(input.currentText);
    const effectiveMode: ActivityTransactionMode = durationOnlyReply ? "repair" : input.mode;

    let recentCandidates: Awaited<ReturnType<RecentOwnActivitiesService["read"]>>["activities"] | undefined;
    if (effectiveMode === "repair") {
      try {
        const recent = await this.deps.recentActivities.read({
          employeeId: input.employeeId,
          companyId: input.companyId,
          groupId: input.groupId,
        });
        const candidates = recent.activities.slice(0, 5);
        recentCandidates = durationOnlyReply
          ? candidates.filter(({ activityDate }) => activityDate === calendarDateInIanaTimezone(this.clock.now(), input.timezone))
          : candidates;
      } catch (error) {
        return { status: "failed", phase: "read", code: boundedFailureCode(error) };
      }
    }

    const extractionStartedAt = Date.now();
    const directorySection = this.deps.routineDirectorySectionProvider?.(input.companyId, input.roleId);
    const extracted = await this.deps.extractor(effectiveMode === "record"
      ? {
        mode: "record",
        currentText: input.currentText,
        durationReferences: [...durationEvidence.candidates],
        ...(directorySection ? { directorySection } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }
      : {
        mode: "repair",
        currentText: input.currentText,
        durationReferences: [...durationEvidence.candidates],
        recentCandidates: recentCandidates ?? [],
        ...(directorySection ? { directorySection } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });

    if (extracted.status === "failed") {
      return {
        status: "failed",
        phase: "extract",
        code: extracted.code,
        ...(extracted.context ? { extraction: extractionMetadata(
          extracted.context,
          extracted.usage,
          extracted.trace,
          undefined,
          extractionStartedAt,
        ) } : {}),
      };
    }

    const extraction = extractionMetadata(
      extracted.context,
      extracted.usage,
      extracted.trace,
      extracted.decision,
      extractionStartedAt,
    );
    if (extracted.decision.kind === "none") {
      return { status: "no_write", reason: extracted.decision.reason, extraction };
    }
    if (extracted.decision.kind === "needs_clarification") {
      return { status: "needs_clarification", reason: extracted.decision.reason, extraction };
    }

    try {
      switch (extracted.decision.kind) {
        case "collect": {
          const prepared = durationEvidence.prepareCollection({ activities: extracted.decision.activities });
          const result = await this.deps.collection.collectBatch({
            employeeId: input.employeeId,
            companyId: input.companyId,
            groupId: input.groupId,
            subjectKey: input.subjectKey,
            sourceMessageId: input.sourceMessageId,
            roleId: input.roleId,
            timezone: input.timezone,
            activities: prepared.input.activities,
          });
          durationEvidence.consumeCollection(prepared.refsByActivity, result.savedCount);
          return collectionResult(result, extraction);
        }
        case "correct": {
          const prepared = durationEvidence.prepareCorrection({
            handle: extracted.decision.handle,
            expectedRevision: extracted.decision.expectedRevision,
            mode: extracted.decision.mode,
            correction: extracted.decision.correction,
          });
          const result = await this.deps.corrections.correct({
            employeeId: input.employeeId,
            companyId: input.companyId,
            groupId: input.groupId,
            sourceMessageId: input.sourceMessageId,
          }, prepared.input);
          durationEvidence.consumeCorrection(prepared.durationRef);
          return { ...result, operation: "correct", extraction };
        }
        case "supersede": {
          const result = await this.deps.corrections.supersede({
            employeeId: input.employeeId,
            companyId: input.companyId,
            groupId: input.groupId,
            sourceMessageId: input.sourceMessageId,
          }, {
            handle: extracted.decision.handle,
            expectedRevision: extracted.decision.expectedRevision,
            replacementHandle: extracted.decision.replacementHandle,
            replacementExpectedRevision: extracted.decision.replacementExpectedRevision,
          });
          return { ...result, operation: "supersede", extraction };
        }
      }
    } catch (error) {
      if (error instanceof PersistenceOutcomeUnknownError) {
        return { status: "outcome_unknown", phase: "write", extraction };
      }
      return {
        status: "failed",
        phase: error instanceof DurationEvidenceValidationError || error instanceof z.ZodError ? "validation" : "write",
        code: boundedFailureCode(error),
        extraction,
      };
    }
  }
}

function extractionMetadata(
  context: ActivityTransactionContextMeasurement,
  usage: ModelTokenUsage | undefined,
  trace: ActivityTransactionGenerationTrace | undefined,
  decision: ActivityTransactionDecision | undefined,
  startedAt: number,
): ActivityTransactionExtractionMetadata {
  return {
    context,
    ...(usage ? { usage } : {}),
    ...(trace ? { trace } : {}),
    ...(decision ? { decision } : {}),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function collectionResult(
  result: CollectActivitiesResult,
  extraction: ActivityTransactionExtractionMetadata,
): ActivityTransactionServiceResult {
  if (result.status === "completed") {
    return { status: "completed", operation: "collect", savedCount: result.savedCount, activityIds: result.activityIds, extraction };
  }
  const code = boundedWriteFailureCode(result.error);
  if (result.status === "partial") {
    return { status: "partial", operation: "collect", savedCount: result.savedCount, activityIds: result.activityIds, code, extraction };
  }
  return { status: "failed", phase: "write", code, extraction };
}

function boundedFailureCode(error: unknown): ActivityTransactionServiceFailureCode {
  return boundedWriteFailureCode(error);
}

function boundedWriteFailureCode(
  error: unknown,
): Exclude<ActivityTransactionServiceFailureCode, ActivityTransactionFailureCode> {
  if (error instanceof DurationEvidenceValidationError || error instanceof z.ZodError) return "validation_error";
  if (error instanceof PersistenceError) {
    if (error.code === "persistence_conflict" || error.code === "persistence_unavailable") return error.code;
  }
  return "persistence_error";
}
