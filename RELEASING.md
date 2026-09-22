# Releasing Heyo Code Audit

Heyo Code Audit is versioned with [Changesets](https://github.com/changesets/changesets)
and released only by GitHub Actions.

## Normal release flow

1. For each consumer-visible change, run `bun run changeset`, choose the
   smallest correct SemVer bump, and commit the generated file.
2. Merge the pull request into `main`.
3. The **Release** workflow creates or updates a version pull request.
4. Review and merge that pull request. The workflow creates the immutable
   `vX.Y.Z` tag and GitHub Release, then moves the stable major tag such as
   `v1` for stable releases.

Before enabling the workflow, allow GitHub Actions to create pull requests in
**Settings → Actions → General**. If tags are protected, allow the workflow to
create immutable version tags and move stable major tags.

## First GitHub Marketplace publication

GitHub Marketplace publication is a one-time manual step. Before merging the
release pull request chosen for this publication, create an Actions variable
named `HEYO_RELEASE_DRAFT` with the value `true` in **Settings → Secrets and
variables → Actions → Variables**. The release workflow creates a draft GitHub
Release while still creating the immutable tag.

Open that draft in **Releases**, select **Publish this Action to the GitHub
Marketplace**, choose the **Code quality** and **Security** categories, and
publish the release. Delete `HEYO_RELEASE_DRAFT` after publishing so later
releases are published automatically.

The release tag must point at a commit containing the committed
`dist/action.js`, [`action.yml`](action.yml), `README.md`, and the
[MIT License](LICENSE). Do not publish a Marketplace release from an unreviewed
commit or a mutable tag.
