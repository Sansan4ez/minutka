import { z } from "zod";
import { currentPrivacyVersion } from "../domain/privacy.js";
import { chatInputFitsCharacterLimit, countUnicodeCodePoints, maxChatInputCharacters, pendingTaskSummaryMaximumCodePoints } from "../shared/chat-limits.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { assistantDiagnosticProcessIds, assistantProcessIds } from "../domain/assistant-process.js";

/** Stable, transport-neutral DTOs for the versioned Minutka application API. */
export const personaSchema = z.enum(["support", "efficiency"]);
export const aiLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export const responseLengthSchema = z.enum(["short", "balanced", "detailed"]);
export const addressFormSchema = z.enum(["informal", "formal"]);
export const timezoneSchema = z.string().min(1).max(64).transform((value, context) => {
  const timezone = normalizeIanaTimezone(value);
  if (timezone) return timezone;
  context.addIssue({ code: "custom", message: "Invalid IANA timezone" });
  return z.NEVER;
});
export const agentManualProcessIdSchema = z.enum(["core", "onboarding", "consent_and_privacy", "evening_reflection", "workday_guardrails", "insight_extraction", "inbox_capture"]);
export const assistantProcessIdSchema = z.enum(assistantProcessIds);
export const assistantDiagnosticProcessIdSchema = z.enum(assistantDiagnosticProcessIds);
export const scheduleViewSchema = z.strictObject({
  id: z.string().min(1), processId: assistantDiagnosticProcessIdSchema,
  timeOfDay: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), timezone: timezoneSchema,
  enabled: z.boolean(), nextFireAt: z.iso.datetime(),
});
export const scheduleListResponseSchema = z.strictObject({ schedules: z.array(scheduleViewSchema) });
export const employeeIdSchema = z.string().min(1).max(128);
export const threadIdSchema = z.string().min(1).max(128);

