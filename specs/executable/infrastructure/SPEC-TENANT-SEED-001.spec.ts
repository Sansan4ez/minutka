import { readFileSync } from "node:fs";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  inspectTenantDirectoryCompany,
  parseTenantSeedArguments,
  seedTenantDirectoryKit,
  tenantDirectorySeedInputSchema,
} from "../../../src/runtime/seed-tenant-reference-directories.js";
import { postgresMigrationConfigFromEnv } from "../../../src/infrastructure/postgres/postgres-config.js";
import { withTransaction } from "../../../src/infrastructure/postgres/postgres-pool.js";

const kit = {
  company: { id: "company_acme", name: "ООО «Пример»" },
  group: {
    id: "group_acme_2026_09",
    name: "Пилот — сентябрь 2026",
    periodFrom: "2026-09-01",
    periodToExclusive: "2026-10-01",
  },
  roles: [
    { id: "role_acme_sales", name: "Менеджер по продажам" },
    { id: "role_acme_logistics", name: "Логист" },
  ],
};

describe("SPEC-TENANT-SEED-001: operator tenant directory script", () => {
  it("uses the migration connection outside the application and presentation boundaries", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const runtimeSource = readFileSync("src/runtime/seed-tenant-reference-directories.ts", "utf8");

    expect(packageJson.scripts["tenant:seed"]).toBe("tsx src/runtime/seed-tenant-reference-directories.ts");
    expect(runtimeSource).toContain("postgresMigrationConfigFromEnv(process.env)");
    expect(runtimeSource).not.toContain("postgresConfigFromEnv(process.env)");
    expect(runtimeSource).not.toMatch(/src\/(?:application|client)\//u);
    expect(postgresMigrationConfigFromEnv({
      MIGRATION_DATABASE_URL: "postgresql://migrator@example/minutka",
      DATABASE_SSL_MODE: "disable",
    }).databaseUrl).toContain("migrator");
  });

  it("validates the file shape and explicit commands", () => {
    expect(tenantDirectorySeedInputSchema.parse(kit)).toEqual(kit);
    expect(() => tenantDirectorySeedInputSchema.parse({ ...kit, company: { ...kit.company, name: " " } })).toThrow();
    expect(() => tenantDirectorySeedInputSchema.parse({
      ...kit,
      group: { ...kit.group, periodToExclusive: kit.group.periodFrom },
    })).toThrow("must be later than periodFrom");
    expect(parseTenantSeedArguments(["seed", "--file", "kit.json"])).toMatchObject({ command: "seed" });
    expect(parseTenantSeedArguments(["inspect", "--company-id", "company_acme"])).toEqual({
      command: "inspect",
      companyId: "company_acme",
    });
    expect(() => parseTenantSeedArguments(["seed", "--company-id", "company_acme"])).toThrow("usage:");
  });

  it("creates the complete kit with parameterized SQL and reports it", async () => {
    const database = fakeDatabase();

    const result = await withTransaction(database.pool, (client) => seedTenantDirectoryKit(client, kit));

    expect(result).toEqual({ status: "created", ...kit });
    expect(database.client.queries.map(({ sql }) => sql.replace(/\s+/gu, " ").trim())).toEqual([
      "BEGIN",
      "SELECT id, name FROM minutka_reference.companies WHERE id = $1",
      "SELECT id, company_id, name, lower(period)::text AS period_from, upper(period)::text AS period_to_exclusive FROM minutka_reference.training_groups WHERE id = $1",
      "SELECT id, company_id, name FROM minutka_reference.roles WHERE id = ANY($1::text[]) OR (company_id = $2 AND name = ANY($3::text[])) ORDER BY id",
      "INSERT INTO minutka_reference.companies (id, name) VALUES ($1, $2)",
      "INSERT INTO minutka_reference.training_groups (id, company_id, name, period) VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'))",
      "INSERT INTO minutka_reference.roles (id, company_id, name) VALUES ($1, $2, $3)",
      "INSERT INTO minutka_reference.roles (id, company_id, name) VALUES ($1, $2, $3)",
      "COMMIT",
    ]);
  });

  it("treats an exact existing kit as idempotent and refuses silent overwrite", async () => {
    const exact = fakeExecutor([
      [kit.company],
      [{
        id: kit.group.id,
        company_id: kit.company.id,
        name: kit.group.name,
        period_from: kit.group.periodFrom,
        period_to_exclusive: kit.group.periodToExclusive,
      }],
      kit.roles.map((role) => ({ ...role, company_id: kit.company.id })),
    ]);
    await expect(seedTenantDirectoryKit(exact, kit)).resolves.toEqual({ status: "already_exists", ...kit });
    expect(exact.queries).toHaveLength(3);

    const conflict = fakeExecutor([
      [{ ...kit.company, name: "Другое имя" }],
      [],
      [],
    ]);
    await expect(seedTenantDirectoryKit(conflict, kit)).rejects.toThrow("conflicts with existing or partially created records");
    expect(conflict.queries).toHaveLength(3);
  });

  it("rolls back the whole kit when any insert fails", async () => {
    const database = fakeDatabase(7);

    await expect(withTransaction(database.pool, (client) => seedTenantDirectoryKit(client, kit)))
      .rejects.toThrow("forced insert failure");

    expect(database.client.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(database.client.queries.some(({ sql }) => sql === "COMMIT")).toBe(false);
  });

  it("inspects groups and roles only through an explicit company scope", async () => {
    const executor = fakeExecutor([
      [{ id: kit.company.id, name: kit.company.name }],
      [{
        id: kit.group.id,
        name: kit.group.name,
        period_from: kit.group.periodFrom,
        period_to_exclusive: kit.group.periodToExclusive,
      }],
      kit.roles,
    ]);

    await expect(inspectTenantDirectoryCompany(executor, kit.company.id)).resolves.toEqual({
      company: kit.company,
      groups: [{
        id: kit.group.id,
        name: kit.group.name,
        periodFrom: kit.group.periodFrom,
        periodToExclusive: kit.group.periodToExclusive,
      }],
      roles: kit.roles,
    });
    expect(executor.queries.every(({ values }) => values?.[0] === kit.company.id)).toBe(true);
  });
});

function fakeExecutor(rowSets: QueryResultRow[][]): {
  query: PoolClient["query"];
  queries: Array<{ sql: string; values?: unknown[] }>;
} {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let index = 0;
  return {
    queries,
    query: (async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return queryResult(rowSets[index++] ?? []);
    }) as PoolClient["query"],
  };
}

function fakeDatabase(failAtQuery?: number): {
  pool: Pool;
  client: PoolClient & { queries: Array<{ sql: string; values?: unknown[] }> };
} {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    queries,
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (queries.length === failAtQuery) throw new Error("forced insert failure");
      return queryResult([]);
    },
    release: () => undefined,
  } as unknown as PoolClient & { queries: Array<{ sql: string; values?: unknown[] }> };
  return {
    client,
    pool: { connect: async () => client } as unknown as Pool,
  };
}

function queryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}
