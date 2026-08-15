import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "migrations/0046_create_tenant_reference_directories.sql";
const runbookPath = "docs/runbooks/tenant-reference-directories.md";

function normalizedSql(): string {
  return readFileSync(migrationPath, "utf8").replace(/\s+/g, " ").trim();
}

describe("SPEC-TENANT-REFERENCE-DIRECTORIES-001: tenant reference directories", () => {
  it("creates the company-scoped reference schema and exact directory columns", () => {
    const sql = normalizedSql();

    expect(sql).toContain("CREATE SCHEMA minutka_reference;");
    expect(sql).toContain("CREATE TABLE minutka_reference.companies (");
    expect(sql).toContain("id text PRIMARY KEY CHECK (length(btrim(id)) > 0), name text NOT NULL CHECK (length(btrim(name)) > 0)");
    expect(sql).toContain("CREATE TABLE minutka_reference.training_groups (");
    expect(sql).toContain("company_id text NOT NULL REFERENCES minutka_reference.companies(id) ON DELETE RESTRICT, name text NOT NULL CHECK (length(btrim(name)) > 0), period daterange NOT NULL CHECK (NOT isempty(period))");
    expect(sql).toContain("CREATE TABLE minutka_reference.roles (");
  });

  it("keeps role names unique per company and gives runtime read-only access", () => {
    const sql = normalizedSql();

    expect(sql).toContain("CONSTRAINT roles_company_id_name_unique UNIQUE (company_id, name)");
    expect(sql).toContain("GRANT USAGE ON SCHEMA minutka_reference TO minutka_runtime;");
    expect(sql).toMatch(/GRANT SELECT ON minutka_reference\.companies, minutka_reference\.training_groups, minutka_reference\.roles TO minutka_runtime;/u);
    expect(sql).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|ALL)[^;]*minutka_reference/iu);
  });

  it("documents code-free creation and company-scoped reads", () => {
    const runbook = readFileSync(runbookPath, "utf8");

    expect(runbook).toContain("INSERT INTO minutka_reference.companies");
    expect(runbook).toContain("INSERT INTO minutka_reference.training_groups");
    expect(runbook).toContain("INSERT INTO minutka_reference.roles");
    expect(runbook).toMatch(/FROM minutka_reference\.training_groups\nWHERE company_id = :'company_id'/u);
    expect(runbook).toMatch(/FROM minutka_reference\.roles\nWHERE company_id = :'company_id'/u);
    expect(runbook).not.toMatch(/SELECT \* FROM minutka_reference\.(?:training_groups|roles)/u);
  });
});
