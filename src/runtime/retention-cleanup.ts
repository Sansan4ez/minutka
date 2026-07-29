export type RetentionCleanupJob = {
  operation: string;
  run: () => Promise<unknown>;
};

/** Best-effort retention housekeeping shared by startup and the hourly sweep. */
export async function runRetentionCleanupJobs(
  jobs: readonly RetentionCleanupJob[],
  warn: (message: string) => void = console.warn,
): Promise<void> {
  await Promise.all(jobs.map(async ({ operation, run }) => {
    try { await run(); }
    catch (error) { warn(`${operation} cleanup failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
  }));
}
