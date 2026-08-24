import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PilotStatusService, type PilotStatusSnapshot } from "../../../src/application/pilot-status.js";
import { pilotStatusDataMarker, renderPilotStatusHtml } from "../../../src/application/pilot-status-html.js";
import { runPilotStatusCommand } from "../../../src/runtime/pilot-status-command.js";

const now = "2026-08-27T12:00:00.000Z"; // day 9; three completed working days since Friday

function snapshot(): PilotStatusSnapshot {
  return {
    participants: [
      {
        employeeId: "emp_safe_1", companyId: "company_a", companyName: "Компания A", groupId: "group_a", groupName: "Пилот A",
        periodFrom: "2026-08-19", periodToExclusive: "2026-09-02", roleName: "Логист", status: "profile_completed",
        lastTouchOn: "2026-08-21", timezone: "Europe/Moscow", messages: 2, activities: 2, traces: 2, schedules: 3, fires: 4, failedFires: 1,
      },
      {
        employeeId: "emp_safe_2", companyId: "company_a", companyName: "Компания A", groupId: "group_a", groupName: "Пилот A",
        periodFrom: "2026-08-19", periodToExclusive: "2026-09-02", status: "invite_issued",
        messages: 0, activities: 0, traces: 0, schedules: 0, fires: 0, failedFires: 0,
      },
      {
        employeeId: "emp_safe_3", companyId: "company_b", companyName: "Компания B", groupId: "group_b", groupName: "Пилот B",
        periodFrom: "2026-08-19", periodToExclusive: "2026-09-02", status: "invite_opened",
        messages: 0, activities: 0, traces: 0, schedules: 0, fires: 0, failedFires: 0,
      },
    ],
    activities: [
      { employee_id: "emp_safe_1", task_category: "reporting", system: "other", duration_bucket: "30_60m", routine_pattern: "other", automation_candidate: "other", energy_stress_marker: "frustration", activity_date: "2026-08-20" },
      { employee_id: "emp_safe_1", task_category: "coordination", duration_bucket: "15_30m", activity_date: "2026-08-21" },
    ],
    messagesByDate: [{ employee_id: "emp_safe_1", message_date: "2026-08-20", count: 2 }],
    feedbackCount: 1,
    traceCoveredMessages: 2,
    controlTotals: { participants: 3, messages: 2, activities: 2, traces: 2 },
  };
}

