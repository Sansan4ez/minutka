export type Persona = "support" | "efficiency";

export type AiLevel = "beginner" | "intermediate" | "advanced";

export type ResponseLengthPreference = "short" | "balanced" | "detailed";

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
  privacyVersion: "privacy-v1";
  acceptedAt: string;
  explanationShownAt: string;
  source: "cli" | "telegram" | "test";
};

export type UserProfile = {
  employeeId: string;
  role: string;
  typicalTasks: string[];
  persona: Persona;
  aiLevel: AiLevel;
  responseLength: ResponseLengthPreference;
  preferredCheckinsPerDay?: 1 | 2 | 3;
  createdAt: string;
  updatedAt: string;
};
