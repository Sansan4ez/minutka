import type { Consent, Participant, UserProfile } from "../domain/employee.js";

export type IssueInviteResult = { participant: Participant; created: boolean; inviteMatches: boolean };
export type OpenInviteResult = { participant: Participant; opened: boolean };
export type ClaimConsentResult = { consent: Consent; created: boolean };
export type CompleteProfileResult = { profile: UserProfile; wasCompleted: boolean };

/** Owner of participant, consent and profile state. Raw invite codes are inputs only. */
export type ProfileStore = {
  issueInvite(input: {
    employeeId: string;
    inviteCode: string;
    issuedAt: string;
  }): Promise<IssueInviteResult>;
  openInvite(input: {
    inviteCode: string;
    openedAt: string;
    explanationShownAt?: string;
  }): Promise<OpenInviteResult | undefined>;
  acceptConsent(consent: Consent): Promise<ClaimConsentResult>;
  recordPrivacyExplanationShown(input: {
    employeeId: string;
    shownAt: string;
  }): Promise<void>;
  completeProfile(input: {
    profile: UserProfile;
    completedAt: string;
  }): Promise<CompleteProfileResult>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  /** Private lookup used only by the atomic Telegram invite-redemption adapter. */
  getParticipantByInviteCode(inviteCode: string): Promise<Participant | undefined>;
  getConsent(employeeId: string): Promise<Consent | undefined>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
  deleteEmployeePersonalData(employeeId: string): Promise<void>;
};
