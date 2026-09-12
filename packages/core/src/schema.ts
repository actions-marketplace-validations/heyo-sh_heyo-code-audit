import { createHash } from "node:crypto";
import {
  CHECK_IDS,
  CONFIDENCES,
  SEVERITIES,
  type DiscoveryResult,
  type Finding,
  type VerificationResult,
} from "./types.js";
import { redactSecrets } from "./redaction.js";

export class SchemaError extends Error {}

export function parseDiscovery(value: unknown): DiscoveryResult {
  if (!isObject(value) || !Array.isArray(value.findings))
    throw new SchemaError("Discovery response must contain findings.");
  if (value.findings.length > 20)
    throw new SchemaError("Discovery response exceeds the finding limit.");
  return { findings: value.findings.map(parseFinding) };
}

export function parseVerification(value: unknown): VerificationResult {
  if (!isObject(value) || typeof value.verified !== "boolean")
    throw new SchemaError("Verification response must contain verified.");
  if (!value.verified)
    return typeof value.reason === "string"
      ? { verified: false, reason: clean(value.reason, 500) }
      : { verified: false };
  if (!value.finding)
    throw new SchemaError("A verified response must contain a finding.");
  return { verified: true, finding: parseFinding(value.finding) };
}

export function parseFinding(value: unknown): Finding {
  if (!isObject(value)) throw new SchemaError("Finding must be an object.");
  const check = enumValue(value.check, CHECK_IDS, "check");
  const severity = enumValue(value.severity, SEVERITIES, "severity");
  const confidence = enumValue(value.confidence, CONFIDENCES, "confidence");
  const title = requiredText(value.title, "title", 160);
  const description = requiredText(value.description, "description", 800);
  const evidence = requiredText(value.evidence, "evidence", 800);
  const file = optionalFile(value.file);
  const line = optionalLine(value.line);
  const fingerprint = fingerprintFor({
    check,
    title,
    evidence,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
  });
  return {
    fingerprint,
    check,
    severity,
    confidence,
    title,
    description,
    evidence,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
  };
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = best.get(finding.fingerprint);
    if (
      !existing ||
      severityRank(finding.severity) > severityRank(existing.severity)
    )
      best.set(finding.fingerprint, finding);
  }
  return [...best.values()].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
}

export function severityRank(severity: Finding["severity"]): number {
  return SEVERITIES.indexOf(severity) + 1;
}

function fingerprintFor(input: {
  check: string;
  title: string;
  evidence: string;
  file?: string;
  line?: number;
}): string {
  const stable = [
    input.check,
    input.file ?? "",
    input.line ?? "",
    input.title,
    input.evidence,
  ]
    .join("\n")
    .toLowerCase();
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (
    typeof value === "string" &&
    (values as readonly string[]).includes(value)
  )
    return value as T[number];
  throw new SchemaError(`Finding ${name} is invalid.`);
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new SchemaError(`Finding ${name} is required.`);
  return clean(redactSecrets(value), max);
}

function clean(value: string, max: number): string {
  return value.replaceAll("\u0000", "").trim().slice(0, max);
}

function optionalFile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 500)
    throw new SchemaError("Finding file is invalid.");
  const file = clean(redactSecrets(value), 500);
  if (
    !file ||
    file.startsWith("/") ||
    file.startsWith("\\") ||
    file.split(/[\\/]/).includes("..")
  ) {
    throw new SchemaError("Finding file is invalid.");
  }
  return file;
}

function optionalLine(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new SchemaError("Finding line is invalid.");
  return value;
}
