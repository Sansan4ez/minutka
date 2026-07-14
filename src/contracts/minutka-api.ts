import { z } from "zod";

/** Stable, transport-neutral DTOs for the versioned Minutka application API. */
export const personaSchema = z.enum(["support", "efficiency"]);
export const aiLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export const responseLengthSchema = z.enum(["short", "balanced", "detailed"]);
export const agentManualProcessIdSchema = z.enum(["core", "onboarding", "consent_and_privacy", "evening_reflection", "workday_guardrails", "insight_extraction", "feedback"]);
export const employeeIdSchema = z.string().min(1).max(128);
export const threadIdSchema = z.string().min(1).max(128);

export const userProfileSchema = z.strictObject({
  employeeId: employeeIdSchema,
  role: z.string().min(1),
  typicalTasks: z.array(z.string().min(1)).min(1).max(7),
  persona: personaSchema,
  aiLevel: aiLevelSchema,
  responseLength: responseLengthSchema,
  preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const chatRequestSchema = z.strictObject({ threadId: threadIdSchema, text: z.string().min(1).max(60_000) });
export const chatResponseSchema = z.strictObject({ messageId: z.string().min(1), response: z.string(), selectedProcessIds: z.array(agentManualProcessIdSchema) });
export const feedbackRatingSchema = z.enum(["positive", "neutral", "negative"]);
export const feedbackSourceSchema = z.enum(["telegram", "cli", "test"]);
export const submitFeedbackRequestSchema = z.strictObject({ threadId: threadIdSchema, targetMessageId: z.string().min(1), rating: feedbackRatingSchema, source: feedbackSourceSchema });
export const submitFeedbackResponseSchema = z.strictObject({ accepted: z.literal(true), feedbackId: z.string().min(1), selectedProcessIds: z.array(agentManualProcessIdSchema) });
export const insightKindSchema = z.enum(["task_category", "routine_pattern", "energy_stress_marker", "automation_candidate"]);
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
export const openInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, inviteCode: z.string().min(1), status: z.enum(["invite_opened", "consent_accepted", "profile_completed"]), privacyVersion: z.literal("privacy-v1"), privacyExplanation: z.string().min(1) });
export const telegramIdentitySchema = z.strictObject({ chatId: z.string().min(1), userId: z.string().min(1).optional() });
export const redeemTelegramInviteRequestSchema = z.strictObject({ inviteCode: z.string().min(1).max(512), identity: telegramIdentitySchema });
export const redeemTelegramInviteResponseSchema = z.strictObject({ employeeId: employeeIdSchema, threadId: threadIdSchema, privacyVersion: z.literal("privacy-v1"), privacyExplanation: z.string().min(1) });
export const recordPrivacyExplanationShownRequestSchema = z.strictObject({ employeeId: employeeIdSchema });
export const acceptConsentRequestSchema = z.strictObject({ accepted: z.literal(true), source: feedbackSourceSchema, telegramIdentity: telegramIdentitySchema.optional() });
/** Employee-plane consent is bound exclusively to the bearer principal. */
export const acceptEmployeeConsentRequestSchema = acceptConsentRequestSchema.omit({ telegramIdentity: true });
export const acceptConsentResponseSchema = z.strictObject({ employeeId: employeeIdSchema, privacyVersion: z.literal("privacy-v1"), acceptedAt: z.string().min(1) });
export const completeOnboardingRequestSchema = z.strictObject({ role: z.string().min(1), typicalTasks: z.array(z.string().min(1)).min(1).max(7), persona: personaSchema, aiLevel: aiLevelSchema, responseLength: responseLengthSchema.optional(), preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() });
export const completeOnboardingResponseSchema = z.strictObject({ employeeId: employeeIdSchema, status: z.literal("profile_completed"), profile: userProfileSchema, firstResponse: z.string() });
export const onboardingFieldSchema = z.enum(["role", "typicalTasks", "persona", "aiLevel"]);
export const onboardingAnswerRequestSchema = z.strictObject({ text: z.string().min(1).max(4_096) });
export const onboardingProgressSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("needs_answer"), field: onboardingFieldSchema, prompt: z.string().min(1) }),
  z.strictObject({ status: z.literal("needs_choice"), field: z.enum(["persona", "aiLevel"]), prompt: z.string().min(1), choices: z.array(z.string().min(1)).min(2) }),
  z.strictObject({ status: z.literal("needs_confirmation"), summary: z.strictObject({ role: z.string().min(1), typicalTasks: z.array(z.string().min(1)).min(1).max(7), persona: z.string().min(1), aiLevel: z.string().min(1) }) }),
  z.strictObject({ status: z.literal("needs_correction"), prompt: z.string().min(1) }),
  z.strictObject({ status: z.literal("completed"), result: completeOnboardingResponseSchema }),
]);

export const errorCodeSchema = z.enum([
  "unauthorized", "forbidden", "invalid_request", "rate_limited", "internal_error",
  "invite_not_found", "employee_already_linked", "chat_already_linked", "participant_not_found",
  "session_not_found", "consent_required", "profile_not_found", "profile_already_completed", "message_not_found",
  "persistence_unavailable", "persistence_conflict",
]);
export const errorEnvelopeSchema = z.strictObject({ error: z.strictObject({ code: errorCodeSchema, message: z.string().min(1), requestId: z.string().min(1) }) });

export type ChatRequest = z.infer<typeof chatRequestSchema>;
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
