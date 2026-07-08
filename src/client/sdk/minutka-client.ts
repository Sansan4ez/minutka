import type { MinutkaApi } from "../../server/http/in-process-server.js";
import { z } from "zod";

const persona = z.enum(["support", "efficiency"], {
  error: "persona must be support or efficiency",
});
const aiLevel = z.enum(["beginner", "intermediate", "advanced"]);
const responseLength = z.enum(["short", "balanced", "detailed"]);
const onboardingStatus = z.enum([
  "invite_opened",
  "consent_accepted",
  "profile_completed",
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
});

const openInviteRequest = z.strictObject({
  inviteCode: z.string().min(1),
  employeeId: z.string().min(1).optional(),
});

const openInviteResponse = z.strictObject({
  employeeId: z.string().min(1),
  inviteCode: z.string().min(1),
  status: onboardingStatus,
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
}

export type OpenInviteResult = z.infer<typeof openInviteResponse>;
export type AcceptConsentResult = z.infer<typeof acceptConsentResponse>;
export type CompleteOnboardingResult = z.infer<typeof completeOnboardingResponse>;
export type UserProfileResult = z.infer<typeof userProfile>;
