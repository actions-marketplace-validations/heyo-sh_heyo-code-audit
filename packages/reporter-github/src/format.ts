import {
  redactSecrets,
  type AuditReport,
  type Finding,
} from "@heyo-sh/code-audit-core";

export const COMMENT_MARKER = "<!-- heyo-code-audit-report -->";

export function formatSummary(report: AuditReport): string {
  const findings = report.findings.map(formatFinding).join("\n\n");
  return sanitizeReport(
    [
      `## Heyo Code Audit — ${report.conclusion}`,
      "",
      sanitizeReport(report.summary),
      "",
      findings || "No verified findings.",
      "",
      `_Scope: ${report.metadata.scope}; provider: ${report.metadata.provider}; model: ${report.metadata.model}_`,
    ].join("\n"),
  );
}

export function formatComment(report: AuditReport): string {
  return `${COMMENT_MARKER}\n${formatSummary(report)}`;
}

function formatFinding(finding: Finding): string {
  const location = finding.file
    ? ` — \`${sanitizeInline(finding.file)}${finding.line ? `:${finding.line}` : ""}\``
    : "";
  return `### ${finding.severity.toUpperCase()}: ${sanitizeInline(finding.title)}${location}\n\n${sanitizeReport(finding.description)}\n\n**Evidence:** ${sanitizeReport(finding.evidence)}`;
}

function sanitizeInline(value: string): string {
  return sanitizeReport(value).replaceAll("`", "'").replaceAll("\n", " ");
}

function sanitizeReport(value: string): string {
  return redactSecrets(value).slice(0, 55_000);
}
