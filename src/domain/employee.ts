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
  roleId?: string;
  status: OnboardingStatus;
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
  /** Stored legacy profile context; no longer accepted by Minutka onboarding. */
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  preferredCheckinsPerDay?: 1 | 2 | 3;
  createdAt: string;
  updatedAt: string;
};
