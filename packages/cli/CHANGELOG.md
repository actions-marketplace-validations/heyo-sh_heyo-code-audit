# @heyo-sh/heyo-code-audit

## 1.3.1

### Patch Changes

- 1dbbdb5: Raise the default Pi turn limit to 120 and improve discovery and verification prompts to avoid unsupported deployment claims and intentional product-policy false positives while keeping repository exploration focused.

## 1.3.0

### Minor Changes

- fe06489: Raise the default Pi session budget so normal pull requests stop failing with
  `Pi audit session exceeded the turn limit`. The previous 8,000-token response
  budget was too small for a high thinking level: reasoning truncated each
  response, the agent spent turns continuing itself, and discovery hit the
  12-turn limit before reporting findings. Turns, tool calls, and the response
  budget are now raised together, while the byte and result caps grow
  conservatively to keep tool output inside the model context.

## 1.2.2

### Patch Changes

- 830b149: Distinguish Pi audit session limits and timeouts from provider failures in Action logs without disclosing raw provider errors.

## 1.2.1

### Patch Changes

- 72c7db3: Fail the Action job and published Check when an audit cannot complete, while preserving intentional commit-limit skips as neutral outcomes.

## 1.2.0

### Minor Changes

- 45ee390: Show an eyes reaction while a pull-request audit runs, then replace it with a thumbs-up for clean audits or remove it when findings remain.

## 1.1.1

### Patch Changes

- 0c70c22: Publish the Action's GitHub Marketplace-ready metadata and documentation.

## 1.1.0

### Minor Changes

- f315937: Publish verified changed-line findings as GitHub Check annotations and one GitHub pull-request review with inline comments, instead of a standalone PR Conversation comment. Attach an apply-able GitHub suggestion when an exact replacement for the selected diff line is available.

## 1.0.0

### Major Changes

- Initial public release with explicit provider authentication, including OAuth
  and Amazon Bedrock AWS or bearer-token modes.
- Require an explicit model identifier and use the verified audit checks.
