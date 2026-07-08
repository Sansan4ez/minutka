import type { Persona } from "./employee.js";

export type ChatMessageReceived = {
  type: "ChatMessageReceived";
  employeeId: string;
  threadId: string;
  text: string;
  timestamp: string;
};

export type ChatResponseGenerated = {
  type: "ChatResponseGenerated";
  employeeId: string;
  threadId: string;
  response: string;
  timestamp: string;
};

export type InviteOpened = {
  type: "InviteOpened";
  employeeId: string;
  inviteCode: string;
  timestamp: string;
};

export type PrivacyExplanationShown = {
  type: "PrivacyExplanationShown";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type ConsentAccepted = {
  type: "ConsentAccepted";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type UserProfileUpdated = {
  type: "UserProfileUpdated";
  employeeId: string;
  changedFields: string[];
  timestamp: string;
};

export type OnboardingCompleted = {
  type: "OnboardingCompleted";
  employeeId: string;
  persona: Persona;
  timestamp: string;
};

export type DomainEvent =
  | ChatMessageReceived
  | ChatResponseGenerated
  | InviteOpened
  | PrivacyExplanationShown
  | ConsentAccepted
  | UserProfileUpdated
  | OnboardingCompleted;
