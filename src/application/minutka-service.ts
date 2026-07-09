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
import { createInMemoryConversationMemory } from "./in-memory-conversation-memory.js";
import { createInMemoryInsightStore } from "./in-memory-insight-store.js";
import { createInMemoryProfileStore } from "./in-memory-profile-store.js";
import type {
  AgentManual,
  AgentManualProcessId,
  AgentManualPurpose,
} from "./agent-manual-types.js";
import { loadAgentManualFromDisk } from "./agent-manual-loader.js";
import {
  createMinutkaContextBuilder,
  type MinutkaContextBuilderLike,
} from "./minutka-context-builder.js";
import type { AgentManualRouter } from "./agent-manual-resolver.js";
import type {
  ConversationMemoryStore,
  ConversationTurn,
} from "./conversation-memory-store.js";
import type { InsightExtractor } from "./insight-extractor.js";
import type { InsightStore } from "./insight-store.js";
import type { ProfileStore } from "./profile-store.js";
import {
  buildBoundaryResponse,
  sanitizeConversationDecision,
  type ConversationDecisionRouter,
} from "./conversation-decision-router.js";
import type {
  InsightKind,
  StructuredInsight,
  StructuredInsightDraft,
} from "../domain/insights.js";
import type { ConversationDecision } from "../domain/conversation-decision.js";

export type ChatInput = {
  employeeId: string;
  threadId: string;
  text: string;
};

export type ChatResult = {
  messageId: string;
  response: string;
  selectedProcessIds: AgentManualProcessId[];
};

export type AgentMemoryContext = {
  resourceId: string;
  threadId: string;
  recentTurns: ConversationTurn[];
};

export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: AgentManualPurpose;
  memory?: AgentMemoryContext;
  decision?: ConversationDecision;
  selectedProcessIds?: AgentManualProcessId[];
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

export type ListInsightsInput = {
  employeeId?: string;
  threadId?: string;
  kind?: InsightKind;
};

export type SubmitFeedbackInput = {
  employeeId: string;
  threadId: string;
  text: string;
};

export type SubmitFeedbackResult = {
  accepted: true;
  selectedProcessIds: AgentManualProcessId[];
};

export type MinutkaServiceDeps = {
  profileStore?: ProfileStore;
  conversationMemory?: ConversationMemoryStore;
  insightStore?: InsightStore;
  insightExtractor?: InsightExtractor;
  contextBuilder?: MinutkaContextBuilderLike;
  agentManualRouter?: AgentManualRouter;
  conversationDecisionRouter?: ConversationDecisionRouter;
};

export class MinutkaService {
  private readonly profileStore: ProfileStore;
  private readonly conversationMemory: ConversationMemoryStore;
  private readonly insightStore: InsightStore;
  private readonly insightExtractor?: InsightExtractor;
  private readonly contextBuilder: MinutkaContextBuilderLike;
  private readonly conversationDecisionRouter?: ConversationDecisionRouter;
  private readonly manual: AgentManual;

  constructor(
    private readonly world: InMemoryWorld,
    private readonly agentRunner: AgentRunner,
    depsOrProfileStore: MinutkaServiceDeps | ProfileStore = {},
  ) {
    const deps = isProfileStore(depsOrProfileStore)
      ? { profileStore: depsOrProfileStore }
      : depsOrProfileStore;
    this.profileStore = deps.profileStore ?? createInMemoryProfileStore(world);
    this.conversationMemory =
      deps.conversationMemory ?? createInMemoryConversationMemory(world);
    this.insightStore = deps.insightStore ?? createInMemoryInsightStore(world);
    this.insightExtractor = deps.insightExtractor;
    this.manual = loadRequiredAgentManual(world);
    this.conversationDecisionRouter = deps.conversationDecisionRouter;
    this.contextBuilder =
      deps.contextBuilder ?? createDefaultContextBuilder(this.manual, deps.agentManualRouter);
  }

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

