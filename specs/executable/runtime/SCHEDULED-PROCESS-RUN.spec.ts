import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AssistantChatResult } from "../../../src/application/assistant-service.js";
import type { ParticipantPage } from "../../../src/application/minutka-service.js";
import {
  parseScheduledProcessRunArguments,
  runScheduledProcessOnDemand,
} from "../../../src/runtime/run-scheduled-process.js";

const completedResult: AssistantChatResult = {
  messageId: "message-1",
  response: "Расскажите об одной-трёх активностях с прошлого касания.",
  selectedProcessIds: ["core", "morning_activity_collection"],
  outcome: { status: "completed" },
  pendingActions: [],
  effect: "none",
};

describe("SCHEDULED-PROCESS-RUN: operator on-demand process command", () => {
  it("parses the explicit employee and scheduled process with a default thread", () => {
    expect(parseScheduledProcessRunArguments([
      "--employee", "emp_1", "--process", "morning_activity_collection",
    ])).toEqual({
      employeeId: "emp_1",
      processId: "morning_activity_collection",
      threadId: "default",
    });
    expect(parseScheduledProcessRunArguments([
      "--thread", "telegram-42", "--process", "evening_reflection", "--employee", "emp_1",
    ])).toEqual({
      employeeId: "emp_1",
      processId: "evening_reflection",
      threadId: "telegram-42",
    });
  });

  it("refuses unknown processes and incomplete arguments with an explicit reason", () => {
    expect(() => parseScheduledProcessRunArguments([
      "--employee", "emp_1", "--process", "consent_and_privacy",
    ])).toThrow("unsupported scheduled process: consent_and_privacy");
    expect(() => parseScheduledProcessRunArguments([
      "--employee", "emp_1", "--process", "day_focus",
    ])).toThrow("unsupported scheduled process: day_focus");
    expect(() => parseScheduledProcessRunArguments(["--employee", "emp_1"])).toThrow("usage:");
  });

  it("runs only the typed facade use-case for a completed employee", async () => {
    const runScheduledProcess = vi.fn(async () => completedResult);
    const application = {
      listParticipants: vi.fn(async (): Promise<ParticipantPage> => ({
        participants: [{
          employeeId: "emp_1",
          status: "profile_completed",
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }],
      })),
      runScheduledProcess,
    };

    await expect(runScheduledProcessOnDemand(application, {
      employeeId: "emp_1",
      processId: "morning_activity_collection",
      threadId: "default",
    })).resolves.toEqual(completedResult);
    expect(runScheduledProcess).toHaveBeenCalledWith({
      userId: "emp_1",
      processId: "morning_activity_collection",
      threadId: "default",
    });
  });

  it("refuses an absent employee and an employee without completed onboarding", async () => {
    const runScheduledProcess = vi.fn(async () => completedResult);
    const absent = {
      listParticipants: async (): Promise<ParticipantPage> => ({ participants: [] }),
      runScheduledProcess,
    };
    await expect(runScheduledProcessOnDemand(absent, {
      employeeId: "missing",
      processId: "morning_activity_collection",
      threadId: "default",
    })).rejects.toThrow('employee "missing" was not found');

    const incomplete = {
      listParticipants: async (): Promise<ParticipantPage> => ({
        participants: [{
          employeeId: "emp_2",
          status: "consent_accepted",
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }],
      }),
      runScheduledProcess,
    };
    await expect(runScheduledProcessOnDemand(incomplete, {
      employeeId: "emp_2",
      processId: "evening_reflection",
      threadId: "default",
    })).rejects.toThrow('employee "emp_2" has not completed onboarding (status: consent_accepted)');
    expect(runScheduledProcess).not.toHaveBeenCalled();
  });

  it("is wired as a local runtime command without Telegram delivery or schedule-store access", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const source = readFileSync("src/runtime/run-scheduled-process.ts", "utf8");

    expect(packageJson.scripts["process:run"]).toBe("tsx src/runtime/run-scheduled-process.ts");
    expect(source).toContain("createPostgresRuntime");
    expect(source).toContain("application.runScheduledProcess");
    expect(source).toMatch(/try \{\s+await runtime\.drainAssistantWork\(\);\s+\} finally \{\s+await runtime\.shutdown\(\);/u);
    expect(source).not.toMatch(/Telegram|telegramShell|ScheduleStore|scheduleStore|schedule_fires|process_schedules/u);
  });
});
