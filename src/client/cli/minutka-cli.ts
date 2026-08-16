import { randomBytes } from "node:crypto";
import { Command } from "commander";
import type { AdminMinutkaClient, EmployeeMinutkaClient } from "../sdk/minutka-client.js";

export type CliResult = { exitCode: number; stdout: string[]; stderr: string[] };
function parseChoice<const T extends readonly string[]>(value: string, choices: T, label: string): T[number] { if (choices.includes(value)) return value; throw new Error(`${label} must be one of: ${choices.join(", ")}`); }
function currentUsageMonth(): string { return new Date().toISOString().slice(0, 7); }
const parsePersona = (value: string) => parseChoice(value, ["support", "efficiency"] as const, "persona");
const parseResponseLength = (value: string) => parseChoice(value, ["short", "balanced", "detailed"] as const, "response-length");
const parseInsightKind = (value: string) => parseChoice(value, ["task_category", "routine_pattern", "energy_stress_marker", "automation_candidate"] as const, "kind");

/** Presentation-only CLI. Identity is supplied by the configured transport token. */
export async function runMinutkaCli(client: EmployeeMinutkaClient | AdminMinutkaClient, argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
  const employeeClient = client as EmployeeMinutkaClient;
  const adminClient = client as AdminMinutkaClient;
  const stdout: string[] = []; const stderr: string[] = [];
  const program = new Command().name("minutka").exitOverride().configureOutput({ writeOut: (v) => stdout.push(v.trim()), writeErr: (v) => stderr.push(v.trim()) });
  const employee = new Command("employee").description("Commands for the authenticated employee");
  employee.addCommand(new Command("open-invite").requiredOption("--invite <inviteCode>").action(async (o: { invite: string }) => { stdout.push(JSON.stringify(await employeeClient.openInvite({ inviteCode: o.invite }))); }));
  employee.addCommand(new Command("accept-consent").option("--yes").action(async (o: { yes?: boolean }) => { if (o.yes !== true) throw new Error("privacy consent must be explicitly accepted"); stdout.push(JSON.stringify(await employeeClient.acceptConsent({ accepted: true, source: "cli" }))); }));
  employee.addCommand(new Command("complete-onboarding").option("--name <preferredName>").option("--assistant-name <assistantName>").option("--address-form <addressForm>", "informal|formal").option("--timezone <timezone>").requiredOption("--role-id <roleId>").option("--self-description <text>").requiredOption("--persona <persona>", "support|efficiency", parsePersona).option("--response-length <length>", "short|balanced|detailed", parseResponseLength).action(async (o: { preferredName?: string; assistantName?: string; addressForm?: "informal" | "formal"; timezone?: string; roleId: string; selfDescription?: string; persona: "support" | "efficiency"; responseLength?: "short" | "balanced" | "detailed" }) => { stdout.push(JSON.stringify(await employeeClient.completeOnboarding({ preferredName: o.preferredName, assistantName: o.assistantName, addressForm: o.addressForm, timezone: o.timezone, roleId: o.roleId, selfDescription: o.selfDescription, persona: o.persona, responseLength: o.responseLength }))); }));
  employee.addCommand(new Command("profile").action(async () => { stdout.push(JSON.stringify(await employeeClient.getProfile())); }));
  employee.addCommand(new Command("chat").option("--thread <threadId>", "Thread ID; specify the Telegram thread ID for cross-channel continuity", "default").requiredOption("--text <text>").action(async (o: { thread: string; text: string }) => { stdout.push(JSON.stringify(await employeeClient.chat({ threadId: o.thread, text: o.text }))); }));
  employee.addCommand(new Command("insights").option("--thread <threadId>").option("--kind <kind>", "Insight kind", parseInsightKind).action(async (o: { thread?: string; kind?: ReturnType<typeof parseInsightKind> }) => { stdout.push(JSON.stringify(await employeeClient.listInsights({ threadId: o.thread, kind: o.kind }))); }));
  employee.addCommand(new Command("feedback").option("--thread <threadId>", "Thread ID; specify the Telegram thread ID for cross-channel continuity", "default").requiredOption("--target-message <targetMessageId>").requiredOption("--rating <rating>").action(async (o: { thread: string; targetMessage: string; rating: string }) => { if (!["positive", "neutral", "negative"].includes(o.rating)) throw new Error("rating must be positive, neutral, or negative"); stdout.push(JSON.stringify(await employeeClient.submitFeedback({ threadId: o.thread, targetMessageId: o.targetMessage, rating: o.rating as "positive" | "neutral" | "negative", source: "cli" }))); }));
  program.addCommand(employee);
  const admin = new Command("admin").description("Operator commands");
  admin.addCommand(new Command("issue-invite").requiredOption("--employee <employeeId>").requiredOption("--invite <inviteCode>").requiredOption("--company <companyId>").requiredOption("--group <groupId>").action(async (o: { employee: string; invite: string; company: string; group: string }) => { stdout.push(JSON.stringify(await adminClient.issueInvite({ employeeId: o.employee, inviteCode: o.invite, companyId: o.company, groupId: o.group }))); }));
  admin.addCommand(new Command("invite")
    .requiredOption("--employee <employeeId>")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .option("--bot <username>", "Telegram bot username; defaults to TELEGRAM_BOT_USERNAME")
    .action(async (o: { employee: string; company: string; group: string; bot?: string }) => {
      const botUsername = (o.bot ?? env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
      if (!botUsername) throw new Error("--bot or TELEGRAM_BOT_USERNAME is required");
      if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error("Telegram bot username must contain 5-32 letters, digits, or underscores");
      const inviteCode = randomBytes(32).toString("base64url");
      const result = await adminClient.issueInvite({ employeeId: o.employee, inviteCode, companyId: o.company, groupId: o.group });
      if (!result.created) throw new Error("employee already has an invite; delete the unused participant before issuing a replacement");
      stdout.push(JSON.stringify({ employeeId: result.employeeId, status: result.status, created: result.created }));
      stdout.push(`https://t.me/${botUsername}?start=${inviteCode}`);
      stdout.push("Invite link shown once; the code is stored only as a digest and cannot be recovered. If lost, issue a new invite.");
    }));
  admin.addCommand(new Command("list-participants")
    .option("--limit <n>", "Participants per page", (value: string) => Number(value))
    .option("--after <cursor>", "Opaque cursor from the previous page")
    .action(async (o: { limit?: number; after?: string }) => {
      const page = await adminClient.listParticipants({ limit: o.limit, after: o.after });
      stdout.push(JSON.stringify(page));
      if (page.nextCursor) stdout.push(`Next page: npm run cli -- admin list-participants${o.limit === undefined ? "" : ` --limit ${o.limit}`} --after ${page.nextCursor}`);
    }));
  admin.addCommand(new Command("company-report")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .action(async (o: { company: string; group: string }) => {
      stdout.push(JSON.stringify(await adminClient.exportCompanyReport({ companyId: o.company, groupId: o.group })));
    }));
  admin.addCommand(new Command("usage")
    .requiredOption("--employee <employeeId>")
    .option("--month <YYYY-MM>", "Usage month in UTC", currentUsageMonth())
    .action(async (o: { employee: string; month: string }) => {
      const usage = await adminClient.getMonthlyUsage({ employeeId: o.employee, month: o.month });
      const format = (value: number) => value.toLocaleString("en-US");
      stdout.push(`Employee: ${usage.userId}`);
      stdout.push(`Month (UTC): ${usage.month}`);
      stdout.push(`Tokens: input ${format(usage.inputTokens)}, cached input ${format(usage.cachedInputTokens)}, output ${format(usage.outputTokens)}, total ${format(usage.totalTokens)}`);
      stdout.push(`Estimated cost: $${(usage.estimatedCostUsdMicros / 1_000_000).toFixed(6)} USD`);
      stdout.push(`Records: ${format(usage.records)}; cache breakdown unknown for ${format(usage.cachedInputUnknownRecords)} record(s)`);
      for (const source of usage.bySource) {
        stdout.push(`  ${source.source}: ${format(source.totalTokens)} tokens (${format(source.cachedInputTokens)} cached input), $${(source.estimatedCostUsdMicros / 1_000_000).toFixed(6)} USD, ${format(source.records)} record(s), ${format(source.cachedInputUnknownRecords)} cache-unknown`);
      }
    }));
  admin.addCommand(new Command("context-document-versions")
    .requiredOption("--employee <employeeId>")
    .requiredOption("--path <handle>")
    .option("--limit <n>", "Versions to show", (value: string) => Number(value))
    .action(async (o: { employee: string; path: string; limit?: number }) => {
      const result = await adminClient.listContextDocumentVersions({ employeeId: o.employee, path: o.path, limit: o.limit });
      stdout.push(`Document: ${result.path}`);
      stdout.push("UPDATED_AT\tSIZE_BYTES\tVERSION");
      for (const item of result.versions) stdout.push(`${item.updatedAt}\t${item.size.toLocaleString("en-US")}\t${item.version}`);
    }));
  admin.addCommand(new Command("restore-context-document")
    .requiredOption("--employee <employeeId>")
    .requiredOption("--path <handle>")
    .requiredOption("--version <version>")
    .action(async (o: { employee: string; path: string; version: string }) => {
      const result = await adminClient.restoreContextDocumentVersion({ employeeId: o.employee, path: o.path, version: o.version });
      stdout.push(result.outcome === "restored"
        ? `Restored ${result.path} as version ${result.version}`
        : `Version not found for ${result.path}`);
    }));
  program.addCommand(admin);
  try { await program.parseAsync(argv, { from: "user" }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { stderr.push(error instanceof Error ? error.message : String(error)); return { exitCode: 1, stdout, stderr }; }
}
