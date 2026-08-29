import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const activeCompositionPaths = [
  "src/mastra/agent-runner.ts",
  "src/application/request-integrity-guard.ts",
  "src/mastra/request-integrity-guard.ts",
  "src/application/onboarding-profile-extractor.ts",
  "src/mastra/onboarding-profile-extractor.ts",
  "src/mastra/tools/process-current-activity-turn-tool.ts",
  "src/application/activity-duration-evidence.ts",
  "src/application/minutka-service.ts",
] as const;

const retiredSemanticRoutingSymbols = new Set([
  "hasExplicitActivityRepairSignal",
  "constrainActivityFacetsToSource",
  "isOrdinaryOwnerScopedRequest",
  "mentionsExplicitBoundaryBypass",
  "extractDeterministicOnboardingPatch",
  "mergePatches",
]);

const semanticClassifierMethods = new Set(["test", "exec", "match", "matchAll", "search", "includes"]);
const formalParserAllowList = new Set([
  "src/application/onboarding-profile-extractor.ts#normalizeFormalTimezone",
]);
const rawTextNames = new Set(["text", "rawText", "userText"]);
const rfcDirection = "See docs/architecture/rfc-agent-led-routing.md §2: keep natural-language meaning in the LLM plane and formal validation in typed boundaries.";

type SourceInput = { path: string; source: string };

function parseSource(input: SourceInput): ts.SourceFile {
  return ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function nodeName(node: ts.Node): string | undefined {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  node.forEachChild((child) => visit(child, visitor));
}

function containsIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && candidate.text === identifier) found = true;
  });
  return found;
}

function referencesRawText(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && aliases.has(candidate.text)) found = true;
    if (ts.isPropertyAccessExpression(candidate) && rawTextNames.has(candidate.name.text)) found = true;
  });
  return found;
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

function enclosingScopes(node: ts.Node, sourceFile: ts.SourceFile): Array<ts.SourceFile | ts.FunctionLikeDeclaration> {
  const scopes: Array<ts.SourceFile | ts.FunctionLikeDeclaration> = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionScope(current)) scopes.push(current);
    current = current.parent;
  }
  return [sourceFile, ...scopes.reverse()];
}

function visitScope(scope: ts.SourceFile | ts.FunctionLikeDeclaration, visitor: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visitor(node);
    node.forEachChild((child) => {
      if (isFunctionScope(child)) return;
      walk(child);
    });
  };
  walk(scope);
}

function addRawParameterNames(scope: ts.FunctionLikeDeclaration, aliases: Set<string>): void {
  for (const parameter of scope.parameters) {
    if (ts.isIdentifier(parameter.name) && rawTextNames.has(parameter.name.text)) aliases.add(parameter.name.text);
    if (!ts.isObjectBindingPattern(parameter.name)) continue;
    for (const element of parameter.name.elements) {
      const sourceName = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (sourceName && rawTextNames.has(sourceName) && ts.isIdentifier(element.name)) aliases.add(element.name.text);
    }
  }
}

function rawTextAliasesAt(node: ts.Node, sourceFile: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set(rawTextNames);
  for (const scope of enclosingScopes(node, sourceFile)) {
    if (isFunctionScope(scope)) addRawParameterNames(scope, aliases);
    let changed = true;
    while (changed) {
      changed = false;
      visitScope(scope, (candidate) => {
        if (!ts.isVariableDeclaration(candidate) || !ts.isIdentifier(candidate.name) || !candidate.initializer) return;
        if (aliases.has(candidate.name.text) || !referencesRawText(candidate.initializer, aliases)) return;
        aliases.add(candidate.name.text);
        changed = true;
      });
    }
  }
  return aliases;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) return nodeName(current);
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function isRawTextClassifier(node: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (!semanticClassifierMethods.has(method)) return false;
  const aliases = rawTextAliasesAt(node, sourceFile);
  if (method === "test" || method === "exec") return node.arguments.some((argument) => referencesRawText(argument, aliases));
  return referencesRawText(node.expression.expression, aliases);
}

function isAllowedFormalParser(path: string, functionName: string | undefined): boolean {
  return Boolean(functionName && formalParserAllowList.has(`${path}#${functionName}`));
}

function isStaticActiveTools(node: ts.PropertyAssignment): boolean {
  if (!ts.isArrayLiteralExpression(node.initializer) || node.initializer.elements.length !== 1) return false;
  const [element] = node.initializer.elements;
  return Boolean(element && ts.isSpreadElement(element) && ts.isIdentifier(element.expression) && element.expression.text === "assistantActiveToolNames");
}

