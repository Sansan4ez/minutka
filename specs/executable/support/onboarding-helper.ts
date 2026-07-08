import type { SpecWorld } from "./spec-harness.js";
import { testEmployee, testInvite, testProfile } from "./fixtures.js";

type TestOnboardingProfile = {
  role: string;
  typicalTasks: string[];
  persona: "support" | "efficiency";
  aiLevel: "beginner" | "intermediate" | "advanced";
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

  const args = [
    "employee",
    "complete-onboarding",
    "--employee",
    testEmployee.employeeId,
    "--role",
    profile.role,
  ];

  for (const task of profile.typicalTasks) {
    args.push("--task", task);
  }

  args.push(
    "--persona",
    profile.persona,
    "--ai-level",
    profile.aiLevel,
    "--response-length",
    profile.responseLength,
  );

  return spec.cli.json(args);
}
