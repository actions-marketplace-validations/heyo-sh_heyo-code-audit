<div align="center">
  <h1>Heyo Code Audit</h1>
  <p>Provider-agnostic, verified AI code auditing for GitHub pull requests.</p>
  <p>
    <a href="https://github.com/heyo-sh/heyo-code-audit/releases"><img src="https://img.shields.io/github/v/release/heyo-sh/heyo-code-audit?display_name=tag&sort=semver&style=flat&colorA=000000&colorB=000000" alt="GitHub release"/></a>
    <a href="https://github.com/heyo-sh/heyo-code-audit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heyo-sh/heyo-code-audit/ci.yml?branch=main&style=flat&label=checks&colorA=000000&colorB=000000" alt="checks"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat&colorA=000000&colorB=000000" alt="MIT License"/></a>
  </p>
  <p>
    <a href="#quick-start">Quick start</a>
    ·
    <a href="#behavior-and-safety">Safety</a>
    ·
    <a href="#releases">Releases</a>
    ·
    <a href="CONTRIBUTING.md">Contributing</a>
  </p>
</div>

Heyo reads
the PR diff and repository context, discovers candidate issues, verifies each
candidate in a separate Pi session, and publishes a GitHub Check and/or a PR
review according to the selected reporting mode. Findings on changed lines are
attached to the GitHub Check as annotations and, when reviews are enabled, are
also published as inline PR review comments. When the verifier can prove an
exact replacement for the selected diff line, the review comment includes
GitHub's **Apply suggestion** control.

## Quick start

```yaml
name: Heyo Code Audit

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: heyo-code-audit-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: heyo-sh/heyo-code-audit@v1
        with:
          provider: openai
          model: gpt-5.6-terra
          auth-type: api-key
          auth-token: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ github.token }}
```

Reports use the identity behind `github-token`. With the default
`${{ github.token }}`, the Check and review comments are authored by
`github-actions[bot]`.

## Providers and checks

Heyo accepts every provider and model bundled with the installed Pi version;
there is no Heyo-specific provider allowlist. Authentication is explicit and
validated against the selected provider.

| Provider                             | `auth-type`      | Required inputs                      |
| ------------------------------------ | ---------------- | ------------------------------------ |
| API-key Pi provider                  | `api-key`        | `auth-token`                         |
| GitHub Copilot or OpenAI Codex       | `oauth`          | `auth-token`                         |
| Amazon Bedrock with AWS credentials  | `aws`            | Optional `aws-region`, `aws-profile` |
| Amazon Bedrock bearer authentication | `bedrock-bearer` | `auth-token`, optional `aws-region`  |

### API key

Use the default API-key mode for providers that Pi authenticates with one
provider token:

```yaml
with:
  provider: openai
  model: gpt-5.6-terra
  auth-type: api-key
  auth-token: ${{ secrets.OPENAI_API_KEY }}
```

### OAuth

GitHub Copilot and OpenAI Codex require `auth-type: oauth`. The workflow must
supply an access token that remains valid for the whole audit. The Action cannot
run a provider OAuth flow or refresh tokens.

### Amazon Bedrock

Configure AWS credentials on the runner before this Action, then select the AWS
credential chain:

```yaml
with:
  provider: amazon-bedrock
  model: amazon.nova-lite-v1:0
  auth-type: aws
  aws-region: eu-central-1
```

Use `auth-type: bedrock-bearer` with `auth-token` when you use Amazon Bedrock's
bearer authentication instead. Bedrock runs in the Node.js Action runtime.

`checks` accepts a comma-separated subset of `security`, `regression`,
`functional`, and `nonfunctional`. Omit `checks` or pass an empty value to
enable all four checks. Malformed provider and unknown check
identifiers fail configuration validation before the audit starts. Pi rejects a
provider that is not in its bundled catalog.

| Input                                | Default                     |
| ------------------------------------ | --------------------------- |
| `provider`                           | `openai`                    |
| `model`                              | Required; no model fallback |
| `auth-type`, `github-token`          | Required                    |
| `auth-token`                         | Required except `aws`       |
| `aws-region` / `aws-profile`         | Optional; Bedrock only      |
| `checks`                             | All four checks             |
| `verification`                       | `true`                      |
| `report`                             | `check-and-comment`         |
| `comment-on-clean`                   | `false`                     |
| `fail-on`                            | `high`                      |
| `paths`                              | Entire repository           |
| `incremental`                        | `true`                      |
| `max-pr-commits` / `max-new-commits` | `100` / `20`                |

Use `unlimited` only for either commit limit when the associated repository
policy permits it. `report: comment` and `report: none` intentionally produce
no GitHub Check, so they do not retain incremental state.

`model`, `auth-type`, and `github-token` must all be non-empty for a normal
audit run. `auth-token` is required for every mode except `aws`. Heyo never
chooses a provider catalog model on your behalf; the configured model identifier
is passed through to Pi and recorded verbatim in the report.

