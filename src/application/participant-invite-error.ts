export class ParticipantInviteExistsError extends Error {
  constructor() {
    super("employee already has an active invite; revoke it with `admin revoke-invite` before issuing a replacement");
    this.name = "ParticipantInviteExistsError";
  }
}