export const userProfileSchema = z.strictObject({
  employeeId: employeeIdSchema,
  preferredName: z.string().min(1).max(128),
  assistantName: z.string().min(1).max(128),
  addressForm: addressFormSchema,
  persona: personaSchema,
  responseLength: responseLengthSchema,
  timezone: timezoneSchema,
  role: z.string().min(1).optional(),
  typicalTasks: z.array(z.string().min(1)).min(1).max(7).optional(),
  aiLevel: aiLevelSchema.optional(),
  preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const chatInputModalitySchema = z.enum(["text", "voice"]);
export const responseChannelSchema = z.enum(["generic", "telegram"]);
const chatInputTextSchema = z.string().min(1).refine(chatInputFitsCharacterLimit, {
  message: `Too big: expected string to have <=${maxChatInputCharacters} Unicode code points`,
});
export const chatRequestSchema = z.strictObject({ threadId: threadIdSchema, text: chatInputTextSchema, inputModality: chatInputModalitySchema.optional() });
export const serviceChatRequestSchema = chatRequestSchema.extend({ responseChannel: responseChannelSchema.optional() });
export const recordTypeSchema = z.enum(["money", "development", "content", "people", "operations", "knowledge", "personal"]);
export const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
export const pendingTaskActionKindSchema = z.enum(["create", "update", "complete", "cancel", "idea_to_task"]);
export const pendingContextDocumentActionKindSchema = z.enum(["update", "move", "delete"]);
export const pendingActionKindSchema = z.union([pendingTaskActionKindSchema, z.literal("delete_idea"), pendingContextDocumentActionKindSchema]);
const pendingTaskPreviewTextSchema = z.strictObject({
  value: z.string().refine((value) => countUnicodeCodePoints(value) <= 280, "Preview value must have at most 280 Unicode code points"),
  truncated: z.boolean(),
});
const pendingTaskUpdatePreviewFieldSchema = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("title"), value: pendingTaskPreviewTextSchema }),
  z.strictObject({ field: z.literal("project"), value: pendingTaskPreviewTextSchema }),
  z.strictObject({ field: z.literal("type"), value: recordTypeSchema }),
  z.strictObject({ field: z.literal("status"), value: taskStatusSchema }),
  z.strictObject({ field: z.literal("dueDate"), value: z.iso.date().nullable() }),
]);
const pendingTaskActionPreviewSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create"), title: pendingTaskPreviewTextSchema, project: pendingTaskPreviewTextSchema, type: recordTypeSchema, dueDate: z.iso.date().nullable() }),
  z.strictObject({ kind: z.literal("idea_to_task"), title: pendingTaskPreviewTextSchema, project: pendingTaskPreviewTextSchema, type: recordTypeSchema, dueDate: z.iso.date().nullable() }),
  z.strictObject({ kind: z.literal("update"), taskId: pendingTaskPreviewTextSchema, taskTitle: pendingTaskPreviewTextSchema, fields: z.array(pendingTaskUpdatePreviewFieldSchema).min(1).max(5) }),
  z.strictObject({ kind: z.literal("complete"), taskId: pendingTaskPreviewTextSchema, taskTitle: pendingTaskPreviewTextSchema }),
  z.strictObject({ kind: z.literal("cancel"), taskId: pendingTaskPreviewTextSchema, taskTitle: pendingTaskPreviewTextSchema }),
]);
const pendingTaskSummarySchema = z.string().min(1).refine(
  (value) => countUnicodeCodePoints(value) <= pendingTaskSummaryMaximumCodePoints,
  `Summary must have at most ${pendingTaskSummaryMaximumCodePoints} Unicode code points`,
);
export const pendingTaskReceiptSchema = z.strictObject({ confirmationId: z.string().min(1), actionKind: pendingTaskActionKindSchema, summary: pendingTaskSummarySchema, expiresAt: z.iso.datetime() });
export const pendingTaskActionSchema = pendingTaskReceiptSchema.extend({ preview: pendingTaskActionPreviewSchema });
const pendingIdeaDeletionActionSchema = z.strictObject({
  confirmationId: z.string().min(1), actionKind: z.literal("delete_idea"), summary: pendingTaskSummarySchema, expiresAt: z.iso.datetime(),
  preview: z.strictObject({ kind: z.literal("delete_idea"), ideaId: pendingTaskPreviewTextSchema, summary: pendingTaskPreviewTextSchema, revision: z.number().int().positive() }),
});
export const contextDocumentHandleSchema = z.custom<`/proc/context/${string}`>((value) => typeof value === "string" && value.startsWith("/proc/context/") && value.endsWith(".md"));
const pendingContextDocumentActionSchema = z.strictObject({
  confirmationId: z.string().min(1), actionKind: pendingContextDocumentActionKindSchema, summary: pendingTaskSummarySchema, expiresAt: z.iso.datetime(),
  preview: z.strictObject({
    path: contextDocumentHandleSchema,
    destination: contextDocumentHandleSchema.optional(),
    change: z.strictObject({
      removed: pendingTaskPreviewTextSchema,
      added: pendingTaskPreviewTextSchema,
    }).optional(),
  }),
});
export const pendingActionSchema = z.union([pendingTaskActionSchema, pendingIdeaDeletionActionSchema, pendingContextDocumentActionSchema]);
export const assistantChatEffectSchema = z.enum(["none", "pending_action_created", "business_write_committed", "outcome_unknown"]);
const legacyChatResponseSchema = z.strictObject({ messageId: z.string().min(1), response: z.string(), selectedProcessIds: z.array(agentManualProcessIdSchema), effect: z.literal("none") });
const assistantChatResponseSchema = z.strictObject({ messageId: z.string().min(1), response: z.string(), selectedProcessIds: z.array(assistantProcessIdSchema), pendingAction: pendingActionSchema.optional(), effect: assistantChatEffectSchema });
export const chatResponseSchema = z.union([legacyChatResponseSchema, assistantChatResponseSchema]);
export const feedbackRatingSchema = z.enum(["positive", "neutral", "negative"]);
export const feedbackSourceSchema = z.enum(["telegram", "cli", "test"]);
export const submitFeedbackRequestSchema = z.strictObject({ threadId: threadIdSchema, targetMessageId: z.string().min(1), rating: feedbackRatingSchema, source: feedbackSourceSchema });
export const submitFeedbackResponseSchema = z.strictObject({ accepted: z.literal(true), feedbackId: z.string().min(1), selectedProcessIds: z.array(agentManualProcessIdSchema) });
export const insightKindSchema = z.enum(["task_category", "routine_pattern", "energy_stress_marker", "automation_candidate"]);

