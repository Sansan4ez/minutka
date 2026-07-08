# Этап 1: Скелет проекта и тест-харнесс — Подробный план (v3)

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)
> **Эталон:** `/home/admin/minutka-agent` (структура, Nix, слои, executable specs)

## Цель этапа

Получить рабочий проект Mastra с:
- Nix-окружением (`flake.nix` + `.envrc`).
- Слоёной архитектурой: Domain → Application → Server → SDK → CLI.
- Заглушкой `MinutkaAgent` (Mastra Agent, хардкод-промпт, `openai/gpt-5.4-mini`) и runtime bridge `AgentRunner`.
- Одной executable spec, которая проверяет полный путь: CLI → SDK → Server → Service → injected AgentRunner (mock, без LLM/API).
- Smoke-проверкой Mastra: `mastra` и `minutkaAgent` импортируются без ошибок.
- Скриптом `nix run .#verify` для кодового агента.

---

## Критерий завершения (Definition of Done)

- [ ] `nix develop` входит в shell с Node.js 22.
- [ ] `npm run typecheck` — 0 ошибок.
- [ ] `npm run specs` — SPEC-SKELETON-001 зелёная (включая smoke-импорт Mastra).
- [ ] `nix run .#verify` проходит (typecheck + specs).
- [ ] `.env.example` содержит все ключи.
- [ ] Provider registry подтверждает `openai/gpt-5.4-mini` (если не найден — стоп, согласование с пользователем).
- [ ] Коммит с тегом `phase-1-skeleton`.

---

## Итоговая структура файлов

```
time-agent/
├── docs/                                       # Существует
│   ├── product/
│   ├── diagram_modules/
│   └── plans/
│       ├── time-agent-mastra-plan.md
│       └── phase-1-skeleton-and-test-harness.md # Этот план
├── docs/
│   └── generated/                              # Артефакты (spec-results.json); в .gitignore
├── src/
│   ├── domain/
│   │   ├── events.ts                           # DomainEvent union type
│   │   └── employee.ts                         # Employee, UserProfile типы
│   ├── application/
│   │   ├── in-memory-world.ts                  # InMemoryWorld — состояние для тестов
│   │   └── minutka-service.ts                  # MinutkaService — бизнес-логика (пока только chat)
│   ├── server/
│   │   └── http/
│   │       └── in-process-server.ts            # createInProcessServer — API-surface
│   ├── client/
│   │   ├── sdk/
│   │   │   └── minutka-client.ts               # MinutkaClient — типизированный SDK с Zod
│   │   └── cli/
│   │       └── minutka-cli.ts                  # CLI (commander) — employee chat
│   └── mastra/
│       ├── index.ts                            # Mastra entry point
│       ├── agent-runner.ts                     # Runtime bridge: Mastra Agent → AgentRunner
│       ├── agents/
│       │   └── minutka-agent.ts                # MinutkaAgent заглушка
│       └── tools/
│           └── index.ts                        # Заглушка для будущих тулов
├── specs/
│   └── executable/
│       ├── support/
│       │   ├── spec-harness.ts                 # Хелперы: createSpecWorld, registerSpecMetadata
│       │   ├── cli-driver.ts                   # CliDriver — обёртка CLI для спеков
│       │   └── fixtures.ts                     # Фикстуры (employeeId, threadId, fixedNow)
│       └── skeleton/
│           └── SPEC-SKELETON-001.spec.ts       # Единственная спека этапа
├── flake.nix
├── flake.lock
├── .envrc
├── tsconfig.json
├── package.json
├── .env.example
└── .gitignore

> **Примечание:** директории `tests/unit`, `tests/contract`, `tests/integration` создаются позже,
> только после отдельного согласования standalone-тестов.
```

---

## Шаг 1. Nix-окружение

### 1.1 `flake.nix`

Берём из `minutka-agent`, адаптируем:

```nix
{
  description = "time-agent — Минутка AI dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
      });
    in
    {
      devShells = forAllSystems ({ pkgs, ... }: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "time-agent dev shell — node $(node --version), npm $(npm --version)"
            if [ ! -d node_modules ]; then
              echo "node_modules missing — run: npm install"
            fi
          '';
        };
      });

      apps = forAllSystems ({ pkgs, system }:
        let
          runner = name: script: {
            type = "app";
            program = toString (pkgs.writeShellApplication {
              name = "time-agent-${name}";
              runtimeInputs = [ pkgs.nodejs_22 ];
              text = ''
                if [ ! -d node_modules ]; then
                  echo "Installing dependencies…"
                  if [ -f package-lock.json ]; then npm ci; else npm install; fi
                fi
                exec npm run ${script}
              '';
            } + "/bin/time-agent-${name}");
          };
        in
        {
          dev     = runner "dev"     "mastra:dev";
          verify  = runner "verify"  "verify";
          test    = runner "test"    "test";
          specs   = runner "specs"   "specs";
          default = self.apps.${system}.dev;
        });

      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixpkgs-fmt);
    };
}
```

