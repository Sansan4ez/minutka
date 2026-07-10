import type { Consent, Participant, UserProfile } from "../domain/employee.js";

export type ClaimParticipantByInviteResult = {
  participant: Participant;
  created: boolean;
};

export type ClaimConsentResult = {
  consent: Consent;
  created: boolean;
};

export type OpenParticipantByInviteResult = {
  participant: Participant;
  opened: boolean;
};

export type ProfileStore = {
  saveParticipant(participant: Participant): Promise<void>;
  /**
   * Atomically creates this invite's participant when absent, otherwise returns
   * its existing participant. Persistent adapters must enforce both inviteCode
   * and employeeId uniqueness in the same storage operation.
   */
  claimParticipantByInvite(participant: Participant): Promise<ClaimParticipantByInviteResult>;
  /**
   * Atomically transitions a pre-issued invite to invite_opened. Persistent
   * adapters must make the state transition conditional in the same operation.
   */
  openParticipantByInvite(
    inviteCode: string,
    openedAt: string,
  ): Promise<OpenParticipantByInviteResult | undefined>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  getParticipantByInvite(inviteCode: string): Promise<Participant | undefined>;

  /**
   * Atomically records consent when it is absent, otherwise returns the
   * existing record. Persistent adapters must enforce employeeId uniqueness
   * in the same storage operation.
   */
  claimConsent(consent: Consent): Promise<ClaimConsentResult>;
  getConsent(employeeId: string): Promise<Consent | undefined>;

  saveProfile(profile: UserProfile): Promise<void>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
};
