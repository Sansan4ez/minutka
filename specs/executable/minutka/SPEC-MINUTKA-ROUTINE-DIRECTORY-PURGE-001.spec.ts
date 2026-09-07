import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRoutineDirectory, RoutineDirectoryError } from "../../../src/application/routine-directory.js";
import { planDirectoryPurge } from "../../../src/application/routine-directory-purge.js";
import { runRoutineDirectoryPurge } from "../../../src/runtime/routine-directory-purge-command.js";
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
  quickWin: "checklist",
  provenance,
});

async function fixtureDirectory(files: Array<[string, RoutineDirectory]>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "minutka-routine-purge-"));
  await Promise.all(files.map(async ([name, value]) => writeFile(join(directory, name), `${JSON.stringify(value)}\n`, "utf8")));
  return directory;
}

async function runSubjectPurge(directory: string, subjectKey = "subject_a", group = "group_a", dryRun = false): Promise<void> {
  await runRoutineDirectoryPurge({ company: "company_a", group, subjectKey, dir: directory, ...(dryRun ? { dryRun: true } : {}) }, () => undefined);
}

describe("SPEC-MINUTKA-ROUTINE-DIRECTORY-PURGE-001: routine directory purge", () => {
  it("removes an A-only entry and all files containing it", async () => {
    const directory = await fixtureDirectory([
      ["routine-directory.company_a.1.json", base("1", [entry("a", [{ groupId: "group_a", subjectKey: "subject_a" }])])],
    ]);
    await runSubjectPurge(directory);
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
    await runSubjectPurge(directory, "subject_a", "group_a", true);
    expect(await readdir(directory)).toEqual(before);
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), "[\"a\"]\n", "utf8");
    expect(() => loadRoutineDirectoryProviderFromDirectory(directory)).toThrowError(expect.objectContaining({ code: "directory_reused_id" }));
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

  it("rejects a tombstone file containing non-ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "minutka-routine-purge-"));
    await writeFile(join(directory, "routine-directory.company_a.tombstones.json"), JSON.stringify([{ id: "a" }]), "utf8");
    await expect(runRoutineDirectoryPurge({ company: "company_a", dir: directory }, () => undefined)).rejects.toThrow(RoutineDirectoryError);
  });
});