### 1.2 `.envrc`

```
use flake
```

### 1.3 Активация

```bash
cd /home/admin/time-agent
direnv allow   # автоматически входит в nix shell
```

---

## Шаг 2. Node.js проект

### 2.1 `package.json`

```jsonc
{
  "name": "time-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "npm run specs",
    "specs": "vitest run specs/executable --reporter=default --reporter=json --outputFile.json=docs/generated/spec-results.json",
    "verify": "npm run typecheck && npm run specs",
    "mastra:dev": "mastra dev"
  },
  "dependencies": {
    "@mastra/core": "^1.49.0",
    "commander": "^14.0.0",
    "mastra": "^1.18.0",
    "zod": "^4.1.13"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "typescript": "^5.9.3",
    "vitest": "^4.0.14"
  }
}
```

> **Примечание:** Версии `@mastra/core` и `mastra` взяты из эталона `minutka-agent` для совместимости. При установке используем `npm install`.

### 2.2 `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest"]
  },
  "include": ["src/**/*.ts", "specs/**/*.ts"]
}
```

### 2.3 `.env.example`

```env
# LLM
OPENAI_API_KEY=

# Telegram (Этап 4)
TELEGRAM_BOT_TOKEN=
```

> **Примечание:** `.env` не создаётся автоматически. На Этапе 1 API key не нужен
> (spec использует mock-runner). Файл `.env` создаётся вручную по необходимости.

### 2.4 `.gitignore`

```
node_modules/
dist/
.env
.mastra/
.direnv/
result
docs/generated/
```

---

## Шаг 3. Domain Layer (минимальный)

### 3.1 `src/domain/events.ts`

```typescript
export type ChatMessageReceived = {
  type: "ChatMessageReceived";
  employeeId: string;
  threadId: string;
  text: string;
  timestamp: string;
};

export type ChatResponseGenerated = {
  type: "ChatResponseGenerated";
  employeeId: string;
  threadId: string;
  response: string;
  timestamp: string;
};

export type DomainEvent =
  | ChatMessageReceived
  | ChatResponseGenerated;
```

### 3.2 `src/domain/employee.ts`

```typescript
export type UserProfile = {
  employeeId: string;
  role: string;
  persona: "support" | "efficiency";
  aiLevel: "beginner" | "intermediate" | "advanced";
  createdAt: string;
};
```

---

## Шаг 4. Application Layer

### 4.1 `src/application/in-memory-world.ts`

Упрощённая версия — только то, что нужно для Этапа 1:

```typescript
import type { DomainEvent } from "../domain/events.js";

export type ChatMessage = {
  id: string;
  employeeId: string;
  threadId: string;
  text: string;
  response: string;
  timestamp: string;
};

export type InMemoryWorld = {
  messages: ChatMessage[];
  events: DomainEvent[];
  counters: { message: number };
  now: () => string;
};

export function createInMemoryWorld(
  now: () => string = () => new Date().toISOString(),
): InMemoryWorld {
  return {
    messages: [],
    events: [],
    counters: { message: 0 },
    now,
  };
}
```

### 4.2 `src/application/minutka-service.ts`

```typescript
import type { InMemoryWorld, ChatMessage } from "./in-memory-world.js";

export type ChatInput = {
  employeeId: string;
  threadId: string;
  text: string;
};

export type ChatResult = {
  messageId: string;
  response: string;
};

/**
 * Генератор ответов агента.
 * В executable specs Этапа 1 инжектируется mock-runner,
 * чтобы проверки не зависели от LLM/API.
 * В runtime используется Mastra Agent runner (src/mastra/agent-runner.ts).
 */
export type AgentRunner = (input: ChatInput) => Promise<string>;

export class MinutkaService {
  constructor(
    private readonly world: InMemoryWorld,
    private readonly agentRunner: AgentRunner,
  ) {}

