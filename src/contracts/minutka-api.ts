import { z } from "zod";
import { currentPrivacyVersion } from "../domain/privacy.js";
import { chatInputFitsCharacterLimit, maxChatInputCharacters } from "../shared/chat-limits.js";
import { normalizeIanaTimezone } from "../shared/iana-timezone.js";
import { assistantProcessIds } from "../domain/assistant-process.js";

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
export const pendingTaskActionKindSchema = z.enum(["create", "update", "complete", "cancel", "idea_to_task"]);
export const pendingTaskActionSchema = z.strictObject({ confirmationId: z.string().min(1), actionKind: pendingTaskActionKindSchema, summary: z.string().min(1).max(280), expiresAt: z.iso.datetime() });
export const assistantChatEffectSchema = z.enum(["none", "pending_action_created", "business_write_committed", "outcome_unknown"]);
const legacyChatResponseSchema = z.strictObject({ messageId: z.string().min(1), response: z.string(), selectedProcessIds: z.array(agentManualProcessIdSchema), effect: z.literal("none") });
const assistantChatResponseSchema = z.strictObject({ messageId: z.string().min(1), response: z.string(), selectedProcessIds: z.array(assistantProcessIdSchema), pendingAction: pendingTaskActionSchema.optional(), effect: assistantChatEffectSchema });
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
export const recordTypeSchema = z.enum([
  "money",
  "development",
  "content",
  "people",
  "operations",
  "knowledge",
  "personal",
]);
export const classifiedSchema = z.strictObject({
  project: z.string().min(1),
  type: recordTypeSchema,
});
export const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
export const taskPatchSchema = z.strictObject({
  title: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  type: recordTypeSchema.optional(),
  status: taskStatusSchema.optional(),
  dueDate: z.iso.date().nullable().optional(),
}).refine((patch) => Object.keys(patch).length > 0, "Task patch must not be empty");
export const taskMutationDecisionRequestSchema = z.strictObject({});
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
export const insightConfidenceSchema = z.enum(["low", "medium", "high"]);
const insightBaseSchema = z.object({ id: z.string().min(1), employeeId: employeeIdSchema, threadId: threadIdSchema, sourceMessageId: z.string().min(1), label: z.string().min(1), confidence: insightConfidenceSchema, createdAt: z.string().min(1) });
export const structuredInsightSchema = z.discriminatedUnion("kind", [
  insightBaseSchema.extend({ kind: z.literal("task_category"), category: z.enum(["planning", "reporting", "meetings", "coordination", "communication", "admin", "focus_work", "unknown"]) }),
  insightBaseSchema.extend({ kind: z.literal("routine_pattern"), patternType: z.enum(["meeting_overload", "context_switching", "manual_reporting", "coordination_overhead", "waiting_for_input", "unclear_priority", "other"]), interferesWith: z.string().min(1).optional() }),
  insightBaseSchema.extend({ kind: z.literal("energy_stress_marker"), marker: z.enum(["overload", "fatigue", "frustration", "focus_loss", "blocked_progress", "neutral"]), intensity: z.enum(["low", "medium", "high"]) }),
  insightBaseSchema.extend({ kind: z.literal("automation_candidate"), candidateType: z.enum(["report_generation", "meeting_reduction", "async_status_update", "task_routing", "template_or_checklist", "data_entry_reduction", "other"]), rationale: z.string().min(1) }),
]);
export const listInsightsRequestSchema = z.strictObject({ threadId: threadIdSchema.optional(), kind: insightKindSchema.optional() });

export const issueInviteRequestSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1).max(512) });
export const issueInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1), status: z.enum(["invite_issued", "invite_opened", "consent_accepted", "profile_completed"]), created: z.boolean() });
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
  z.strictObject({ status: z.literal("needs_choice"), field: z.enum(["addressForm", "persona", "responseLength"]), prompt: z.string().min(1), choices: z.array(z.string().min(1)).min(2) }),
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

export type ChatInputModality = z.infer<typeof chatInputModalitySchema>;
export type ResponseChannel = z.infer<typeof responseChannelSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ServiceChatRequest = z.infer<typeof serviceChatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type SubmitFeedbackRequest = z.infer<typeof submitFeedbackRequestSchema>;
export type SubmitFeedbackResponse = z.infer<typeof submitFeedbackResponseSchema>;
export type ListInsightsRequest = z.infer<typeof listInsightsRequestSchema>;
export type StructuredInsight = z.infer<typeof structuredInsightSchema>;
export type IssueInviteRequest = z.infer<typeof issueInviteRequestSchema>;
export type IssueInviteResponse = z.infer<typeof issueInviteResponseSchema>;
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
