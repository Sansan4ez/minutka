import type { AiLevel, Persona } from "../domain/employee.js";

export type OnboardingField = "role" | "typicalTasks" | "persona" | "aiLevel";
export type OnboardingDraft = {
  employeeId: string;
  role?: string;
  typicalTasks?: string[];
  persona?: Persona;
  aiLevel?: AiLevel;
  status: "collecting" | "awaiting_confirmation";
  pendingField?: OnboardingField;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
export type OnboardingProfilePatch = {
  role?: string;
  typicalTasks?: string[];
  persona?: Persona;
  aiLevel?: AiLevel;
  /** Explicit additions to the existing task list, used for natural-language corrections. */
  appendTypicalTasks?: string[];
  ambiguousFields: OnboardingField[];
};
export type OnboardingSummary = {
  role: string;
  typicalTasks: string[];
  persona: string;
  aiLevel: string;
};
export type OnboardingProgress =
  | { status: "needs_answer"; field: OnboardingField; prompt: string }
  | { status: "needs_choice"; field: "persona" | "aiLevel"; prompt: string; choices: string[] }
  | { status: "needs_confirmation"; summary: OnboardingSummary }
  | { status: "completed"; result: import("./minutka-service.js").CompleteOnboardingResult };
