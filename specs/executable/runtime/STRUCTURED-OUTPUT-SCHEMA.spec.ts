import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decisionTransportSchema } from "../../../src/mastra/conversation-decision-router.js";
import { insightTransportSchema } from "../../../src/mastra/insight-extractor.js";
import { onboardingExtractorTransportSchema } from "../../../src/mastra/onboarding-profile-extractor.js";
import { requestIntegrityOutcomeSchema } from "../../../src/mastra/request-integrity-guard.js";

/**
 * Every structured-output schema is sent to the provider as `response_format`
 * JSON Schema. A `.transform()` anywhere inside makes that subschema
 * unrepresentable, Mastra emits an untyped `{}` and the provider answers 400
 * ("schema must have a 'type' key"). Typecheck cannot see this, so it is
 * asserted here.
 */
const structuredOutputSchemas: Array<[string, z.ZodType]> = [
  ["onboardingExtractorTransportSchema", onboardingExtractorTransportSchema],
  ["decisionTransportSchema", decisionTransportSchema],
  ["insightTransportSchema", insightTransportSchema],
  ["requestIntegrityOutcomeSchema", requestIntegrityOutcomeSchema],
];

function untypedPaths(schema: unknown, path: string[] = []): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const combinator = node.anyOf ?? node.oneOf ?? node.allOf;
  const isTyped = node.type !== undefined || Array.isArray(combinator) || node.$ref !== undefined || node.enum !== undefined || node.const !== undefined;
  const here = isTyped ? [] : [path.join(".") || "<root>"];
  const children: string[] = [];
  for (const [key, value] of Object.entries(node.properties ?? {})) children.push(...untypedPaths(value, [...path, key]));
  if (node.items !== undefined) children.push(...untypedPaths(node.items, [...path, "[]"]));
  for (const branch of Array.isArray(combinator) ? combinator : []) children.push(...untypedPaths(branch, [...path, "|"]));
  for (const [key, value] of Object.entries(node.$defs ?? {})) children.push(...untypedPaths(value, ["$defs", key]));
  return [...here, ...children];
}

describe("structured-output schemas stay representable as provider JSON Schema", () => {
  for (const [name, schema] of structuredOutputSchemas) {
    it(`${name} converts without unrepresentable members`, () => {
      // `unrepresentable: "throw"` is the strict form of what Mastra does with
      // `unrepresentable: "any"`, where the same member degrades to `{}`.
      expect(() => z.toJSONSchema(schema, { io: "output", unrepresentable: "throw" })).not.toThrow();
      expect(untypedPaths(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }))).toEqual([]);
    });
  }
});
