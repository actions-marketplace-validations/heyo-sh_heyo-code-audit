import { configHash } from "./config.js";
import {
  POLICY_VERSION,
  discoveryPrompt,
  verificationPrompt,
} from "./prompts.js";
import { createReport, neutralReport } from "./report.js";
import { deduplicateFindings } from "./schema.js";
import type {
  AuditConfig,
  AuditPublisher,
  AuditRepository,
  AuditRuntime,
  AuditScope,
  AuditState,
  Finding,
  PullRequestContext,
  RunOutcome,
  RuntimeInput,
} from "./types.js";

const DEFAULT_LIMITS = {
  maxTurns: 12,
  maxToolCalls: 40,
  maxTokens: 8_000,
  maxFileBytes: 100_000,
  maxSearchResults: 100,
  maxDiffBytes: 160_000,
  maxOutputBytes: 80_000,
  timeoutMs: 15 * 60_000,
} as const;

export class AuditService {
  constructor(
    private readonly dependencies: {
      repository: AuditRepository;
      runtime: AuditRuntime;
      publisher: AuditPublisher;
    },
  ) {}

  async run(config: AuditConfig): Promise<RunOutcome> {
    const pr = await this.dependencies.repository.getPullRequest();
    const configDigest = configHash(config);
    let scope: AuditScope = "full";
    try {
      const previous = await this.dependencies.repository.findLatestState(pr);
      const decision = await this.selectScope(
        config,
        configDigest,
        pr,
        previous,
      );
      scope = decision.scope;
      const limit =
        scope === "full" ? config.maxPrCommits : config.maxNewCommits;
      const commitCount = await this.dependencies.repository.countCommits(
        decision.fromSha,
        pr.headSha,
      );
      if (limit !== "unlimited" && commitCount > limit) {
        const label = scope === "full" ? "max-pr-commits" : "max-new-commits";
        return this.publishWithoutState(
          pr,
          neutralReport({
            config,
            pr,
            scope,
            summary: `Heyo skipped this ${scope} audit: ${commitCount} commits exceed ${label}=${limit}.`,
          }),
        );
      }

      const snapshot = await this.dependencies.repository.getSnapshot(
        decision.fromSha,
        pr.headSha,
        config.paths,
      );
      const discovery = await this.dependencies.runtime.run(
        this.runtimeInput(
          config,
          snapshot,
          "discovery",
          discoveryPrompt({
            checks: config.checks,
            snapshot,
            prTitle: pr.title,
            prBody: pr.body,
            scope,
          }),
        ),
      );
      if (!("findings" in discovery)) {
        throw new Error("Discovery runtime returned a verification result.");
      }
      const candidates = config.verification
        ? deduplicateFindings([
            ...discovery.findings,
            ...(decision.previous?.findings ?? []),
          ])
        : discovery.findings;
      const findings = config.verification
        ? await this.verify(config, snapshot, candidates)
        : candidates;
      const report = createReport({
        config,
        pr,
        scope,
        ...(decision.previous
          ? { previousHeadSha: decision.previous.auditedHeadSha }
          : {}),
        findings,
      });
      const state = this.stateFor(config, configDigest, pr, report.findings);
      if (!(await this.dependencies.repository.isCurrentHead(pr, pr.headSha)))
        return { kind: "stale" };
      await this.dependencies.publisher.publish({
        pr,
        report,
        ...(state ? { state } : {}),
      });
      return { kind: "published", report, ...(state ? { state } : {}) };
    } catch {
      const report = neutralReport({
        config,
        pr,
        scope,
        summary:
          "Heyo could not complete this audit reliably. No audit state was advanced.",
      });
      return this.publishWithoutState(pr, report);
    }
  }

  private async selectScope(
    config: AuditConfig,
    configDigest: string,
    pr: PullRequestContext,
    previous: AuditState | undefined,
  ): Promise<{ scope: AuditScope; fromSha: string; previous?: AuditState }> {
    if (
      !config.incremental ||
      !previous ||
      previous.baseSha !== pr.baseSha ||
      previous.configHash !== configDigest ||
      previous.policyVersion !== POLICY_VERSION
    ) {
      return { scope: "full", fromSha: pr.baseSha };
    }
    if (
      !(await this.dependencies.repository.isAncestor(
        previous.auditedHeadSha,
        pr.headSha,
      ))
    )
      return { scope: "full", fromSha: pr.baseSha };
    return { scope: "incremental", fromSha: previous.auditedHeadSha, previous };
  }

  private stateFor(
    config: AuditConfig,
    configDigest: string,
    pr: PullRequestContext,
    findings: Finding[],
  ): AuditState | undefined {
    if (config.report !== "check" && config.report !== "check-and-comment")
      return undefined;
    return {
      version: 1,
      baseSha: pr.baseSha,
      auditedHeadSha: pr.headSha,
      configHash: configDigest,
      policyVersion: POLICY_VERSION,
      findings,
    };
  }

  private async verify(
    config: AuditConfig,
    snapshot: Awaited<ReturnType<AuditRepository["getSnapshot"]>>,
    candidates: Finding[],
  ): Promise<Finding[]> {
    const verified: Finding[] = [];
    for (const candidate of candidates) {
      const result = await this.dependencies.runtime.run(
        this.runtimeInput(
          config,
          snapshot,
          "verification",
          verificationPrompt({ candidate, snapshot, checks: config.checks }),
        ),
      );
      if (!("verified" in result)) {
        throw new Error("Verification runtime returned a discovery result.");
      }
      if (result.verified && result.finding) verified.push(result.finding);
    }
    return deduplicateFindings(verified);
  }

  private runtimeInput(
    config: AuditConfig,
    snapshot: Awaited<ReturnType<AuditRepository["getSnapshot"]>>,
    phase: RuntimeInput["phase"],
    internalPrompt: string,
  ): RuntimeInput {
    return {
      repositoryPath: snapshot.repositoryPath,
      baseSha: snapshot.baseSha,
      headSha: snapshot.headSha,
      phase,
      checks: config.checks,
      provider: config.provider,
      model: config.model,
      auth: config.auth,
      internalPrompt,
      permissions: "read-only",
      limits: DEFAULT_LIMITS,
    };
  }

  private async publishWithoutState(
    pr: PullRequestContext,
    report: ReturnType<typeof neutralReport>,
  ): Promise<RunOutcome> {
    if (!(await this.dependencies.repository.isCurrentHead(pr, pr.headSha)))
      return { kind: "stale" };
    await this.dependencies.publisher.publish({ pr, report });
    return { kind: "skipped", report };
  }
}
