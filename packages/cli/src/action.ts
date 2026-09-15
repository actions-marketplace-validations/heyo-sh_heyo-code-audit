import { readFile } from "node:fs/promises";
import * as core from "@actions/core";
import {
  AuditService,
  parseAuditConfig,
  type AuditConfig,
  type AuditRepository,
  type RunOutcome,
} from "@heyo-sh/code-audit-core";
import {
  createGitHubClient,
  GitHubAuditPublisher,
  GitHubAuditRepository,
} from "@heyo-sh/code-audit-reporter-github";
import {
  PiAuditRuntime,
  type SnapshotResolver,
} from "@heyo-sh/code-audit-runtime-pi";

export interface PullRequestEvent {
  number?: number;
  pull_request?: { head?: { repo?: { full_name?: string | null } | null } };
}

interface ActionCore {
  getInput(name: string): string;
  warning(message: string): void;
  info(message: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
}

interface AuditRunner {
  run(config: AuditConfig): Promise<RunOutcome>;
}

export interface ActionDependencies {
  core: ActionCore;
  readEvent(path: string | undefined): Promise<PullRequestEvent>;
  createAudit(config: AuditConfig, context: AuditContext): AuditRunner;
}

export interface AuditContext {
  owner: string;
  repo: string;
  prNumber: number;
  workspace: string | undefined;
}

const DEFAULT_DEPENDENCIES: ActionDependencies = {
  core,
  readEvent: eventPayload,
  createAudit: createAuditService,
};

export async function runAction(
  environment = process.env,
  dependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (environment.GITHUB_EVENT_NAME !== "pull_request")
    throw new Error("Heyo Code Audit only supports pull_request events.");
  const event = await dependencies.readEvent(environment.GITHUB_EVENT_PATH);
  const [owner, repo] = (environment.GITHUB_REPOSITORY ?? "").split("/", 2);
  if (!owner || !repo || !event.number)
    throw new Error("GitHub pull request context is incomplete.");
  const authType = dependencies.core.getInput("auth-type");
  const authToken = dependencies.core.getInput("auth-token");
  const isFork =
    event.pull_request?.head?.repo?.full_name !== `${owner}/${repo}`;
  if (isFork && authType !== "aws" && !authToken.trim()) {
    dependencies.core.warning(
      "Heyo Code Audit skipped this fork pull request because no provider authentication token is available.",
    );
    dependencies.core.setOutput("outcome", "skipped-fork-without-auth-token");
    return;
  }
  const config = parseAuditConfig({
    provider: dependencies.core.getInput("provider"),
    model: dependencies.core.getInput("model"),
    "auth-type": authType,
    "auth-token": authToken,
    "aws-region": dependencies.core.getInput("aws-region"),
    "aws-profile": dependencies.core.getInput("aws-profile"),
    "github-token": dependencies.core.getInput("github-token"),
    checks: dependencies.core.getInput("checks"),
    verification: dependencies.core.getInput("verification"),
    report: dependencies.core.getInput("report"),
    "comment-on-clean": dependencies.core.getInput("comment-on-clean"),
    "fail-on": dependencies.core.getInput("fail-on"),
    paths: dependencies.core.getInput("paths"),
    incremental: dependencies.core.getInput("incremental"),
    "max-pr-commits": dependencies.core.getInput("max-pr-commits"),
    "max-new-commits": dependencies.core.getInput("max-new-commits"),
  });
  const audit = dependencies.createAudit(config, {
    owner,
    repo,
    prNumber: event.number,
    workspace: environment.GITHUB_WORKSPACE,
  });
  const outcome = await audit.run(config);
  dependencies.core.setOutput("outcome", outcome.kind);
  if (outcome.kind === "published") {
    dependencies.core.setOutput("conclusion", outcome.report.conclusion);
    dependencies.core.info(
      `Heyo Code Audit completed: ${outcome.report.conclusion}.`,
    );
    if (outcome.report.conclusion === "failure")
      dependencies.core.setFailed(
        "Heyo Code Audit found verified findings at or above fail-on.",
      );
  } else if (outcome.kind === "skipped") {
    dependencies.core.setOutput("conclusion", "neutral");
    dependencies.core.warning(outcome.report.summary);
  } else {
    dependencies.core.warning(
      "Heyo Code Audit did not publish because the pull request head changed during the run.",
    );
  }
}

export function createAuditService(
  config: AuditConfig,
  context: AuditContext,
): AuditService {
  const client = createGitHubClient(config.githubToken);
  const repository = new GitHubAuditRepository(client, {
    owner: context.owner,
    repo: context.repo,
    prNumber: context.prNumber,
    repositoryPath: context.workspace ?? process.cwd(),
  });
  return new AuditService({
    repository,
    runtime: new PiAuditRuntime(
      createSnapshotResolver(repository, config.paths, context.workspace),
    ),
    publisher: new GitHubAuditPublisher(client, config),
  });
}

export function createSnapshotResolver(
  repository: AuditRepository,
  paths: string[],
  workspace: string | undefined,
): SnapshotResolver {
  return {
    async resolve(repositoryPath, baseSha, headSha) {
      if (workspace && repositoryPath !== workspace)
        throw new Error(
          "Pi runtime repository path did not match the checked-out workspace.",
        );
      return repository.getSnapshot(baseSha, headSha, paths);
    },
  };
}

export async function eventPayload(
  path: string | undefined,
): Promise<PullRequestEvent> {
  if (!path) throw new Error("GITHUB_EVENT_PATH is required.");
  return JSON.parse(await readFile(path, "utf8")) as PullRequestEvent;
}
