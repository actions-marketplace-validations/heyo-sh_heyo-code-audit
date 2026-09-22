import { describe, expect, test } from "bun:test";
import {
  findingMarker,
  formatCheckAnnotation,
  formatCleanReview,
  formatInlineComment,
  formatSummary,
  decodeAuditState,
  encodeAuditState,
} from "../src/index.js";
import type { AuditReport, AuditState } from "@heyo-sh/code-audit-core";

const state: AuditState = {
  version: 1,
  baseSha: "a".repeat(40),
  auditedHeadSha: "b".repeat(40),
  configHash: "c".repeat(64),
  policyVersion: "policy",
  findings: [
    {
      fingerprint: "x",
      check: "security",
      severity: "high",
      confidence: "high",
      title: "Leaked token",
      description: "The API token is returned to the client.",
      evidence: "token=abcdefghijklmnopqrstuvwxyz",
      suggestion: "return redact(token);",
      file: "src/api.ts",
      line: 8,
    },
  ],
};

const report: AuditReport = {
  version: 1,
  conclusion: "failure",
  findings: state.findings,
  summary: "One verified finding.",
  metadata: {
    runtime: "pi",
    provider: "openai",
    model: "gpt",
    baseSha: state.baseSha,
    headSha: state.auditedHeadSha,
    verification: true,
    scope: "full",
  },
};

describe("GitHub report state and format", () => {
  test("round-trips only valid owned machine state", () => {
    const encoded = encodeAuditState(state);
    const decoded = decodeAuditState(`report\n${encoded}`);
    expect(decoded).toMatchObject({
      ...state,
      findings: [
        {
          check: "security",
          severity: "high",
          confidence: "high",
          title: "Leaked token",
        },
      ],
    });
    expect(decoded?.findings[0]?.fingerprint).toEqual(expect.any(String));
    expect(
      decodeAuditState("<!-- heyo-code-audit-state:not-base64 -->"),
    ).toBeUndefined();
  });

  test("formats a replaceable comment and redacts values that resemble secrets", () => {
    const summary = formatSummary(report);
    expect(summary).toContain("[REDACTED_SECRET]");
    expect(summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(formatCleanReview(report)).toBe(
      "## Heyo Code Audit — failure\n\nOne verified finding.",
    );
    expect(formatSummary(report)).toContain("Suggested fix");
    expect(formatInlineComment(state.findings[0]!)).toContain(
      "```suggestion\nreturn redact(token);\n```",
    );
    expect(formatInlineComment(state.findings[0]!)).toStartWith(
      findingMarker(state.findings[0]!),
    );
    expect(formatCheckAnnotation(state.findings[0]!)).toEqual({
      path: "src/api.ts",
      start_line: 8,
      end_line: 8,
      annotation_level: "failure",
      title: "HIGH · SECURITY: Leaked token",
      message:
        "The API token is returned to the client.\n\nEvidence: token=[REDACTED_SECRET]",
    });
  });
});
