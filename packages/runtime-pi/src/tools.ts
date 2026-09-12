import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { redactSecrets } from "@heyo-sh/code-audit-core";
import type {
  RepositorySnapshot,
  RuntimeInput,
} from "@heyo-sh/code-audit-core";

const execFileAsync = promisify(execFile);
const BLOCKED_NAMES = new Set([
  "agents.md",
  "system.md",
  "skill.md",
  "claude.md",
  "gemini.md",
  "copilot.md",
  "instructions.md",
  "prompt.md",
  "prompts.md",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "id_rsa",
  "id_ed25519",
]);
const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".pi",
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
  ".continue",
  ".opencode",
  ".aws",
  ".ssh",
  ".gnupg",
  "node_modules",
  "prompts",
  "secrets",
  "skills",
]);

export function createRestrictedTools(
  input: RuntimeInput,
  snapshot: RepositorySnapshot,
): AgentTool[] {
  const budget = new ToolBudget(input.limits.maxToolCalls);
  const guard = new RepositoryGuard(input.repositoryPath);
  const tools: AgentTool[] = [
    {
      name: "read_file",
      label: "Read repository file",
      description:
        "Read a UTF-8 text file under the checked-out repository. Repository instructions are unavailable.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 500 }),
      }),
      async execute(_id, params) {
        budget.take();
        const path = await guard.file((params as { path: string }).path);
        if ((await fs.stat(path)).size > input.limits.maxFileBytes) {
          return result("File exceeds Heyo's configured size limit.");
        }
        const data = await fs.readFile(path, "utf8");
        return result(trim(data, input.limits.maxFileBytes));
      },
    },
    {
      name: "search_repository",
      label: "Search repository",
      description:
        "Search UTF-8 source files for a literal query. It does not search repository instruction or extension files.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        path: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      async execute(_id, params) {
        budget.take();
        const request = params as { query: string; path?: string };
        const root = request.path
          ? await guard.directory(request.path)
          : await guard.root();
        const matches = await search(
          root,
          request.query,
          input.limits.maxSearchResults,
          input.limits.maxFileBytes,
          guard,
        );
        return result(matches.join("\n") || "No matches.");
      },
    },
    {
      name: "read_pr_diff",
      label: "Read PR diff",
      description: "Read the bounded diff selected by Heyo for this audit.",
      parameters: Type.Object({}),
      async execute() {
        budget.take();
        return result(trim(snapshot.diff, input.limits.maxDiffBytes));
      },
    },
    {
      name: "list_repository_files",
      label: "List repository files",
      description:
        "List repository files and directories. Repository instructions and extension directories are unavailable.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      async execute(_id, params) {
        budget.take();
        const request = params as { path?: string };
        const directory = request.path
          ? await guard.directory(request.path)
          : await guard.root();
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const visible = entries
          .filter((entry) => guard.isVisibleName(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 500)
          .map(
            (entry) =>
              `${entry.isDirectory() ? "dir" : "file"} ${redactSecrets(entry.name)}`,
          );
        return result(visible.join("\n") || "Empty directory.");
      },
    },
  ];
  if (input.phase === "verification") {
    tools.push({
      name: "run_bundled_verification",
      label: "Run bundled verification",
      description:
        "Run Heyo's fixed git diff whitespace check. No repository command or arbitrary shell command can be run.",
      parameters: Type.Object({ check: Type.Literal("git-diff-check") }),
      async execute(_id, params) {
        budget.take();
        if ((params as { check: string }).check !== "git-diff-check")
          throw new Error("Unsupported bundled verification check.");
        const root = await guard.root();
        try {
          const output = await execFileAsync(
            "git",
            ["diff", "--check", `${input.baseSha}..${input.headSha}`],
            {
              cwd: root,
              timeout: 10_000,
              maxBuffer: input.limits.maxOutputBytes,
            },
          );
          return result(
            trim(
              output.stdout || "No whitespace errors.",
              input.limits.maxOutputBytes,
            ),
          );
        } catch (error) {
          const stdout =
            error instanceof Error && "stdout" in error
              ? String(error.stdout ?? "")
              : "";
          return result(
            trim(
              stdout || "git diff --check reported an issue.",
              input.limits.maxOutputBytes,
            ),
          );
        }
      },
    });
  }
  return tools;
}

