import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.env.HEYO_RELEASE_ROOT ?? process.cwd());
const packagePath = resolve(repositoryRoot, "packages/cli/package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const version = packageJson.version;

if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
)
  throw new Error("The action package version must be valid SemVer.");
if (!process.env.GH_TOKEN)
  throw new Error("GH_TOKEN is required to create a GitHub Release.");

const tag = `v${version}`;
const stableMajor = /^\d+\.\d+\.\d+$/.test(version)
  ? `v${version.split(".")[0]}`
  : undefined;
const draftRelease = process.env.HEYO_RELEASE_DRAFT?.trim() === "true";

await configureGitIdentity();
if (!(await tagExists(tag))) {
  await git(["tag", "--annotate", tag, "--message", `Heyo Code Audit ${tag}`]);
  await git(["push", "origin", tag]);
}

const releaseCommit = (await git(["rev-list", "-n", "1", tag])).stdout.trim();
if (stableMajor && !(await tagPointsTo(stableMajor, releaseCommit))) {
  await git([
    "tag",
    "--annotate",
    "--force",
    stableMajor,
    releaseCommit,
    "--message",
    `Heyo Code Audit ${stableMajor}`,
  ]);
  await git(["push", "origin", `refs/tags/${stableMajor}`, "--force"]);
}

if (!(await releaseExists(tag))) {
  const releaseArguments = [
    "release",
    "create",
    tag,
    "--generate-notes",
    "--verify-tag",
  ];
  if (draftRelease) releaseArguments.push("--draft");
  await command("gh", releaseArguments);
}

async function configureGitIdentity() {
  await git(["config", "user.name", "github-actions[bot]"]);
  await git([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
}

async function tagExists(name) {
  return (
    await command("git", ["rev-parse", "--verify", `refs/tags/${name}`], true)
  ).ok;
}

async function tagPointsTo(name, commit) {
  const result = await command("git", ["rev-list", "-n", "1", name], true);
  return result.ok && result.stdout.trim() === commit.trim();
}

async function releaseExists(name) {
  return (await command("gh", ["release", "view", name], true)).ok;
}

async function git(args) {
  return command("git", args);
}

async function command(file, args, allowFailure = false) {
  try {
    const output = await execFileAsync(file, args, {
      cwd: repositoryRoot,
      env: process.env,
    });
    return { ok: true, stdout: output.stdout };
  } catch (error) {
    if (allowFailure) return { ok: false, stdout: "" };
    throw error;
  }
}
