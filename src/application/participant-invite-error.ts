export class ParticipantInviteExistsError extends Error {
  constructor() {
    super("employee already has an active invite; revoke it with `admin revoke-invite` before issuing a replacement");
    this.name = "ParticipantInviteExistsError";
  }
}

export class ParticipantInviteRevocationError extends Error {
  constructor(status: string) {
    super(`participant status is ${status}; only invite_issued participants can be deleted with this command. Use employee:data:delete for participants who have progressed further.`);
    this.name = "ParticipantInviteRevocationError";
  }
}
