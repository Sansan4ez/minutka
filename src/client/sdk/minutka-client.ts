import type { MinutkaApi } from "../../server/http/in-process-server.js";
import { z } from "zod";

const persona = z.enum(["support", "efficiency"], {
  error: "persona must be support or efficiency",
});
const aiLevel = z.enum(["beginner", "intermediate", "advanced"]);
const responseLength = z.enum(["short", "balanced", "detailed"]);
const agentManualProcessId = z.enum([
  "core",
  "onboarding",
  "consent_and_privacy",
  "evening_reflection",
  "workday_guardrails",
  "insight_extraction",
  "feedback",
]);
const userProfile = z.strictObject({
  employeeId: z.string().min(1),
  role: z.string().min(1),
  typicalTasks: z.array(z.string().min(1)).min(1).max(7),
  persona,
  aiLevel,
  responseLength,
  preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const chatRequest = z.strictObject({
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string().min(1),
});

const chatResponse = z.strictObject({
  messageId: z.string(),
  response: z.string(),
  selectedProcessIds: z.array(agentManualProcessId),
});

const submitFeedbackRequest = z.strictObject({
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  targetMessageId: z.string().min(1),
  rating: z.enum(["positive", "neutral", "negative"]),
  source: z.enum(["telegram", "cli", "test"]),
});

const submitFeedbackResponse = z.strictObject({
  accepted: z.literal(true),
  feedbackId: z.string().min(1),
  selectedProcessIds: z.array(agentManualProcessId),
});

const insightKind = z.enum([
  "task_category",
  "routine_pattern",
  "energy_stress_marker",
  "automation_candidate",
]);
const insightConfidence = z.enum(["low", "medium", "high"]);
const insightBase = z.object({
  id: z.string().min(1),
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  label: z.string().min(1),
  confidence: insightConfidence,
  createdAt: z.string().min(1),
});
const structuredInsight = z.discriminatedUnion("kind", [
  insightBase.extend({
    kind: z.literal("task_category"),
    category: z.enum([
      "planning",
      "reporting",
      "meetings",
      "coordination",
      "communication",
      "admin",
      "focus_work",
      "unknown",
    ]),
  }),
  insightBase.extend({
    kind: z.literal("routine_pattern"),
    patternType: z.enum([
      "meeting_overload",
      "context_switching",
      "manual_reporting",
      "coordination_overhead",
      "waiting_for_input",
      "unclear_priority",
      "other",
    ]),
    interferesWith: z.string().min(1).optional(),
  }),
  insightBase.extend({
    kind: z.literal("energy_stress_marker"),
    marker: z.enum([
      "overload",
      "fatigue",
      "frustration",
      "focus_loss",
      "blocked_progress",
      "neutral",
    ]),
    intensity: z.enum(["low", "medium", "high"]),
  }),
  insightBase.extend({
    kind: z.literal("automation_candidate"),
    candidateType: z.enum([
      "report_generation",
      "meeting_reduction",
      "async_status_update",
      "task_routing",
      "template_or_checklist",
      "data_entry_reduction",
      "other",
    ]),
    rationale: z.string().min(1),
  }),
]);

const listInsightsRequest = z.strictObject({
  employeeId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  kind: insightKind.optional(),
});

const listInsightsResponse = z.array(structuredInsight);

const issueInviteRequest = z.strictObject({
  employeeId: z.string().min(1),
  inviteCode: z.string().min(1),
});

const issueInviteResponse = z.strictObject({
  employeeId: z.string().min(1),
  inviteCode: z.string().min(1),
  status: z.enum(["invite_issued", "invite_opened", "consent_accepted", "profile_completed"]),
  created: z.boolean(),
});

const openInviteRequest = z.strictObject({
  inviteCode: z.string().min(1),
});

const openInviteResponse = z.strictObject({
  employeeId: z.string().min(1),
  inviteCode: z.string().min(1),
  status: z.enum(["invite_opened", "consent_accepted", "profile_completed"]),
  privacyVersion: z.literal("privacy-v1"),
  privacyExplanation: z.string().min(1),
});

const acceptConsentRequest = z.strictObject({
  employeeId: z.string().min(1),
  accepted: z.literal(true),
  source: z.enum(["cli", "telegram", "test"]),
});

const acceptConsentResponse = z.strictObject({
  employeeId: z.string().min(1),
  privacyVersion: z.literal("privacy-v1"),
  acceptedAt: z.string().min(1),
});

const completeOnboardingRequest = z.strictObject({
  employeeId: z.string().min(1),
  role: z.string().min(1),
  typicalTasks: z.array(z.string().min(1)).min(1).max(7),
  persona,
  aiLevel,
  responseLength: responseLength.optional(),
  preferredCheckinsPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

const completeOnboardingResponse = z.strictObject({
  employeeId: z.string().min(1),
  status: z.literal("profile_completed"),
  profile: userProfile,
  firstResponse: z.string(),
});

const getProfileRequest = z.strictObject({
  employeeId: z.string().min(1),
});

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  return result.data;
}

export class MinutkaClient {
  constructor(private readonly api: MinutkaApi) {}

  async chat(input: z.input<typeof chatRequest>) {
    const validated = validate(chatRequest, input, "chat request");
    const result = await this.api.chat(validated);
    return validate(chatResponse, result, "chat response");
  }

  async issueInvite(input: z.input<typeof issueInviteRequest>) {
    const validated = validate(issueInviteRequest, input, "issueInvite request");
    const result = await this.api.issueInvite(validated);
    return validate(issueInviteResponse, result, "issueInvite response");
  }

  async openInvite(input: z.input<typeof openInviteRequest>) {
    const validated = validate(openInviteRequest, input, "openInvite request");
    const result = await this.api.openInvite(validated);
    return validate(openInviteResponse, result, "openInvite response");
  }

  async acceptConsent(input: z.input<typeof acceptConsentRequest>) {
    const validated = validate(acceptConsentRequest, input, "acceptConsent request");
    const result = await this.api.acceptConsent(validated);
    return validate(acceptConsentResponse, result, "acceptConsent response");
  }

  async completeOnboarding(input: z.input<typeof completeOnboardingRequest>) {
    const validated = validate(
      completeOnboardingRequest,
      input,
      "completeOnboarding request",
    );
    const result = await this.api.completeOnboarding(validated);
    return validate(
      completeOnboardingResponse,
      result,
      "completeOnboarding response",
    );
  }

  async getProfile(input: z.input<typeof getProfileRequest>) {
    const validated = validate(getProfileRequest, input, "getProfile request");
    const result = await this.api.getProfile(validated);
    return validate(userProfile, result, "getProfile response");
  }

  async listInsights(input: z.input<typeof listInsightsRequest>) {
    const validated = validate(listInsightsRequest, input, "listInsights request");
    const result = await this.api.listInsights(validated);
    return validate(listInsightsResponse, result, "listInsights response");
  }

  async submitFeedback(input: z.input<typeof submitFeedbackRequest>) {
    const validated = validate(submitFeedbackRequest, input, "submitFeedback request");
    const result = await this.api.submitFeedback(validated);
    return validate(submitFeedbackResponse, result, "submitFeedback response");
  }
}

export type IssueInviteResult = z.infer<typeof issueInviteResponse>;
export type OpenInviteResult = z.infer<typeof openInviteResponse>;
export type AcceptConsentResult = z.infer<typeof acceptConsentResponse>;
export type ChatResult = z.infer<typeof chatResponse>;
export type CompleteOnboardingResult = z.infer<typeof completeOnboardingResponse>;
export type SubmitFeedbackResult = z.infer<typeof submitFeedbackResponse>;
export type UserProfileResult = z.infer<typeof userProfile>;
export type StructuredInsightResult = z.infer<typeof structuredInsight>;
