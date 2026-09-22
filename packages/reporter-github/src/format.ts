import {
  redactSecrets,
  type AuditReport,
  type Finding,
} from "@heyo-sh/code-audit-core";

const FINDING_MARKER_PREFIX = "<!-- heyo-code-audit-finding:";

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

export function formatCleanReview(report: AuditReport): string {
  return `## Heyo Code Audit — ${report.conclusion}\n\n${sanitizeReport(report.summary)}`;
}

/** Formats a changed-line finding for a GitHub Check annotation. */
export function formatCheckAnnotation(finding: Finding): {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
} {
  if (!finding.file || !finding.line)
    throw new Error("Check annotations require a file and line.");
  return {
    path: finding.file,
    start_line: finding.line,
    end_line: finding.line,
    annotation_level:
      finding.severity === "low"
        ? "notice"
        : finding.severity === "medium"
          ? "warning"
          : "failure",
    title:
      `${finding.severity.toUpperCase()} · ${finding.check.toUpperCase()}: ${sanitizeInline(finding.title)}`.slice(
        0,
        255,
      ),
    message:
      `${sanitizeReport(finding.description)}\n\nEvidence: ${sanitizeReport(finding.evidence)}`.slice(
        0,
        4_000,
      ),
  };
}

/** A GitHub PR-review body, optionally including an apply-able suggestion. */
export function formatInlineComment(finding: Finding): string {
  return [
    findingMarker(finding),
    `**${finding.severity.toUpperCase()} · ${finding.check.toUpperCase()}: ${sanitizeInline(finding.title)}**`,
    "",
    sanitizeReport(finding.description),
    "",
    `**Evidence:** ${sanitizeReport(finding.evidence)}`,
    ...(finding.suggestion
      ? [
          "",
          "**Suggested fix:**",
          "",
          "```suggestion",
          finding.suggestion,
          "```",
        ]
      : []),
  ].join("\n");
}

export function findingMarker(finding: Pick<Finding, "fingerprint">): string {
  return `${FINDING_MARKER_PREFIX}${finding.fingerprint} -->`;
}

function formatFinding(finding: Finding): string {
  const location = finding.file
    ? ` — \`${sanitizeInline(finding.file)}${finding.line ? `:${finding.line}` : ""}\``
    : "";
  const suggestion = finding.suggestion
    ? `\n\n**Suggested fix:**\n\n\`\`\`\n${finding.suggestion}\n\`\`\``
    : "";
  return `### ${finding.severity.toUpperCase()}: ${sanitizeInline(finding.title)}${location}\n\n${sanitizeReport(finding.description)}\n\n**Evidence:** ${sanitizeReport(finding.evidence)}${suggestion}`;
}

function sanitizeInline(value: string): string {
  return sanitizeReport(value).replaceAll("`", "'").replaceAll("\n", " ");
}

function sanitizeReport(value: string): string {
  return redactSecrets(value).slice(0, 55_000);
}
