import type {
  AiLevel,
  Consent,
  OnboardingStatus,
  Participant,
  Persona,
  ResponseLengthPreference,
  UserProfile,
} from "../domain/employee.js";
import {
  currentPrivacyVersion,
  privacyExplanation,
} from "../domain/privacy.js";
import type { InMemoryWorld, ChatMessage } from "./in-memory-world.js";
import { createInMemoryProfileStore } from "./in-memory-profile-store.js";
import { buildMinutkaProfileContext } from "./minutka-context-builder.js";
import type { ProfileStore } from "./profile-store.js";

export type ChatInput = {
  employeeId: string;
  threadId: string;
  text: string;
};

export type ChatResult = {
  messageId: string;
  response: string;
};

export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: "chat" | "onboarding_first_response";
};

/**
 * Генератор ответов агента.
 * В executable specs инжектируется mock-runner,
 * чтобы проверки не зависели от LLM/API.
 * В runtime используется Mastra Agent runner (src/mastra/agent-runner.ts).
 */
export type AgentRunner = (
  input: ChatInput,
  context?: AgentRunContext,
) => Promise<string>;

export type OpenInviteInput = {
  inviteCode: string;
  employeeId?: string;
};

export type OpenInviteResult = {
  employeeId: string;
  inviteCode: string;
  status: OnboardingStatus;
  privacyVersion: typeof currentPrivacyVersion;
  privacyExplanation: string;
};

export type AcceptConsentInput = {
  employeeId: string;
  accepted: true;
  source: "cli" | "telegram" | "test";
};

export type AcceptConsentResult = {
  employeeId: string;
  privacyVersion: typeof currentPrivacyVersion;
  acceptedAt: string;
};

export type CompleteOnboardingInput = {
  employeeId: string;
  role: string;
  typicalTasks: string[];
  persona: Persona;
  aiLevel: AiLevel;
  responseLength?: ResponseLengthPreference;
  preferredCheckinsPerDay?: 1 | 2 | 3;
};

export type CompleteOnboardingResult = {
  employeeId: string;
  status: "profile_completed";
  profile: UserProfile;
  firstResponse: string;
};

export class MinutkaService {
  constructor(
    private readonly world: InMemoryWorld,
    private readonly agentRunner: AgentRunner,
    private readonly profileStore: ProfileStore = createInMemoryProfileStore(world),
  ) {}

  async openInvite(input: OpenInviteInput): Promise<OpenInviteResult> {
    if (!input.inviteCode.trim()) throw new Error("inviteCode is required");

    let participant = await this.profileStore.getParticipantByInvite(
      input.inviteCode,
    );

    if (participant && input.employeeId && participant.employeeId !== input.employeeId) {
      throw new Error("invite already belongs to another employee");
    }

    if (!participant) {
      const timestamp = this.world.now();
      participant = {
        employeeId: input.employeeId ?? this.nextEmployeeId(),
        inviteCode: input.inviteCode,
        status: "invite_opened",
        createdAt: timestamp,
        updatedAt: timestamp,
      } satisfies Participant;
      await this.profileStore.saveParticipant(participant);
      this.world.events.push({
        type: "InviteOpened",
        employeeId: participant.employeeId,
        inviteCode: participant.inviteCode,
        timestamp,
      });
    }

    this.world.events.push({
      type: "PrivacyExplanationShown",
      employeeId: participant.employeeId,
      privacyVersion: currentPrivacyVersion,
      timestamp: this.world.now(),
    });

    return {
      employeeId: participant.employeeId,
      inviteCode: participant.inviteCode,
      status: participant.status,
      privacyVersion: currentPrivacyVersion,
      privacyExplanation,
    };
  }

  async acceptConsent(input: AcceptConsentInput): Promise<AcceptConsentResult> {
    const participant = await this.requireParticipant(input.employeeId);
    if (input.accepted !== true) {
      throw new Error("privacy consent must be explicitly accepted");
    }

    const existing = await this.profileStore.getConsent(input.employeeId);
    if (existing) {
      return {
        employeeId: existing.employeeId,
        privacyVersion: existing.privacyVersion,
        acceptedAt: existing.acceptedAt,
      };
    }

    const timestamp = this.world.now();
    const consent: Consent = {
      employeeId: input.employeeId,
      privacyVersion: currentPrivacyVersion,
      acceptedAt: timestamp,
      explanationShownAt:
        this.lastPrivacyExplanationShownAt(input.employeeId) ?? timestamp,
      source: input.source,
    };
    await this.profileStore.saveConsent(consent);

    if (participant.status !== "profile_completed") {
      await this.profileStore.saveParticipant({
        ...participant,
        status: "consent_accepted",
        updatedAt: timestamp,
      });
    }

    this.world.events.push({
      type: "ConsentAccepted",
      employeeId: input.employeeId,
      privacyVersion: currentPrivacyVersion,
      timestamp,
    });

    return {
      employeeId: consent.employeeId,
      privacyVersion: consent.privacyVersion,
      acceptedAt: consent.acceptedAt,
    };
  }

