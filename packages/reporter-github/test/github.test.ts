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
    createComment: [] as unknown[],
    updateComment: [] as unknown[],
  };
  const order: string[] = [];
  const functions = {
    listCommits: async () => [],
    listForRef: async () => [],
    listComments: async () => [],
  };
  let commitRows: unknown[] = [];
  let checks: unknown[] = [];
  let comments: unknown[] = [];
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
      },
      checks: {
        listForRef: functions.listForRef,
        create: async (input: unknown) => {
          order.push("check");
          calls.checks.push(input);
        },
      },
      issues: {
        listComments: functions.listComments,
        createComment: async (input: unknown) => {
          order.push("create-comment");
          calls.createComment.push(input);
        },
        updateComment: async (input: unknown) => {
          order.push("update-comment");
          calls.updateComment.push(input);
        },
      },
    },
    paginate: async (method: unknown) =>
      method === functions.listCommits
        ? commitRows
        : method === functions.listForRef
          ? checks
          : comments,
  };
  return {
    client: client as never,
    calls,
    order,
    setRows: (next: {
      commitRows?: unknown[];
      checks?: unknown[];
      comments?: unknown[];
    }) => {
      commitRows = next.commitRows ?? commitRows;
      checks = next.checks ?? checks;
      comments = next.comments ?? comments;
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

  test("publishes checks plus a single replaceable PR comment according to report settings", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      "api-key": "provider",
      "github-token": "github",
      "comment-on-clean": "true",
    });
    const publisher = new GitHubAuditPublisher(fake.client, config);
    await publisher.publish({ pr, report, state });
    expect(fake.calls.checks).toHaveLength(1);
    expect(fake.calls.createComment).toHaveLength(1);
    expect(fake.order).toEqual(["create-comment", "check"]);
    fake.setRows({
      comments: [
        {
          id: 44,
          user: { type: "Bot" },
          body: "<!-- heyo-code-audit-report -->\nold",
        },
      ],
    });
    await publisher.publish({ pr, report });
    expect(fake.calls.updateComment).toHaveLength(1);
    const commentOnly = new GitHubAuditPublisher(fake.client, {
      ...config,
      report: "comment",
      commentOnClean: false,
    });
    await commentOnly.publish({
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
          },
        ],
      },
    });
    expect(fake.calls.checks).toHaveLength(2);
    expect(fake.calls.updateComment).toHaveLength(2);
    expect(createGitHubClient("token")).toBeDefined();
  });

  test("keeps the GitHub Check summary within its output limit while preserving state", async () => {
    const fake = fakeClient();
    const config = parseAuditConfig({
      "api-key": "provider",
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
      "api-key": "provider",
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
