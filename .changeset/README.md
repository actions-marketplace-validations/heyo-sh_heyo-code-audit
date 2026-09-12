# Changesets

Heyo Code Audit is released as one GitHub Action. Every user-visible change
that should reach consumers needs a Changeset for the action package:

```md
---
"@heyo-sh/heyo-code-audit": patch
---

Describe the consumer-visible change.
```

Use `patch` for fixes, `minor` for backwards-compatible capabilities, and
`major` for breaking changes. Run `bun run changeset` to create the file.

After a Changeset reaches `main`, automation opens or updates a release PR.
Merging it bumps `packages/cli/package.json`, creates an immutable `vX.Y.Z`
tag and GitHub Release, and moves the matching stable major tag such as `v1`.
The internal workspace packages are intentionally ignored: the action is the
single published delivery unit.
