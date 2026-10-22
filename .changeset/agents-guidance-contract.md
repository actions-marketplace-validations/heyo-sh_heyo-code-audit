---
"@heyo-sh/heyo-code-audit": patch
---

Review changed code against applicable root and nested AGENTS.md requirements from the pull request's target base, without allowing PR-local instructions to override audit safety rules. Tighten discovery and verification to reject speculative findings and reasonable product decisions unless they demonstrably violate a supported requirement.
