import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import {
  RecentOwnActivitiesService,
  recentOwnActivitiesMaximumItems,
  recentOwnActivitiesWindowHours,
  type RecentOwnActivityReadStore,
} from "../../../src/application/recent-own-activities.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryRecentOwnActivityReadStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createReadRecentOwnActivitiesTool } from "../../../src/mastra/tools/recent-own-activities-tool.js";

const now = "2026-08-24T12:00:00.000Z";
const ownScope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a" };

function activity(overrides: Partial<PersonalActivityRecord> = {}): PersonalActivityRecord {
  return {
    activityId: "activity_default",
    employeeId: ownScope.employeeId,
    subjectKey: "subject_employee_a",
    sourceMessageId: "message_private",
    companyId: ownScope.companyId,
    groupId: ownScope.groupId,
    roleId: "role_a",
    taskCategory: "reporting",
    routinePattern: "manual_reporting",
    activityDate: "2026-08-24",
    recordedAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("SPEC-MINUTKA-RECENT-OWN-ACTIVITIES-001: bounded correction lookup", () => {
  it("binds a 72-hour, five-item owner/company/group window and returns stable opaque candidates", async () => {
    let seenWindow: Parameters<RecentOwnActivityReadStore["listRecentOwnActivities"]>[0] | undefined;
    const listed = [
      activity({ activityId: "activity_3", recordedAt: "2026-08-24T11:00:00.000Z", automationCandidate: "report_generation" }),
      activity({ activityId: "activity_2", recordedAt: "2026-08-24T11:00:00.000Z", energyStressMarker: "frustration" }),
      activity({ activityId: "activity_1", recordedAt: "2026-08-23T09:00:00.000Z", durationBucket: "1_2h", system: "spreadsheets" }),
      activity({ activityId: "foreign_employee", employeeId: "employee_b" }),
      activity({ activityId: "foreign_company", companyId: "company_b" }),
      activity({ activityId: "foreign_group", groupId: "group_b" }),
      activity({ activityId: "too_old", recordedAt: "2026-08-21T11:59:59.999Z" }),
    ];
    const service = new RecentOwnActivitiesService({
      async listRecentOwnActivities(window) {
        seenWindow = window;
        return listed;
      },
    }, { now: () => now });

    const result = await service.read(ownScope);

    expect(recentOwnActivitiesWindowHours).toBe(72);
    expect(recentOwnActivitiesMaximumItems).toBe(5);
    expect(seenWindow).toEqual({
      ...ownScope,
      recordedAfter: "2026-08-21T12:00:00.000Z",
      recordedBefore: now,
      limit: 5,
    });
    expect(result.activities.map(({ handle }) => handle)).toEqual(["activity_3", "activity_2", "activity_1"]);
    expect(result.activities).toEqual([
      expect.objectContaining({ handle: "activity_3", revision: 1, activityDate: "2026-08-24", recordedAt: "2026-08-24T11:00:00.000Z", automationCandidate: "report_generation" }),
      expect.objectContaining({ handle: "activity_2", revision: 1, energyStressMarker: "frustration" }),
      expect.objectContaining({ handle: "activity_1", revision: 1, durationBucket: "1_2h", system: "spreadsheets" }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/employee_|subject_|company_|group_|role_|message_|private/u);
  });

  it("keeps ordinary repeated work as separate rows and changes nothing when no recent match exists", async () => {
    const state = createInMemoryActivityCollectionState();
    state.activities.push(
      activity({ activityId: "repeat_1", recordedAt: "2026-08-24T08:00:00.000Z" }),
      activity({ activityId: "repeat_2", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "old_repeat", recordedAt: "2026-08-20T09:00:00.000Z" }),
    );
    const service = new RecentOwnActivitiesService(createInMemoryRecentOwnActivityReadStore(state), { now: () => now });
    const before = structuredClone(state.activities);

    await expect(service.read(ownScope)).resolves.toEqual({
      activities: [
        expect.objectContaining({ handle: "repeat_2", taskCategory: "reporting", routinePattern: "manual_reporting" }),
        expect.objectContaining({ handle: "repeat_1", taskCategory: "reporting", routinePattern: "manual_reporting" }),
      ],
    });
    await expect(service.read({ employeeId: "employee_missing", companyId: "company_a", groupId: "group_a" }))
      .resolves.toEqual({ activities: [] });
    expect(state.activities).toEqual(before);
  });

  it("exposes no target identity in model input or output and documents conservative ambiguity handling", async () => {
    const tool = createReadRecentOwnActivitiesTool(async () => ({ activities: [] }));
    const inputSchema = tool.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
    const outputSchema = tool.outputSchema!["~standard"].jsonSchema.output({ target: "draft-07" });
    const description = tool.description ?? "";
    const manual = readFileSync("vault/assistant/bin/read-recent-own-activities.md", "utf8");

    expect(inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
    expect(JSON.stringify(outputSchema)).not.toMatch(/employeeId|subjectKey|companyId|groupId|roleId|messageId|rawText|userText|agentResponse/u);
    expect(description).toContain("Never call before ordinary activity collection");
    expect(description).toContain("If several candidates fit, ask one short clarification");
    expect(description).toContain("if none fit, change nothing");
    expect(manual).toContain("repeating the same kind of work can be a separate factual episode");
    expect(manual).toContain("Never call before ordinary `collectActivities` writes");
    expect(manual).toContain("If several candidates fit, ask one short clarifying question");
    expect(manual).toContain("If no candidate fits, change nothing");
  });
});