    const builtContext = await this.contextBuilder.build({
      purpose: "onboarding_first_response",
      text: "Профиль онбординга заполнен. Дай короткое первое сообщение сотруднику.",
      profile,
    });
    const firstResponse = await this.agentRunner(
      {
        employeeId: input.employeeId,
        threadId: input.employeeId,
        text: "Профиль онбординга заполнен. Дай короткое первое сообщение сотруднику.",
      },
      {
        profile,
        systemContext: builtContext.systemContext,
        selectedProcessIds: builtContext.selectedProcessIds,
        purpose: "onboarding_first_response",
      },
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
    const recentTurns = await this.conversationMemory.getRecentTurns({
      employeeId: input.employeeId,
      threadId: input.threadId,
      limit: 10,
    });
    const decision = await this.routeConversationDecisionSafely({
      purpose: "chat",
      text: input.text,
      profile,
      recentTurns,
    });
    const builtContext = await this.contextBuilder.build({
      purpose: "chat",
      text: input.text,
      profile,
      recentTurns,
      selectedProcessIds: decision.selectedProcessIds,
    });

    let response: string;
    if (decision.workDecision.mode === "boundary") {
      response = buildBoundaryResponse(decision.workDecision, profile);
      this.world.events.push({
        type: "WorkBoundaryApplied",
        employeeId: input.employeeId,
        threadId: input.threadId,
        reason: decision.workDecision.reason,
        selectedProcessIds: builtContext.selectedProcessIds,
        timestamp: this.world.now(),
      });
    } else {
      response = await this.agentRunner(input, {
        ...(profile ? { profile } : {}),
        systemContext: builtContext.systemContext,
        selectedProcessIds: builtContext.selectedProcessIds,
        purpose: "chat",
        memory: {
          resourceId: input.employeeId,
          threadId: input.threadId,
          recentTurns,
        },
        decision,
      });
    }

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

    if (decision.insightDecision.candidate) {
      try {
        const insightExtractor = this.requireInsightExtractor();
        const extraction = await insightExtractor({
          employeeId: input.employeeId,
          threadId: input.threadId,
          messageId,
          text: input.text,
          response,
          profile,
          recentTurns,
          decision,
        });
        const insights = this.assignInsightIdsAndTimestamps(extraction.insights);
        await this.insightStore.saveInsights(insights);
        for (const insight of insights) {
          this.world.events.push({
            type: "InsightRecorded",
            employeeId: insight.employeeId,
            threadId: insight.threadId,
            insightId: insight.id,
            kind: insight.kind,
            timestamp: insight.createdAt,
          });
        }
      } catch (error) {
        this.world.events.push({
          type: "InsightExtractionFailed",
          employeeId: input.employeeId,
          threadId: input.threadId,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: this.world.now(),
        });
        console.warn("Insight extraction failed; returning chat response without insights.", error);
      }
    }

    return {
      messageId,
      response,
      selectedProcessIds: builtContext.selectedProcessIds,
    };
  }

  async listInsights(input: ListInsightsInput): Promise<StructuredInsight[]> {
    return this.insightStore.listInsights(input);
  }

  async submitFeedback(
    input: SubmitFeedbackInput,
  ): Promise<SubmitFeedbackResult> {
    await this.requireParticipant(input.employeeId);
    const profile = await this.profileStore.getProfile(input.employeeId);
    const decision = await this.routeConversationDecisionSafely({
      purpose: "feedback",
      text: input.text,
      profile,
      recentTurns: [],
    });
    const builtContext = await this.contextBuilder.build({
      purpose: "feedback",
      text: input.text,
      profile,
      selectedProcessIds: decision.selectedProcessIds,
    });

    this.world.events.push({
      type: "FeedbackReceived",
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      selectedProcessIds: builtContext.selectedProcessIds,
      timestamp: this.world.now(),
    });

    return {
      accepted: true,
      selectedProcessIds: builtContext.selectedProcessIds,
    };
  }

  private async routeConversationDecisionSafely(input: {
    purpose: AgentManualPurpose;
    text: string;
    profile?: UserProfile;
    recentTurns: ConversationTurn[];
  }): Promise<ConversationDecision> {
    const decisionRouter = this.requireConversationDecisionRouter();
    try {
      return sanitizeConversationDecision(
        await decisionRouter({
          ...input,
          manual: this.manual,
        }),
        this.manual,
        input.purpose,
      );
    } catch (error) {
      console.warn(
        "Conversation decision router failed; applying fail-closed work boundary.",
        error,
      );
      return sanitizeConversationDecision(
        {
          selectedProcessIds: ["core", "workday_guardrails"],
          workDecision: { mode: "boundary", reason: "unknown" },
          insightDecision: { candidate: false, suggestedKinds: [] },
        },
        this.manual,
        input.purpose,
      );
    }
  }

  private nextEmployeeId() {
    this.world.counters.participant++;
    return `emp_${this.world.counters.participant}`;
  }

  private assignInsightIdsAndTimestamps(
    drafts: StructuredInsightDraft[],
  ): StructuredInsight[] {
    return drafts.map((draft) => {
      this.world.counters.insight++;
      return {
        ...draft,
        id: `ins_${this.world.counters.insight}`,
        createdAt: this.world.now(),
      } as StructuredInsight;
    });
  }

  private async requireParticipant(employeeId: string) {
    const participant = await this.profileStore.getParticipant(employeeId);
    if (!participant) throw new Error("participant not found");
    return participant;
  }

  private requireConversationDecisionRouter() {
    if (!this.conversationDecisionRouter) {
      throw new Error("conversationDecisionRouter is required for chat");
    }
    return this.conversationDecisionRouter;
  }

  private requireInsightExtractor() {
    if (!this.insightExtractor) {
      throw new Error("insightExtractor is required when decision enables insight extraction");
    }
    return this.insightExtractor;
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

function createDefaultContextBuilder(
  manual: AgentManual,
  agentManualRouter?: AgentManualRouter,
) {
  return createMinutkaContextBuilder(manual, agentManualRouter);
}

function loadRequiredAgentManual(world: InMemoryWorld) {
  try {
    return loadAgentManualFromDisk();
  } catch (error) {
    world.events.push({
      type: "AgentManualLoadFailed",
      reason: error instanceof Error ? error.message : String(error),
      timestamp: world.now(),
    });
    throw error;
  }
}

function isProfileStore(value: MinutkaServiceDeps | ProfileStore): value is ProfileStore {
  return (
    typeof (value as ProfileStore).getProfile === "function" &&
    typeof (value as ProfileStore).saveProfile === "function"
  );
}

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
