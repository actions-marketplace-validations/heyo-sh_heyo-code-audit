import { parseFinding, type AuditState } from "@heyo-sh/code-audit-core";

const START = "<!-- heyo-code-audit-state:";
const END = " -->";

export function encodeAuditState(state: AuditState): string {
  const json = JSON.stringify(state);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  if (encoded.length > 50_000)
    throw new Error("Heyo audit state exceeds GitHub Check output limits.");
  return `${START}${encoded}${END}`;
}

export function decodeAuditState(
  summary: string | undefined,
): AuditState | undefined {
  if (!summary) return undefined;
  const start = summary.lastIndexOf(START);
  if (start < 0) return undefined;
  const end = summary.indexOf(END, start);
  if (end < 0) return undefined;
  try {
    const raw = JSON.parse(
      Buffer.from(
        summary.slice(start + START.length, end),
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    if (
      raw.version !== 1 ||
      !sha(raw.baseSha) ||
      !sha(raw.auditedHeadSha) ||
      typeof raw.configHash !== "string" ||
      typeof raw.policyVersion !== "string" ||
      !Array.isArray(raw.findings)
    )
      return undefined;
    return {
      version: 1,
      baseSha: raw.baseSha,
      auditedHeadSha: raw.auditedHeadSha,
      configHash: raw.configHash,
      policyVersion: raw.policyVersion,
      findings: raw.findings.map(parseFinding),
    };
  } catch {
    return undefined;
  }
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);
}
