export interface TransportStartup {
  startScheduler(): Promise<void>;
  launchTelegram?: () => Promise<void>;
}

export async function startTransports({
  startScheduler,
  launchTelegram,
}: TransportStartup): Promise<{ launchCompleted: Promise<void> | undefined }> {
  await startScheduler();
  return { launchCompleted: launchTelegram?.() };
}
