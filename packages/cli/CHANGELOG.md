# @heyo-sh/heyo-code-audit

## 1.1.0

### Minor Changes

- f315937: Publish verified changed-line findings as GitHub Check annotations and one GitHub pull-request review with inline comments, instead of a standalone PR Conversation comment. Attach an apply-able GitHub suggestion when an exact replacement for the selected diff line is available.

## 1.0.0

### Major Changes

- Initial public release with explicit provider authentication, including OAuth
  and Amazon Bedrock AWS or bearer-token modes.
- Require an explicit model identifier and use the verified audit checks.
