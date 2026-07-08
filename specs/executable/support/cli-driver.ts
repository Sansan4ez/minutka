import { MinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import {
  runMinutkaCli,
  type CliResult,
} from "../../../src/client/cli/minutka-cli.js";
import type { InMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInProcessServer } from "../../../src/server/http/in-process-server.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";

export class CliDriver {
  private readonly client: MinutkaClient;

  constructor(
    world: InMemoryWorld,
    agentRunner: AgentRunner,
    private readonly onCommand?: (commandPath: string) => void,
  ) {
    this.client = new MinutkaClient(createInProcessServer(world, agentRunner));
  }

  async run(args: string[]): Promise<CliResult> {
    const commandPath: string[] = [];
    for (const token of args) {
      if (token.startsWith("-")) break;
      commandPath.push(token);
    }
    this.onCommand?.(commandPath.join(" "));
    return runMinutkaCli(this.client, args);
  }

  async json<T>(args: string[]): Promise<T> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.join("\n"));
    }
    const lastLine = result.stdout.at(-1);
    if (!lastLine) {
      throw new Error(`CLI produced no JSON for ${args.join(" ")}`);
    }
    return JSON.parse(lastLine) as T;
  }
}