  async chat(input: ChatInput): Promise<ChatResult> {
    this.world.counters.message++;
    const messageId = `msg_${this.world.counters.message}`;
    const timestamp = this.world.now();

    this.world.events.push({
      type: "ChatMessageReceived",
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      timestamp,
    });

    const response = await this.agentRunner(input);

    this.world.events.push({
      type: "ChatResponseGenerated",
      employeeId: input.employeeId,
      threadId: input.threadId,
      response,
      timestamp: this.world.now(),
    });

    const message: ChatMessage = {
      id: messageId,
      employeeId: input.employeeId,
      threadId: input.threadId,
      text: input.text,
      response,
      timestamp,
    };
    this.world.messages.push(message);

    return { messageId, response };
  }
}
```

---

## Шаг 5. Mastra Agent

### 5.1 `src/mastra/agents/minutka-agent.ts`

```typescript
import { Agent } from "@mastra/core/agent";

export const minutkaAgent = new Agent({
  id: "minutka-agent",
  name: "Минутка",
  instructions: `
Ты — «Минутка», AI-партнёр для разбора и планирования рабочего дня.

Твоя роль:
- Слушать, отражать, помогать структурировать задачи.
- Замечать закономерности в работе и эмоциях.
- Напоминать о приоритетах.

Что ты НЕ делаешь:
- Не пишешь тексты, посты и письма за сотрудника.
- Не ищешь информацию в интернете.
- Не учишь пользоваться ИИ-инструментами.
- Не даёшь оценок и нравоучений.
- Не контролируешь и не давишь.

Тон: тёплый, спокойный, на стороне сотрудника. Без корпоративного канцелярита.
Отвечаешь только на темы рабочего дня и связанного с работой эмоционального состояния.
Если пользователь просит что-то за рамками — мягко отказывай
и возвращай разговор к теме рабочего дня.
  `.trim(),
  model: "openai/gpt-5.4-mini",
});
```

### 5.2 `src/mastra/agent-runner.ts`

```typescript
import type { AgentRunner } from "../../application/minutka-service.js";
import { minutkaAgent } from "./agents/minutka-agent.js";

/**
 * Runtime bridge: Mastra Agent → AgentRunner.
 * Точный API вызова (generate / text) подтверждается после npm install
 * через embedded docs в node_modules/@mastra/core/dist/docs/.
 *
 * В executable specs этот runner не используется —
 * спеки инжектируют mock-runner, чтобы не зависеть от LLM/API-ключа.
 */
export const runMinutkaAgent: AgentRunner = async (input) => {
  // TODO: подтвердить API после npm install через embedded docs.
  const result = await minutkaAgent.generate(input.text);
  return result.text ?? "";
};
```

### 5.3 `src/mastra/tools/index.ts`

```typescript
// Инструменты агента — подключаются на Этапах 2–3.
// updateProfileTool, extractInsightsTool
export {};
```

### 5.4 `src/mastra/index.ts`

```typescript
import { Mastra } from "@mastra/core";
import { minutkaAgent } from "./agents/minutka-agent.js";

export const mastra = new Mastra({
  agents: { minutkaAgent },
});
```

---

## Шаг 6. Server Layer (In-Process)

### 6.1 `src/server/http/in-process-server.ts`

```typescript
import type { InMemoryWorld } from "../../application/in-memory-world.js";
import {
  MinutkaService,
  type AgentRunner,
  type ChatInput,
} from "../../application/minutka-service.js";

export type MinutkaApi = ReturnType<typeof createInProcessServer>;

export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
) {
  const service = new MinutkaService(world, agentRunner);

  return {
    chat(input: ChatInput) {
      return service.chat(input);
    },
  };
}
```

---

## Шаг 7. Client SDK + CLI

### 7.1 `src/client/sdk/minutka-client.ts`

```typescript
import type { MinutkaApi } from "../../server/http/in-process-server.js";
import { z } from "zod";

const chatRequest = z.strictObject({
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string().min(1),
});

const chatResponse = z.strictObject({
  messageId: z.string(),
  response: z.string(),
});

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  return result.data;
}

export class MinutkaClient {
  constructor(private readonly api: MinutkaApi) {}

  async chat(input: z.input<typeof chatRequest>) {
    const validated = validate(chatRequest, input, "chat request");
    const result = await this.api.chat(validated);
    return validate(chatResponse, result, "chat response");
  }
}
```

### 7.2 `src/client/cli/minutka-cli.ts`

```typescript
import { Command } from "commander";
import type { MinutkaClient } from "../sdk/minutka-client.js";

export type CliResult = {
  exitCode: number;
  stdout: string[];
  stderr: string[];
};

