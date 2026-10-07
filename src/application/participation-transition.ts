import { z } from "zod";

export const participationTransitionSchema = z.strictObject({
  companyId: z.string().trim().min(1),
  sourceGroupId: z.string().trim().min(1),
  targetGroupId: z.string().trim().min(1),
  sourceEmployeeId: z.string().trim().min(1),
  targetEmployeeId: z.string().trim().min(1),
}).refine(x => x.sourceEmployeeId !== x.targetEmployeeId && x.sourceGroupId !== x.targetGroupId, "different participations required");
export type ParticipationTransition = z.infer<typeof participationTransitionSchema>;
export type ParticipationTransitionResult = { status: "applied" | "already_applied"; threadId: string };
export interface ParticipationTransitionStore {
  transition(input: ParticipationTransition): Promise<ParticipationTransitionResult>;
}
/** Operator-only, while runtime is stopped; never accepts consent on behalf of a person. */
export class ParticipationTransitionService {
  constructor(private readonly store: ParticipationTransitionStore) {}
  transition(input: ParticipationTransition): Promise<ParticipationTransitionResult> {
    return this.store.transition(participationTransitionSchema.parse(input));
  }
}
