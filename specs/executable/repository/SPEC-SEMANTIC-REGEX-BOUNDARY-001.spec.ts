import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const activeCompositionPaths = [
  "src/mastra/agent-runner.ts",
  "src/application/request-integrity-guard.ts",
  "src/mastra/request-integrity-guard.ts",
  "src/application/onboarding-profile-extractor.ts",
  "src/mastra/onboarding-profile-extractor.ts",
  "src/mastra/tools/activity-collection-tool.ts",
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

const semanticClassifierMethods = new Set(["test", "match", "search", "includes"]);
const formalParserName = /(?:exact|formal|literal|protocol)/iu;
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

function referencesRawText(node: ts.Node): boolean {
  let found = false;
  visit(node, (candidate) => {
    if (ts.isIdentifier(candidate) && ["text", "rawText", "userText"].includes(candidate.text)) found = true;
    if (ts.isPropertyAccessExpression(candidate) && candidate.name.text === "text") found = true;
  });
  return found;
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

function isRawTextClassifier(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  if (!semanticClassifierMethods.has(method)) return false;
  if (method === "test") return node.arguments.some(referencesRawText);
  return referencesRawText(node.expression.expression);
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
        let collectActivitiesIsDirect = false;
        if (!node.body) {
          report("`createAssistantToolsets` must have an implementation");
          return;
        }
        visit(node.body, (candidate) => {
          if (!ts.isPropertyAssignment(candidate) || nodeName(candidate) !== "collectActivities") return;
          if (!ts.isCallExpression(candidate.initializer) || !ts.isIdentifier(candidate.initializer.expression)) return;
          collectActivitiesIsDirect = candidate.initializer.expression.text === "createCollectActivitiesTool"
            && candidate.initializer.arguments.length === 1
            && candidate.initializer.arguments[0]?.getText(sourceFile) === "context.collectActivities";
        });
        if (!collectActivitiesIsDirect) report("the activity write tool must bind directly to its typed use-case without semantic argument rewriting");
      }
    });
  }

  if (input.path === "src/mastra/tools/activity-collection-tool.ts") {
    visit(sourceFile, (node) => {
      if (!ts.isFunctionDeclaration(node) || nodeName(node) !== "createCollectActivitiesTool") return;
      let directTypedCall = false;
      if (!node.body) {
        report("`createCollectActivitiesTool` must have an implementation");
        return;
      }
      visit(node.body, (candidate) => {
        if (!ts.isCallExpression(candidate) || !ts.isIdentifier(candidate.expression) || candidate.expression.text !== "collectActivities") return;
        directTypedCall = candidate.arguments.length === 1 && candidate.arguments[0]?.getText(sourceFile) === "input";
      });
      if (!directTypedCall) report("the activity tool must forward its schema-validated input without raw-text deletion or rewriting");
    });
  }

  if (input.path === "src/mastra/request-integrity-guard.ts") {
    visit(sourceFile, (node) => {
      if (ts.isCallExpression(node) && isRawTextClassifier(node)) {
        report("request-integrity composition must preserve the structured LLM outcome instead of keyword-overriding it");
      }
    });
  }

  if (input.path === "src/application/onboarding-profile-extractor.ts" || input.path === "src/mastra/onboarding-profile-extractor.ts") {
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isRawTextClassifier(node)) return;
      const ownerName = enclosingFunctionName(node);
      if (!ownerName || !formalParserName.test(ownerName)) {
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
    expect(findings).toEqual([expect.stringContaining("`activeTools` must expose the static request-scoped typed catalog")]);
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

  it("allows regex that validates formal protocol syntax", () => {
    const findings = inspectSource({
      path: "src/application/onboarding-profile-extractor.ts",
      source: `
        export function normalizeFormalDate(value: string) {
          return /^\\d{4}-\\d{2}-\\d{2}$/u.test(value) ? value : undefined;
        }
      `,
    });
    expect(findings).toEqual([]);
  });
});