  async completeOnboarding(
    input: CompleteOnboardingInput,
  ): Promise<CompleteOnboardingResult> {
    const participant = await this.requireParticipant(input.employeeId);
    const consent = await this.profileStore.getConsent(input.employeeId);
    if (!consent) {
      throw new Error("consent is required before onboarding can be completed");
    }

    this.validateProfileInput(input);

    const existingProfile = await this.profileStore.getProfile(input.employeeId);
    const timestamp = this.world.now();
    const profile: UserProfile = {
      employeeId: input.employeeId,
      role: input.role.trim(),
      typicalTasks: input.typicalTasks.map((task) => task.trim()),
      persona: input.persona,
      aiLevel: input.aiLevel,
      responseLength: input.responseLength ?? "balanced",
      preferredCheckinsPerDay: input.preferredCheckinsPerDay,
      createdAt: existingProfile?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await this.profileStore.saveProfile(profile);

    const wasCompleted = participant.status === "profile_completed";
    await this.profileStore.saveParticipant({
      ...participant,
      status: "profile_completed",
      updatedAt: timestamp,
    });

    const changedFields = getChangedFields(existingProfile, profile);
    this.world.events.push({
      type: "UserProfileUpdated",
      employeeId: input.employeeId,
      changedFields,
      timestamp,
    });

    if (!wasCompleted) {
      this.world.events.push({
        type: "OnboardingCompleted",
        employeeId: input.employeeId,
        persona: input.persona,
        timestamp,
      });
    }

    const systemContext = buildMinutkaProfileContext(profile);
    const firstResponse = await this.agentRunner(
      {
        employeeId: input.employeeId,
        threadId: input.employeeId,
        text: "Профиль онбординга заполнен. Дай короткое первое сообщение сотруднику.",
      },
      { profile, systemContext, purpose: "onboarding_first_response" },
    );

    return {
      employeeId: input.employeeId,
      status: "profile_completed",
      profile,
      firstResponse,
    };
  }

  async getProfile(input: { employeeId: string }): Promise<UserProfile> {
    const profile = await this.profileStore.getProfile(input.employeeId);
    if (!profile) throw new Error("profile not found");
    return profile;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    this.world.counters.message++;
    const messageId = `msg_${this.world.counters.message}`;
    const timestamp = this.world.now();

    this.world.events.push({
      type: "ChatMessageReceived",
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      timestamp,
    });

    const profile = await this.profileStore.getProfile(input.employeeId);
    const response = await this.agentRunner(
      input,
      profile
        ? {
            profile,
            systemContext: buildMinutkaProfileContext(profile),
            purpose: "chat",
          }
        : { purpose: "chat" },
    );

    this.world.events.push({
      type: "ChatResponseGenerated",
      employeeId: input.employeeId,
      threadId: input.threadId,
      response,
      timestamp: this.world.now(),
    });

    const message: ChatMessage = {
      id: messageId,
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      response,
      timestamp,
    };
    this.world.messages.push(message);

    return { messageId, response };
  }

  private nextEmployeeId() {
    this.world.counters.participant++;
    return `emp_${this.world.counters.participant}`;
  }

  private async requireParticipant(employeeId: string) {
    const participant = await this.profileStore.getParticipant(employeeId);
    if (!participant) throw new Error("participant not found");
    return participant;
  }

  private validateProfileInput(input: CompleteOnboardingInput) {
    if (!input.role.trim()) throw new Error("role is required");
    const tasks = input.typicalTasks.map((task) => task.trim());
    if (tasks.length < 1 || tasks.length > 7 || tasks.some((task) => !task)) {
      throw new Error("typicalTasks must contain 1 to 7 non-empty tasks");
    }
  }

  private lastPrivacyExplanationShownAt(employeeId: string) {
    return [...this.world.events]
      .reverse()
      .find(
        (event) =>
          event.type === "PrivacyExplanationShown" &&
          event.employeeId === employeeId &&
          event.privacyVersion === currentPrivacyVersion,
      )?.timestamp;
  }
}

const trackedProfileFields = [
  "role",
  "typicalTasks",
  "persona",
  "aiLevel",
  "responseLength",
  "preferredCheckinsPerDay",
] as const;

function getChangedFields(
  existing: UserProfile | undefined,
  next: UserProfile,
): string[] {
  if (!existing) {
    return trackedProfileFields.filter((field) => next[field] !== undefined);
  }
  return trackedProfileFields.filter(
    (field) => JSON.stringify(existing[field]) !== JSON.stringify(next[field]),
  );
}
