<div align="center">
  <h1>Heyo Code Audit</h1>
  <p>Verified AI code reviews for GitHub pull requests.</p>

  <p>
    <a href="https://github.com/marketplace/actions/heyo-code-audit"><img src="https://img.shields.io/badge/GitHub%20Marketplace-Heyo%20Code%20Audit-000000?style=flat&amp;logo=github&amp;logoColor=white" alt="GitHub Marketplace"/></a>
    <a href="https://github.com/heyo-sh/heyo-code-audit/releases"><img src="https://img.shields.io/github/v/release/heyo-sh/heyo-code-audit?display_name=tag&amp;sort=semver&amp;style=flat&amp;colorA=000000&amp;colorB=000000" alt="GitHub release"/></a>
    <a href="https://github.com/heyo-sh/heyo-code-audit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heyo-sh/heyo-code-audit/ci.yml?branch=main&amp;style=flat&amp;label=checks&amp;colorA=000000&amp;colorB=000000" alt="checks"/></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000?style=flat&amp;colorA=000000&amp;colorB=000000" alt="MIT License"/></a>
  </p>

  <p style="margin-top: 0.375rem;">
    <a href="https://heyo.sh/heyo-code-audit/introduction">Documentation</a>
    ·
    <a href="https://github.com/marketplace/actions/heyo-code-audit">Marketplace</a>
    ·
    <a href="https://github.com/heyo-sh/heyo-code-audit/discussions">Discussions</a>
  </p>
</div>

## Heyo Code Audit

Heyo Code Audit reviews GitHub pull requests with an AI model from Pi's bundled
provider catalog. It reads the pull-request diff and relevant repository
context, then verifies every candidate finding in a separate Pi session before
publishing results as a GitHub Check and inline review comments.

It can review security, regression, functional, and non-functional issues. It
only annotates changed lines and adds a suggestion only when it can prove an
exact one-line replacement.

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
immutable tag such as `@v1.1.1`.

## Minimum configuration

The Action requires an explicit `provider`, `model`, authentication mode, and
provider credential. API-key providers use `auth-type: api-key`; GitHub Copilot
and OpenAI Codex use `oauth`; Amazon Bedrock supports `aws` or
`bedrock-bearer`.

The default report mode creates both a **Heyo Code Audit** GitHub Check and an
inline pull-request review. Configure reporting, severity thresholds, paths,
incremental runs, and commit limits in the Action inputs.

## Documentation

Read the [Heyo Code Audit documentation](https://heyo.sh/heyo-code-audit/introduction)
for the [quickstart](https://heyo.sh/heyo-code-audit/quickstart), provider
setup, Action inputs, reporting behaviour, safety boundaries, and
troubleshooting. See the [provider guide](https://heyo.sh/heyo-code-audit/providers)
for copyable configurations and [Pi's provider documentation](https://github.com/earendil-works/pi/blob/main/docs/providers.md)
for provider and model details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and contribution
guidelines. Use [GitHub Discussions](https://github.com/heyo-sh/heyo-code-audit/discussions)
for questions and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE)
