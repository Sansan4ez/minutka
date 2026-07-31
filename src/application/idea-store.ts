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
  revision: number;
  deletedAt?: string;
  undoExpiresAt?: string;
};

export type AddIdeaInput = Omit<Idea, "createdAt" | "lastActivityAt" | "revision" | "deletedAt" | "undoExpiresAt">;

export type IdeaFilter = Partial<Classified> & {
  status?: IdeaStatus;
};

export type IdeaListOptions = {
  /** Optional bounded read. */
  limit?: number;
  order?: "created_asc" | "activity_desc";
  /** Typed deletion use-cases only; normal reads hide tombstones. */
  includeDeleted?: boolean;
};

export type UpdateIdeaInput = Partial<Pick<Idea, "project" | "type" | "summary" | "source" | "status">>;

export type IdeaMutationResult =
  | { outcome: "deleted" | "already_deleted" | "restored" | "unchanged"; idea: Idea }
  | { outcome: "not_found" | "expired" }
  | { outcome: "conflict"; current?: Idea };

/**
 * Owner-scoped persistence boundary for the idea bank.
 * Timestamps are owned by the adapter so updates always renew activity.
 */
export interface IdeaStore {
  add(input: AddIdeaInput): Promise<Idea>;
  get(userId: string, id: string): Promise<Idea | null>;
  list(userId: string, filter?: IdeaFilter, options?: IdeaListOptions): Promise<Idea[]>;
  stale(userId: string, days: number): Promise<Idea[]>;
  update(userId: string, id: string, patch: UpdateIdeaInput): Promise<Idea | null>;
  softDelete(userId: string, id: string, input: { expectedRevision?: number; deletedAt: string; undoExpiresAt: string }): Promise<IdeaMutationResult>;
  undoDelete(userId: string, id: string, input: { expectedRevision?: number; restoredAt: string }): Promise<IdeaMutationResult>;
}

export function validateIdeaText(value: string, field: "project" | "summary"): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}

export function definedIdeaPatch(patch: UpdateIdeaInput): UpdateIdeaInput {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as UpdateIdeaInput;
  if (defined.project !== undefined) validateIdeaText(defined.project, "project");
  if (defined.summary !== undefined) validateIdeaText(defined.summary, "summary");
  if (defined.source?.kind === "text" && !defined.source.text.trim()) throw new Error("source text is required");
  if (defined.source?.kind === "blob" && !defined.source.blobKey.trim()) throw new Error("source blob key is required");
  return defined;
}
