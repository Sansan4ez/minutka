export type Persona = "support" | "efficiency";

export type AiLevel = "beginner" | "intermediate" | "advanced";

export type ResponseLengthPreference = "short" | "balanced" | "detailed";

export type OnboardingStatus =
  | "invite_opened"
  | "consent_accepted"
  | "profile_completed";

export type Participant = {
  employeeId: string;
  inviteCode: string;
  status: OnboardingStatus;
  createdAt: string;
  updatedAt: string;
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
