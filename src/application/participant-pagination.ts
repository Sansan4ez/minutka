export type ParticipantPageCursor = { createdAt: string; employeeId: string };
export type ListParticipantsInput = { companyId: string; groupId: string; limit?: number; after?: string };

export class InvalidParticipantCursorError extends Error {
  constructor() {
    super("Invalid participant cursor.");
    this.name = "InvalidParticipantCursorError";
  }
}

const cursorVersion = 1;
const cursorScope = "participants";
const maximumCursorLength = 2_048;

export function encodeParticipantCursor(cursor: ParticipantPageCursor): string {
  return Buffer.from(JSON.stringify({ v: cursorVersion, scope: cursorScope, ...cursor }), "utf8").toString("base64url");
}

export function decodeParticipantCursor(cursor: string): ParticipantPageCursor {
  try {
    if (!cursor || cursor.length > maximumCursorLength) throw new InvalidParticipantCursorError();
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new InvalidParticipantCursorError();
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidParticipantCursorError();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "createdAt,employeeId,scope,v") throw new InvalidParticipantCursorError();
    if (record.v !== cursorVersion || record.scope !== cursorScope) throw new InvalidParticipantCursorError();
    if (typeof record.createdAt !== "string") throw new InvalidParticipantCursorError();
    const createdAt = new Date(record.createdAt);
    if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== record.createdAt) throw new InvalidParticipantCursorError();
    if (typeof record.employeeId !== "string" || !record.employeeId || record.employeeId.length > 128) throw new InvalidParticipantCursorError();
    return { createdAt: record.createdAt, employeeId: record.employeeId };
  } catch (error) {
    if (error instanceof InvalidParticipantCursorError) throw error;
    throw new InvalidParticipantCursorError();
  }
}
