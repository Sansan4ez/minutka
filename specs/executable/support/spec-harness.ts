import { afterAll, expect } from "vitest";
import {
  createInMemoryWorld,
  type InMemoryWorld,
} from "../../../src/application/in-memory-world.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import type {
  AgentRunner,
  MinutkaServiceDeps,
} from "../../../src/application/minutka-service.js";
import type { UserProfile } from "../../../src/domain/employee.js";
import { CliDriver } from "./cli-driver.js";
import { fixedNow } from "./fixtures.js";

export type SpecMetadata = {
  id: string;
  userStory: string;
  requirements: string[];
  productParts: string[];
  contracts: string[];
  events: string[];
  mastra: string[];
  cli: string[];
};

const trackedWorlds: InMemoryWorld[] = [];
const observedCliCommands = new Set<string>();

export function registerSpecMetadata(metadata: SpecMetadata) {
  afterAll(() => {
    const observedEvents = new Set<string>(
      trackedWorlds.flatMap((w) => w.events.map((e) => e.type)),
    );
    const problems = [
      ...metadata.cli
        .filter((cmd) => !observedCliCommands.has(cmd))
        .map((cmd) => `declared CLI command never invoked: "${cmd}"`),
      ...metadata.events
        .filter((evt) => !observedEvents.has(evt))
        .map((evt) => `declared event never emitted: ${evt}`),
    ];
    if (problems.length > 0) {
      throw new Error(
        `${metadata.id} metadata mismatch:\n- ${problems.join("\n- ")}`,
      );
    }
  });
  return metadata;
}

export type SpecWorld = {
  cli: CliDriver;
  world: InMemoryWorld;
};

function getWorld(spec: SpecWorld): InMemoryWorld {
  return spec.world;
}

export type ExpectedEvent = Partial<DomainEvent> & { type: DomainEvent["type"] };

export function expectEvent(spec: SpecWorld, expected: ExpectedEvent | ExpectedEvent[]) {
  const list = Array.isArray(expected) ? expected : [expected];
  expect(getWorld(spec).events).toEqual(
    expect.arrayContaining(list.map((e) => expect.objectContaining(e))),
  );
}

export function expectProfile(
  spec: SpecWorld,
  employeeId: string,
  expected: Partial<UserProfile>,
) {
  expect(getWorld(spec).profiles).toContainEqual(
    expect.objectContaining({ employeeId, ...expected }),
  );
}

export type CreateSpecWorldOptions = {
  deps?: Partial<MinutkaServiceDeps>;
};

export function createSpecWorld(
  agentRunner: AgentRunner,
  options: CreateSpecWorldOptions = {},
): SpecWorld {
  const world = createInMemoryWorld(() => fixedNow);
  trackedWorlds.push(world);
  const cli = new CliDriver(
    world,
    agentRunner,
    (cmd) => observedCliCommands.add(cmd),
    options.deps,
  );
  return { cli, world };
}
