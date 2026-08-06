import { assertUserId } from "./document-store.js";
import type { IdeaAppendMutationResult, IdeaStore } from "./idea-store.js";

export type AppendIdeaInput = {
  ideaId: string;
  expectedRevision: number;
  text: string;
};

export type AppendIdeaResult = IdeaAppendMutationResult;

/** Owner-scoped level-0 mutation used to enrich an existing idea instead of creating a duplicate. */
export class IdeaAppendService {
  constructor(private readonly ideas: Pick<IdeaStore, "append" | "get">) {}

  async append(ownerId: string, input: AppendIdeaInput): Promise<AppendIdeaResult> {
    const safeOwnerId = assertUserId(ownerId);
    const ideaId = input.ideaId.trim();
    if (!ideaId) throw new Error("ideaId is required");
    try {
      return await this.ideas.append(safeOwnerId, ideaId, {
        expectedRevision: input.expectedRevision,
        text: input.text,
      });
    } catch (cause) {
      if (await this.ideas.get(safeOwnerId, ideaId)) throw cause;
      return { status: "not_found" };
    }
  }
}
