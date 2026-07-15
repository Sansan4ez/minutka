import { describe, expect, it } from "vitest";
import { classifiedSchema, recordTypeSchema } from "../../../src/contracts/minutka-api.js";
import { NO_PROJECT, recordTypes } from "../../../src/domain/classification.js";

describe("SPEC-CLASSIFICATION-001: сквозной классификатор Classified", () => {
  it("принимает валидную классификацию по двум осям", () => {
    const parsed = classifiedSchema.parse({ project: "АССИСТЕНТ", type: "development" });
    expect(parsed).toEqual({ project: "АССИСТЕНТ", type: "development" });
  });

  it("принимает сентинел БЕЗ_ПРОЕКТА как валидный проект (запись не теряется)", () => {
    const parsed = classifiedSchema.parse({ project: NO_PROJECT, type: "knowledge" });
    expect(parsed.project).toBe("БЕЗ_ПРОЕКТА");
  });

  it("отвергает пустой проект и неизвестный тип", () => {
    expect(classifiedSchema.safeParse({ project: "", type: "knowledge" }).success).toBe(false);
    expect(classifiedSchema.safeParse({ project: "АССИСТЕНТ", type: "unknown" }).success).toBe(false);
  });

  it("схема типа и доменный список типов синхронизированы", () => {
    expect([...recordTypeSchema.options].sort()).toEqual([...recordTypes].sort());
  });
});
