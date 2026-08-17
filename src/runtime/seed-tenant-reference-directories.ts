import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresMigrationConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool, type SqlExecutor, withTransaction } from "../infrastructure/postgres/postgres-pool.js";

const nonEmptyText = z.string().trim().min(1);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isCalendarDate, "must be a valid YYYY-MM-DD date");

export const tenantDirectorySeedInputSchema = z.object({
  company: z.object({ id: nonEmptyText, name: nonEmptyText }).strict(),
  group: z.object({
    id: nonEmptyText,
    name: nonEmptyText,
    periodFrom: calendarDate,
    periodToExclusive: calendarDate,
  }).strict(),
  roles: z.array(z.object({ id: nonEmptyText, name: nonEmptyText }).strict()).min(1),
}).strict().superRefine((input, context) => {
  if (input.group.periodFrom >= input.group.periodToExclusive) {
    context.addIssue({
      code: "custom",
      path: ["group", "periodToExclusive"],
      message: "must be later than periodFrom",
    });
  }
  reportDuplicates(input.roles.map((role) => role.id), "id", context);
  reportDuplicates(input.roles.map((role) => role.name), "name", context);
});

export type TenantDirectorySeedInput = z.infer<typeof tenantDirectorySeedInputSchema>;
export type TenantDirectoryKitResult = TenantDirectorySeedInput & { status: "created" | "already_exists" };

export async function seedTenantDirectoryKit(
  executor: SqlExecutor,
  rawInput: unknown,
): Promise<TenantDirectoryKitResult> {
  const input = tenantDirectorySeedInputSchema.parse(rawInput);
  const companyResult = await executor.query<{ id: string; name: string }>(
    "SELECT id, name FROM minutka_reference.companies WHERE id = $1",
    [input.company.id],
  );
  const groupResult = await executor.query<{
    id: string;
    company_id: string;
    name: string;
    period_from: string;
    period_to_exclusive: string;
  }>(
    `SELECT id, company_id, name, lower(period)::text AS period_from,
       upper(period)::text AS period_to_exclusive
     FROM minutka_reference.training_groups
     WHERE id = $1`,
    [input.group.id],
  );
  const roleResult = await executor.query<{ id: string; company_id: string; name: string }>(
    `SELECT id, company_id, name
     FROM minutka_reference.roles
     WHERE id = ANY($1::text[])
        OR (company_id = $2 AND name = ANY($3::text[]))
     ORDER BY id`,
    [input.roles.map((role) => role.id), input.company.id, input.roles.map((role) => role.name)],
  );

  const company = companyResult.rows[0];
  const group = groupResult.rows[0];
  const roles = roleResult.rows;
  if (!company && !group && roles.length === 0) {
    await executor.query(
      "INSERT INTO minutka_reference.companies (id, name) VALUES ($1, $2)",
      [input.company.id, input.company.name],
    );
    await executor.query(
      `INSERT INTO minutka_reference.training_groups (id, company_id, name, period)
       VALUES ($1, $2, $3, daterange($4::date, $5::date, '[)'))`,
      [
        input.group.id,
        input.company.id,
        input.group.name,
        input.group.periodFrom,
        input.group.periodToExclusive,
      ],
    );
    for (const role of input.roles) {
      await executor.query(
        "INSERT INTO minutka_reference.roles (id, company_id, name) VALUES ($1, $2, $3)",
        [role.id, input.company.id, role.name],
      );
    }
    return { status: "created", ...input };
  }

  if (existingKitMatchesInput({ company, group, roles }, input)) {
    return { status: "already_exists", ...input };
  }
  throw new Error(
    `tenant directory kit conflicts with existing or partially created records for company ${JSON.stringify(input.company.id)}; nothing was changed`,
  );
}

export async function inspectTenantDirectoryCompany(executor: SqlExecutor, companyIdInput: string): Promise<{
  company: { id: string; name: string } | null;
  groups: Array<{ id: string; name: string; periodFrom: string; periodToExclusive: string }>;
  roles: Array<{ id: string; name: string }>;
}> {
  const companyId = nonEmptyText.parse(companyIdInput);
  const companyResult = await executor.query<{ id: string; name: string }>(
    "SELECT id, name FROM minutka_reference.companies WHERE id = $1",
    [companyId],
  );
  const groupResult = await executor.query<{
    id: string;
    name: string;
    period_from: string;
    period_to_exclusive: string;
  }>(
    `SELECT id, name, lower(period)::text AS period_from, upper(period)::text AS period_to_exclusive
     FROM minutka_reference.training_groups
     WHERE company_id = $1
     ORDER BY name, id`,
    [companyId],
  );
  const roleResult = await executor.query<{ id: string; name: string }>(
    `SELECT id, name
     FROM minutka_reference.roles
     WHERE company_id = $1
     ORDER BY name, id`,
    [companyId],
  );
  return {
    company: companyResult.rows[0] ?? null,
    groups: groupResult.rows.map((group) => ({
      id: group.id,
      name: group.name,
      periodFrom: group.period_from,
      periodToExclusive: group.period_to_exclusive,
    })),
    roles: roleResult.rows,
  };
}

export function parseTenantSeedArguments(args: string[]):
  | { command: "seed"; file: string }
  | { command: "inspect"; companyId: string } {
  const [command, option, value, ...rest] = args;
  if (rest.length > 0) throw usageError();
  if (command === "seed" && option === "--file" && value?.trim()) {
    return { command, file: resolve(value) };
  }
  if (command === "inspect" && option === "--company-id" && value?.trim()) {
    return { command, companyId: value.trim() };
  }
  throw usageError();
}

async function main(): Promise<void> {
  const command = parseTenantSeedArguments(process.argv.slice(2));
  const config = postgresMigrationConfigFromEnv(process.env);
  const pool = createPostgresPool(config);
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length) {
      throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    }
    const result = command.command === "seed"
      ? await withTransaction(pool, async (client) => seedTenantDirectoryKit(
          client,
          JSON.parse(await readFile(command.file, "utf8")) as unknown,
        ))
      : await inspectTenantDirectoryCompany(pool, command.companyId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function existingKitMatchesInput(
  existing: {
    company?: { id: string; name: string };
    group?: { id: string; company_id: string; name: string; period_from: string; period_to_exclusive: string };
    roles: Array<{ id: string; company_id: string; name: string }>;
  },
  input: TenantDirectorySeedInput,
): boolean {
  if (existing.company?.name !== input.company.name) return false;
  if (
    existing.group?.company_id !== input.company.id
    || existing.group.name !== input.group.name
    || existing.group.period_from !== input.group.periodFrom
    || existing.group.period_to_exclusive !== input.group.periodToExclusive
  ) return false;
  if (existing.roles.length !== input.roles.length) return false;
  const rolesById = new Map(existing.roles.map((role) => [role.id, role]));
  return input.roles.every((role) => {
    const existingRole = rolesById.get(role.id);
    return existingRole?.company_id === input.company.id && existingRole.name === role.name;
  });
}

function reportDuplicates(values: string[], field: "id" | "name", context: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: ["roles", index, field], message: `duplicate role ${field}` });
    }
    seen.add(value);
  });
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function usageError(): Error {
  return new Error([
    "usage:",
    "  npm run tenant:seed -- seed --file <kit.json>",
    "  npm run tenant:seed -- inspect --company-id <company_id>",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "tenant directory operation failed");
    process.exitCode = 1;
  });
}
