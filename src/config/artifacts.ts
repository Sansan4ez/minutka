import { validateArtifactCapacityPolicy, type ArtifactCapacityPolicy } from "../application/artifact-capacity.js";
import type { ArtifactSaveLimits } from "../application/artifact-body-stager.js";

export const artifactMaximumBytesEnvName = "ASSISTANT_ARTIFACT_MAXIMUM_BYTES";
export const artifactSaveTimeoutMsEnvName = "ASSISTANT_ARTIFACT_SAVE_TIMEOUT_MS";
export const artifactOwnerSoftQuotaBytesEnvName = "ASSISTANT_ARTIFACT_OWNER_SOFT_QUOTA_BYTES";
export const artifactOwnerHardQuotaBytesEnvName = "ASSISTANT_ARTIFACT_OWNER_HARD_QUOTA_BYTES";
export const artifactGlobalHardQuotaBytesEnvName = "ASSISTANT_ARTIFACT_GLOBAL_HARD_QUOTA_BYTES";
export const artifactInfrastructureReserveBytesEnvName = "ASSISTANT_ARTIFACT_INFRASTRUCTURE_RESERVE_BYTES";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export type ArtifactRuntimeConfig = {
  saveLimits: ArtifactSaveLimits;
  capacityPolicy: ArtifactCapacityPolicy;
  infrastructureReserveBytes: number;
};

export const defaultArtifactRuntimeConfig: ArtifactRuntimeConfig = {
  saveLimits: { maximumBytes: 100 * MiB, timeoutMs: 60_000 },
  capacityPolicy: {
    ownerSoftQuotaBytes: 2 * GiB,
    ownerHardQuotaBytes: 3 * GiB,
    globalHardQuotaBytes: 45 * GiB,
  },
  infrastructureReserveBytes: 5 * GiB,
};

export function artifactRuntimeConfigFromEnv(env: NodeJS.ProcessEnv): ArtifactRuntimeConfig {
  const config = {
    saveLimits: {
      maximumBytes: positiveSafeInteger(env[artifactMaximumBytesEnvName], defaultArtifactRuntimeConfig.saveLimits.maximumBytes, artifactMaximumBytesEnvName),
      timeoutMs: positiveSafeInteger(env[artifactSaveTimeoutMsEnvName], defaultArtifactRuntimeConfig.saveLimits.timeoutMs, artifactSaveTimeoutMsEnvName),
    },
    capacityPolicy: validateArtifactCapacityPolicy({
      ownerSoftQuotaBytes: positiveSafeInteger(env[artifactOwnerSoftQuotaBytesEnvName], defaultArtifactRuntimeConfig.capacityPolicy.ownerSoftQuotaBytes, artifactOwnerSoftQuotaBytesEnvName),
      ownerHardQuotaBytes: positiveSafeInteger(env[artifactOwnerHardQuotaBytesEnvName], defaultArtifactRuntimeConfig.capacityPolicy.ownerHardQuotaBytes, artifactOwnerHardQuotaBytesEnvName),
      globalHardQuotaBytes: positiveSafeInteger(env[artifactGlobalHardQuotaBytesEnvName], defaultArtifactRuntimeConfig.capacityPolicy.globalHardQuotaBytes, artifactGlobalHardQuotaBytesEnvName),
    }),
    infrastructureReserveBytes: positiveSafeInteger(env[artifactInfrastructureReserveBytesEnvName], defaultArtifactRuntimeConfig.infrastructureReserveBytes, artifactInfrastructureReserveBytesEnvName),
  };
  if (config.capacityPolicy.globalHardQuotaBytes > Number.MAX_SAFE_INTEGER - config.infrastructureReserveBytes) {
    throw new Error("artifact global hard quota plus infrastructure reserve must be a safe integer");
  }
  return config;
}

function positiveSafeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/u.test(normalized)) throw new Error(`${name} must be a positive safe integer`);
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
