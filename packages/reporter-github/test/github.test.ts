import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GitHubAuditPublisher,
  GitHubAuditRepository,
  createGitHubClient,
  decodeAuditState,
  encodeAuditState,
  reviewableLocations,
} from "../src/index.js";
import {
  parseAuditConfig,
  type AuditReport,
  type AuditState,
  type PullRequestContext,
} from "@heyo-sh/code-audit-core";

const exec = promisify(execFile);
const temporary: string[] = [];
const base = "a".repeat(40);
const head = "b".repeat(40);
const state: AuditState = {
  version: 1,
  baseSha: base,
  auditedHeadSha: head,
  configHash: "c".repeat(64),
  policyVersion: "policy",
  findings: [],
};
const pr: PullRequestContext = {
  owner: "heyo",
  repo: "audit",
  number: 7,
  baseSha: base,
  headSha: head,
  title: "Title",
  body: "",
};
const report: AuditReport = {
  version: 1,
  conclusion: "success",
  findings: [],
  summary: "Clean",
  metadata: {
    runtime: "pi",
    provider: "openai",
    model: "gpt",
    baseSha: base,
    headSha: head,
    verification: true,
    scope: "full",
  },
};

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fakeClient() {
  const calls = {
    checks: [] as unknown[],
    reviews: [] as unknown[],
  };
  const order: string[] = [];
  const functions = {
    listCommits: async () => [],
    listForRef: async () => [],
    listReviewComments: async () => [],
  };
  let commitRows: unknown[] = [];
  let checks: unknown[] = [];
  let reviewComments: unknown[] = [];
  const client = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            base: { sha: base },
            head: { sha: head, repo: { fork: false } },
            title: "Title",
            body: null,
          },
        }),
        listCommits: functions.listCommits,
        listReviewComments: functions.listReviewComments,
        createReview: async (input: unknown) => {
          order.push("review");
          calls.reviews.push(input);
        },
      },
      checks: {
        listForRef: functions.listForRef,
        create: async (input: unknown) => {
          order.push("check");
          calls.checks.push(input);
        },
      },
    },
    paginate: async (method: unknown) =>
      method === functions.listCommits
        ? commitRows
        : method === functions.listForRef
          ? checks
          : reviewComments,
  };
  return {
    client: client as never,
    calls,
    order,
    setRows: (next: {
      commitRows?: unknown[];
      checks?: unknown[];
      reviewComments?: unknown[];
    }) => {
      commitRows = next.commitRows ?? commitRows;
      checks = next.checks ?? checks;
      reviewComments = next.reviewComments ?? reviewComments;
    },
  };
}

