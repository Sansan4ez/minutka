import { describe, expect, it } from "vitest";
import { classifyTextConfirmation, classifyTextConfirmationSelection } from "../../../src/telegram/text-confirmation.js";

describe("SPEC-TEXT-CONFIRMATION-001: deterministic short text decisions", () => {
  it.each([
    ["да", "confirm"],
    [" ДА! ", "confirm"],
    ["Ок.", "confirm"],
    ["подтверждаю", "confirm"],
    ["Yes", "confirm"],
    ["нет", "reject"],
    ["НЕ НАДО!", "reject"],
    ["отмена", "reject"],
    ["стоп.", "reject"],
  ] as const)("classifies %j as %s", (text, decision) => {
    expect(classifyTextConfirmation(text)).toBe(decision);
  });

  it.each([
    "",
    "да, но сначала проверь проект",
    "нет, давай завтра",
    "да 👍",
    "👍",
    "подтверждаю удаление",
    "конечно",
    "okay",
    "дааа",
    "yes please",
    "это сообщение намеренно длиннее установленного безопасного порога",
  ])("treats %j as not a decision", (text) => {
    expect(classifyTextConfirmation(text)).toBeUndefined();
  });

  it("classifies bounded group selections without free interpretation", () => {
    expect(classifyTextConfirmationSelection("да", 3)).toEqual({ confirm: [0, 1, 2], reject: [] });
    expect(classifyTextConfirmationSelection("только первое", 3)).toEqual({ confirm: [0], reject: [] });
    expect(classifyTextConfirmationSelection("первое и третье — да, второе не надо", 3)).toEqual({ confirm: [0, 2], reject: [1] });
    expect(classifyTextConfirmationSelection("первое да, пятое нет", 3)).toBeUndefined();
    expect(classifyTextConfirmationSelection("сделай как считаешь лучше", 3)).toBeUndefined();
  });
});