export async function runMinutkaCli(
  client: MinutkaClient,
  argv: string[],
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command();

  program
    .name("minutka")
    .exitOverride()
    .configureOutput({
      writeOut: (v) => stdout.push(v.trim()),
      writeErr: (v) => stderr.push(v.trim()),
    });

  program
    .command("employee")
    .description("Employee commands")
    .addCommand(
      new Command("chat")
        .requiredOption("--employee <employeeId>")
        .option("--thread <threadId>", "Thread ID (defaults to employeeId)")
        .requiredOption("--text <text>")
        .action(async (options: { employee: string; thread?: string; text: string }) => {
          const result = await client.chat({
            employeeId: options.employee,
            threadId: options.thread ?? options.employee,
            text: options.text,
          });
          stdout.push(JSON.stringify(result));
        }),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(message);
    return { exitCode: 1, stdout, stderr };
  }
}
```

---

## Шаг 8. Executable Spec инфраструктура

### 8.1 `specs/executable/support/fixtures.ts`

```typescript
export const fixedNow = "2026-07-08T10:00:00.000Z";

export const testEmployee = {
  employeeId: "emp_test_1",
  threadId: "thread_test_1",
};
```

### 8.2 `specs/executable/support/cli-driver.ts`

```typescript
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
```

### 8.3 `specs/executable/support/spec-harness.ts`

Упрощённая версия — достаточная для Этапа 1:

```typescript
import { afterAll, expect } from "vitest";
import {
  createInMemoryWorld,
  type InMemoryWorld,
} from "../../../src/application/in-memory-world.js";
import type { DomainEvent } from "../../../src/domain/events.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
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
const worldsBySpec = new WeakMap<SpecWorld, InMemoryWorld>();

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
};

function getWorld(spec: SpecWorld): InMemoryWorld {
  const world = worldsBySpec.get(spec);
  if (!world) throw new Error("Spec world not registered");
  return world;
}

export type ExpectedEvent = Partial<DomainEvent> & { type: DomainEvent["type"] };

export function expectEvent(spec: SpecWorld, expected: ExpectedEvent | ExpectedEvent[]) {
  const list = Array.isArray(expected) ? expected : [expected];
  expect(getWorld(spec).events).toEqual(
    expect.arrayContaining(list.map((e) => expect.objectContaining(e))),
  );
}

export function createSpecWorld(agentRunner: AgentRunner): SpecWorld {
  const world = createInMemoryWorld(() => fixedNow);
  trackedWorlds.push(world);
  const cli = new CliDriver(world, agentRunner, (cmd) =>
    observedCliCommands.add(cmd),
  );
  const spec = { cli };
  worldsBySpec.set(spec, world);
  return spec;
}
```

---

## Шаг 9. Executable Spec — SPEC-SKELETON-001

### 9.1 `specs/executable/skeleton/SPEC-SKELETON-001.spec.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  createSpecWorld,
  expectEvent,
  registerSpecMetadata,
} from "../support/spec-harness.js";
import { testEmployee } from "../support/fixtures.js";

registerSpecMetadata({
  id: "SPEC-SKELETON-001",
  userStory: "US-SKELETON-001",
  requirements: ["FR-CHAT-001"],
  productParts: ["agent-minutka-brief"],
  contracts: ["chat"],
  events: ["ChatMessageReceived", "ChatResponseGenerated"],
  mastra: ["minutkaAgent"],
  cli: ["employee chat"],
});