// Сквозной классификатор записей (RFC §6.1; domain/classification.ts). `type` —
// закрытый enum (LLM не выдумает тип); `project` — непустая строка (список
// проектов — пользовательские данные vault, которые читает и интерпретирует
// агент. Application-слой валидирует DTO, но не разбирает Markdown-классификатор.
export const classifiedSchema = z.strictObject({
  project: z.string().min(1),
  type: recordTypeSchema,
});
export const taskPatchSchema = z.strictObject({
  title: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  type: recordTypeSchema.optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.iso.date().nullable().optional(),
}).refine((patch) => Object.keys(patch).length > 0, "Task patch must not be empty");
export const taskMutationDecisionRequestSchema = z.strictObject({});
export const ideaDeletionDecisionRequestSchema = z.strictObject({});
export const contextDocumentDecisionRequestSchema = z.strictObject({});
const taskSchema = classifiedSchema.extend({ id: z.string().min(1), userId: employeeIdSchema, title: z.string().min(1), status: taskStatusSchema, dueDate: z.iso.date().optional(), originIdeaId: z.string().min(1).optional(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), revision: z.number().int().positive() });
const taskMutationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["created", "updated", "unchanged"]), task: taskSchema }),
  z.strictObject({ outcome: z.literal("not_found") }),
  z.strictObject({ outcome: z.literal("conflict"), current: taskSchema.optional() }),
]);
export const taskMutationDecisionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.enum(["confirmed", "already_confirmed"]), outcome: taskMutationOutcomeSchema }),
  z.strictObject({ status: z.enum(["rejected", "already_rejected", "not_found", "owner_mismatch", "expired", "invalid_payload"]) }),
]);
export type TaskMutationDecisionRequest = z.infer<typeof taskMutationDecisionRequestSchema>;
export const ideaMutationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["deleted", "already_deleted", "restored", "unchanged"]), idea: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive() }).passthrough() }),
  z.strictObject({ outcome: z.enum(["not_found", "expired"]) }),
  z.strictObject({ outcome: z.literal("conflict"), current: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive() }).passthrough().optional() }),
]);
export const ideaDeletionDecisionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.enum(["confirmed", "already_confirmed"]), outcome: ideaMutationOutcomeSchema }),
  z.strictObject({ status: z.enum(["rejected", "already_rejected", "not_found", "expired", "invalid_payload"]) }),
]);
const contextDocumentMutationOutcomeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("updated"), path: contextDocumentHandleSchema, version: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("moved"), sourcePath: contextDocumentHandleSchema, destinationPath: contextDocumentHandleSchema, version: z.string().min(1), sourceVersion: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("deleted"), path: contextDocumentHandleSchema, restoreVersion: z.string().min(1) }),
  z.strictObject({ outcome: z.enum(["not_found", "conflict", "destination_conflict"]), path: contextDocumentHandleSchema, currentVersion: z.string().min(1).optional() }),
]);
export const contextDocumentDecisionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.enum(["confirmed", "already_confirmed"]), outcome: contextDocumentMutationOutcomeSchema }),
  z.strictObject({ status: z.enum(["rejected", "already_rejected", "not_found", "owner_mismatch", "expired", "invalid_payload"]) }),
]);
export type ContextDocumentDecisionRequest = z.infer<typeof contextDocumentDecisionRequestSchema>;
export type IdeaDeletionDecisionRequest = z.infer<typeof ideaDeletionDecisionRequestSchema>;
export const insightConfidenceSchema = z.enum(["low", "medium", "high"]);
const insightBaseSchema = z.object({ id: z.string().min(1), employeeId: employeeIdSchema, threadId: threadIdSchema, sourceMessageId: z.string().min(1), label: z.string().min(1), confidence: insightConfidenceSchema, createdAt: z.string().min(1) });
export const structuredInsightSchema = z.discriminatedUnion("kind", [
  insightBaseSchema.extend({ kind: z.literal("task_category"), category: z.enum(["planning", "reporting", "meetings", "coordination", "communication", "admin", "focus_work", "unknown"]) }),
  insightBaseSchema.extend({ kind: z.literal("routine_pattern"), patternType: z.enum(["meeting_overload", "context_switching", "manual_reporting", "coordination_overhead", "waiting_for_input", "unclear_priority", "other"]), interferesWith: z.string().min(1).optional() }),
  insightBaseSchema.extend({ kind: z.literal("energy_stress_marker"), marker: z.enum(["overload", "fatigue", "frustration", "focus_loss", "blocked_progress", "neutral"]), intensity: z.enum(["low", "medium", "high"]) }),
  insightBaseSchema.extend({ kind: z.literal("automation_candidate"), candidateType: z.enum(["report_generation", "meeting_reduction", "async_status_update", "task_routing", "template_or_checklist", "data_entry_reduction", "other"]), rationale: z.string().min(1) }),
]);
export const listInsightsRequestSchema = z.strictObject({ threadId: threadIdSchema.optional(), kind: insightKindSchema.optional() });

