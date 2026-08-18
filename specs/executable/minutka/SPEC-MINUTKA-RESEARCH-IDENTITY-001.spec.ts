import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createResearchIdentityProjection } from "../../../src/application/research-identity-projection.js";

const now = "2026-08-18T00:00:00.000Z";

describe("SPEC-MINUTKA-RESEARCH-IDENTITY-001: group-scoped research subjects", () => {
  it("creates random unique keys and returns only tenant-scoped research identity", async () => {
    const world = createInMemoryWorld(() => now);
    const keys = ["subject-a", "subject-b", "subject-c"];
    const profiles = createInMemoryProfileStore(world, { subjectKey: () => keys.shift()! });
    const research = createResearchIdentityProjection(profiles);

    await profiles.issueInvite({ employeeId: "employee-a", inviteCode: "invite-a", companyId: "company-a", groupId: "group-a", issuedAt: now });
    await profiles.issueInvite({ employeeId: "employee-b", inviteCode: "invite-b", companyId: "company-a", groupId: "group-b", issuedAt: now });
    await profiles.issueInvite({ employeeId: "employee-c", inviteCode: "invite-c", companyId: "company-b", groupId: "group-c", issuedAt: now });
    world.participants[0]!.roleId = "role-a";

    const conversations = createInMemoryConversationStore(world);
    await conversations.appendTurn({
      messageId: "message-a",
      employeeId: "employee-a",
      subjectKey: "subject-a",
      threadId: "thread-a",
      userText: "private text",
      agentResponse: "reply",
      timestamp: now,
    });

    const repeated = await profiles.issueInvite({ employeeId: "employee-a", inviteCode: "invite-a", companyId: "company-a", groupId: "group-a", issuedAt: now });
    expect(repeated.participant.subjectKey).toBe("subject-a");
    expect(new Set(world.participants.map((participant) => participant.subjectKey)).size).toBe(3);
    expect(await research.listSubjects({ companyId: "company-a", groupId: "group-a" })).toEqual([{
      companyId: "company-a",
      groupId: "group-a",
      subjectKey: "subject-a",
      roleId: "role-a",
      evidenceRefs: [{ kind: "message", id: "message-a" }],
    }]);
    expect(await research.getSubject({ companyId: "company-b", groupId: "group-c", subjectKey: "subject-a" })).toBeUndefined();
    expect(JSON.stringify(await research.listSubjects({ companyId: "company-a", groupId: "group-a" })))
      .not.toMatch(/employee|telegram|invite|private text/iu);
  });

  it("indexes canonical records by subject while employee APIs remain employee-scoped", () => {
    const sql = readFileSync("migrations/0056_add_research_subject_keys.sql", "utf8");
    expect(sql).toContain("participants_group_subject_unique");
    expect(sql).toContain("participants_subject_unique");
    expect(sql).toContain("messages_subject_recent");
    expect(sql).toContain("activities_subject_recorded");
    expect(sql).toMatch(/ADD COLUMN subject_key uuid[\s\S]*UPDATE minutka_private\.participants[\s\S]*ALTER COLUMN subject_key SET NOT NULL/u);
    expect(sql).toMatch(/UPDATE minutka_private\.messages[\s\S]*participant\.subject_key/u);
    expect(sql).toMatch(/UPDATE minutka_private\.activities[\s\S]*participant\.subject_key/u);
  });
});
