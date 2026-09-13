import { afterEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { PiAuditRuntime, extractJson, providerModel } from "../src/index.js";
import type {
  RepositorySnapshot,
  RuntimeInput,
} from "@heyo-sh/code-audit-core";

let registration: FauxProviderRegistration | undefined;
afterEach(() => {
  registration?.unregister();
  registration = undefined;
});

const input: RuntimeInput = {
  repositoryPath: process.cwd(),
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  phase: "discovery",
  checks: ["security"],
  provider: "openai",
  model: "gpt-5.6-terra",
  apiKey: "key",
  internalPrompt: "fixed",
  permissions: "read-only",
  limits: {
    maxTurns: 3,
    maxToolCalls: 3,
    maxTokens: 100,
    maxFileBytes: 1000,
    maxSearchResults: 3,
    maxDiffBytes: 1000,
    maxOutputBytes: 1000,
    timeoutMs: 1000,
  },
};
const snapshot: RepositorySnapshot = {
  repositoryPath: input.repositoryPath,
  baseSha: input.baseSha,
  headSha: input.headSha,
  diff: "",
  changedPaths: [],
  commits: [],
};

describe("Pi runtime helpers", () => {
  test("accepts direct or fenced JSON and resolves configured provider models", () => {
    expect(extractJson('```json\n{"findings":[]}\n```')).toBe(
      '{"findings":[]}',
    );
    expect(extractJson('{"verified":false}')).toBe('{"verified":false}');
    expect(providerModel("openai", "gpt-5.6-terra")).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai",
    });
    expect(() => providerModel("google", "")).toThrow("configured model");
    expect(() => providerModel("not-a-pi-provider", "model")).toThrow(
      "Pi does not support provider",
    );
  });

  test("runs an isolated Pi session and validates discovery and verification output", async () => {
    registration = registerFauxProvider({
      api: "openai-responses",
      provider: "openai",
    });
    registration.setResponses([fauxAssistantMessage('{"findings":[]}')]);
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    await expect(runtime.run(input)).resolves.toEqual({ findings: [] });
    registration.setResponses([
      fauxAssistantMessage('{"verified":false,"reason":"not reproducible"}'),
    ]);
    await expect(
      runtime.run({ ...input, phase: "verification" }),
    ).resolves.toEqual({ verified: false, reason: "not reproducible" });
  });

  test("fails closed for non-read-only permissions and missing provider output", async () => {
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    await expect(
      runtime.run({ ...input, permissions: "write" as never }),
    ).rejects.toThrow("read-only");
    await expect(runtime.run(input)).rejects.toThrow();
  });
});