const onboardingStatusSchema = z.enum(["invite_issued", "invite_opened", "consent_accepted", "profile_completed"]);
export const issueInviteRequestSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1).max(512) });
export const issueInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1), status: onboardingStatusSchema, created: z.boolean() });
export const participantSummarySchema = z.strictObject({ employeeId: employeeIdSchema, status: onboardingStatusSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const listParticipantsRequestSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  after: z.string().min(1).max(2_048).optional(),
});
export const listParticipantsResponseSchema = z.strictObject({
  participants: z.array(participantSummarySchema).max(100),
  nextCursor: z.string().min(1).max(2_048).optional(),
});
export const usageMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "month must use YYYY-MM");
export const adminUsageRequestSchema = z.strictObject({ employeeId: employeeIdSchema, month: usageMonthSchema });
const usageTotalsResponseSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(),
  estimatedCostUsdMicros: z.number().int().nonnegative(), records: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(),
  cachedInputUnknownRecords: z.number().int().nonnegative(),
});
export const monthlyUsageResponseSchema = usageTotalsResponseSchema.extend({
  userId: employeeIdSchema,
  month: usageMonthSchema,
  bySource: z.array(usageTotalsResponseSchema.extend({ source: z.enum(["chat", "onboarding", "summarization", "guard"]) })).max(4),
});
export const contextDocumentVersionsRequestSchema = z.strictObject({
  employeeId: employeeIdSchema,
  path: contextDocumentHandleSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const contextDocumentVersionSchema = z.strictObject({
  version: z.string().min(1).max(512), updatedAt: z.iso.datetime(), size: z.number().int().nonnegative(),
});
export const contextDocumentVersionsResponseSchema = z.strictObject({
  path: contextDocumentHandleSchema, versions: z.array(contextDocumentVersionSchema).max(100),
});
export const restoreContextDocumentVersionRequestSchema = z.strictObject({
  employeeId: employeeIdSchema, path: contextDocumentHandleSchema, version: z.string().min(1).max(512),
});
export const restoreContextDocumentVersionBodySchema = restoreContextDocumentVersionRequestSchema.omit({ employeeId: true });
export const restoreContextDocumentVersionResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("restored"), path: contextDocumentHandleSchema, version: z.string().min(1).max(512) }),
  z.strictObject({ outcome: z.literal("not_found"), path: contextDocumentHandleSchema }),
]);
export const openInviteRequestSchema = z.strictObject({ inviteCode: z.string().min(1).max(512) });
export const openInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1), status: z.enum(["invite_opened", "consent_accepted", "profile_completed"]), privacyVersion: z.literal(currentPrivacyVersion), privacyExplanation: z.string().min(1) });
export const telegramIdentitySchema = z.strictObject({ chatId: z.string().min(1), userId: z.string().min(1).optional() });
export const redeemTelegramInviteRequestSchema = z.strictObject({ inviteCode: z.string().min(1).max(512), identity: telegramIdentitySchema });
export const redeemTelegramInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, threadId: threadIdSchema, privacyVersion: z.literal(currentPrivacyVersion), privacyExplanation: z.string().min(1) });
export const recordPrivacyExplanationShownRequestSchema = z.strictObject({ employeeId: employeeIdSchema });
export const acceptConsentRequestSchema = z.strictObject({ accepted: z.literal(true), source: feedbackSourceSchema, telegramIdentity: telegramIdentitySchema.optional() });
/** Employee-plane consent is bound exclusively to the bearer principal. */
export const acceptEmployeeConsentRequestSchema = acceptConsentRequestSchema.omit({ telegramIdentity: true });
export const acceptConsentResponseSchema = z.strictObject({ employeeId: employeeIdSchema, privacyVersion: z.literal(currentPrivacyVersion), acceptedAt: z.string().min(1) });
export const completeOnboardingRequestSchema = z.strictObject({
  preferredName: z.string().min(1).max(128).optional(), assistantName: z.string().min(1).max(128).optional(), addressForm: addressFormSchema.optional(), timezone: timezoneSchema.optional(),
  persona: personaSchema, responseLength: responseLengthSchema.optional(), preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  role: z.string().min(1).optional(), typicalTasks: z.array(z.string().min(1)).min(1).max(7).optional(), aiLevel: aiLevelSchema.optional(),
});
export const completeOnboardingResponseSchema = z.strictObject({ employeeId: employeeIdSchema, status: z.literal("profile_completed"), completion: z.enum(["new", "already"]), profile: userProfileSchema, firstResponse: z.string() });
export const onboardingFieldSchema = z.enum(["preferredName", "assistantName", "addressForm", "persona", "responseLength", "timezone"]);
export const onboardingAnswerRequestSchema = z.strictObject({ text: chatInputTextSchema });
export const onboardingProgressSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("needs_answer"), field: onboardingFieldSchema, prompt: z.string().min(1) }),
  z.strictObject({ status: z.literal("needs_choice"), field: z.enum(["addressForm", "persona", "responseLength", "timezone"]), prompt: z.string().min(1), choices: z.array(z.string().min(1)).min(2), allowFreeText: z.boolean().optional() }),
  z.strictObject({ status: z.literal("needs_confirmation"), deliveryKey: z.string().min(1).max(128), summary: z.strictObject({ preferredName: z.string().min(1), assistantName: z.string().min(1), addressForm: z.string().min(1), persona: z.string().min(1), responseLength: z.string().min(1), timezone: timezoneSchema }) }),
  z.strictObject({ status: z.literal("needs_correction"), prompt: z.string().min(1) }),
  z.strictObject({ status: z.literal("completed"), result: completeOnboardingResponseSchema }),
]);

