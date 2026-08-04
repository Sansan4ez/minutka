import { describe, expect, it } from "vitest";
import { classifyTextConfirmation } from "../../../src/telegram/text-confirmation.js";

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
});
