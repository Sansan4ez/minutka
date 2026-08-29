import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../../../src/domain/insights.js";

type FacetConstraint = {
  table: "activities" | "activity_revisions";
  column: string;
  constraint: string;
  values: readonly string[];
};

const facetConstraints: FacetConstraint[] = [
  { table: "activities", column: "task_category", constraint: "activities_task_category_check", values: taskCategories },
  { table: "activities", column: "routine_pattern", constraint: "activities_routine_pattern_check", values: routinePatternTypes },
  { table: "activities", column: "automation_candidate", constraint: "activities_automation_candidate_check", values: automationCandidateTypes },
  { table: "activities", column: "energy_stress_marker", constraint: "activities_energy_stress_marker_check", values: energyStressMarkerTypes },
  { table: "activities", column: "duration_bucket", constraint: "activities_duration_bucket_check", values: activityDurationBuckets },
  { table: "activities", column: "system", constraint: "activities_system_check", values: activitySystems },
  { table: "activity_revisions", column: "task_category", constraint: "activity_revisions_task_category_check", values: taskCategories },
  { table: "activity_revisions", column: "routine_pattern", constraint: "activity_revisions_routine_pattern_check", values: routinePatternTypes },
  { table: "activity_revisions", column: "automation_candidate", constraint: "activity_revisions_automation_candidate_check", values: automationCandidateTypes },
  { table: "activity_revisions", column: "energy_stress_marker", constraint: "activity_revisions_energy_stress_marker_check", values: energyStressMarkerTypes },
  { table: "activity_revisions", column: "duration_bucket", constraint: "activity_revisions_duration_bucket_check", values: activityDurationBuckets },
  { table: "activity_revisions", column: "system", constraint: "activity_revisions_system_check", values: activitySystems },
];

const migrations = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ path: `migrations/${name}`, sql: readFileSync(`migrations/${name}`, "utf8") }));

function latestConstraintMigration({ table, column, constraint }: FacetConstraint): { path: string; sql: string } {
  const escapedTable = escapeRegex(table);
  const escapedColumn = escapeRegex(column);
  const escapedConstraint = escapeRegex(constraint);
  const namedConstraint = new RegExp(
    `ALTER\\s+TABLE\\s+minutka_private\\.${escapedTable}[\\s\\S]*?ADD\\s+CONSTRAINT\\s+${escapedConstraint}\\b`,
    "i",
  );
  const inlineConstraint = new RegExp(
    `CREATE\\s+TABLE\\s+minutka_private\\.${escapedTable}[\\s\\S]*?\\b${escapedColumn}\\s+text\\s+CHECK\\s*\\(`,
    "i",
  );
  const migration = [...migrations].reverse().find(({ sql }) => namedConstraint.test(sql) || inlineConstraint.test(sql));
  if (!migration) throw new Error(`${constraint} migration not found`);
  return migration;
}

function constrainedValues(sql: string, { column, constraint }: FacetConstraint): string[] {
  const escapedConstraint = escapeRegex(constraint);
  const escapedColumn = escapeRegex(column);
  const namedCheck = new RegExp(
    `ADD\\s+CONSTRAINT\\s+${escapedConstraint}\\s+CHECK\\s*\\(\\s*${escapedColumn}\\s+IN\\s*\\(([^;]+?)\\)\\s*\\)`,
    "is",
  );
  const inlineCheck = new RegExp(
    `\\b${escapedColumn}\\s+text\\s+CHECK\\s*\\(\\s*${escapedColumn}\\s+IN\\s*\\(([^;]+?)\\)\\s*\\)`,
    "is",
  );
  const check = sql.match(namedCheck)?.[1] ?? sql.match(inlineCheck)?.[1];
  if (!check) throw new Error(`${constraint} CHECK list not found`);
  return [...check.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("ACTIVITY-SYSTEM-DICTIONARY-PARITY: activity facet dictionaries match their current database constraints", () => {
  for (const facet of facetConstraints) {
    it(`keeps ${facet.table}.${facet.column} equal to its domain dictionary in both directions`, () => {
      // A domain value rejected by either canonical rows or their revision
      // history loses the whole transactional write. Every projection must
      // therefore move with the single domain dictionary.
      const migration = latestConstraintMigration(facet);
      const constrained = constrainedValues(migration.sql, facet);

      expect(new Set(constrained).size, `${migration.path} contains duplicate ${facet.column} values`).toBe(constrained.length);
      expect([...constrained].sort()).toEqual([...facet.values].sort());
    });
  }
});
