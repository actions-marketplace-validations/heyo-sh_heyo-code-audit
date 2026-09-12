const SECRET_PATTERNS = [
  /(?:sk|rk|pk)[_-][A-Za-z0-9_-]{16,}/g,
  /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g,
] as const;

const ASSIGNMENT_PATTERN =
  /((?:api[_-]?key|token|password|secret)\s*[:=])\s*["']?[^\s"']{12,}/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g;

/** Removes common credential formats before untrusted content leaves Heyo. */
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replaceAll(pattern, "[REDACTED_SECRET]"),
    value,
  )
    .replaceAll(ASSIGNMENT_PATTERN, "$1[REDACTED_SECRET]")
    .replaceAll(BEARER_PATTERN, "Bearer [REDACTED_SECRET]")
    .replaceAll(AWS_ACCESS_KEY_PATTERN, "[REDACTED_SECRET]")
    .replaceAll(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");
}
