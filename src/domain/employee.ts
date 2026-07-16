import type { PrivacyVersion } from "./privacy.js";

export type Persona = "support" | "efficiency";

export type AiLevel = "beginner" | "intermediate" | "advanced";

export type ResponseLengthPreference = "short" | "balanced" | "detailed";

export type AddressForm = "informal" | "formal";

export type OnboardingStatus =
  | "invite_issued"
  | "invite_opened"
  | "consent_accepted"
  | "profile_completed";

/** Persistent participant state. Invite codes are operation inputs, never participant data. */
export type Participant = {
  employeeId: string;
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
  /** Structured identity and delivery preferences used outside LLM context. */
  preferredName: string;
  assistantName: string;
  addressForm: AddressForm;
  persona: Persona;
  responseLength: ResponseLengthPreference;
  timezone: string;
  /** Legacy context retained for existing profiles; new onboarding does not require it. */
  role?: string;
  typicalTasks?: string[];
  aiLevel?: AiLevel;
  preferredCheckinsPerDay?: 1 | 2 | 3;
  createdAt: string;
  updatedAt: string;
};
