import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import type {
  AuditConfig,
  AuditPublisher,
  AuditReport,
  AuditRepository,
  AuditState,
  CommitMetadata,
  PullRequestContext,
  RepositorySnapshot,
} from "@heyo-sh/code-audit-core";
import { decodeAuditState, encodeAuditState } from "./state.js";
import {
  findingMarker,
  formatCheckAnnotation,
  formatCleanReview,
  formatInlineComment,
  formatSummary,
} from "./format.js";

const execFileAsync = promisify(execFile);
const CHECK_NAME = "Heyo Code Audit";
const MAX_DIFF_BYTES = 160_000;
const MAX_CHECK_SUMMARY_CHARS = 65_000;

export interface GitHubEnvironment {
  owner: string;
  repo: string;
  prNumber: number;
  repositoryPath: string;
}

export class GitHubAuditRepository implements AuditRepository {
  constructor(
    private readonly client: Octokit,
    private readonly environment: GitHubEnvironment,
  ) {}

  async getPullRequest(): Promise<PullRequestContext> {
    const { data } = await this.client.rest.pulls.get({
      owner: this.environment.owner,
      repo: this.environment.repo,
      pull_number: this.environment.prNumber,
    });
    return {
      owner: this.environment.owner,
      repo: this.environment.repo,
      number: this.environment.prNumber,
      baseSha: data.base.sha,
      headSha: data.head.sha,
      title: data.title,
      body: data.body ?? "",
    };
  }

  async getSnapshot(
    baseSha: string,
    headSha: string,
    paths: string[],
  ): Promise<RepositorySnapshot> {
    assertSha(baseSha);
    assertSha(headSha);
    const changedPaths = (
      await git(this.environment.repositoryPath, [
        "diff",
        "--name-only",
        "--no-ext-diff",
        `${baseSha}..${headSha}`,
      ])
    ).stdout
      .split("\n")
      .filter(Boolean)
      .filter((path) => matchesAny(path, paths));
    const pathArgs = paths.length ? ["--", ...paths] : [];
    const diff = await boundedGitDiff(
      this.environment.repositoryPath,
      [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=80",
        `${baseSha}..${headSha}`,
        ...pathArgs,
      ],
      MAX_DIFF_BYTES,
    );
    const commits = parseCommits(
      (
        await git(this.environment.repositoryPath, [
          "log",
          "--format=%H%x00%s",
          `${baseSha}..${headSha}`,
        ])
      ).stdout,
    );
    return {
      repositoryPath: this.environment.repositoryPath,
      baseSha,
      headSha,
      diff,
      changedPaths,
      commits,
    };
  }

  async countCommits(baseSha: string, headSha: string): Promise<number> {
    assertSha(baseSha);
    assertSha(headSha);
    const value = Number(
      (
        await git(this.environment.repositoryPath, [
          "rev-list",
          "--count",
          `${baseSha}..${headSha}`,
        ])
      ).stdout.trim(),
    );
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Git returned an invalid commit count.");
    return value;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertSha(ancestor);
    assertSha(descendant);
    try {
      await git(this.environment.repositoryPath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      return true;
    } catch (error) {
      if (exitCode(error) === 1) return false;
      throw error;
    }
  }

  async findLatestState(
    pr: PullRequestContext,
  ): Promise<AuditState | undefined> {
    const commits = await this.client.paginate(
      this.client.rest.pulls.listCommits,
      { owner: pr.owner, repo: pr.repo, pull_number: pr.number, per_page: 100 },
    );
    for (const commit of [...commits].reverse()) {
      const checkRuns = await this.client.paginate(
        this.client.rest.checks.listForRef,
        {
          owner: pr.owner,
          repo: pr.repo,
          ref: commit.sha,
          check_name: CHECK_NAME,
          per_page: 100,
        },
      );
      for (const check of checkRuns) {
        if (
          check.status !== "completed" ||
          (check.conclusion !== "success" && check.conclusion !== "failure")
        )
          continue;
        const state = decodeAuditState(check.output?.summary ?? undefined);
        if (state && state.auditedHeadSha === commit.sha) return state;
      }
    }
    return undefined;
  }

  async isCurrentHead(
    pr: PullRequestContext,
    headSha: string,
  ): Promise<boolean> {
    return (await this.getPullRequest()).headSha === headSha;
  }
}

export class GitHubAuditPublisher implements AuditPublisher {
  constructor(
    private readonly client: Octokit,
    private readonly config: AuditConfig,
  ) {}

  async publish(input: {
    pr: PullRequestContext;
    report: AuditReport;
    state?: AuditState;
    snapshot?: Pick<RepositorySnapshot, "diff">;
  }): Promise<void> {
    const writesCheck =
      this.config.report === "check" ||
      this.config.report === "check-and-comment";
    const reportsReview =
      this.config.report === "comment" ||
      this.config.report === "check-and-comment";
    const changedLineFindings = input.snapshot
      ? findingsOnChangedLines(input.report.findings, input.snapshot.diff)
      : [];
    if (writesCheck) {
      const summary = checkSummary(input.report, input.state);
      await this.client.rest.checks.create({
        owner: input.pr.owner,
        repo: input.pr.repo,
        name: CHECK_NAME,
        head_sha: input.pr.headSha,
        status: "completed",
        conclusion: input.report.conclusion,
        output: {
          title: `Heyo Code Audit: ${input.report.conclusion}`,
          summary,
          ...(changedLineFindings.length
            ? {
                annotations: changedLineFindings.map(formatCheckAnnotation),
              }
            : {}),
        },
      });
    }
    if (reportsReview && changedLineFindings.length)
      await this.publishReview(input.pr, changedLineFindings);
    else if (
      reportsReview &&
      this.config.commentOnClean &&
      input.report.findings.length === 0
    )
      await this.publishCleanReview(input.pr, input.report);
  }

