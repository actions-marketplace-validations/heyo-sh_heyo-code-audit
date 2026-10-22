import { afterEach, describe, expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
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
  auth: { type: "api-key", token: "key" },
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
  guidance: [],
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

  test("passes AWS and bearer authentication to Bedrock streams", async () => {
    registration = registerFauxProvider({
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
    });
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    const bedrockInput = {
      ...input,
      provider: "amazon-bedrock" as const,
      model: "amazon.nova-lite-v1:0",
    };

    let awsRegion: string | undefined;
    let awsProfile: string | undefined;
    registration.setResponses([
      (_context, options) => {
        awsRegion = (options as { region?: string } | undefined)?.region;
        awsProfile = (options as { profile?: string } | undefined)?.profile;
        return fauxAssistantMessage('{"findings":[]}');
      },
    ]);
    await expect(
      runtime.run({
        ...bedrockInput,
        auth: {
          type: "aws",
          region: "eu-central-1",
          profile: "production",
        },
      }),
    ).resolves.toEqual({ findings: [] });
    expect({ awsRegion, awsProfile }).toEqual({
      awsRegion: "eu-central-1",
      awsProfile: "production",
    });

    let bearerToken: string | undefined;
    let bearerRegion: string | undefined;
    registration.setResponses([
      (_context, options) => {
        bearerToken = (options as { bearerToken?: string } | undefined)
          ?.bearerToken;
        bearerRegion = (options as { region?: string } | undefined)?.region;
        return fauxAssistantMessage('{"findings":[]}');
      },
    ]);
    await expect(
      runtime.run({
        ...bedrockInput,
        auth: {
          type: "bedrock-bearer",
          token: "bedrock-token",
          region: "us-east-1",
        },
      }),
    ).resolves.toEqual({ findings: [] });
    expect({ bearerToken, bearerRegion }).toEqual({
      bearerToken: "bedrock-token",
      bearerRegion: "us-east-1",
    });
  });

  test("distinguishes the turn limit from a provider failure", async () => {
    registration = registerFauxProvider({
      api: "openai-responses",
      provider: "openai",
    });
    registration.setResponses([
      fauxAssistantMessage(fauxToolCall("read_pr_diff", {})),
      fauxAssistantMessage('{"findings":[]}'),
    ]);
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    await expect(
      runtime.run({ ...input, limits: { ...input.limits, maxTurns: 1 } }),
    ).rejects.toThrow("exceeded the turn limit (1)");
  });

  test("classifies provider errors without disclosing their raw messages", async () => {
    registration = registerFauxProvider({
      api: "openai-responses",
      provider: "openai",
    });
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    const secret = "sk_fakeSecret12345678901234567890";
    for (const [raw, category] of [
      [`429 Rate limit reached; token=${secret}`, "rate limited (HTTP 429)"],
      [
        `HTTP 401: invalid key ${secret}`,
        "authentication or permission error (HTTP 401)",
      ],
      [`status=503; body=${secret}`, "provider server error (HTTP 503)"],
      [
        `API error: status=502; body=${secret}`,
        "provider server error (HTTP 502)",
      ],
      [`HTTP 400: bad request ${secret}`, "request rejected (HTTP 400)"],
      [`fetch failed: ${secret}`, "network or transport error"],
      [
        `unexpected response: ${secret}`,
        "unclassified provider or runtime error",
      ],
    ] as const) {
      registration.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: raw }),
      ]);
      const failure = await runtime.run(input).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(category);
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).message).not.toContain(raw);
    }
  });

  test("reports deadline expiry separately from session errors", async () => {
    registration = registerFauxProvider({
      api: "openai-responses",
      provider: "openai",
      tokensPerSecond: 100,
    });
    registration.setResponses([fauxAssistantMessage('{"findings":[]}')]);
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    await expect(
      runtime.run({ ...input, limits: { ...input.limits, timeoutMs: 1 } }),
    ).rejects.toThrow("timed out after 1 ms");
  });

  test("fails closed for non-read-only permissions and missing provider output", async () => {
    const runtime = new PiAuditRuntime({ resolve: async () => snapshot });
    await expect(
      runtime.run({ ...input, permissions: "write" as never }),
    ).rejects.toThrow("read-only");
    await expect(runtime.run(input)).rejects.toThrow();
  });
});
