import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditService,
  parseAuditConfig,
  type AuditRepository,
  type AuditState,
  type RunOutcome,
} from "@heyo-sh/code-audit-core";
import {
  createAuditService,
  createSnapshotResolver,
  eventPayload,
  runAction,
  type ActionDependencies,
  type AuditContext,
  type PullRequestEvent,
} from "../src/action.js";

const temporary: string[] = [];
const inputs: Record<string, string> = {
  provider: "openai",
  model: "",
  "api-key": "provider-key",
  "github-token": "github-token",
  checks: "",
  verification: "true",
  report: "check",
  "comment-on-clean": "false",
  "fail-on": "high",
  paths: "",
  incremental: "true",
  "max-pr-commits": "100",
  "max-new-commits": "20",
};
const messages = {
  warnings: [] as string[],
  information: [] as string[],
  failures: [] as string[],
  outputs: new Map<string, string>(),
};
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const report = {
  version: 1 as const,
  conclusion: "success" as const,
  findings: [],
  summary: "Clean",
  metadata: {
    runtime: "pi" as const,
    provider: "openai",
    model: "gpt",
    baseSha,
    headSha,
    verification: true,
    scope: "full" as const,
  },
};
const state: AuditState = {
  version: 1,
  baseSha,
  auditedHeadSha: headSha,
  configHash: "c".repeat(64),
  policyVersion: "policy",
  findings: [],
};

let event: PullRequestEvent = {
  number: 7,
  pull_request: { head: { repo: { full_name: "heyo/audit" } } },
};
let nextOutcome: RunOutcome = { kind: "published", report, state };
let createdContext: AuditContext | undefined;

const dependencies: ActionDependencies = {
  core: {
    getInput: (name) => inputs[name] ?? "",
    warning: (message) => messages.warnings.push(message),
    info: (message) => messages.information.push(message),
    setOutput: (name, value) => messages.outputs.set(name, value),
    setFailed: (message) => messages.failures.push(message),
  },
  readEvent: async () => event,
  createAudit: (_config, context) => {
    createdContext = context;
    return { run: async () => nextOutcome };
  },
};

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  Object.assign(inputs, {
    provider: "openai",
    model: "",
    "api-key": "provider-key",
    "github-token": "github-token",
    checks: "",
    verification: "true",
    report: "check",
    "comment-on-clean": "false",
    "fail-on": "high",
    paths: "",
    incremental: "true",
    "max-pr-commits": "100",
    "max-new-commits": "20",
  });
  messages.warnings.splice(0);
  messages.information.splice(0);
  messages.failures.splice(0);
  messages.outputs.clear();
  event = {
    number: 7,
    pull_request: { head: { repo: { full_name: "heyo/audit" } } },
  };
  nextOutcome = { kind: "published", report, state };
  createdContext = undefined;
});

const environment = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: "/event.json",
  GITHUB_REPOSITORY: "heyo/audit",
  GITHUB_WORKSPACE: "/workspace",
};

describe("GitHub Action entry point", () => {
  test("reads event payloads and rejects unsupported or incomplete contexts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heyo-action-"));
    temporary.push(directory);
    const path = join(directory, "event.json");
    await writeFile(path, JSON.stringify(event));
    expect(await eventPayload(path)).toEqual(event);
    await expect(eventPayload(undefined)).rejects.toThrow("GITHUB_EVENT_PATH");
    await expect(
      runAction({ GITHUB_EVENT_NAME: "push" }, dependencies),
    ).rejects.toThrow("only supports pull_request");
    event = {};
    await expect(runAction(environment, dependencies)).rejects.toThrow(
      "context is incomplete",
    );
  });

  test("skips forks without a provider key before creating an audit", async () => {
    inputs["api-key"] = "";
    event = {
      number: 7,
      pull_request: { head: { repo: { full_name: "contributor/audit" } } },
    };
    await runAction(environment, dependencies);
    expect(messages.outputs.get("outcome")).toBe(
      "skipped-fork-without-api-key",
    );
    expect(messages.warnings[0]).toContain("fork pull request");
    expect(createdContext).toBeUndefined();

    event = { number: 7, pull_request: { head: { repo: null } } };
    await runAction(environment, dependencies);
    expect(messages.warnings.at(-1)).toContain("fork pull request");
  });

  test("maps normal published, skipped, and stale outcomes to action output", async () => {
    await runAction(environment, dependencies);
    expect(messages.outputs).toEqual(
      new Map([
        ["outcome", "published"],
        ["conclusion", "success"],
      ]),
    );
    expect(messages.information[0]).toContain("completed: success");
    expect(createdContext).toEqual({
      owner: "heyo",
      repo: "audit",
      prNumber: 7,
      workspace: "/workspace",
    });

    nextOutcome = {
      kind: "skipped",
      report: { ...report, conclusion: "neutral", summary: "Limited" },
    };
    await runAction(environment, dependencies);
    expect(messages.outputs.get("conclusion")).toBe("neutral");
    expect(messages.warnings.at(-1)).toBe("Limited");

    nextOutcome = { kind: "stale" };
    await runAction(environment, dependencies);
    expect(messages.outputs.get("outcome")).toBe("stale");
    expect(messages.warnings.at(-1)).toContain("head changed");
  });

  test("fails the job only for a published failure", async () => {
    nextOutcome = {
      kind: "published",
      report: { ...report, conclusion: "failure" },
      state,
    };
    await runAction(environment, dependencies);
    expect(messages.outputs.get("conclusion")).toBe("failure");
    expect(messages.failures[0]).toContain("verified findings");
  });
});

test("builds the production service and pins Pi snapshots to the workspace", async () => {
  const config = parseAuditConfig({
    "api-key": "provider-key",
    "github-token": "github-token",
  });
  expect(
    createAuditService(config, {
      owner: "heyo",
      repo: "audit",
      prNumber: 7,
      workspace: undefined,
    }),
  ).toBeInstanceOf(AuditService);

  let snapshotRequest: string[] | undefined;
  const repository = {
    getSnapshot: async (
      requestedBase: string,
      requestedHead: string,
      paths: string[],
    ) => {
      snapshotRequest = [requestedBase, requestedHead, ...paths];
      return {
        repositoryPath: "/workspace",
        baseSha: requestedBase,
        headSha: requestedHead,
        diff: "",
        changedPaths: [],
        commits: [],
      };
    },
  } as unknown as AuditRepository;
  const resolver = createSnapshotResolver(repository, ["src/**"], "/workspace");
  await resolver.resolve("/workspace", baseSha, headSha);
  expect(snapshotRequest).toEqual([baseSha, headSha, "src/**"]);
  await expect(resolver.resolve("/other", baseSha, headSha)).rejects.toThrow(
    "did not match",
  );
});
