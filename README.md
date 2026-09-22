<div align="center">
  <h1>Heyo Code Audit</h1>
  <p>Verified AI code reviews for GitHub pull requests.</p>
  <p>
    <a href="https://github.com/marketplace/actions/heyo-code-audit"><img src="https://img.shields.io/badge/GitHub%20Marketplace-Heyo%20Code%20Audit-000000?style=flat&logo=github&logoColor=white" alt="GitHub Marketplace"/></a>
    <a href="https://github.com/heyo-sh/heyo-code-audit/releases"><img src="https://img.shields.io/github/v/release/heyo-sh/heyo-code-audit?display_name=tag&sort=semver&style=flat&colorA=000000&colorB=000000" alt="GitHub release"/></a>
    <a href="https://github.com/heyo-sh/heyo-code-audit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heyo-sh/heyo-code-audit/ci.yml?branch=main&style=flat&label=checks&colorA=000000&colorB=000000" alt="checks"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat&colorA=000000&colorB=000000" alt="MIT License"/></a>
  </p>
  <p>
    <a href="https://docs.heyo.sh/heyo-code-audit/introduction">Documentation</a>
    ·
    <a href="https://github.com/marketplace/actions/heyo-code-audit">Marketplace</a>
    ·
    <a href="https://github.com/heyo-sh/heyo-code-audit/discussions">Discussions</a>
  </p>
</div>

## Heyo Code Audit

Heyo Code Audit reviews GitHub pull requests with an AI model from Pi's bundled
provider catalog. It reads the pull-request diff and relevant repository
context, then by default verifies every candidate finding in a separate Pi
session before publishing results as a GitHub Check and inline review comments.

## Get started

Add this workflow to `.github/workflows/heyo-code-audit.yml`, then add the
provider credential as a GitHub Actions secret.

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
          model: gpt-5.4
          auth-type: api-key
          auth-token: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ github.token }}
```

Use the stable `@v1` reference for the latest compatible release, or pin an
immutable tag such as `@v1.1.1`. Reports use the identity behind
`github-token`; with `${{ github.token }}`, GitHub attributes them to
`github-actions[bot]`.

## What it checks

Heyo can review for security, regression, functional, and non-functional
issues. It verifies each proposed finding before reporting it, only annotates
changed lines, and adds an inline suggestion only when it can prove an exact
one-line replacement.

The default report mode creates both a **Heyo Code Audit** GitHub Check and an
inline pull-request review. Configure reporting, severity thresholds, paths,
incremental runs, and commit limits in the Action inputs.

## Providers

The Action uses Pi's bundled provider catalog and requires an explicit model
and authentication mode. API-key providers such as OpenAI, Anthropic, Google,
OpenRouter, Groq, Mistral, xAI, DeepSeek, and Cerebras use `auth-type: api-key`.
GitHub Copilot and OpenAI Codex use `auth-type: oauth`. Amazon Bedrock supports
AWS credentials with `auth-type: aws` or a bearer token with
`auth-type: bedrock-bearer`.

See the [provider guide](https://docs.heyo.sh/heyo-code-audit/providers) for
complete, copyable configurations and [Pi's provider
documentation](https://github.com/earendil-works/pi/blob/main/docs/providers.md)
for provider and model details.

## Documentation

Read the [Heyo Code Audit documentation](https://docs.heyo.sh/heyo-code-audit/introduction)
for the [quickstart](https://docs.heyo.sh/heyo-code-audit/quickstart), provider
setup, Action inputs, reporting behaviour, safety boundaries, and
troubleshooting.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for local
setup and validation. For questions, use
[GitHub Discussions](https://github.com/heyo-sh/heyo-code-audit/discussions).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
