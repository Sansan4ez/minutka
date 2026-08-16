import type { SpecWorld } from "./spec-harness.js";
import { testEmployee, testInvite, testProfile, testTenant } from "./fixtures.js";

type TestOnboardingProfile = {
  selfDescription: string;
  persona: "support" | "efficiency";
  responseLength: "short" | "balanced" | "detailed";
};

export async function onboardTestEmployee(
  spec: SpecWorld,
  profileOverrides: Partial<TestOnboardingProfile> = {},
) {
  const profile = { ...testProfile, ...profileOverrides };

  await spec.cli.json([
    "employee",
    "open-invite",
    "--invite",
    testInvite.inviteCode,
    "--employee",
    testEmployee.employeeId,
  ]);

  await spec.cli.json([
    "employee",
    "accept-consent",
    "--employee",
    testEmployee.employeeId,
    "--yes",
  ]);

  return spec.cli.json([
    "employee",
    "complete-onboarding",
    "--employee",
    testEmployee.employeeId,
    "--role-id",
    testTenant.roleId,
    "--self-description",
    profile.selfDescription,
    "--persona",
    profile.persona,
    "--response-length",
    profile.responseLength,
  ]);
}
