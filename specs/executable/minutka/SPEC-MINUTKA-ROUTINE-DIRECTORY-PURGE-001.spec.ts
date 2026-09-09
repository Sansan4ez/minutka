import { mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRoutineDirectory, RoutineDirectoryError } from "../../../src/application/routine-directory.js";
import { planDirectoryPurge } from "../../../src/application/routine-directory-purge.js";
import { runRoutineDirectoryPurge } from "../../../src/runtime/routine-directory-purge-command.js";
import { runRoutineDirectoryCommand } from "../../../src/runtime/routine-directory.js";
import { runCompanyReportCommand } from "../../../src/runtime/company-report-command.js";
import { loadRoutineDirectoryProviderFromDirectory } from "../../../src/infrastructure/routine-directory-provider.js";
import type { RoutineDirectory } from "../../../src/application/routine-directory.js";

const base = (version: string, entries: RoutineDirectory["sections"][number]["entries"]): RoutineDirectory => ({
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company_a",
  version,
  sections: [{ roleId: "role_a", entries }],
});

const entry = (id: string, provenance: Array<{ groupId: string; subjectKey: string }>, example = id): RoutineDirectory["sections"][number]["entries"][number] => ({
  id,
  name: `Routine ${id}`,
  description: `Description ${id}`,
  examples: [example],
  workCategory: "internal_management",
  quickWin: "checklist",
  provenance,
});

async function fixtureDirectory(files: Array<[string, RoutineDirectory]>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "minutka-routine-purge-"));
  await Promise.all(files.map(async ([name, value]) => writeFile(join(directory, name), `${JSON.stringify(value)}\n`, "utf8")));
  return directory;
}

async function runSubjectPurge(directory: string, subjectKey = "subject_a", group = "group_a", dryRun = false): Promise<string> {
  let output = "";
  await runRoutineDirectoryPurge({ company: "company_a", group, subjectKey, dir: directory, ...(dryRun ? { dryRun: true } : {}) }, (text) => { output += text; });
  return output;
}

