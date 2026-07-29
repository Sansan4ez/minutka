import { taskMutationConfirmationTtlMilliseconds } from "../application/task-mutation-confirmation.js";

export const taskMutationCompletedReplayRetentionEnvName = "TASK_CONFIRMATION_COMPLETED_REPLAY_RETENTION_MS";
/** Seven days keeps idempotent confirmation outcomes available across ordinary retries and restarts. */
export const defaultTaskMutationCompletedReplayRetentionMilliseconds = 7 * 24 * 60 * 60_000;

export function taskMutationCompletedReplayRetentionFromEnv(
  env: NodeJS.ProcessEnv,
  confirmationTtlMilliseconds = taskMutationConfirmationTtlMilliseconds,
): number {
  const raw = env[taskMutationCompletedReplayRetentionEnvName];
  const retention = raw === undefined || raw === ""
    ? defaultTaskMutationCompletedReplayRetentionMilliseconds
    : parsePositiveSafeInteger(raw);
  if (retention <= confirmationTtlMilliseconds) {
    throw new Error(`${taskMutationCompletedReplayRetentionEnvName} must exceed the task confirmation TTL (${confirmationTtlMilliseconds} ms)`);
  }
  return retention;
}

function parsePositiveSafeInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${taskMutationCompletedReplayRetentionEnvName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${taskMutationCompletedReplayRetentionEnvName} must be a positive safe integer`);
  return parsed;
}