function inspectSource(input: SourceInput): string[] {
  const sourceFile = parseSource(input);
  const findings: string[] = [];
  const report = (message: string) => findings.push(`${input.path}: ${message} ${rfcDirection}`);

  visit(sourceFile, (node) => {
    if (ts.isIdentifier(node) && retiredSemanticRoutingSymbols.has(node.text)) {
      report(`retired semantic-routing symbol \`${node.text}\` is forbidden in active composition`);
    }
    if (ts.isStringLiteral(node) && node.text.endsWith("activity-turn-policy.js")) {
      report("the retired activity turn policy must not be imported");
    }
  });

  if (input.path === "src/mastra/agent-runner.ts") {
    visit(sourceFile, (node) => {
      if (ts.isPropertyAssignment(node) && nodeName(node) === "activeTools" && !isStaticActiveTools(node)) {
        report("`activeTools` must expose the static request-scoped typed catalog, not a text-dependent gate");
      }
      if (ts.isFunctionDeclaration(node) && nodeName(node) === "createAssistantToolsets") {
        if (node.parameters.length !== 1 || node.parameters.some((parameter) => containsIdentifier(parameter, "text"))) {
          report("`createAssistantToolsets` must accept only typed request context, never raw user text");
        }
        let requestBoundActivityTransaction = false;
        if (!node.body) {
          report("`createAssistantToolsets` must have an implementation");
          return;
        }
        visit(node.body, (candidate) => {
          if (!ts.isPropertyAssignment(candidate) || nodeName(candidate) !== "processCurrentActivityTurn") return;
          if (!ts.isCallExpression(candidate.initializer) || !ts.isIdentifier(candidate.initializer.expression)) return;
          requestBoundActivityTransaction = candidate.initializer.expression.text === "createProcessCurrentActivityTurnTool"
            && candidate.initializer.arguments.length === 1
            && candidate.initializer.arguments[0]?.getText(sourceFile) === "context.processCurrentActivityTurn";
        });
        if (!requestBoundActivityTransaction) report("the broad agent must bind one request-scoped activity transaction tool without raw-text routing");
      }
    });
  }

  if (input.path === "src/mastra/tools/process-current-activity-turn-tool.ts") {
    visit(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || nodeName(node) !== "processCurrentActivityTurnInputSchema") return;
      for (const forbidden of ["currentText", "employeeId", "companyId", "groupId", "subjectKey", "handle", "revision", "taskCategory"]) {
        if (containsIdentifier(node, forbidden)) report(`the request-bound activity tool input must not expose \`${forbidden}\``);
      }
    });
  }

  if (input.path === "src/application/activity-duration-evidence.ts") {
    const durationParserSymbols = new Set(["integerDurationPattern", "halfHourPattern", "oneAndHalfHourPattern"]);
    visit(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !durationParserSymbols.has(node.name.text)) return;
      if (!node.initializer || !ts.isRegularExpressionLiteral(node.initializer)) {
        report("duration measurement patterns must remain explicit formal regex literals");
      }
    });
  }

  if (input.path === "src/mastra/request-integrity-guard.ts") {
    visit(sourceFile, (node) => {
      if (ts.isCallExpression(node) && isRawTextClassifier(node, sourceFile)) {
        report("request-integrity composition must preserve the structured LLM outcome instead of keyword-overriding it");
      }
    });
  }

  if (input.path === "src/application/onboarding-profile-extractor.ts" || input.path === "src/mastra/onboarding-profile-extractor.ts") {
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isRawTextClassifier(node, sourceFile)) return;
      const ownerName = enclosingFunctionName(node);
      if (!isAllowedFormalParser(input.path, ownerName)) {
        report("onboarding composition must not provide a production natural-language regex fallback");
      }
    });
  }

  if (input.path === "src/application/minutka-service.ts") {
    let onboardingMethod: ts.MethodDeclaration | undefined;
    visit(sourceFile, (node) => {
      if (ts.isMethodDeclaration(node) && nodeName(node) === "submitOnboardingAnswer") onboardingMethod = node;
    });
    if (!onboardingMethod
      || !containsIdentifier(onboardingMethod, "parseExactOnboardingAnswer")
      || !containsIdentifier(onboardingMethod, "extractOnboardingPatchWithTimeout")) {
      report("guided onboarding must compose the exact protocol parser with the structured extractor");
    } else {
      let failureKeepsCurrentStep = false;
      visit(onboardingMethod, (node) => {
        if (ts.isCatchClause(node) && containsIdentifier(node, "onboardingProgressWithRoles")) failureKeepsCurrentStep = true;
      });
      if (!failureKeepsCurrentStep) report("structured extractor failure must keep the current guided step instead of invoking a semantic fallback");
    }
  }

  return findings;
}

