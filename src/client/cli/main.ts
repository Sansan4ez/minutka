import { AdminMinutkaClient, EmployeeMinutkaClient } from "../sdk/minutka-client.js";
import { HttpAdminMinutkaTransport, HttpEmployeeMinutkaTransport } from "../sdk/http-transport.js";
import { runMinutkaCli } from "./minutka-cli.js";

async function main(): Promise<void> {
  const options = { baseUrl: process.env.MINUTKA_API_URL ?? "", token: process.env.MINUTKA_API_TOKEN ?? "" };
  const client = process.argv[2] === "admin"
    ? new AdminMinutkaClient(new HttpAdminMinutkaTransport(options))
    : new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport(options));
  const result = await runMinutkaCli(client, process.argv.slice(2));
  for (const line of result.stdout) if (line) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) if (line) process.stderr.write(`${line}\n`);
  process.exitCode = result.exitCode;
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "CLI failed"}\n`); process.exitCode = 1; });
