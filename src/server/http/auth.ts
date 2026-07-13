import { createHash, timingSafeEqual } from "node:crypto";
export type AuthenticatedPrincipal =
  | { kind: "employee"; employeeId: string }
  | { kind: "operator"; operatorId: string }
  | { kind: "service"; serviceId: string };

export type ApiAuthConfig = { serviceToken?: string; adminToken?: string; employeeTokens: Map<string, string> };
const minTokenLength = 32;
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function tokenMatches(actual: string, expected: string): boolean { return timingSafeEqual(digest(actual), digest(expected)); }
function validToken(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  if (value.length < minTokenLength) throw new Error(`${label} must contain at least ${minTokenLength} characters`);
  return value;
}

export function apiAuthConfigFromEnv(env: NodeJS.ProcessEnv): ApiAuthConfig {
  const employeeTokens = new Map<string, string>();
  for (const entry of (env.MINUTKA_EMPLOYEE_TOKENS ?? "").split(",").filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0) throw new Error("MINUTKA_EMPLOYEE_TOKENS must contain employeeId:token pairs");
    const employeeId = entry.slice(0, separator).trim(); const token = validToken(entry.slice(separator + 1).trim(), "employee token");
    if (!employeeId || !token || employeeTokens.has(employeeId)) throw new Error("MINUTKA_EMPLOYEE_TOKENS contains an invalid or duplicate employee");
    employeeTokens.set(employeeId, token);
  }
  const config = { serviceToken: validToken(env.MINUTKA_SERVICE_TOKEN, "MINUTKA_SERVICE_TOKEN"), adminToken: validToken(env.MINUTKA_ADMIN_TOKEN, "MINUTKA_ADMIN_TOKEN"), employeeTokens };
  if (!config.serviceToken && !config.adminToken && !config.employeeTokens.size) throw new Error("at least one MINUTKA_*_TOKEN must be configured");
  const tokens = [config.serviceToken, config.adminToken, ...config.employeeTokens.values()].filter((token): token is string => Boolean(token));
  if (new Set(tokens).size !== tokens.length) throw new Error("MINUTKA credentials must be unique per principal");
  return config;
}

export function authenticateBearer(header: string | undefined, config: ApiAuthConfig): AuthenticatedPrincipal | undefined {
  const token = header?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return undefined;
  // Compare every configured credential. This keeps the number of comparisons
  // independent of a matching employee token's position.
  const serviceMatch = config.serviceToken ? tokenMatches(token, config.serviceToken) : false;
  const adminMatch = config.adminToken ? tokenMatches(token, config.adminToken) : false;
  let employee: string | undefined;
  for (const [employeeId, expected] of config.employeeTokens) {
    const matches = tokenMatches(token, expected);
    if (matches) employee = employeeId;
  }
  if (serviceMatch) return { kind: "service", serviceId: "minutka-service" };
  if (adminMatch) return { kind: "operator", operatorId: "minutka-operator" };
  return employee ? { kind: "employee", employeeId: employee } : undefined;
}
