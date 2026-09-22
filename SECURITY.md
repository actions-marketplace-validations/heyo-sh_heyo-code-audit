# Security policy

## Reporting a vulnerability

Do not open a public issue, pull request, discussion, or workflow log for a
suspected vulnerability. Use this repository's private vulnerability-report
form instead:

<https://github.com/heyo-sh/heyo-code-audit/security/advisories/new>

Include the Action version, a minimal reproduction, impact, affected workflow
configuration, and any mitigation you know. Never include API keys, OAuth
access tokens, AWS credentials, GitHub tokens, customer data, or private
repository contents.

We will acknowledge the report, investigate it privately, and coordinate a fix
and disclosure with the reporter where possible.

## Supported versions

Security fixes are made against the latest released Action version and `main`.

## Scope

Reports are particularly welcome for issues that could expose repository
content or secrets, bypass the Action's restricted tools or path checks, alter
GitHub reporting outside the configured pull request, or weaken authentication
handling and redaction.
