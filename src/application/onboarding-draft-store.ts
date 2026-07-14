import type { OnboardingDraft } from "./onboarding-types.js";

/** Temporary, scoped onboarding state. save is compare-and-swap when expectedRevision is provided. */
export interface OnboardingDraftStore {
  get(employeeId: string): Promise<OnboardingDraft | undefined>;
  save(draft: OnboardingDraft, expectedRevision?: number): Promise<OnboardingDraft>;
  /** Replaces a draft after an explicit user reset; this intentionally bypasses CAS. */
  replace(draft: OnboardingDraft): Promise<OnboardingDraft>;
  delete(employeeId: string): Promise<void>;
  /** Deletes expired temporary onboarding data without requiring a user request. */
  purgeExpired(): Promise<number>;
}
