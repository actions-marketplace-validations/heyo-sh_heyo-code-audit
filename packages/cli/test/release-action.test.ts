import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const temporary: string[] = [];
const releaseScript = join(
  import.meta.dir,
  "../../../scripts/release-action.mjs",
);

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("release automation creates immutable and major tags idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "heyo-release-"));
  temporary.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const releaseMarker = join(root, "release-created");
  await Promise.all([
    mkdir(join(repository, "packages", "cli"), { recursive: true }),
    mkdir(bin),
  ]);
  await writeFile(
    join(repository, "packages", "cli", "package.json"),
    JSON.stringify({ name: "@heyo-sh/heyo-code-audit", version: "1.2.3" }),
  );
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  test -f "$HEYO_RELEASE_MARKER"
  exit $?
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  : > "$HEYO_RELEASE_MARKER"
  exit 0
fi
exit 1
`,
  );
  await chmod(join(bin, "gh"), 0o755);
  await exec("git", ["init", "--bare", "--quiet", remote]);
  await exec("git", ["init", "--quiet", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.email", "test@example.test"], {
    cwd: repository,
  });
  await exec("git", ["config", "user.name", "Test"], { cwd: repository });
  await exec("git", ["add", "."], { cwd: repository });
  await exec("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repository,
  });
  await exec("git", ["remote", "add", "origin", remote], { cwd: repository });
  await exec("git", ["push", "--quiet", "-u", "origin", "main"], {
    cwd: repository,
  });

  const environment = {
    ...process.env,
    GH_TOKEN: "test-token",
    HEYO_RELEASE_ROOT: repository,
    HEYO_RELEASE_MARKER: releaseMarker,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  await exec("node", [releaseScript], { env: environment });
  await exec("node", [releaseScript], { env: environment });

  const versionCommit = (
    await exec("git", ["rev-list", "-n", "1", "v1.2.3"], {
      cwd: repository,
    })
  ).stdout.trim();
  const majorCommit = (
    await exec("git", ["rev-list", "-n", "1", "v1"], { cwd: repository })
  ).stdout.trim();
  expect(versionCommit).toBe(majorCommit);
  expect(await readFile(releaseMarker, "utf8")).toBe("");
  expect(
    (
      await exec("git", ["ls-remote", "--tags", "origin", "v1*"], {
        cwd: repository,
      })
    ).stdout,
  ).toContain("refs/tags/v1.2.3");
});
