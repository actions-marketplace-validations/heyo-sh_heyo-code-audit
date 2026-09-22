# Contributing to Heyo Code Audit

Thanks for improving Heyo Code Audit. Bug fixes, focused checks, provider
compatibility improvements, tests, examples, and documentation are welcome.

## Before opening an issue

Search existing issues and discussions first. Use an issue for a reproducible
bug or scoped proposal; use GitHub Discussions for questions and early ideas.
Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Local setup

Heyo Code Audit is a Bun workspace. Use the Bun version declared in
`package.json`.

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:coverage
bun run build
bun run verify:action-bundle
```

Run `bun run quality` to execute the full CI-equivalent check. The workspace
contains:

- `packages/core` — audit policy, schemas, prompts, redaction, and orchestration.
- `packages/runtime-pi` — the restricted Pi runtime and repository tools.
- `packages/reporter-github` — Check and pull-request review reporting.
- `packages/cli` — the GitHub Action entrypoint.

The committed `dist/action.js` is the self-contained Action bundle executed by
GitHub. Rebuild and commit it whenever a change affects the bundle.

## Pull requests

1. Start from an up-to-date `main` branch and keep the pull request focused.
2. Describe the user-visible or security effect and link the relevant issue.
3. Add or update focused tests for behaviour changes.
4. Update `README.md`, `action.yml`, and the example workflow when their
   documented contract changes.
5. Run the checks above. CI must pass before merging.

For a consumer-visible Action change, run `bun run changeset` and commit the
file generated in `.changeset/`. Documentation, CI, test-only, and repository
community-health changes do not need a Changeset.

Do not commit credentials, provider tokens, repository secrets, local
configuration, `node_modules`, coverage output, or untracked build output.
Repository content is untrusted input to the Action; do not weaken its bounded
tool access or redaction controls without a security review.

## Contribution license

By submitting a contribution, you confirm that you have the right to submit it
and license your contribution under this repository's [MIT License](LICENSE).
