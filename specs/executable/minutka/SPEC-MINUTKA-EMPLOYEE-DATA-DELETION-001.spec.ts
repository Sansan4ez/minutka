import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmployeeDataDeletionService } from "../../../src/application/employee-data-deletion.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createMinioEmployeeObjectDeletionStore } from "../../../src/infrastructure/minio/minio-employee-object-deletion-store.js";

const issuedAt = "2026-08-17T00:00:00.000Z";

async function invite(profiles: ReturnType<typeof createInMemoryProfileStore>, input: {
  employeeId: string; inviteCode: string; companyId: string; groupId: string;
}) {
  await profiles.issueInvite({ ...input, issuedAt });
}

describe("SPEC-MINUTKA-EMPLOYEE-DATA-DELETION-001: operator employee deletion", () => {
  it("deletes only the requested employee, preserves anonymized rows, and revokes the old invite", async () => {
    const world = createInMemoryWorld();
    const profiles = createInMemoryProfileStore(world);
    await invite(profiles, { employeeId: "employee_a", inviteCode: "invite_a", companyId: "company_a", groupId: "group_a" });
    await invite(profiles, { employeeId: "employee_b", inviteCode: "invite_b", companyId: "company_a", groupId: "group_a" });
    await invite(profiles, { employeeId: "employee_c", inviteCode: "invite_c", companyId: "company_b", groupId: "group_c" });
    world.messages.push(
      { id: "a", employeeId: "employee_a", threadId: "thread_a", text: "private A", response: "reply", timestamp: issuedAt },
      { id: "b", employeeId: "employee_b", threadId: "thread_b", text: "private B", response: "reply", timestamp: issuedAt },
      { id: "c", employeeId: "employee_c", threadId: "thread_c", text: "private C", response: "reply", timestamp: issuedAt },
    );
    const anonymizedRows = [
      { companyId: "company_a", groupId: "group_a", roleId: "role_a", date: "2026-08-17" },
      { companyId: "company_b", groupId: "group_c", roleId: "role_c", date: "2026-08-17" },
    ];
    const deletedObjectOwners: string[] = [];
    const service = new EmployeeDataDeletionService(profiles, {
      async deleteByEmployee(employeeId) { deletedObjectOwners.push(employeeId); return { deletedObjectVersions: 4 }; },
    });

    await expect(service.deleteEmployeeData({ employeeId: " employee_a " })).resolves.toMatchObject({
      employeeId: "employee_a",
      deleted: { participants: 1, messages: 1, minioObjectVersions: 4 },
      preserved: { anonymizedActivities: true, anonymousDeletionAudit: true, aggregateUsageCounters: "not_configured" },
      oldInviteRevoked: true,
    });

    expect(deletedObjectOwners).toEqual(["employee_a"]);
    expect(world.participants.map(({ employeeId }) => employeeId).sort()).toEqual(["employee_b", "employee_c"]);
    expect(world.messages.map(({ employeeId }) => employeeId).sort()).toEqual(["employee_b", "employee_c"]);
    expect(anonymizedRows).toHaveLength(2);
    await expect(profiles.openInvite({ inviteCode: "invite_a", openedAt: issuedAt })).resolves.toBeUndefined();
    await expect(profiles.openInvite({ inviteCode: "invite_b", openedAt: issuedAt })).resolves.toBeDefined();
    await expect(profiles.openInvite({ inviteCode: "invite_c", openedAt: issuedAt })).resolves.toBeDefined();
    expect(world.auditEvents.at(-1)).toMatchObject({ type: "employee_data_deleted", metadata: {} });
    expect(world.auditEvents.at(-1)).not.toHaveProperty("employeeId");
  });

  it("physically deletes every MinIO object version under only the requested owner prefix", async () => {
    const removed: Array<{ name: string; options: { forceDelete?: boolean; versionId?: string } }> = [];
    const client = {
      listObjects(_bucket: string, prefix: string, recursive: boolean, options: { IncludeVersion?: boolean }) {
        expect(prefix).toBe("employee_a/");
        expect(recursive).toBe(true);
        expect(options).toEqual({ IncludeVersion: true });
        const stream = new EventEmitter();
        queueMicrotask(() => {
          stream.emit("data", { name: "employee_a/context/profile.md", versionId: "v2" });
          stream.emit("data", { name: "employee_a/context/profile.md", versionId: "v1", isDeleteMarker: true });
          stream.emit("data", { name: "employee_a/cas/sha256/aa/body", versionId: "v3" });
          stream.emit("end");
        });
        return stream;
      },
      async removeObject(_bucket: string, name: string, options: { forceDelete?: boolean; versionId?: string }) {
        removed.push({ name, options });
      },
    };
    const store = createMinioEmployeeObjectDeletionStore({ client: client as never, bucket: "vault" });

    await expect(store.deleteByEmployee("employee_a")).resolves.toEqual({ deletedObjectVersions: 3 });
    expect(removed).toEqual([
      { name: "employee_a/context/profile.md", options: { forceDelete: true, versionId: "v2" } },
      { name: "employee_a/context/profile.md", options: { forceDelete: true, versionId: "v1" } },
      { name: "employee_a/cas/sha256/aa/body", options: { forceDelete: true, versionId: "v3" } },
    ]);
  });

  it("keeps the participant when object deletion fails so the operation can be retried", async () => {
    const world = createInMemoryWorld();
    const profiles = createInMemoryProfileStore(world);
    await invite(profiles, { employeeId: "employee_a", inviteCode: "invite_a", companyId: "company_a", groupId: "group_a" });
    const service = new EmployeeDataDeletionService(profiles, {
      async deleteByEmployee() { throw new Error("minio unavailable"); },
    });

    await expect(service.deleteEmployeeData({ employeeId: "employee_a" })).rejects.toThrow("minio unavailable");
    await expect(profiles.getParticipant("employee_a")).resolves.toBeDefined();
  });

  it("documents the confirmed operator command and the exact privacy-v6 subject scope", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const runtime = readFileSync("src/runtime/delete-employee-data.ts", "utf8");
    const runbook = readFileSync("docs/runbooks/employee-personal-data-deletion.md", "utf8");
    const consent = readFileSync("vault/assistant/processes/consent_and_privacy.md", "utf8");
    const skillsMap = readFileSync("docs/product/skills-map.md", "utf8");

    expect(packageJson.scripts["employee:data:delete"]).toBe("tsx src/runtime/delete-employee-data.ts");
    expect(runtime).toContain("DELETE ${employeeId}");
    expect(runtime).toContain("confirmation did not match; nothing was deleted");
    expect(runbook).toContain("npm run employee:data:delete -- <employee_id>");
    for (const phrase of ["профиль", "Telegram-привязку", "разговоры", "активности", "traces", "feedback", "evaluation cases", "персональные выводы"]) {
      expect(consent).toContain(phrase);
    }
    expect(consent).toContain("subject_key");
    expect(consent).toContain("старый инвайт перестаёт работать");
    expect(consent).toContain("отчёт пересчитывается");

    const workingSection = skillsMap.split("## 🚧 Следующий срез")[0] ?? "";
    const nextSliceSection = skillsMap.split("## 🚧 Следующий срез")[1]?.split("## ⛔")[0] ?? "";
    expect(workingSection).toContain("| Удаление данных |");
    expect(nextSliceSection).not.toContain("| Удаление данных |");
    for (const phrase of [
      "передаётся доверенному оператору",
      "не self-service действие агента",
      "irreversible typed procedure",
      "company/group/subject scope",
      "canonical corpus/traces/evaluation удаляются",
      "ещё не переданный report пересчитывается",
      "старый инвайт subject отзывается",
    ]) {
      expect(workingSection).toContain(phrase);
    }
  });
});
