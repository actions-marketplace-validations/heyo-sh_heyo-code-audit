import { describe, expect, test } from "bun:test";
import {
  AuditService,
  POLICY_VERSION,
  configHash,
  parseAuditConfig,
  type AuditConfig,
  type AuditPublisher,
  type AuditRepository,
  type AuditRuntime,
  type AuditState,
  type Finding,
  type PullRequestContext,
  type RepositorySnapshot,
  type RuntimeInput,
} from "../src/index.js";

const pr: PullRequestContext = {
  owner: "heyo",
  repo: "audit",
  number: 4,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  title: "Add account lookup",
  body: "",
};
const config = parseAuditConfig({ "api-key": "key", "github-token": "token" });
const candidate: Finding = {
  fingerprint: "candidate",
  check: "security",
  severity: "high",
  confidence: "high",
  title: "Authorization missing",
  description: "The route reads an account without a tenant check.",
  evidence: "src/route.ts:12",
  file: "src/route.ts",
  line: 12,
};

class FakeRepository implements AuditRepository {
  state?: AuditState;
  commits = 1;
  ancestor = true;
  current = true;
  snapshots: Array<{ base: string; head: string; paths: string[] }> = [];
  async getPullRequest() {
    return pr;
  }
  async getSnapshot(
    baseSha: string,
    headSha: string,
    paths: string[],
  ): Promise<RepositorySnapshot> {
    this.snapshots.push({ base: baseSha, head: headSha, paths });
    return {
      repositoryPath: "/repo",
      baseSha,
      headSha,
      diff: "diff",
      changedPaths: ["src/route.ts"],
      commits: [],
    };
  }
  async countCommits() {
    return this.commits;
  }
  async isAncestor() {
    return this.ancestor;
  }
  async findLatestState() {
    return this.state;
  }
  async isCurrentHead() {
    return this.current;
  }
}

class FakeRuntime implements AuditRuntime {
  discovered: Finding[] = [candidate];
  discoveryCalls = 0;
  verificationCalls = 0;
  async run(input: RuntimeInput) {
    if (input.phase === "discovery") {
      this.discoveryCalls += 1;
      return { findings: this.discovered };
    }
    this.verificationCalls += 1;
    return { verified: true as const, finding: candidate };
  }
}

class FakePublisher implements AuditPublisher {
  publications: Array<{ state?: AuditState; report: { conclusion: string } }> =
    [];
  async publish(input: { state?: AuditState; report: { conclusion: string } }) {
    this.publications.push(input);
  }
}

function service<TRuntime extends AuditRuntime = FakeRuntime>(
  repository = new FakeRepository(),
  runtime: TRuntime = new FakeRuntime() as unknown as TRuntime,
  publisher = new FakePublisher(),
) {
  return {
    repository,
    runtime,
    publisher,
    audit: new AuditService({ repository, runtime, publisher }),
  };
}

describe("audit pipeline", () => {
  test("runs a full audit, separately verifies candidates, and persists state", async () => {
    const setup = service();
    const outcome = await setup.audit.run(config);
    expect(outcome.kind).toBe("published");
    expect(setup.repository.snapshots).toEqual([
      { base: pr.baseSha, head: pr.headSha, paths: [] },
    ]);
    expect(setup.runtime.discoveryCalls).toBe(1);
    expect(setup.runtime.verificationCalls).toBe(1);
    expect(setup.publisher.publications[0]?.state?.policyVersion).toBe(
      POLICY_VERSION,
    );
  });

  test("uses a compatible state incrementally and re-verifies active findings", async () => {
    const repository = new FakeRepository();
    const older = { ...candidate, fingerprint: "old" };
    repository.state = {
      version: 1,
      baseSha: pr.baseSha,
      auditedHeadSha: "c".repeat(40),
      configHash: configHash(config),
      policyVersion: POLICY_VERSION,
      findings: [older],
    };
    const runtime = new FakeRuntime();
    const setup = service(repository, runtime);
    await setup.audit.run(config);
    expect(repository.snapshots[0]?.base).toBe("c".repeat(40));
    expect(runtime.verificationCalls).toBe(2);
    expect(setup.publisher.publications[0]?.state?.findings).toHaveLength(1);
  });

  test("falls back to a full audit when state is incompatible", async () => {
    const repository = new FakeRepository();
    repository.state = {
      version: 1,
      baseSha: pr.baseSha,
      auditedHeadSha: "c".repeat(40),
      configHash: "different",
      policyVersion: POLICY_VERSION,
      findings: [],
    };
    const setup = service(repository);
    await setup.audit.run(config);
    expect(repository.snapshots[0]?.base).toBe(pr.baseSha);
    repository.ancestor = false;
    repository.state = { ...repository.state, configHash: configHash(config) };
    await setup.audit.run(config);
    expect(repository.snapshots[1]?.base).toBe(pr.baseSha);
  });

  test("skips before invoking Pi when a commit limit is exceeded", async () => {
    const setup = service();
    setup.repository.commits = 101;
    const outcome = await setup.audit.run(config);
    expect(outcome.kind).toBe("skipped");
    expect(setup.runtime.discoveryCalls).toBe(0);
    expect(setup.publisher.publications[0]?.state).toBeUndefined();
    expect(setup.publisher.publications[0]?.report.conclusion).toBe("neutral");
  });

  test("does not publish stale heads and turns runtime failures neutral without state", async () => {
    const stale = service();
    stale.repository.current = false;
    expect((await stale.audit.run(config)).kind).toBe("stale");
    expect(stale.publisher.publications).toHaveLength(0);
    const brokenRuntime: AuditRuntime = {
      run: async () => {
        throw new Error("provider log with secret");
      },
    };
    const broken = service(new FakeRepository(), brokenRuntime);
    const outcome = await broken.audit.run(config);
    expect(outcome).toMatchObject({
      kind: "skipped",
      report: { conclusion: "neutral" },
    });
    expect(broken.publisher.publications[0]?.state).toBeUndefined();
  });

  test("honors disabled verification and full-only mode", async () => {
    const setup = service();
    const noVerification: AuditConfig = {
      ...config,
      verification: false,
      incremental: false,
      failOn: "never",
    };
    const outcome = await setup.audit.run(noVerification);
    expect(setup.runtime.verificationCalls).toBe(0);
    expect(outcome).toMatchObject({
      kind: "published",
      report: { conclusion: "success" },
    });
  });

  test("does not create incremental state when reporting has no Check", async () => {
    const setup = service();
    const outcome = await setup.audit.run({
      ...config,
      report: "comment",
      commentOnClean: true,
    });
    expect(outcome).toMatchObject({ kind: "published" });
    if (outcome.kind !== "published") throw new Error("Expected publication.");
    expect(outcome.state).toBeUndefined();
    expect(setup.publisher.publications[0]?.state).toBeUndefined();
  });
});