describe("SPEC-MINUTKA-PILOT-STATUS-001: metadata-only automated pilot report", () => {
  it("builds safe data, counters and threshold flags through the typed use-case", async () => {
    const unsafeProfile = { typicalTasks: ["секретная задача"], aiLevel: "advanced", programGoal: "секретная цель", preferredName: "Имя" };
    const unsafeTransport = { telegramUserId: "telegram-user-secret", chatId: "telegram-chat-secret", subjectKey: "subject-secret" };
    const unsafeMessage = { userText: "полный текст сотрудника", agentResponse: "полный ответ" };
    const result = await new PilotStatusService({ async loadSnapshot() { void unsafeProfile; void unsafeTransport; void unsafeMessage; return snapshot(); } }, () => now).generate({
      healthz: "ok", pendingMigrations: 0, server: { commit: "abc123", backupId: "backup-1", smoke: "passed", units: [{ name: "minutka", status: "active" }] },
    });
    const serialized = JSON.stringify(result);

    expect(result.participants[0]).toMatchObject({ id: "emp_safe_1", role: "Логист", messages: 2, activities: 2, traces: 2, schedules: 3, fires: 4, failedFires: 1, engagement: "dropped_off" });
    expect(result.metrics).toEqual({
      coveragePercent: 33,
      systemOtherPercent: 50,
      systemMissingPercent: 50,
      routinePatternOtherPercent: 50,
      routinePatternMissingPercent: 50,
      automationCandidateOtherPercent: 50,
      automationCandidateMissingPercent: 50,
      energyStressMarkerMissingPercent: 50,
    });
    expect(result.flags.map((flag) => flag.code)).toEqual([
      "coverage_below_60",
      "system_other_above_40",
      "routine_pattern_other_above_40",
      "automation_candidate_other_above_40",
      "participant_dropped_off",
    ]);
    expect(result.flags.map((flag) => flag.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("system omitted — 50%"),
      expect.stringContaining("routine pattern вне словаря — 50%; facet omitted — 50%"),
      expect.stringContaining("automation candidate вне словаря — 50%; facet omitted — 50%"),
    ]));
    expect(result.health).toMatchObject({ firesSucceeded: 3, firesFailed: 1, feedbackCount: 1, traceCoverage: { messages: 2, traces: 2, coveredMessages: 2 } });
    for (const forbidden of ["секретная задача", "секретная цель", "Имя", "telegram-user-secret", "telegram-chat-secret", "subject-secret", "полный текст сотрудника", "полный ответ", "typicalTasks", "aiLevel", "programGoal", "telegramUserId", "chatId", "subjectKey", "userText", "agentResponse"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(result.activities[0]!)).toEqual(["employee_id", "task_category", "system", "duration_bucket", "routine_pattern", "automation_candidate", "energy_stress_marker", "activity_date"]);
  });

  it("reports missing facets diagnostically without treating omission as a warning", async () => {
    const omitted = snapshot();
    omitted.activities = omitted.activities.map((activity) => ({ employee_id: activity.employee_id, task_category: activity.task_category, activity_date: activity.activity_date }));
    const result = await new PilotStatusService({ async loadSnapshot() { return omitted; } }, () => now).generate({ healthz: "ok", pendingMigrations: 0, server: { units: [] } });

    expect(result.metrics).toMatchObject({
      systemOtherPercent: 0,
      systemMissingPercent: 100,
      routinePatternOtherPercent: 0,
      routinePatternMissingPercent: 100,
      automationCandidateOtherPercent: 0,
      automationCandidateMissingPercent: 100,
      energyStressMarkerMissingPercent: 100,
    });
    expect(result.flags.map((flag) => flag.code)).toEqual(["coverage_below_60", "participant_dropped_off"]);
  });

  it("flags each taxonomy misfit independently", async () => {
    const routineOnly = snapshot();
    routineOnly.activities = routineOnly.activities.map((activity) => ({
      employee_id: activity.employee_id,
      task_category: activity.task_category,
      routine_pattern: "other",
      activity_date: activity.activity_date,
    }));
    const result = await new PilotStatusService({ async loadSnapshot() { return routineOnly; } }, () => now).generate({ healthz: "ok", pendingMigrations: 0, server: { units: [] } });

    expect(result.flags.map((flag) => flag.code)).toEqual(["coverage_below_60", "routine_pattern_other_above_40", "participant_dropped_off"]);
  });

  it("fails when per-participant counts drift from independent control totals", async () => {
    const drifted = snapshot();
    drifted.controlTotals.messages = 3;
    await expect(new PilotStatusService({ async loadSnapshot() { return drifted; } }, () => now).generate({ healthz: "ok", pendingMigrations: 0, server: { units: [] } }))
      .rejects.toThrow("aggregate mismatch for messages");
  });

  it("renders a self-contained HTML file by replacing only the data marker", async () => {
    const template = readFileSync("docs/reports/pilot-status-template.html", "utf8");
    const data = await new PilotStatusService({ async loadSnapshot() { return snapshot(); } }, () => now).generate({ healthz: "ok", pendingMigrations: 0, server: { units: [] } });
    const html = renderPilotStatusHtml(template, data);

    expect(html).not.toContain(pilotStatusDataMarker);
    expect(html).toContain('id="pilot-status-data"');
    expect(html).toContain('"schemaVersion":"minutka-pilot-status/v2"');
    expect(html).toContain("Routine other");
    expect(html).toContain("Automation missing");
    expect(html).toContain("Energy missing");
    expect(html).toContain("сгенерировано автоматически, не содержит текстов переписки");
    expect(() => renderPilotStatusHtml("no marker", data)).toThrow("exactly one");
  });

  it("parses the manual CLI output path and server metadata", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    await runPilotStatusCommand([
      "--output", "/tmp/pilot.html", "--template", "custom.html", "--healthz-url", "http://localhost/healthz",
      "--commit", "abc", "--backup-id", "b1", "--smoke", "passed", "--unit", "minutka=active", "--unit", "postgresql=active",
    ], {
      async generate(options) { calls.push(options); return { output: options.output }; },
      write(text) { output.push(text); },
    });
    expect(calls).toEqual([{
      output: "/tmp/pilot.html", template: "custom.html", healthzUrl: "http://localhost/healthz", commit: "abc", backupId: "b1", smoke: "passed",
      units: [{ name: "minutka", status: "active" }, { name: "postgresql", status: "active" }],
    }]);
    expect(output).toEqual(["/tmp/pilot.html\n"]);
  });

  it("keeps generated reports ignored while tracking the template and wires the production timer", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    const nix = readFileSync("nixos/phase3-assistant-stack/modules/pilot-status.nix", "utf8");
    expect(ignore).toContain("reports/*.html");
    expect(ignore).toContain("!docs/reports/pilot-status-template.html");
    expect(nix).toContain("systemd.timers.minutka-pilot-status");
    expect(nix).toContain('reportsDir = "/var/lib/minutka-reports"');
    expect(nix).toContain('reportOutput = "${reportsDir}/pilot-status-latest.html"');
    expect(nix).toContain("OnCalendar");
    // setgid keeps generated files readable by group `users` without widening the directory.
    expect(nix).toContain('"d ${reportsDir} 2750 minutka users -"');
  });
});