export { redactSecrets };

class ToolBudget {
  private used = 0;
  constructor(private readonly maximum: number) {}
  take(): void {
    this.used += 1;
    if (this.used > this.maximum)
      throw new Error("Heyo tool-call limit reached.");
  }
}

class RepositoryGuard {
  private readonly rootPromise: Promise<string>;
  constructor(private readonly repositoryPath: string) {
    this.rootPromise = fs.realpath(repositoryPath);
  }
  async root(): Promise<string> {
    return this.rootPromise;
  }
  isVisibleName(name: string): boolean {
    return (
      !isBlockedName(name) && !BLOCKED_DIRECTORIES.has(name.toLocaleLowerCase())
    );
  }
  async file(path: string): Promise<string> {
    const candidate = await this.resolveVisible(path);
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) throw new Error("Requested path is not a file.");
    return candidate;
  }
  async directory(path: string): Promise<string> {
    const candidate = await this.resolveVisible(path);
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory())
      throw new Error("Requested path is not a directory.");
    return candidate;
  }
  async relative(path: string): Promise<string> {
    return relative(await this.root(), path)
      .split(sep)
      .join("/");
  }
  private async resolveVisible(requested: string): Promise<string> {
    if (
      !requested ||
      requested.includes("\0") ||
      requested.startsWith("/") ||
      requested
        .split(/[\\/]/)
        .some(
          (part) =>
            part === ".." ||
            isBlockedName(part) ||
            BLOCKED_DIRECTORIES.has(part.toLocaleLowerCase()),
        )
    ) {
      throw new Error(
        "Requested path is outside the permitted repository scope.",
      );
    }
    const root = await this.root();
    const candidate = await fs.realpath(resolve(root, requested));
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
      throw new Error("Requested path escapes the repository.");
    const resolvedParts = relative(root, candidate).split(sep).filter(Boolean);
    if (
      resolvedParts.some(
        (part) =>
          isBlockedName(part) ||
          BLOCKED_DIRECTORIES.has(part.toLocaleLowerCase()),
      )
    ) {
      throw new Error(
        "Requested path is outside the permitted repository scope.",
      );
    }
    return candidate;
  }
}

async function search(
  root: string,
  query: string,
  maximum: number,
  maxFileBytes: number,
  guard: RepositoryGuard,
): Promise<string[]> {
  const result: string[] = [];
  const needle = query.toLocaleLowerCase();
  async function walk(directory: string): Promise<void> {
    if (result.length >= maximum) return;
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (result.length >= maximum || !guard.isVisibleName(entry.name))
        continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path);
        if (stat.size > maxFileBytes) continue;
        const content = await fs.readFile(path, "utf8");
        const lines = content.split("\n");
        for (
          let index = 0;
          index < lines.length && result.length < maximum;
          index += 1
        ) {
          const line = lines[index];
          if (line?.toLocaleLowerCase().includes(needle)) {
            const relativePath = redactSecrets(await guard.relative(path));
            result.push(
              `${relativePath}:${index + 1}: ${redactSecrets(line).slice(0, 500)}`,
            );
          }
        }
      }
    }
  }
  await walk(root);
  return result;
}

function trim(value: string, maximum: number): string {
  const marker = "\n[Output truncated by Heyo]";
  const bounded =
    value.length > maximum
      ? value.slice(0, Math.max(0, maximum - marker.length))
      : value;
  return redactSecrets(bounded) + (value.length > maximum ? marker : "");
}

function isBlockedName(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  return (
    BLOCKED_NAMES.has(normalized) ||
    normalized.startsWith(".env") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key")
  );
}

function result(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
