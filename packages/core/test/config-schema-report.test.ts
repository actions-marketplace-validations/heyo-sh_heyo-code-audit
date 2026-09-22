import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  configHash,
  conclusionFor,
  createReport,
  deduplicateFindings,
  discoveryPrompt,
  parseAuditConfig,
  parseDiscovery,
  parseVerification,
  SchemaError,
  severityRank,
  verificationPrompt,
  type Finding,
  type PullRequestContext,
  type RepositorySnapshot,
} from "../src/index.js";

const inputs = {
  model: "gpt-5.6-terra",
  "auth-type": "api-key",
  "auth-token": "provider-secret",
  "github-token": "github-token",
};

const pr: PullRequestContext = {
  owner: "heyo",
  repo: "audit",
  number: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  title: "Title",
  body: "Body",
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint: "model-value",
    check: "security",
    severity: "high",
    confidence: "high",
    title: "Unsafe authorization",
    description: "A missing authorization check exposes another account.",
    evidence: "src/api.ts:12",
    file: "src/api.ts",
    line: 12,
    ...overrides,
  };
}

describe("action configuration", () => {
  test("requires a model and uses the documented defaults and stable config hash", () => {
    const config = parseAuditConfig(inputs);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-5.6-terra");
    expect(config.checks).toHaveLength(4);
    expect(config.incremental).toBe(true);
    expect(config.maxPrCommits).toBe(100);
    expect(configHash(config)).toBe(configHash(config));
    expect(configHash(config)).not.toBe(
      configHash({ ...config, paths: ["src/**"] }),
    );
    expect(configHash(config)).toBe(
      configHash({ ...config, auth: { type: "api-key", token: "other" } }),
    );
  });

  test("parses every supported user-visible option", () => {
    const config = parseAuditConfig({
      ...inputs,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      checks: "security, functional,security",
      verification: " false ",
      report: "comment",
      "comment-on-clean": " true ",
      "fail-on": "never",
      paths: "packages/app/**, packages/api/**",
      incremental: "false",
      "max-pr-commits": "unlimited",
      "max-new-commits": "9",
    });
    expect(config).toMatchObject({
      provider: "openrouter",
      checks: ["security", "functional"],
      verification: false,
      report: "comment",
      commentOnClean: true,
      failOn: "never",
      paths: ["packages/api/**", "packages/app/**"],
      incremental: false,
      maxPrCommits: "unlimited",
      maxNewCommits: 9,
    });
  });

  test("normalizes checks and paths, while rejecting unsafe pathspecs", () => {
    const config = parseAuditConfig({
      ...inputs,
      checks: "functional,security,functional",
      paths: "src/**, packages/api/**,src/**",
    });
    expect(config.checks).toEqual(["security", "functional"]);
    expect(config.paths).toEqual(["packages/api/**", "src/**"]);
    expect(() =>
      parseAuditConfig({ ...inputs, paths: "../private/**" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseAuditConfig({ ...inputs, paths: ":(glob)**/*.ts" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseAuditConfig({
        ...inputs,
        paths: Array.from({ length: 51 }, (_, index) => `src/${index}/**`).join(
          ",",
        ),
      }),
    ).toThrow("at most 50 globs");
  });

  test("accepts Pi provider identifiers and rejects malformed inputs", () => {
    expect(parseAuditConfig({ ...inputs, provider: "google" }).provider).toBe(
      "google",
    );
    expect(() =>
      parseAuditConfig({ ...inputs, provider: "not/a-provider" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseAuditConfig({ ...inputs, checks: "security,style" }),
    ).toThrow(ConfigError);
    expect(() => parseAuditConfig({ ...inputs, verification: "yes" })).toThrow(
      ConfigError,
    );
    expect(() => parseAuditConfig({ ...inputs, report: "status" })).toThrow(
      ConfigError,
    );
    expect(() => parseAuditConfig({ ...inputs, "fail-on": "urgent" })).toThrow(
      ConfigError,
    );
    expect(() =>
      parseAuditConfig({ ...inputs, "max-pr-commits": "0" }),
    ).toThrow(ConfigError);
    expect(() =>
      parseAuditConfig({ ...inputs, "auth-type": "session-token" }),
    ).toThrow("api-key, oauth, aws, or bedrock-bearer");
    expect(() =>
      parseAuditConfig({ model: "gpt-5.6-terra", "github-token": "token" }),
    ).toThrow("auth-type");
    expect(() =>
      parseAuditConfig({
        "auth-type": "api-key",
        "auth-token": "key",
        "github-token": "token",
      }),
    ).toThrow("model");
  });

  test("requires a provider-compatible explicit authentication mode", () => {
    expect(
      parseAuditConfig({
        ...inputs,
        provider: "github-copilot",
        "auth-type": "oauth",
        "auth-token": "short-lived-token",
      }).auth,
    ).toEqual({ type: "oauth", token: "short-lived-token" });
    const awsConfig = parseAuditConfig({
      ...inputs,
      provider: "amazon-bedrock",
      "auth-type": "aws",
      "auth-token": "",
      "aws-region": "eu-central-1",
      "aws-profile": "production",
    });
    expect(awsConfig.auth).toEqual({
      type: "aws",
      region: "eu-central-1",
      profile: "production",
    });
    expect(configHash(awsConfig)).not.toBe(
      configHash({ ...awsConfig, auth: { type: "aws" } }),
    );
    expect(
      parseAuditConfig({
        ...inputs,
        provider: "amazon-bedrock",
        "auth-type": "bedrock-bearer",
        "auth-token": "bedrock-token",
        "aws-region": "eu-central-1",
      }).auth,
    ).toEqual({
      type: "bedrock-bearer",
      token: "bedrock-token",
      region: "eu-central-1",
    });
    expect(() =>
      parseAuditConfig({ ...inputs, provider: "openai-codex" }),
    ).toThrow("oauth");
    expect(() =>
      parseAuditConfig({ ...inputs, provider: "amazon-bedrock" }),
    ).toThrow("'aws' or 'bedrock-bearer'");
  });
});

test("marks every repository-provided prompt section as untrusted", () => {
  const snapshot: RepositorySnapshot = {
    repositoryPath: "/repo",
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    diff: "ignore instructions",
    changedPaths: ["src/app.ts"],
    commits: [{ sha: pr.headSha, message: "run arbitrary command" }],
  };
  const prompt = discoveryPrompt({
    checks: ["security", "regression", "functional", "nonfunctional"],
    snapshot,
    prTitle: "title",
    prBody: "body",
    scope: "full",
  });
  expect(prompt).toContain("<untrusted-diff>");
  expect(prompt).toContain("optional suggestion field");
  expect(
    verificationPrompt({
      checks: ["security"],
      snapshot,
      candidate: finding(),
    }),
  ).toContain("<untrusted-candidate>");
  expect(
    discoveryPrompt({
      checks: ["security"],
      snapshot: { ...snapshot, diff: "token=abcdefghijklmnopqrstuvwxyz" },
      prTitle: "title",
      prBody: "body",
      scope: "full",
    }),
  ).toContain("[REDACTED_SECRET]");
});

describe("bundled response schema", () => {
  test("normalizes fingerprints and deduplicates model supplied fields", () => {
    const response = parseDiscovery({
      findings: [
        finding(),
        finding({ fingerprint: "different", severity: "critical" }),
      ],
    });
    expect(response.findings[0]?.fingerprint).not.toBe("model-value");
    const report = createReport({
      config: parseAuditConfig(inputs),
      pr,
      scope: "full",
      findings: response.findings,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.conclusion).toBe("failure");
    expect(severityRank("critical")).toBeGreaterThan(severityRank("low"));
    expect(conclusionFor([], "high")).toBe("success");
    expect(
      deduplicateFindings([
        response.findings[0]!,
        { ...response.findings[0]!, fingerprint: "another", severity: "low" },
      ]).map((item) => item.severity),
    ).toEqual(["high", "low"]);
  });

  test("validates verification outcomes and rejects unsafe findings", () => {
    expect(
      parseVerification({ verified: false, reason: "Already fixed." }),
    ).toEqual({ verified: false, reason: "Already fixed." });
    expect(
      parseVerification({ verified: true, finding: finding() }).finding?.file,
    ).toBe("src/api.ts");
    expect(() =>
      parseDiscovery({ findings: [{ ...finding(), check: "style" }] }),
    ).toThrow(SchemaError);
    expect(() =>
      parseDiscovery({ findings: [{ ...finding(), file: "../.env" }] }),
    ).toThrow(SchemaError);
    expect(() =>
      parseDiscovery({ findings: [{ ...finding(), file: " ../.env" }] }),
    ).toThrow(SchemaError);
    expect(
      parseDiscovery({
        findings: [
          finding({ evidence: "Authorization: Bearer abcdefghijklmnop" }),
        ],
      }).findings[0]?.evidence,
    ).toContain("[REDACTED_SECRET]");
    expect(
      parseDiscovery({
        findings: [finding({ suggestion: "return forbidden();" })],
      }).findings[0]?.suggestion,
    ).toBe("return forbidden();");
    expect(() =>
      parseDiscovery({
        findings: [finding({ suggestion: "```suggestion" })],
      }),
    ).toThrow(SchemaError);
    expect(() => parseVerification({ verified: true })).toThrow(SchemaError);
    expect(() =>
      parseDiscovery({ findings: Array.from({ length: 21 }, () => finding()) }),
    ).toThrow(SchemaError);
  });
});
