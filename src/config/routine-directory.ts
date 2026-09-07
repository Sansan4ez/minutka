export type RoutineDirectoryRuntimeConfig = {
  directory?: string;
};

/** Optional operator-managed directory of routine-directory.<companyId>.json files. */
export function routineDirectoryRuntimeConfigFromEnv(env: NodeJS.ProcessEnv): RoutineDirectoryRuntimeConfig {
  const directory = env.ROUTINE_DIRECTORY_DIR?.trim();
  return directory ? { directory } : {};
}