function inspectSources(inputs: readonly SourceInput[]): string[] {
  return inputs.flatMap(inspectSource);
}

describe("SPEC-SEMANTIC-REGEX-BOUNDARY-001: agent-led semantic source guard", () => {
  it("keeps active chat, request-integrity, and onboarding composition free of retired semantic regex routing", () => {
    const findings = inspectSources(activeCompositionPaths.map((path) => ({ path, source: readFileSync(path, "utf8") })));
    expect(findings, rfcDirection).toEqual([]);
  });

  it("rejects a raw-text semantic gate that changes the active tool catalog", () => {
    const findings = inspectSource({
      path: "src/mastra/agent-runner.ts",
      source: `
        const assistantActiveToolNames = ["collectActivities", "correctRecentActivity"];
        function createAssistantToolsets(context: unknown) {
          return { activities: { collectActivities: createCollectActivitiesTool(context.collectActivities) } };
        }
        function run(input: { text: string }) {
          const semanticGate = /\\p{L}+/u.test(input.text);
          return agent.generate(input.text, {
            activeTools: semanticGate ? [...assistantActiveToolNames] : ["collectActivities"],
          });
        }
      `,
    });
    expect(findings).toEqual(expect.arrayContaining([expect.stringContaining("`activeTools` must expose the static request-scoped typed catalog")]));
  });

  it("rejects a raw-text classifier that overrides a structured request-integrity outcome", () => {
    const findings = inspectSource({
      path: "src/mastra/request-integrity-guard.ts",
      source: `
        function createRequestIntegrityGuard(generate: Function) {
          return async ({ text }: { text: string }) => {
            const parsed = await generate(text);
            const semanticOverride = /\\p{L}+/u.test(text);
            return parsed.status === "denied" && semanticOverride ? { status: "allowed" } : parsed;
          };
        }
      `,
    });
    expect(findings).toEqual([expect.stringContaining("must preserve the structured LLM outcome")]);
  });

  it("rejects renamed semantic routing through normalized aliases", () => {
    const findings = inspectSource({
      path: "src/mastra/request-integrity-guard.ts",
      source: `
        function checkExactScope(text: string) {
          const normalized = text.toLocaleLowerCase("ru-RU");
          return /(?:моя|своя)\\s+(?:задача|запись)/u.test(normalized);
        }
      `,
    });
    expect(findings).toEqual([expect.stringContaining("must preserve the structured LLM outcome")]);
  });

  it("rejects exec and matchAll classifiers over raw-text aliases", () => {
    const findings = inspectSource({
      path: "src/mastra/request-integrity-guard.ts",
      source: `
        function classify(text: string) {
          const lowered = text.toLowerCase();
          const byExec = /ignore rules/u.exec(lowered);
          const byMatchAll = [...lowered.matchAll(/bypass/gu)];
          return { byExec, byMatchAll };
        }
      `,
    });
    expect(findings).toHaveLength(2);
    expect(findings).toEqual(expect.arrayContaining([
      expect.stringContaining("must preserve the structured LLM outcome"),
      expect.stringContaining("must preserve the structured LLM outcome"),
    ]));
  });

  it("allows only an explicitly listed formal parser", () => {
    const allowed = inspectSource({
      path: "src/application/onboarding-profile-extractor.ts",
      source: `
        export function normalizeFormalTimezone(text: string) {
          return /^UTC[+-]\\d{2}:\\d{2}$/u.test(text) ? text : undefined;
        }
      `,
    });
    const renamed = inspectSource({
      path: "src/application/onboarding-profile-extractor.ts",
      source: `
        export function checkExactScope(text: string) {
          return /(?:моя|своя)\\s+(?:задача|запись)/u.test(text);
        }
      `,
    });
    expect(allowed).toEqual([]);
    expect(renamed).toEqual([expect.stringContaining("must not provide a production natural-language regex fallback")]);
  });
});