describe("SPEC-MINUTKA-ROUTINE-DIRECTORY-PURGE-001: routine directory purge", () => {
  it("removes an A-only entry and all files containing it", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    const output = await runSubjectPurge(directory);
    expect(JSON.parse(output)).toMatchObject({ runtimeRestartRequired: true });
    expect(await readdir(directory)).toEqual(["routine-directory.company_a.tombstones.json"]);
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).toEqual({ ids: ["a"] });
  });

  it("deletes an A+B entry as a whole, including text that only came from A", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [entry("shared", [
        { groupId: "group_a", subjectKey: "subject_a" },
        { groupId: "group_a", subjectKey: "subject_b" },
      ], "example X")])],
    ]);
    await runSubjectPurge(directory);
    const names = await readdir(directory);
    expect(names).not.toContain("routine-directory.company_a.1.json");
    expect((await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).not.toContain("example X");
  });

  it("selects numeric version 10 over version 9 and writes the surviving version as active", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.9.json", base("9", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
      ["routine-directory.company_a.10.json", base("10", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
    ]);
    await runSubjectPurge(directory);
    const surviving = JSON.parse(await readFile(join(directory, "routine-directory.company_a.json"), "utf8")) as RoutineDirectory;
    expect(surviving.version).toBe("11");
    expect(surviving.sections[0]?.entries.map(({ id }) => id)).toEqual(["b"]);
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.11.json"), "utf8"))).toEqual(surviving);
    expect(loadRoutineDirectoryProviderFromDirectory(directory).directories.get("company_a")?.version).toBe("11");
  });

  it("preserves B-only entries from a mixed file in a new version", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
    ]);
    await runSubjectPurge(directory);
    const surviving = (await readdir(directory)).find((name) => name.endsWith(".2.json"));
    expect(surviving).toBeDefined();
    const loaded = JSON.parse(await readFile(join(directory, surviving!), "utf8")) as RoutineDirectory;
    expect(loaded.sections[0]?.entries.map(({ id }) => id)).toEqual(["b"]);
  });

  it("matches a group exactly and does not expand by subjectKey across groups", async () => {
    const files: Array<[string, RoutineDirectory]> = [["routine-directory.company_a.1.json", base("1", [
      entry("g1", [{ groupId: "group_1", subjectKey: "same" }]),
      entry("g2", [{ groupId: "group_2", subjectKey: "same" }]),
    ])]];
    const plan = planDirectoryPurge({ files: files.map(([path, directory]) => ({ path, directory })), scope: { groupId: "group_1" } });
    expect(plan.affectedEntryIds).toEqual(["g1"]);
    const subjectPlan = planDirectoryPurge({ files: files.map(([path, directory]) => ({ path, directory })), scope: { groupId: "group_1", subjectKey: "same" } });
    expect(subjectPlan.affectedEntryIds).toEqual(["g1"]);
  });

  it("deletes every version for a company without touching another company", () => {
    const companyA = base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])]);
    const companyB: RoutineDirectory = { ...companyA, companyId: "company_b" };
    const plan = planDirectoryPurge({
      files: [
        { path: "routine-directory.company_a.1.json", directory: companyA },
        { path: "routine-directory.company_a.2.json", directory: { ...companyA, version: "2" } },
      ],
      scope: "company",
    });
    expect(plan.filesToDelete).toEqual(["routine-directory.company_a.1.json", "routine-directory.company_a.2.json"]);
    expect(plan.affectedEntryIds).toEqual(["a"]);
    expect(companyB.companyId).toBe("company_b");
  });

  it("finds an entry that exists only in an old version and tombstones ids shared by versions", () => {
    const old = base("1", [entry("old", [{ groupId: "group_a", subjectKey: "subject_a" }])]);
    const current = base("2", [entry("keep", [{ groupId: "group_a", subjectKey: "subject_b" }])]);
    const plan = planDirectoryPurge({
      files: [
        { path: "old.json", directory: old },
        { path: "current.json", directory: current },
      ],
      scope: { groupId: "group_a", subjectKey: "subject_a" },
    });
    expect(plan.affectedEntryIds).toEqual(["old"]);
    expect(plan.filesToDelete).toEqual(["old.json"]);
  });

  it("does not recreate a dangling activity id or infer a replacement", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [entry("old", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    await runSubjectPurge(directory);
    const tombstones = JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8")) as { ids: string[] };
    expect(tombstones.ids).toEqual(["old"]);
    expect(tombstones).not.toContain("replacement");
  });

  it("is idempotent and does not delete an unrelated survivor on repeat", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
    ]);
    await runSubjectPurge(directory);
    const before = await readdir(directory);
    await runSubjectPurge(directory);
    expect(await readdir(directory)).toEqual(before);
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.2.json"), "utf8"))).toMatchObject({ sections: [{ entries: [{ id: "b" }] }] });
  });

  it("supports dry-run without changing files and rejects tombstone id reuse", async () => {
    const directory = await fixtureDirectory([
      [
        "routine-directory.company_a.1.json",
        base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])]),
      ],
    ]);
    const before = await readdir(directory);
    const output = await runSubjectPurge(directory, "subject_a", "group_a", true);
    expect(JSON.parse(output)).toMatchObject({ runtimeRestartRequired: true });
    expect(await readdir(directory)).toEqual(before);
    const activeDirectory = base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])]);
    await writeFile(join(directory, "routine-directory.company_a.json"), `${JSON.stringify(activeDirectory)}\n`, "utf8");
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), "[\"a\"]\n", "utf8");
    expect(() => loadRoutineDirectoryProviderFromDirectory(directory)).toThrowError(expect.objectContaining({ code: "directory_reused_id" }));
  });

  it("reports that no runtime restart is needed when the purge plan is empty", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }])])],
    ]);
    const output = await runSubjectPurge(directory);
    expect(JSON.parse(output)).toMatchObject({ affectedEntries: 0, filesDeleted: 0, runtimeRestartRequired: false });
  });

  it("stores tombstones as ids only and accepts restoration with a new id", async () => {
    const directory = await fixtureDirectory([
      [
        "routine-directory.company_a.1.json",
        base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])]),
      ],
    ]);
    await runSubjectPurge(directory);
    const restored = base("3", [entry("new-id", [{ groupId: "group_a", subjectKey: "subject_b" }], "new example")]);
    const loaded = loadRoutineDirectory(restored, { expectedCompanyId: "company_a", tombstoneIds: new Set(["a"]) });
    expect(loaded.sections[0]?.entries[0]?.id).toBe("new-id");
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).toEqual({ ids: ["a"] });
  });

  it("rejects tombstoned ids at validate and company-report command boundaries before writing output", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), JSON.stringify({ ids: ["a"] }), "utf8");
    const directoryFile = join(directory, "routine-directory.company_a.json");
    const reportFile = join(directory, "report.json");
    let validateOutput = "";
    await runRoutineDirectoryCommand(["validate", "--company", "company_a", "--file", directoryFile], (text) => { validateOutput += text; });
    expect(JSON.parse(validateOutput)).toMatchObject({ ok: false, code: "directory_reused_id" });

    let reportBuilds = 0;
    const dependencies = {
      reporting: { async buildReport() { reportBuilds += 1; return { internal: {}, client: {} } as never; } },
      checkLlm: async () => ({ object: { results: [] } }),
      publishing: {
        async resolvePreflightFinding() { throw new Error("must not resolve"); },
        async publishClientReport() { throw new Error("must not publish"); },
      },
    };
    await expect(runCompanyReportCommand([
      "build", "--company", "company_a", "--group", "group_a", "--directory", directoryFile, "--out", reportFile,
    ], dependencies)).rejects.toMatchObject({ code: "directory_reused_id" });
    await expect(stat(reportFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runCompanyReportCommand([
      "publish", "--company", "company_a", "--group", "group_a", "--directory", directoryFile,
      "--findings", join(directory, "findings.json"), "--out", reportFile,
    ], dependencies)).rejects.toMatchObject({ code: "directory_reused_id" });
    expect(reportBuilds).toBe(0);
    await expect(stat(reportFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves command behavior when the sibling tombstone file is absent", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    let output = "";
    await runRoutineDirectoryCommand([
      "validate", "--company", "company_a", "--file", join(directory, "routine-directory.company_a.json"),
    ], (text) => { output += text; });
    expect(JSON.parse(output)).toMatchObject({ ok: true, version: "1", entries: 1 });
  });

  it("purges the active file, versions and tombstones in ROUTINE_DIRECTORY_DIR when --dir is omitted", async () => {
    const shared = base("1", [
      entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
      entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
    ]);
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", shared],
      ["routine-directory.company_a.1.json", shared],
    ]);
    let output = "";
    await runRoutineDirectoryPurge(
      { company: "company_a", group: "group_a", subjectKey: "subject_a" },
      (text) => { output += text; },
      { ROUTINE_DIRECTORY_DIR: directory },
    );
    expect(JSON.parse(output)).toMatchObject({ affectedEntries: 1, filesDeleted: 1, runtimeRestartRequired: true });
    expect((await readdir(directory)).sort()).toEqual([
      "routine-directory.company_a.2.json",
      "routine-directory.company_a.json",
      "routine-directory.company_a.tombstones.json",
    ]);
    const active = JSON.parse(await readFile(join(directory, "routine-directory.company_a.json"), "utf8")) as RoutineDirectory;
    expect(active.version).toBe("2");
    expect(active.sections[0]?.entries.map(({ id }) => id)).toEqual(["b"]);
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).toEqual({ ids: ["a"] });
    const loaded = loadRoutineDirectoryProviderFromDirectory(directory).directories.get("company_a");
    expect(loaded?.version).toBe("2");
    expect(loaded?.sections.flatMap(({ entries }) => entries.map(({ id }) => id))).toEqual(["b"]);
  });

  it("refuses to purge without --dir when ROUTINE_DIRECTORY_DIR is not configured", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    const before = await readdir(directory);
    await expect(runRoutineDirectoryPurge({ company: "company_a" }, () => undefined, {}))
      .rejects.toMatchObject({ name: "RoutineDirectoryError", code: "directory_dir_not_configured" });
    await expect(runRoutineDirectoryPurge({ company: "company_a" }, () => undefined, { ROUTINE_DIRECTORY_DIR: "  " }))
      .rejects.toMatchObject({ code: "directory_dir_not_configured" });
    expect(await readdir(directory)).toEqual(before);
  });

  it("scans historical copies without rejecting ids that were already tombstoned", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("2", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
      ["routine-directory.company_a.1.json", base("1", [
        entry("old", [{ groupId: "group_a", subjectKey: "subject_b" }]),
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
      ])],
    ]);
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), JSON.stringify({ ids: ["old"] }), "utf8");

    const output = await runSubjectPurge(directory);

    expect(JSON.parse(output)).toMatchObject({ affectedEntries: 1, filesDeleted: 1, tombstones: 2 });
    expect(await readdir(directory)).not.toContain("routine-directory.company_a.1.json");
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).toEqual({ ids: ["a", "old"] });
  });

  it("writes tombstones before derived files and completes after a failed first attempt", async () => {
    const active = base("2", [
      entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
      entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
    ]);
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", active],
      ["routine-directory.company_a.2.json", active],
    ]);
    let writes = 0;
    await expect(runRoutineDirectoryPurge(
      { company: "company_a", group: "group_a", subjectKey: "subject_a", dir: directory },
      () => undefined,
      {},
      {
        async writeJson(path, value) {
          writes += 1;
          if (writes === 2) throw new Error("simulated write failure");
          await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        },
        async unlink(path) { await unlink(path); },
      },
    )).rejects.toThrow("simulated write failure");
    expect(JSON.parse(await readFile(join(directory, "routine-directory.company_a.tombstones.json"), "utf8"))).toEqual({ ids: ["a"] });
    expect(await readdir(directory)).toContain("routine-directory.company_a.2.json");

    await runSubjectPurge(directory);

    const surviving = JSON.parse(await readFile(join(directory, "routine-directory.company_a.json"), "utf8")) as RoutineDirectory;
    expect(surviving.sections[0]?.entries.map(({ id }) => id)).toEqual(["b"]);
    expect(await readdir(directory)).not.toContain("routine-directory.company_a.2.json");
  });

  it("uses the active file as current even when a higher saved version exists", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("2", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
      ["routine-directory.company_a.3.json", base("3", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
        entry("c", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
    ]);

    const output = await runSubjectPurge(directory);

    expect(JSON.parse(output)).toMatchObject({ activeFileFallback: 0 });
    const active = JSON.parse(await readFile(join(directory, "routine-directory.company_a.json"), "utf8")) as RoutineDirectory;
    expect(active.version).toBe("4");
    expect(active.sections[0]?.entries.map(({ id }) => id)).toEqual(["b"]);
  });

  it("deletes an unreadable company copy but fails closed for a narrower scope", async () => {
    const companyDirectory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    await writeFile(join(companyDirectory, "routine-directory.company_a.broken.json"), "not-json\n", "utf8");
    let output = "";
    await runRoutineDirectoryPurge({ company: "company_a", dir: companyDirectory }, (text) => { output += text; });
    expect(JSON.parse(output)).toMatchObject({ unparsedFilesDeleted: 1, filesDeleted: 2 });
    expect(await readdir(companyDirectory)).toEqual(["routine-directory.company_a.tombstones.json"]);

    const subjectDirectory = await fixtureDirectory([
      ["routine-directory.company_a.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    await writeFile(join(subjectDirectory, "routine-directory.company_a.broken.json"), "not-json\n", "utf8");
    await expect(runSubjectPurge(subjectDirectory)).rejects.toThrow(/broken\.json.*fix or delete this copy.*retry/u);
  });

  it("reports max-version fallback when the active file is absent", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.9.json", base("9", [
        entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }]),
        entry("b", [{ groupId: "group_a", subjectKey: "subject_b" }]),
      ])],
    ]);
    const output = await runSubjectPurge(directory);
    expect(JSON.parse(output)).toMatchObject({ activeFileFallback: 1 });
  });

  it("rejects a tombstone file containing non-ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minutka-routine-purge-"));
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), JSON.stringify([{ id: "a" }]), "utf8");
    await expect(runRoutineDirectoryPurge({ company: "company_a", dir: directory }, () => undefined)).rejects.toThrow(RoutineDirectoryError);
  });
});
