import { expect } from "vitest";
import type {
  ActivityCorrectionCommand,
  ActivityMutationStore,
  ActivitySupersessionCommand,
} from "../../../src/application/activity-correction.js";

export async function expectActivityMutationResultContract(
  store: ActivityMutationStore,
  input: {
    correction: ActivityCorrectionCommand;
    supersession: ActivitySupersessionCommand;
  },
): Promise<void> {
  const corrected = await store.correctRecentActivity(input.correction);
  expect(corrected).toMatchObject({
    activityId: input.correction.handle,
    revision: input.correction.expectedRevision + 1,
  });
  expect(corrected).not.toHaveProperty("revisions");

  const superseded = await store.supersedeRecentActivity(input.supersession);
  expect(superseded).toMatchObject({
    activityId: input.supersession.handle,
    revision: input.supersession.expectedRevision + 1,
    status: "superseded",
    supersededByActivityId: input.supersession.replacementHandle,
  });
  expect(superseded).not.toHaveProperty("revisions");
}
