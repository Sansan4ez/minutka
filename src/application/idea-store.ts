import type { Classified } from "../domain/classification.js";

export type IdeaStatus = "raw" | "discussed" | "planned" | "done" | "dropped";

export type IdeaSource =
  | { kind: "text"; text: string }
  | { kind: "blob"; blobKey: string };

/** An owner-scoped record captured by the assistant's idea bank. */
export type Idea = Classified & {
  id: string;
  userId: string;
  summary: string;
  source?: IdeaSource;
  status: IdeaStatus;
  createdAt: string;
  lastActivityAt: string;
};

export type AddIdeaInput = Omit<Idea, "createdAt" | "lastActivityAt">;

export type IdeaFilter = Partial<Classified> & {
  status?: IdeaStatus;
};

export type UpdateIdeaInput = Partial<Pick<Idea, "project" | "type" | "summary" | "source" | "status">>;

/**
 * Owner-scoped persistence boundary for the idea bank.
 * Timestamps are owned by the adapter so updates always renew activity.
 */
export interface IdeaStore {
  add(input: AddIdeaInput): Promise<Idea>;
  list(userId: string, filter?: IdeaFilter): Promise<Idea[]>;
  stale(userId: string, days: number): Promise<Idea[]>;
  update(userId: string, id: string, patch: UpdateIdeaInput): Promise<Idea | null>;
}