  private async publishReview(
    pr: PullRequestContext,
    findings: LocatedFinding[],
  ): Promise<void> {
    const existing = await this.client.paginate(
      this.client.rest.pulls.listReviewComments,
      {
        owner: pr.owner,
        repo: pr.repo,
        pull_number: pr.number,
        per_page: 100,
      },
    );
    const published = existing
      .filter(
        (comment) =>
          comment.user?.type === "Bot" && comment.commit_id === pr.headSha,
      )
      .map((comment) => comment.body ?? "");
    const fresh = findings.filter(
      (finding) =>
        !published.some((body) => body.includes(findingMarker(finding))),
    );
    if (!fresh.length) return;
    await this.client.rest.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      commit_id: pr.headSha,
      event: "COMMENT",
      comments: fresh.map((finding) => ({
        path: finding.file,
        line: finding.line,
        side: "RIGHT",
        body: formatInlineComment(finding),
      })),
    });
  }

  private async publishCleanReview(
    pr: PullRequestContext,
    report: AuditReport,
  ): Promise<void> {
    await this.client.rest.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      commit_id: pr.headSha,
      event: "COMMENT",
      body: formatCleanReview(report),
    });
  }
}

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "heyo-code-audit" });
}

function assertSha(value: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(value))
    throw new Error("Invalid git SHA supplied by GitHub.");
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = 1_000_000,
): Promise<{ stdout: string }> {
  return execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer,
    env: { PATH: process.env.PATH ?? "" },
  });
}

async function boundedGitDiff(
  cwd: string,
  args: string[],
  maximum: number,
): Promise<string> {
  const marker = "\n[Diff truncated by Heyo]";
  const capacity = Math.max(0, maximum - Buffer.byteLength(marker));
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = capacity - bytes;
      if (remaining > 0)
        chunks.push(chunk.subarray(0, Math.min(chunk.length, remaining)));
      bytes += Math.min(chunk.length, Math.max(0, remaining));
      if (chunk.length > remaining) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.resume();
    void once(child, "close").then(([code]) => {
      if (truncated)
        return resolve(Buffer.concat(chunks).toString("utf8") + marker);
      if (code === 0) return resolve(Buffer.concat(chunks).toString("utf8"));
      return reject(new Error("Git diff failed."));
    }, reject);
  });
}

function parseCommits(output: string): CommitMetadata[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, message = ""] = line.split("\0", 2);
      if (!sha) throw new Error("Git returned malformed commit metadata.");
      return { sha, message };
    });
}

function matchesAny(path: string, patterns: string[]): boolean {
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => glob(pattern).test(path))
  );
}

function checkSummary(
  report: AuditReport,
  state: AuditState | undefined,
): string {
  const marker = state ? optionalStateMarker(state) : "";
  const separator = marker ? "\n\n" : "";
  return `${truncate(formatSummary(report), MAX_CHECK_SUMMARY_CHARS - marker.length - separator.length)}${separator}${marker}`;
}

function optionalStateMarker(state: AuditState): string {
  try {
    return encodeAuditState(state);
  } catch {
    return "";
  }
}

function truncate(value: string, maximum: number): string {
  const marker = "\n\n_Report truncated by Heyo._";
  if (value.length <= maximum) return value;
  return value.slice(0, Math.max(0, maximum - marker.length)) + marker;
}

type LocatedFinding = AuditReport["findings"][number] & {
  file: string;
  line: number;
};

function findingsOnChangedLines(
  findings: AuditReport["findings"],
  diff: string,
): LocatedFinding[] {
  const locations = reviewableLocations(diff);
  return findings.filter(
    (finding): finding is LocatedFinding =>
      typeof finding.file === "string" &&
      typeof finding.line === "number" &&
      locations.has(locationKey(finding.file, finding.line)),
  );
}

/** Changed right-side lines are the only locations accepted by PR review APIs. */
export function reviewableLocations(diff: string): Set<string> {
  const locations = new Set<string>();
  let file: string | undefined;
  let headLine = 0;
  let inHunk = false;
  for (const diffLine of diff.split("\n")) {
    if (diffLine.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
      continue;
    }
    if (diffLine.startsWith("+++ ")) {
      file = headPath(diffLine);
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(diffLine);
    if (hunk?.[1]) {
      headLine = Number(hunk[1]);
      inHunk = Boolean(file);
      continue;
    }
    if (!file || !inHunk || diffLine.startsWith("\\")) continue;
    if (diffLine.startsWith("+")) {
      locations.add(locationKey(file, headLine));
      headLine += 1;
    } else if (diffLine.startsWith(" ")) {
      headLine += 1;
    }
  }
  return locations;
}

function headPath(diffLine: string): string | undefined {
  const prefix = "+++ b/";
  if (!diffLine.startsWith(prefix)) return undefined;
  const path = diffLine.slice(prefix.length);
  return path && path !== "/dev/null" ? path : undefined;
}

function locationKey(file: string, line: number): string {
  return `${file}\u0000${line}`;
}

function glob(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (!character) continue;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`^${expression}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exitCode(error: unknown): number | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}
