import type { AddressForm, Persona, ResponseLengthPreference } from "../domain/employee.js";

export type OnboardingField = "preferredName" | "assistantName" | "addressForm" | "persona" | "responseLength" | "timezone";
export type OnboardingDraft = {
  employeeId: string;
  preferredName?: string;
  assistantName?: string;
  addressForm?: AddressForm;
  persona?: Persona;
  responseLength?: ResponseLengthPreference;
  timezone?: string;
  status: "collecting" | "awaiting_confirmation";
  pendingField?: OnboardingField;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
export type OnboardingProfilePatch = {
  preferredName?: string;
  assistantName?: string;
  addressForm?: AddressForm;
  persona?: Persona;
  responseLength?: ResponseLengthPreference;
  timezone?: string;
  ambiguousFields: OnboardingField[];
};
export type OnboardingSummary = {
  preferredName: string;
  assistantName: string;
  addressForm: string;
  persona: string;
  responseLength: string;
  timezone: string;
};
export type OnboardingProgress =
  | { status: "needs_answer"; field: OnboardingField; prompt: string }
  | { status: "needs_choice"; field: "addressForm" | "persona" | "responseLength" | "timezone"; prompt: string; choices: string[]; allowFreeText?: boolean }
  | { status: "needs_confirmation"; deliveryKey: string; summary: OnboardingSummary }
  /** The user rejected the summary; the next natural-language message is a correction. */
  | { status: "needs_correction"; prompt: string }
  | { status: "completed"; result: import("./minutka-service.js").CompleteOnboardingResult };
