import { deduplicateFindings, severityRank } from "./schema.js";
import type {
  AuditConfig,
  AuditReport,
  AuditScope,
  Finding,
  PullRequestContext,
} from "./types.js";

export function createReport(input: {
  config: AuditConfig;
  pr: PullRequestContext;
  scope: AuditScope;
  previousHeadSha?: string;
  findings: Finding[];
}): AuditReport {
  const findings = deduplicateFindings(input.findings);
  const conclusion = conclusionFor(findings, input.config.failOn);
  const count = findings.length;
  const summary =
    count === 0
      ? "Heyo completed the audit with no verified findings."
      : `Heyo verified ${count} finding${count === 1 ? "" : "s"}; ${findings.filter((finding) => severityRank(finding.severity) >= severityRank("high")).length} high or critical.`;
  return {
    version: 1,
    conclusion,
    findings,
    summary,
    metadata: {
      runtime: "pi",
      provider: input.config.provider,
      model: input.config.model,
      baseSha: input.pr.baseSha,
      headSha: input.pr.headSha,
      verification: input.config.verification,
      scope: input.scope,
      ...(input.previousHeadSha
        ? { previousHeadSha: input.previousHeadSha }
        : {}),
    },
  };
}

export function neutralReport(input: {
  config: AuditConfig;
  pr: PullRequestContext;
  summary: string;
  scope: AuditScope;
}): AuditReport {
  return {
    version: 1,
    conclusion: "neutral",
    findings: [],
    summary: input.summary,
    metadata: {
      runtime: "pi",
      provider: input.config.provider,
      model: input.config.model,
      baseSha: input.pr.baseSha,
      headSha: input.pr.headSha,
      verification: input.config.verification,
      scope: input.scope,
    },
  };
}

export function conclusionFor(
  findings: Finding[],
  failOn: AuditConfig["failOn"],
): AuditReport["conclusion"] {
  if (failOn === "never") return "success";
  return findings.some(
    (finding) => severityRank(finding.severity) >= severityRank(failOn),
  )
    ? "failure"
    : "success";
}