export const errorCodeSchema = z.enum([
  "unauthorized", "forbidden", "invalid_request", "rate_limited", "context_overflow", "mutation_outcome_unknown", "internal_error",
  "invite_not_found", "employee_already_linked", "chat_already_linked", "participant_not_found",
  "session_not_found", "consent_required", "profile_not_found", "profile_already_completed", "message_not_found",
  "persistence_unavailable", "persistence_conflict",
]);
export const errorEnvelopeSchema = z.strictObject({ error: z.strictObject({ code: errorCodeSchema, message: z.string().min(1), requestId: z.string().min(1) }) });

export type ScheduleView = z.infer<typeof scheduleViewSchema>;
export type ChatInputModality = z.infer<typeof chatInputModalitySchema>;
export type ResponseChannel = z.infer<typeof responseChannelSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ServiceChatRequest = z.infer<typeof serviceChatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type PendingActionResponse = z.infer<typeof pendingActionSchema>;
export type SubmitFeedbackRequest = z.infer<typeof submitFeedbackRequestSchema>;
export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;
export type ListInsightsRequest = z.infer<typeof listInsightsRequestSchema>;
export type StructuredInsight = z.infer<typeof structuredInsightSchema>;
export type IssueInviteRequest = z.infer<typeof issueInviteRequestSchema>;
export type IssueInviteResponse = z.infer<typeof issueInviteResponseSchema>;
export type ParticipantSummaryResponse = z.infer<typeof participantSummarySchema>;
export type ListParticipantsRequest = z.infer<typeof listParticipantsRequestSchema>;
export type ListParticipantsResponse = z.infer<typeof listParticipantsResponseSchema>;
export type AdminUsageRequest = z.infer<typeof adminUsageRequestSchema>;
export type MonthlyUsageResponse = z.infer<typeof monthlyUsageResponseSchema>;
export type ContextDocumentVersionsRequest = z.infer<typeof contextDocumentVersionsRequestSchema>;
export type ContextDocumentVersionsResponse = z.infer<typeof contextDocumentVersionsResponseSchema>;
export type RestoreContextDocumentVersionRequest = z.infer<typeof restoreContextDocumentVersionRequestSchema>;
export type OpenInviteRequest = z.infer<typeof openInviteRequestSchema>;
export type OpenInviteResponse = z.infer<typeof openInviteResponseSchema>;
export type RedeemTelegramInviteRequest = z.infer<typeof redeemTelegramInviteRequestSchema>;
export type RedeemTelegramInviteResponse = z.infer<typeof redeemTelegramInviteResponseSchema>;
export type RecordPrivacyExplanationShownRequest = z.infer<typeof recordPrivacyExplanationShownRequestSchema>;
export type AcceptConsentRequest = z.infer<typeof acceptConsentRequestSchema>;
export type AcceptEmployeeConsentRequest = z.infer<typeof acceptEmployeeConsentRequestSchema>;
export type AcceptConsentResponse = z.infer<typeof acceptConsentResponseSchema>;
export type CompleteOnboardingRequest = z.infer<typeof completeOnboardingRequestSchema>;
export type CompleteOnboardingResponse = z.infer<typeof completeOnboardingResponseSchema>;
export type OnboardingAnswerRequest = z.infer<typeof onboardingAnswerRequestSchema>;
export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type ApiErrorCode = z.infer<typeof errorCodeSchema>;
export type ApiErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
