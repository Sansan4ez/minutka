export class ParticipantInviteExistsError extends Error {
  constructor() {
    super("employee already has an active invite");
    this.name = "ParticipantInviteExistsError";
  }
}
