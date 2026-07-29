import { describe, expect, it, vi } from "vitest";
import { runRetentionCleanupJobs } from "../../../src/runtime/retention-cleanup.js";

describe("RETENTION-CLEANUP: best-effort startup/hourly housekeeping", () => {
  it("runs every retention job and tolerates a task-confirmation cleanup failure", async () => {
    const onboarding = vi.fn(async () => 1);
    const telegram = vi.fn(async () => 2);
    const taskConfirmations = vi.fn(async () => { throw new TypeError("database unavailable"); });
    const warnings: string[] = [];

    await expect(runRetentionCleanupJobs([
      { operation: "Minutka onboarding draft", run: onboarding },
      { operation: "Minutka Telegram action-message", run: telegram },
      { operation: "Personal assistant task-confirmation", run: taskConfirmations },
    ], (message) => warnings.push(message))).resolves.toBeUndefined();

    expect(onboarding).toHaveBeenCalledOnce();
    expect(telegram).toHaveBeenCalledOnce();
    expect(taskConfirmations).toHaveBeenCalledOnce();
    expect(warnings).toEqual(["Personal assistant task-confirmation cleanup failed (TypeError)."]);
  });
});
