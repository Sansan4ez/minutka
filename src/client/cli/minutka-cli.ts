import { Command } from "commander";
import type { AdminMinutkaClient, EmployeeMinutkaClient } from "../sdk/minutka-client.js";

export type CliResult = { exitCode: number; stdout: string[]; stderr: string[] };
function collect(value: string, previous: string[]) { return [...previous, value]; }
function parseChoice<const T extends readonly string[]>(value: string, choices: T, label: string): T[number] { if (choices.includes(value)) return value; throw new Error(`${label} must be one of: ${choices.join(", ")}`); }
const parsePersona = (value: string) => parseChoice(value, ["support", "efficiency"] as const, "persona");
const parseAiLevel = (value: string) => parseChoice(value, ["beginner", "intermediate", "advanced"] as const, "ai-level");
const parseResponseLength = (value: string) => parseChoice(value, ["short", "balanced", "detailed"] as const, "response-length");
const parseInsightKind = (value: string) => parseChoice(value, ["task_category", "routine_pattern", "energy_stress_marker", "automation_candidate"] as const, "kind");

/** Presentation-only CLI. Identity is supplied by the configured transport token. */
export async function runMinutkaCli(client: EmployeeMinutkaClient | AdminMinutkaClient, argv: string[]): Promise<CliResult> {
  const employeeClient = client as EmployeeMinutkaClient;
  const adminClient = client as AdminMinutkaClient;
  const stdout: string[] = []; const stderr: string[] = [];
  const program = new Command().name("minutka").exitOverride().configureOutput({ writeOut: (v) => stdout.push(v.trim()), writeErr: (v) => stderr.push(v.trim()) });
  const employee = new Command("employee").description("Commands for the authenticated employee");
  employee.addCommand(new Command("open-invite").requiredOption("--invite <inviteCode>").action(async (o: { invite: string }) => { stdout.push(JSON.stringify(await employeeClient.openInvite({ inviteCode: o.invite }))); }));
  employee.addCommand(new Command("accept-consent").option("--yes").action(async (o: { yes?: boolean }) => { if (o.yes !== true) throw new Error("privacy consent must be explicitly accepted"); stdout.push(JSON.stringify(await employeeClient.acceptConsent({ accepted: true, source: "cli" }))); }));
  employee.addCommand(new Command("complete-onboarding").option("--name <preferredName>").option("--assistant-name <assistantName>").option("--address-form <addressForm>", "informal|formal").option("--timezone <timezone>").option("--role <role>").option("--task <task>", "Typical task", collect, []).requiredOption("--persona <persona>", "support|efficiency", parsePersona).option("--ai-level <level>", "beginner|intermediate|advanced", parseAiLevel).option("--response-length <length>", "short|balanced|detailed", parseResponseLength).action(async (o: { preferredName?: string; assistantName?: string; addressForm?: "informal" | "formal"; timezone?: string; role?: string; task: string[]; persona: "support" | "efficiency"; aiLevel?: "beginner" | "intermediate" | "advanced"; responseLength?: "short" | "balanced" | "detailed" }) => { stdout.push(JSON.stringify(await employeeClient.completeOnboarding({ preferredName: o.preferredName, assistantName: o.assistantName, addressForm: o.addressForm, timezone: o.timezone, role: o.role, typicalTasks: o.task.length ? o.task : undefined, persona: o.persona, aiLevel: o.aiLevel, responseLength: o.responseLength }))); }));
  employee.addCommand(new Command("profile").action(async () => { stdout.push(JSON.stringify(await employeeClient.getProfile())); }));
  employee.addCommand(new Command("chat").option("--thread <threadId>", "Thread ID; specify the Telegram thread ID for cross-channel continuity", "default").requiredOption("--text <text>").action(async (o: { thread: string; text: string }) => { stdout.push(JSON.stringify(await employeeClient.chat({ threadId: o.thread, text: o.text }))); }));
  employee.addCommand(new Command("insights").option("--thread <threadId>").option("--kind <kind>", "Insight kind", parseInsightKind).action(async (o: { thread?: string; kind?: ReturnType<typeof parseInsightKind> }) => { stdout.push(JSON.stringify(await employeeClient.listInsights({ threadId: o.thread, kind: o.kind }))); }));
  employee.addCommand(new Command("feedback").option("--thread <threadId>", "Thread ID; specify the Telegram thread ID for cross-channel continuity", "default").requiredOption("--target-message <targetMessageId>").requiredOption("--rating <rating>").action(async (o: { thread: string; targetMessage: string; rating: string }) => { if (!["positive", "neutral", "negative"].includes(o.rating)) throw new Error("rating must be positive, neutral, or negative"); stdout.push(JSON.stringify(await employeeClient.submitFeedback({ threadId: o.thread, targetMessageId: o.targetMessage, rating: o.rating as "positive" | "neutral" | "negative", source: "cli" }))); }));
  program.addCommand(employee);
  const admin = new Command("admin").description("Operator commands");
  admin.addCommand(new Command("issue-invite").requiredOption("--employee <employeeId>").requiredOption("--invite <inviteCode>").action(async (o: { employee: string; invite: string }) => { stdout.push(JSON.stringify(await adminClient.issueInvite({ employeeId: o.employee, inviteCode: o.invite }))); }));
  program.addCommand(admin);
  try { await program.parseAsync(argv, { from: "user" }); return { exitCode: 0, stdout, stderr }; }
  catch (error) { stderr.push(error instanceof Error ? error.message : String(error)); return { exitCode: 1, stdout, stderr }; }
}
