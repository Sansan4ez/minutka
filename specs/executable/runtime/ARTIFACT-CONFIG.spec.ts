import { describe, expect, it } from "vitest";
import {
  artifactGlobalHardQuotaBytesEnvName,
  artifactInfrastructureReserveBytesEnvName,
  artifactMaximumBytesEnvName,
  artifactOwnerHardQuotaBytesEnvName,
  artifactOwnerSoftQuotaBytesEnvName,
  artifactRuntimeConfigFromEnv,
  artifactSaveTimeoutMsEnvName,
  defaultArtifactRuntimeConfig,
} from "../../../src/config/artifacts.js";

describe("ARTIFACT-CONFIG: validated pilot storage limits", () => {
  it("keeps the 100 MiB pilot object default and explicit capacity reserve", () => {
    expect(artifactRuntimeConfigFromEnv({})).toEqual(defaultArtifactRuntimeConfig);
    expect(defaultArtifactRuntimeConfig.saveLimits.maximumBytes).toBe(100 * 1024 * 1024);
  });

  it("accepts positive safe boundary values with soft below hard", () => {
    expect(artifactRuntimeConfigFromEnv({
      [artifactMaximumBytesEnvName]: "1",
      [artifactSaveTimeoutMsEnvName]: "1",
      [artifactOwnerSoftQuotaBytesEnvName]: "1",
      [artifactOwnerHardQuotaBytesEnvName]: "2",
      [artifactGlobalHardQuotaBytesEnvName]: "2",
      [artifactInfrastructureReserveBytesEnvName]: "1",
    })).toMatchObject({
      saveLimits: { maximumBytes: 1, timeoutMs: 1 },
      capacityPolicy: { ownerSoftQuotaBytes: 1, ownerHardQuotaBytes: 2, globalHardQuotaBytes: 2 },
      infrastructureReserveBytes: 1,
    });
  });

  it.each([
    [{ [artifactMaximumBytesEnvName]: "0" }, artifactMaximumBytesEnvName],
    [{ [artifactSaveTimeoutMsEnvName]: "1.5" }, artifactSaveTimeoutMsEnvName],
    [{ [artifactOwnerSoftQuotaBytesEnvName]: "10", [artifactOwnerHardQuotaBytesEnvName]: "10" }, "soft quota"],
    [{ [artifactGlobalHardQuotaBytesEnvName]: String(Number.MAX_SAFE_INTEGER), [artifactInfrastructureReserveBytesEnvName]: "1" }, "plus infrastructure reserve"],
  ])("fails fast for invalid artifact config %#", (env, expected) => {
    expect(() => artifactRuntimeConfigFromEnv(env)).toThrow(expected);
  });
});
