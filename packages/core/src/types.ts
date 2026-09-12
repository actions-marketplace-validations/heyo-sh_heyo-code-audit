export const CHECK_IDS = [
  "security",
  "regression",
  "product-gap",
  "functional",
  "nonfunctional",
] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const CONFIDENCES = ["medium", "high"] as const;
export const CONCLUSIONS = ["success", "neutral", "failure"] as const;

export type CheckId = (typeof CHECK_IDS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Conclusion = (typeof CONCLUSIONS)[number];
export type ProviderId = string;
export type AuditScope = "full" | "incremental";
export type ReportMode = "check" | "comment" | "check-and-comment" | "none";
export type CommitLimit = number | "unlimited";

export interface Finding {
  fingerprint: string;
  check: CheckId;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  evidence: string;
  file?: string;
  line?: number;
}

export interface AuditState {
  version: 1;
  baseSha: string;
  auditedHeadSha: string;
  configHash: string;
  policyVersion: string;
  findings: Finding[];
}

export interface AuditReport {
  version: 1;
  conclusion: Conclusion;
  findings: Finding[];
  summary: string;
  metadata: {
    runtime: "pi";
    provider: string;
    model: string;
    baseSha: string;
    headSha: string;
    verification: boolean;
    scope: AuditScope;
    previousHeadSha?: string;
  };
}

export interface AuditConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  githubToken: string;
  checks: CheckId[];
  verification: boolean;
  report: ReportMode;
  commentOnClean: boolean;
  failOn: Severity | "never";
  paths: string[];
  incremental: boolean;
  maxPrCommits: CommitLimit;
  maxNewCommits: CommitLimit;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
}

export interface CommitMetadata {
  sha: string;
  message: string;
}

export interface RepositorySnapshot {
  repositoryPath: string;
  baseSha: string;
  headSha: string;
  diff: string;
  changedPaths: string[];
  commits: CommitMetadata[];
}

export interface RuntimeLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxTokens: number;
  maxFileBytes: number;
  maxSearchResults: number;
  maxDiffBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface RuntimeInput {
  repositoryPath: string;
  baseSha: string;
  headSha: string;
  phase: "discovery" | "verification";
  checks: CheckId[];
  provider: ProviderId;
  model: string;
  apiKey: string;
  internalPrompt: string;
  permissions: "read-only";
  limits: RuntimeLimits;
}

export interface DiscoveryResult {
  findings: Finding[];
}

export interface VerificationResult {
  verified: boolean;
  finding?: Finding;
  reason?: string;
}

export type AuditPhaseResult = DiscoveryResult | VerificationResult;

export interface AuditRuntime {
  run(input: RuntimeInput): Promise<AuditPhaseResult>;
}

export interface AuditRepository {
  getPullRequest(): Promise<PullRequestContext>;
  getSnapshot(
    baseSha: string,
    headSha: string,
    paths: string[],
  ): Promise<RepositorySnapshot>;
  countCommits(baseSha: string, headSha: string): Promise<number>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  findLatestState(pr: PullRequestContext): Promise<AuditState | undefined>;
  isCurrentHead(pr: PullRequestContext, headSha: string): Promise<boolean>;
}

export interface AuditPublisher {
  publish(input: {
    pr: PullRequestContext;
    report: AuditReport;
    state?: AuditState;
  }): Promise<void>;
}

export type RunOutcome =
  | { kind: "published"; report: AuditReport; state?: AuditState }
  | { kind: "stale" }
  | { kind: "skipped"; report: AuditReport };