describe("SPEC-SKELETON-001: agent responds to text message via CLI", () => {
  it("Mastra agent is registered and importable (smoke)", async () => {
    const { mastra } = await import("../../../src/mastra/index.js");
    const { minutkaAgent } = await import(
      "../../../src/mastra/agents/minutka-agent.js"
    );
    expect(mastra).toBeDefined();
    expect(minutkaAgent).toBeDefined();
    expect(minutkaAgent.name).toBe("Минутка");
  });

  it("accepts employee text and returns agent response", async () => {
    // Mock-runner: спека не зависит от LLM/API-ключа.
    // Runtime bridge (src/mastra/agent-runner.ts) подключает реальный Agent.
    const mockAgentRunner = async () =>
      "Слышу тебя. Давай разберём план на сегодня.";

    const spec = createSpecWorld(mockAgentRunner);

    const result = await spec.cli.json<{
      messageId: string;
      response: string;
    }>([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      "Сегодня у меня три встречи и нужно закрыть отчёт.",
    ]);

    // Проверяем структуру ответа
    expect(result.messageId).toMatch(/^msg_/);
    expect(result.response).toBeTruthy();
    expect(result.response.length).toBeGreaterThan(5);

    // Проверяем, что domain events эмитнулись
    expectEvent(spec, [
      {
        type: "ChatMessageReceived",
        employeeId: testEmployee.employeeId,
      },
      {
        type: "ChatResponseGenerated",
        employeeId: testEmployee.employeeId,
      },
    ]);
  });

  it("rejects empty text", async () => {
    const spec = createSpecWorld(async () => "ok");

    // Пустой текст должен быть отвергнут Zod-валидацией в SDK
    await expect(
      spec.cli.json(["employee", "chat", "--employee", "emp_1", "--text", ""]),
    ).rejects.toThrow();
  });
});
```

---

## Шаг 10. Порядок выполнения

| # | Действие | Команда проверки |
|---|----------|------------------|
| 1 | Создать `flake.nix`, `.envrc` | `nix develop --command echo ok` |
| 2 | Создать `package.json`, `tsconfig.json` | — |
| 3 | `npm install` | `ls node_modules/@mastra/core` |
| 3a | Проверить provider registry | `node ~/.pi/agent/skills/mastra/scripts/provider-registry.mjs --provider openai \| grep gpt-5.4-mini` |
| 4 | Создать `.env.example`, `.gitignore` | — |
| 5 | Создать `src/domain/` (events, employee) | `npm run typecheck` |
| 6 | Создать `src/application/` (world, service) | `npm run typecheck` |
| 7 | Создать `src/mastra/` (agent, tools, index) | `npm run typecheck` |
| 8 | Создать `src/server/` (in-process-server) | `npm run typecheck` |
| 9 | Создать `src/client/` (sdk, cli) | `npm run typecheck` |
| 10 | Создать `specs/executable/` (harness, driver, fixtures, spec) | `npm run typecheck` |
| 11 | Запустить спеку | `npm run specs` |
| 12 | Полная проверка | `npm run verify` |
| 13 | Коммит | `git add . && git commit && git tag phase-1-skeleton` |

---

## Как кодовый агент проверяет проект

Единая команда:
```bash
nix run .#verify
```

Что внутри:
1. `npm run typecheck` → `tsc --noEmit` (типы сходятся).
2. `npm run specs` → `vitest run specs/executable` (поведение корректно).

**Агенту не нужен Telegram, API-ключ или запущенный сервер.**  
Спека использует мок-агента и InMemoryWorld — полностью автономна.

---

## Решение по клиент-серверной архитектуре

**Ответ: да, но в лёгком варианте (Вариант C).**

Полная архитектура из `minutka-agent` избыточна на Этапе 1, но **структура слоёв закладывается сейчас**, чтобы Этапы 2–6 добавляли функционал **без рефакторинга каркаса**.

| Слой | Этап 1 (сейчас) | Этап 2 (следующий) |
|------|-----------------|---------------------|
| Domain | `DomainEvent`, `UserProfile` | + `ParticipantOnboarded`, `ConsentAccepted` |
| Application | `InMemoryWorld` (messages, events) | + participants, profiles |
| Service | `chat()` | + `completeOnboarding()`, `acceptConsent()` |
| Server | `createInProcessServer({chat})` | + onboarding endpoints |
| SDK | `MinutkaClient.chat()` | + `completeOnboarding()` |
| CLI | `employee chat` | + `employee open-invite`, `complete-onboarding` |
| Specs | SPEC-SKELETON-001 | + SPEC-ONBOARDING-001 |

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| `nix develop` не работает (нет Nix) | Низкая | На сервере Nix установлен; fallback — `node` в PATH |
| Версии `@mastra/core` несовместимы с `openai/gpt-5.4-mini` | Средняя | Шаг 3a: обязательная проверка provider-registry. Если модель не найдена — **стоп**, согласование с пользователем. Не заменять молча |
| Zod v4 breaking changes | Низкая | Версия `^4.1.13` из эталона, проверена |
| `commander` async parsing edge cases | Низкая | `parseAsync` + `exitOverride` — проверенный паттерн |

---

## Ориентировочное время

| Шаг | Время |
|-----|-------|
| 1–4. Nix + Node.js + конфиги | 15 мин |
| 5–6. Domain + Application | 10 мин |
| 7. Mastra Agent | 5 мин |
| 8–9. Server + Client (SDK + CLI) | 15 мин |
| 10–11. Spec инфраструктура + SPEC-SKELETON-001 | 15 мин |
| 12–13. Проверка + коммит | 10 мин |
| **Итого** | **≈ 70 мин** |
