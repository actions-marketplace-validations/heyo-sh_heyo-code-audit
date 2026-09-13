import { createHash } from "node:crypto";
import {
  CHECK_IDS,
  type AuditConfig,
  type CheckId,
  type CommitLimit,
  type ProviderId,
  type ReportMode,
  type Severity,
} from "./types.js";

const REPORT_MODES = new Set<ReportMode>([
  "check",
  "comment",
  "check-and-comment",
  "none",
]);
const SEVERITY_SET = new Set<Severity>(["low", "medium", "high", "critical"]);

export class ConfigError extends Error {}

export function parseAuditConfig(
  inputs: Record<string, string | undefined>,
): AuditConfig {
  const provider = parseProvider(inputs.provider ?? "openai");
  const config: AuditConfig = {
    provider,
    model: requiredModel(inputs.model),
    apiKey: required(inputs["api-key"], "api-key"),
    githubToken: required(inputs["github-token"], "github-token"),
    checks: parseChecks(inputs.checks),
    verification: parseBoolean(inputs.verification, true, "verification"),
    report: parseReport(inputs.report),
    commentOnClean: parseBoolean(
      inputs["comment-on-clean"],
      false,
      "comment-on-clean",
    ),
    failOn: parseFailOn(inputs["fail-on"]),
    paths: parsePaths(inputs.paths),
    incremental: parseBoolean(inputs.incremental, true, "incremental"),
    maxPrCommits: parseLimit(inputs["max-pr-commits"], 100, "max-pr-commits"),
    maxNewCommits: parseLimit(inputs["max-new-commits"], 20, "max-new-commits"),
  };
  return config;
}

export function configHash(config: AuditConfig): string {
  const visible = {
    provider: config.provider,
    model: config.model,
    checks: config.checks,
    verification: config.verification,
    report: config.report,
    commentOnClean: config.commentOnClean,
    failOn: config.failOn,
    paths: config.paths,
    incremental: config.incremental,
    maxPrCommits: config.maxPrCommits,
    maxNewCommits: config.maxNewCommits,
  };
  return createHash("sha256").update(JSON.stringify(visible)).digest("hex");
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ConfigError(`Input '${name}' is required.`);
  return trimmed;
}

function parseProvider(value: string): ProviderId {
  const provider = value.trim().toLocaleLowerCase();
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider) && provider.length <= 100)
    return provider;
  throw new ConfigError(
    "Input 'provider' must be a Pi provider identifier using lowercase letters, numbers, and hyphens.",
  );
}

function requiredModel(value: string | undefined): string {
  const model = required(value, "model");
  if (model.length > 200)
    throw new ConfigError("Input 'model' must be at most 200 characters.");
  return model;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  const boolean = value?.trim();
  if (!boolean) return fallback;
  if (boolean === "true") return true;
  if (boolean === "false") return false;
  throw new ConfigError(`Input '${name}' must be 'true' or 'false'.`);
}

function parseChecks(value: string | undefined): CheckId[] {
  const checks = parseList(value);
  if (checks.length === 0) return [...CHECK_IDS];
  const unique = [...new Set(checks)];
  for (const check of unique) {
    if (!CHECK_IDS.includes(check as CheckId))
      throw new ConfigError(`Unknown audit check '${check}'.`);
  }
  return CHECK_IDS.filter((check) => unique.includes(check));
}

function parseReport(value: string | undefined): ReportMode {
  const report = value?.trim() || "check-and-comment";
  if (REPORT_MODES.has(report as ReportMode)) return report as ReportMode;
  throw new ConfigError(
    "Input 'report' must be check, comment, check-and-comment, or none.",
  );
}

function parseFailOn(value: string | undefined): Severity | "never" {
  const failOn = value?.trim() || "high";
  if (failOn === "never" || SEVERITY_SET.has(failOn as Severity))
    return failOn as Severity | "never";
  throw new ConfigError(
    "Input 'fail-on' must be never, low, medium, high, or critical.",
  );
}

function parseLimit(
  value: string | undefined,
  fallback: number,
  name: string,
): CommitLimit {
  const limit = value?.trim() || String(fallback);
  if (limit === "unlimited") return limit;
  if (/^[1-9]\d*$/.test(limit)) return Number(limit);
  throw new ConfigError(
    `Input '${name}' must be a positive integer or 'unlimited'.`,
  );
}

function parseList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePaths(value: string | undefined): string[] {
  const paths = [...new Set(parseList(value))].sort();
  if (paths.length > 50) {
    throw new ConfigError("Input 'paths' supports at most 50 globs.");
  }
  for (const path of paths) {
    if (
      path.length > 500 ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.startsWith(":") ||
      path.split(/[\\/]/).includes("..")
    ) {
      throw new ConfigError(`Path glob '${path}' is invalid.`);
    }
  }
  return paths;
}
