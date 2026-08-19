import type { PrivacyVersion } from "./privacy.js";

export type Persona = "support" | "efficiency";

export type AiLevel = "beginner" | "intermediate" | "advanced";

export const responseLengthPreferences = ["short", "balanced", "detailed"] as const;

export type ResponseLengthPreference = typeof responseLengthPreferences[number];

export type AddressForm = "informal" | "formal";

export type OnboardingStatus =
  | "invite_issued"
  | "invite_opened"
  | "consent_accepted"
  | "profile_completed";

/** Persistent participant state. Invite codes are operation inputs, never participant data. */
export type Participant = {
  employeeId: string;
  companyId: string;
  groupId: string;
  /** Random group-scoped research pseudonym; never accepted as a credential. */
  subjectKey: string;
  roleId?: string;
  status: OnboardingStatus;
  /**
   * Latest local calendar date on which the employee contacted the assistant.
   * Onboarding completion counts as that first contact; scheduled fires do not.
   */
  lastTouchOn?: string;
  /** Automatic soft reminders already sent; bounded before the live escalation tier. */
  engagementRemindersSent?: number;
  /** Instant of the latest automatic soft reminder; enforces the rolling daily limit. */
  lastEngagementReminderAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Internal onboarding timestamp; never included in agent-facing projections. */
  privacyExplanationShownAt?: string;
};

export type Consent = {
  employeeId: string;
  privacyVersion: PrivacyVersion;
  acceptedAt: string;
  explanationShownAt: string;
  source: "cli" | "telegram" | "test";
};

export type UserProfile = {
  employeeId: string;
  companyId: string;
  groupId: string;
  roleId: string;
  /** Structured identity and delivery preferences used outside LLM context. */
  preferredName: string;
  assistantName: string;
  addressForm: AddressForm;
  persona: Persona;
  responseLength: ResponseLengthPreference;
  timezone: string;
  /** Personal self-description; never copied into anonymized reporting rows. */
  role?: string;
  /** Bounded personal context gathered from ordinary employee conversation. */
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  programGoal?: string;
  preferredCheckinsPerDay?: 1 | 2 | 3;
  createdAt: string;
  updatedAt: string;
};