## Behavior and safety

The released action owns its policy, prompts, response schemas, verification
rules, and Pi integration. There is no configuration file and no input for a
prompt, command, provider URL, extension, skill, schema, or tool permission.

Pi receives only Heyo-owned tools: bounded file reads and search, PR diff and
structure inspection, and, during verification, a fixed `git diff --check`
command. It cannot load `AGENTS.md`, `SYSTEM.md`, Pi extensions, repository
skills, or an unrestricted shell. Repository content is handled as untrusted
data; sensitive-looking values are redacted from model-visible tool output and
published reports. Path checks are applied again after symlinks resolve, so a
permitted-looking link cannot expose a blocked file. Authentication is supplied
only to Pi's provider resolver or, for Bedrock, its Node.js stream options.

The collected PR diff is bounded to 160 kB. An oversized diff is truncated and
marked as such instead of causing the audit to fail before it reaches Pi.

The action uses `pull_request`, never `pull_request_target`. A fork without the
needed `auth-token` is skipped without attempting an audit. An AWS-authenticated
fork can run only when the runner already has the intended AWS credential chain.

On later pushes Heyo finds the latest compatible machine state embedded in its
completed Check. It audits only the delta, then re-verifies all active prior
findings and deduplicates the result. A base change, non-ancestor head,
configuration or policy change, invalid state, disabled incremental mode, or an
unreliable prior run causes a full audit. Commit limits are checked before Pi is
created; a limit breach publishes `neutral` and never advances audit state.
If a complete state would exceed GitHub's Check-output limit, Heyo still
publishes the report without that state; a later run uses an earlier compatible
checkpoint or performs a full audit.

Immediately before writing, Heyo re-reads the pull request head. A stale run
publishes neither a Check, comment, nor state. In `check` and
`check-and-comment` modes, verified findings whose `file` and `line` point to
an added or modified PR line become annotations on the **Heyo Code Audit**
Check. In `comment` and `check-and-comment` modes, those same findings are also
published directly on the line as PR review comments. Heyo groups all newly
published inline findings into one `COMMENTED` review, like GitHub Advanced
Security; it does not create a standalone comment in the PR Conversation.
Thus the default `check-and-comment` mode provides both the
Advanced-Security-style Check annotation and a review thread. An inline comment
has an **Apply suggestion** button only when Heyo has verified an exact
replacement for the selected diff line; otherwise it contains the finding
without an unsafe guessed patch. With `comment-on-clean: true`, Heyo submits a
clean review when no findings are verified. Existing Heyo bot review comments
with the same finding fingerprint are not duplicated when the action reruns on
the same PR head.

## Development

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:coverage
bun run build
```

`dist/action.js` is the committed, self-contained JavaScript action used by
GitHub. CI requires it to be tracked, rebuilds it, and fails if the committed
bundle differs. The repository
also includes CodeQL, Dependabot, Changesets-driven release automation, and
concurrency-safe CI adapted from the Heyo documentation project.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for local
setup, validation, and release-artifact expectations.

## Support and security

Use [GitHub Discussions](https://github.com/heyo-sh/heyo-code-audit/discussions)
for questions and implementation help. Report suspected vulnerabilities only
through the private process in [SECURITY.md](SECURITY.md); never include tokens
or repository secrets in a public issue, workflow log, or discussion.

## Releases

The action is released as one unit through `@heyo-sh/heyo-code-audit`, even
though its implementation uses internal workspaces. Create a Changeset for each
consumer-visible change:

```sh
bun run changeset
```

Select `@heyo-sh/heyo-code-audit` and an appropriate SemVer bump. When that PR
reaches `main`, automation creates or updates a version PR. Merging the version
PR creates an immutable `vX.Y.Z` tag and GitHub Release, then moves the matching
stable major tag such as `v1`. Pre-releases do not move a stable major tag.

Before enabling this workflow in GitHub, allow Actions to create pull requests
in **Settings → Actions → General**. If tag protection is enabled, allow the
release workflow to create immutable version tags and move the major tag.

## GitHub Marketplace

The first Marketplace publication is a one-time manual release step. Before
merging the release PR, create an Actions variable named `HEYO_RELEASE_DRAFT`
with the value `true`. The release workflow then creates a draft GitHub Release
instead of publishing it. Open that draft, select **Publish this Action to the
GitHub Marketplace**, choose the **Code quality** and **Security** categories,
and publish the release. Delete the variable afterwards so later releases are
published automatically.

The release tag must point at a commit containing the committed `dist/action.js`,
[`action.yml`](action.yml), this README, and the [MIT License](LICENSE).
Marketplace users can reference immutable version tags or the stable `v1` tag.

## License

[MIT](LICENSE)
