import type { OnboardingDraft } from "./onboarding-types.js";

/** Temporary, scoped onboarding state. save is compare-and-swap when expectedRevision is provided. */
export interface OnboardingDraftStore {
  get(employeeId: string): Promise<OnboardingDraft | undefined>;
  save(draft: OnboardingDraft, expectedRevision?: number): Promise<OnboardingDraft>;
  delete(employeeId: string): Promise<void>;
}