describe("GitHub adapter", () => {
  test("reads PR metadata, finds only valid completed owned state, and checks current head", async () => {
    const fake = fakeClient();
    fake.setRows({
      commitRows: [{ sha: base }, { sha: head }],
      checks: [
        {
          status: "completed",
          conclusion: "neutral",
          output: { summary: encodeAuditState(state) },
        },
        {
          status: "completed",
          conclusion: "failure",
          output: { summary: encodeAuditState(state) },
        },
      ],
    });
    const repository = new GitHubAuditRepository(fake.client, {
      owner: "heyo",
      repo: "audit",
      prNumber: 7,
      repositoryPath: "/unused",
    });
    expect(await repository.getPullRequest()).toMatchObject({
      title: "Title",
      body: "",
    });
    expect(await repository.findLatestState(pr)).toEqual(state);
    expect(await repository.isCurrentHead(pr, head)).toBe(true);
    expect(await repository.isCurrentHead(pr, base)).toBe(false);
    await expect(repository.countCommits("invalid", head)).rejects.toThrow(
      "Invalid git SHA",
    );
  });

  test("reads bounded git snapshots and detects ancestry without shell interpolation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heyo-github-"));
    temporary.push(directory);
    await exec("git", ["init", "-q"], { cwd: directory });
    await exec("git", ["config", "user.email", "audit@example.test"], {
      cwd: directory,
    });
    await exec("git", ["config", "user.name", "Audit"], { cwd: directory });
    await writeFile(join(directory, "app.ts"), "export const version = 1;\n");
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "base"], { cwd: directory });
    const initial = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    await writeFile(join(directory, "app.ts"), "export const version = 2;\n");
    await writeFile(join(directory, "notes.md"), "changed\n");
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "change app"], { cwd: directory });
    const current = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    const repository = new GitHubAuditRepository(fakeClient().client, {
      owner: "heyo",
      repo: "audit",
      prNumber: 7,
      repositoryPath: directory,
    });
    const snapshot = await repository.getSnapshot(initial, current, ["*.ts"]);
    expect(snapshot.changedPaths).toEqual(["app.ts"]);
    expect(snapshot.diff).toContain("version = 2");
    expect(await repository.countCommits(initial, current)).toBe(1);
    expect(await repository.isAncestor(initial, current)).toBe(true);
    expect(await repository.isAncestor(current, initial)).toBe(false);

    await writeFile(join(directory, "large.txt"), "a".repeat(200_000));
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "large base"], { cwd: directory });
    const largeBase = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    await writeFile(join(directory, "large.txt"), "b".repeat(200_000));
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "large change"], {
      cwd: directory,
    });
    const largeHead = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    const largeSnapshot = await repository.getSnapshot(
      largeBase,
      largeHead,
      [],
    );
    expect(Buffer.byteLength(largeSnapshot.diff)).toBeLessThanOrEqual(160_000);
    expect(largeSnapshot.diff).toEndWith("[Diff truncated by Heyo]");
  });

  test("applies recursive path globs to both repository-root and nested files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heyo-github-"));
    temporary.push(directory);
    await exec("git", ["init", "-q"], { cwd: directory });
    await exec("git", ["config", "user.email", "audit@example.test"], {
      cwd: directory,
    });
    await exec("git", ["config", "user.name", "Audit"], { cwd: directory });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "root.ts"), "export const root = 1;\n");
    await writeFile(
      join(directory, "src", "nested.ts"),
      "export const nested = 1;\n",
    );
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "base"], { cwd: directory });
    const initial = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    await writeFile(join(directory, "root.ts"), "export const root = 2;\n");
    await writeFile(
      join(directory, "src", "nested.ts"),
      "export const nested = 2;\n",
    );
    await exec("git", ["add", "."], { cwd: directory });
    await exec("git", ["commit", "-qm", "change TypeScript"], {
      cwd: directory,
    });
    const current = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: directory })
    ).stdout.trim();
    const repository = new GitHubAuditRepository(fakeClient().client, {
      owner: "heyo",
      repo: "audit",
      prNumber: 7,
      repositoryPath: directory,
    });

    const snapshot = await repository.getSnapshot(initial, current, [
      "**/*.ts",
    ]);
    expect(snapshot.changedPaths).toEqual(["root.ts", "src/nested.ts"]);
  });

  test("publishes changed-line findings as Check annotations and inline review comments", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      model: "gpt-5.6-terra",
      "auth-type": "api-key",
      "auth-token": "provider",
      "github-token": "github",
    });
    const publisher = new GitHubAuditPublisher(fake.client, config);
    const finding = {
      fingerprint: "a-verified-finding",
      check: "security" as const,
      severity: "high" as const,
      confidence: "high" as const,
      title: "Authorize the account lookup",
      description:
        "The changed handler reads an account without a tenant check.",
      evidence: "The new return sends the loaded account to the caller.",
      file: "src/route.ts",
      line: 12,
      suggestion:
        "return account.tenantId === tenant.id ? account : undefined;",
    };
    const diff = [
      "diff --git a/src/route.ts b/src/route.ts",
      "--- a/src/route.ts",
      "+++ b/src/route.ts",
      "@@ -12 +12 @@ export function getAccount() {",
      "-  return account;",
      "+  return account;",
    ].join("\n");
    const unchangedFinding = {
      ...finding,
      fingerprint: "not-on-a-changed-line",
      title: "Do not annotate unchanged code",
      line: 13,
    };
    await publisher.publish({
      pr,
      report: {
        ...report,
        conclusion: "failure",
        findings: [finding, unchangedFinding],
      },
      snapshot: { diff },
    });
    expect(fake.calls.reviews).toEqual([
      {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        commit_id: pr.headSha,
        event: "COMMENT",
        comments: [
          {
            path: "src/route.ts",
            line: 12,
            side: "RIGHT",
            body: expect.stringContaining(
              "```suggestion\nreturn account.tenantId === tenant.id ? account : undefined;\n```",
            ),
          },
        ],
      },
    ]);
    expect(fake.order).toEqual(["check", "review"]);
    expect(fake.calls.checks).toEqual([
      expect.objectContaining({
        output: expect.objectContaining({
          annotations: [
            {
              path: "src/route.ts",
              start_line: 12,
              end_line: 12,
              annotation_level: "failure",
              title: "HIGH · SECURITY: Authorize the account lookup",
              message:
                "The changed handler reads an account without a tenant check.\n\nEvidence: The new return sends the loaded account to the caller.",
            },
          ],
        }),
      }),
    ]);

    fake.setRows({
      reviewComments: [
        {
          user: { type: "Bot" },
          commit_id: pr.headSha,
          body: "<!-- heyo-code-audit-finding:a-verified-finding -->",
        },
      ],
    });
    await publisher.publish({
      pr,
      report: {
        ...report,
        conclusion: "failure",
        findings: [finding, unchangedFinding],
      },
      snapshot: { diff },
    });
    expect(fake.calls.reviews).toHaveLength(1);
  });

  test("publishes Check annotations without comments in check mode", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      model: "gpt-5.6-terra",
      "auth-type": "api-key",
      "auth-token": "provider",
      "github-token": "github",
      report: "check",
    });
    const publisher = new GitHubAuditPublisher(fake.client, config);
    await publisher.publish({
      pr,
      report: {
        ...report,
        conclusion: "failure",
        findings: [
          {
            fingerprint: "check-only-finding",
            check: "functional",
            severity: "medium",
            confidence: "high",
            title: "The response omits a required field",
            description: "The changed handler no longer returns the field.",
            evidence: "The return object lacks the documented property.",
            file: "src/route.ts",
            line: 12,
          },
        ],
      },
      snapshot: {
        diff: [
          "diff --git a/src/route.ts b/src/route.ts",
          "--- a/src/route.ts",
          "+++ b/src/route.ts",
          "@@ -12 +12 @@ export function handler() {",
          "-  return { value };",
          "+  return {};",
        ].join("\n"),
      },
    });

    expect(fake.calls.reviews).toHaveLength(0);
    expect(fake.calls.checks).toEqual([
      expect.objectContaining({
        output: expect.objectContaining({
          annotations: [
            expect.objectContaining({
              annotation_level: "warning",
              path: "src/route.ts",
              start_line: 12,
            }),
          ],
        }),
      }),
    ]);
  });

  test("keeps only changed right-side lines eligible for inline comments", () => {
    const locations = reviewableLocations(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -8,3 +8,4 @@",
        " unchanged();",
        "-removed();",
        "+added();",
        "+alsoAdded();",
        " unchangedAgain();",
      ].join("\n"),
    );
    expect([...locations]).toEqual(["src/app.ts\u00009", "src/app.ts\u000010"]);
  });

  test("publishes a clean PR review and supports review-only reporting", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      model: "gpt-5.6-terra",
      "auth-type": "api-key",
      "auth-token": "provider",
      "github-token": "github",
      "comment-on-clean": "true",
    });
    const publisher = new GitHubAuditPublisher(fake.client, config);
    await publisher.publish({ pr, report, state });
    expect(fake.calls.checks).toHaveLength(1);
    expect(fake.calls.reviews).toEqual([
      {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        commit_id: pr.headSha,
        event: "COMMENT",
        body: "## Heyo Code Audit — success\n\nClean",
      },
    ]);
    expect(fake.order).toEqual(["check", "review"]);

    const reviewOnly = new GitHubAuditPublisher(fake.client, {
      ...config,
      report: "comment",
      commentOnClean: false,
    });
    await reviewOnly.publish({
      pr,
      report: {
        ...report,
        findings: [
          {
            fingerprint: "f",
            check: "functional",
            severity: "low",
            confidence: "high",
            title: "Title",
            description: "Description",
            evidence: "Evidence",
            file: "src/route.ts",
            line: 12,
          },
        ],
      },
      snapshot: {
        diff: [
          "diff --git a/src/route.ts b/src/route.ts",
          "--- a/src/route.ts",
          "+++ b/src/route.ts",
          "@@ -12 +12 @@",
          "-old();",
          "+new();",
        ].join("\n"),
      },
    });
    expect(fake.calls.checks).toHaveLength(1);
    expect(fake.calls.reviews).toHaveLength(2);
    expect(createGitHubClient("token")).toBeDefined();
  });

  test("keeps the GitHub Check summary within its output limit while preserving state", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      model: "gpt-5.6-terra",
      "auth-type": "api-key",
      "auth-token": "provider",
      "github-token": "github",
      report: "check",
    });
    const findings = Array.from({ length: 20 }, (_, index) => ({
      fingerprint: `finding-${index}`,
      check: "functional" as const,
      severity: "high" as const,
      confidence: "high" as const,
      title: `Finding ${index}`,
      description: "d".repeat(800),
      evidence: "e".repeat(800),
    }));
    const publisher = new GitHubAuditPublisher(fake.client, config);
    await publisher.publish({
      pr,
      report: { ...report, conclusion: "failure", findings },
      state: { ...state, findings },
    });

    const check = fake.calls.checks[0] as { output: { summary: string } };
    expect(check.output.summary.length).toBeLessThanOrEqual(65_000);
    expect(check.output.summary).toContain("_Report truncated by Heyo._");
    expect(decodeAuditState(check.output.summary)?.findings).toHaveLength(20);
  });

  test("publishes the report when its optional incremental state is too large", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      model: "gpt-5.6-terra",
      "auth-type": "api-key",
      "auth-token": "provider",
      "github-token": "github",
      report: "check",
    });
    const findings = Array.from({ length: 20 }, (_, index) => ({
      fingerprint: `finding-${index}`,
      check: "functional" as const,
      severity: "high" as const,
      confidence: "high" as const,
      title: `Finding ${index} ${"t".repeat(140)}`,
      description: "d".repeat(800),
      evidence: "e".repeat(800),
      file: `src/${"p".repeat(490)}.ts`,
      line: index + 1,
    }));
    const publisher = new GitHubAuditPublisher(fake.client, config);
    await publisher.publish({
      pr,
      report: { ...report, conclusion: "failure", findings },
      state: { ...state, findings },
    });

    const check = fake.calls.checks[0] as { output: { summary: string } };
    expect(check.output.summary).toContain("Finding 0");
    expect(check.output.summary.length).toBeLessThanOrEqual(65_000);
    expect(decodeAuditState(check.output.summary)).toBeUndefined();
  });
});
