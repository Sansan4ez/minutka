import { assertUserId } from "./document-store.js";

export type ArtifactCapacityPolicy = {
  ownerSoftQuotaBytes: number;
  ownerHardQuotaBytes: number;
  globalHardQuotaBytes: number;
};

export type ArtifactCapacityCheckInput = {
  ownerId: string;
  deliveryKey: string;
  size: number;
};

export type ArtifactCapacitySnapshot = {
  ownerUsageBytes: number;
  globalUsageBytes: number;
  prospectiveBytes: number;
  ownerSoftLimitExceeded: boolean;
  duplicateDelivery: boolean;
};

export type ArtifactCapacityWarning = Pick<ArtifactCapacitySnapshot,
  "ownerUsageBytes" | "globalUsageBytes" | "prospectiveBytes"
> & { reason: "owner_soft_quota" };

export class ArtifactOwnerQuotaExceededError extends Error {
  constructor() {
    super("artifact owner quota exceeded");
    this.name = "ArtifactOwnerQuotaExceededError";
  }
}

export class ArtifactGlobalCapacityExceededError extends Error {
  constructor() {
    super("artifact global capacity exceeded");
    this.name = "ArtifactGlobalCapacityExceededError";
  }
}

export const unboundedArtifactCapacityPolicy: ArtifactCapacityPolicy = {
  ownerSoftQuotaBytes: Number.MAX_SAFE_INTEGER - 1,
  ownerHardQuotaBytes: Number.MAX_SAFE_INTEGER,
  globalHardQuotaBytes: Number.MAX_SAFE_INTEGER,
};

export function validateArtifactCapacityPolicy(policy: ArtifactCapacityPolicy): ArtifactCapacityPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  if (policy.ownerSoftQuotaBytes >= policy.ownerHardQuotaBytes) throw new Error("artifact owner soft quota must be less than owner hard quota");
  return policy;
}

export function validateArtifactCapacityCheckInput(input: ArtifactCapacityCheckInput): ArtifactCapacityCheckInput {
  assertUserId(input.ownerId);
  const deliveryKey = input.deliveryKey.trim();
  if (!deliveryKey || deliveryKey.length > 512 || /[\u0000-\u001f\u007f]/.test(deliveryKey)) throw new Error("invalid deliveryKey");
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("artifact capacity size must be a non-negative safe integer");
  return input;
}

export function evaluateArtifactCapacity(input: {
  policy: ArtifactCapacityPolicy;
  ownerUsageBytes: number;
  globalUsageBytes: number;
  prospectiveBytes: number;
  duplicateDelivery?: boolean;
}): ArtifactCapacitySnapshot {
  const policy = validateArtifactCapacityPolicy(input.policy);
  for (const [name, value] of Object.entries({
    ownerUsageBytes: input.ownerUsageBytes,
    globalUsageBytes: input.globalUsageBytes,
    prospectiveBytes: input.prospectiveBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  const duplicateDelivery = input.duplicateDelivery ?? false;
  const prospectiveBytes = duplicateDelivery ? 0 : input.prospectiveBytes;
  if (prospectiveBytes > policy.ownerHardQuotaBytes - Math.min(input.ownerUsageBytes, policy.ownerHardQuotaBytes)) {
    throw new ArtifactOwnerQuotaExceededError();
  }
  if (prospectiveBytes > policy.globalHardQuotaBytes - Math.min(input.globalUsageBytes, policy.globalHardQuotaBytes)) {
    throw new ArtifactGlobalCapacityExceededError();
  }
  return {
    ownerUsageBytes: input.ownerUsageBytes,
    globalUsageBytes: input.globalUsageBytes,
    prospectiveBytes,
    ownerSoftLimitExceeded: prospectiveBytes > 0 && input.ownerUsageBytes + prospectiveBytes > policy.ownerSoftQuotaBytes,
    duplicateDelivery,
  };
}
