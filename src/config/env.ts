import { existsSync, readFileSync } from "node:fs";

function parseDotEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  const index = trimmed.indexOf("=");
  if (!trimmed || trimmed.startsWith("#") || index === -1) return undefined;

  const key = trimmed.slice(0, index).trim();
  return key ? { key, value: trimmed.slice(index + 1).trim() } : undefined;
}

/** Read one value without copying any other .env secrets into process.env. */
export function readDotEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (parsed?.key === key) return parsed.value;
  }
  return undefined;
}

/** Load local runtime configuration while preserving explicitly set variables. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (!parsed || Object.prototype.hasOwnProperty.call(process.env, parsed.key)) continue;
    process.env[parsed.key] = parsed.value;
  }
}
