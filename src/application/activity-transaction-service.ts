import { z } from "zod";
import { linkedActivityContextSchema } from "./activity-transaction-extractor.js";
import type { RetrospectiveScope, RetrospectiveExtractionInput } from "../domain/work-retrospective.js";
import type { WorkRetrospectiveUseCases } from "./work-retrospective-store.js";
import type { LinkedActivityTransactionStore, LinkedActivityTransactionKey } from "./linked-activity-transaction-store.js";
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
  /** Enables linked processing only when application has resolved group policy. */
  retrospectiveScope?: RetrospectiveScope;
};

export type ActivityTransactionExtractionMetadata = {
  context: ActivityTransactionContextMeasurement;
  usage?: ModelTokenUsage;
  trace?: ActivityTransactionGenerationTrace;
  decision?: ActivityTransactionDecision;
  latencyMs?: number;
};

export type ActivityTransactionServiceResult =
  | { status: "linked"; outcomes: ActivityTransactionServiceResult[]; extraction?: ActivityTransactionExtractionMetadata }
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
  retrospectiveScope: z.strictObject({ employeeId: z.string(), companyId: z.string(), groupId: z.string(), subjectKey: z.string(), threadId: z.string().min(1) }).optional(),
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
  retrospective?: Pick<WorkRetrospectiveUseCases, "readEpisodes">;
  linkedTransactions?: LinkedActivityTransactionStore;
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
    if (input.retrospectiveScope) return this.processLinked(input);
    return this.processUnlinked(input);
  }

  private async processUnlinked(input: ActivityTransactionTrustedRequest & { mode: ActivityTransactionMode }, linkedContext?: Omit<RetrospectiveExtractionInput, "currentText">): Promise<ActivityTransactionServiceResult> {
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
        ...(linkedContext ? { linkedContext } : {}),
        currentText: input.currentText,
        durationReferences: [...durationEvidence.candidates],
        ...(directorySection ? { directorySection } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }
      : {
        mode: "repair",
        ...(linkedContext ? { linkedContext } : {}),
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
        case "linked":
          return { status: "failed", phase: "validation", code: "validation_error", extraction };
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
  private async processLinked(input: ActivityTransactionTrustedRequest & { mode: ActivityTransactionMode }): Promise<ActivityTransactionServiceResult> {
    const scope = input.retrospectiveScope!;
    const store = this.deps.linkedTransactions;
    if (!store || !this.deps.retrospective || scope.employeeId !== input.employeeId || scope.companyId !== input.companyId || scope.groupId !== input.groupId || scope.subjectKey !== input.subjectKey) {
      return { status: "failed", phase: "validation", code: "validation_error" };
    }
    const key: LinkedActivityTransactionKey = { ...scope, sourceMessageId: input.sourceMessageId, ordinal: 0 };
    const unknown = (): ActivityTransactionServiceResult => ({ status: "outcome_unknown", phase: "write", extraction: { context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } } });
    try {
      const claim = await store.claim(key);
      if (claim.status === "existing") return claim.outcome ?? unknown();
      const episodes = await this.deps.retrospective.readEpisodes({ scope, limit: 100 });
      if (!("value" in episodes)) {
        const failure: ActivityTransactionServiceResult = { status: "failed", phase: "read", code: "persistence_error" };
        await store.complete(key, failure); return failure;
      }
      const pending = episodes.value.filter((episode) => episode.employeeId === scope.employeeId && episode.companyId === scope.companyId && episode.groupId === scope.groupId && episode.subjectKey === scope.subjectKey && episode.threadId === scope.threadId && episode.status === "active" && episode.pendingQuestion && episode.questionBudget.localDate === calendarDateInIanaTimezone(this.clock.now(), input.timezone) && Date.parse(this.clock.now()) < Date.parse(episode.period.end));
      const episode = pending.length === 1 ? pending[0] : undefined;
      const linkedContext = episode?.pendingQuestion ? linkedActivityContextSchema.parse({ question: episode.pendingQuestion, boundTarget: { episodeId: episode.episodeId, revision: episode.revision, sourceRefs: episode.pendingQuestion.target.sourceRefs, activityRefs: episode.activityRefs, statements: episode.statements } }) : undefined;
      if (linkedContext && JSON.stringify(linkedContext).length > 6000) {
        const result: ActivityTransactionServiceResult = { status: "failed", phase: "read", code: "context_budget_error" };
        await store.complete(key, result); return result;
      }
      let result: ActivityTransactionServiceResult | undefined;
      const { retrospectiveScope: _scope, ...unlinked } = input;
      const extractor: ActivityTransactionExtractor = async (request) => {
        const extracted = await this.deps.extractor(request);
        if (extracted.status !== "completed") return extracted;
        const selected = extracted.decision;
        if ((selected.kind === "correct" || selected.kind === "linked") && linkedContext && !linkedContext.boundTarget.activityRefs.some((ref) => ref.activityId === selected.handle && ref.revision === selected.expectedRevision)) {
          return { status: "failed", code: "schema_error", context: extracted.context };
        }
        if (extracted.decision.kind !== "linked") return extracted;
        const decision = extracted.decision;
        if (!linkedContext || !linkedContext.boundTarget.activityRefs.some((ref) => ref.activityId === decision.handle && ref.revision === decision.expectedRevision)
          || (decision.correction.durationRef && decision.activities.some((item) => item.durationRef === decision.correction.durationRef))) {
          return { status: "failed", code: "schema_error", context: extracted.context };
        }
        const parts: ActivityTransactionDecision[] = [{ kind: "correct", handle: decision.handle, expectedRevision: decision.expectedRevision, mode: "patch", correction: decision.correction }, ...(decision.activities.length ? [{ kind: "collect" as const, activities: decision.activities }] : [])];
        const outcomes: ActivityTransactionServiceResult[] = [];
        for (const [index, part] of parts.entries()) {
          const operationKey = { ...key, ordinal: index + 1 };
          const reserved = await store.claim(operationKey);
          if (reserved.status === "existing") { outcomes.push(reserved.outcome ?? unknown()); continue; }
          const service = new ActivityTransactionService({ ...this.deps, extractor: async () => ({ ...extracted, decision: part }) });
          const outcome = await service.processUnlinked(unlinked);
          await store.complete(operationKey, outcome);
          outcomes.push(outcome);
        }
        result = { status: "linked", outcomes, extraction: { context: extracted.context, decision: extracted.decision, ...(extracted.usage ? { usage: extracted.usage } : {}), ...(extracted.trace ? { trace: extracted.trace } : {}) } };
        // Outer processing must not write this decision again.
        return { ...extracted, decision: { kind: "none", reason: "no_factual_activity" } };
      };
      const service = new ActivityTransactionService({ ...this.deps, extractor });
      const outer = await service.processUnlinked(unlinked, linkedContext);
      result = result ?? outer;
      await store.complete(key, result);
      return result;
    } catch {
      // A claim/write may have committed. Keep its reservation and never blindly retry.
      return unknown();
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
