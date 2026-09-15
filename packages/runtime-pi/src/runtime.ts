import { Agent, type AgentOptions } from "@mariozechner/pi-agent-core";
import { getModel, getModels, stream, type Model } from "@mariozechner/pi-ai";
import {
  parseDiscovery,
  parseVerification,
  redactSecrets,
  type AuditRuntime,
  type DiscoveryResult,
  type RuntimeInput,
  type VerificationResult,
} from "@heyo-sh/code-audit-core";
import { createRestrictedTools } from "./tools.js";
import type { RepositorySnapshot } from "@heyo-sh/code-audit-core";

export class PiAuditRuntime implements AuditRuntime {
  constructor(private readonly snapshots: SnapshotResolver) {}

  async run(
    input: RuntimeInput,
  ): Promise<DiscoveryResult | VerificationResult> {
    const response = await this.execute(input);
    return input.phase === "discovery"
      ? parseDiscovery(response)
      : parseVerification(response);
  }

  private async execute(input: RuntimeInput): Promise<unknown> {
    if (input.permissions !== "read-only")
      throw new Error("Pi runtime requires read-only permissions.");
    const snapshot = await this.snapshots.resolve(
      input.repositoryPath,
      input.baseSha,
      input.headSha,
    );
    const selectedModel = providerModel(input.provider, input.model);
    const model = {
      ...selectedModel,
      maxTokens: Math.min(selectedModel.maxTokens, input.limits.maxTokens),
    };
    const agent = new Agent({
      initialState: {
        systemPrompt: input.internalPrompt,
        model,
        thinkingLevel: "high",
        tools: createRestrictedTools(input, snapshot),
      },
      ...piAgentAuthOptions(input),
      toolExecution: "sequential",
      maxRetryDelayMs: 5_000,
    });
    let turns = 0;
    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        turns += 1;
        if (turns > input.limits.maxTurns) agent.abort();
      }
    });
    const timeout = setTimeout(agent.abort.bind(agent), input.limits.timeoutMs);
    try {
      await agent.prompt(
        "Perform the requested Heyo audit phase now. Return the required JSON object only.",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (turns > input.limits.maxTurns || agent.state.errorMessage)
      throw new Error("Pi audit session did not complete reliably.");
    const assistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !assistant ||
      assistant.stopReason === "error" ||
      assistant.stopReason === "aborted"
    )
      throw new Error("Pi audit session returned no valid final answer.");
    const text = assistant.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    if (!text || Buffer.byteLength(text) > input.limits.maxOutputBytes)
      throw new Error("Pi audit response exceeded the output limit.");
    return JSON.parse(extractJson(text));
  }
}

function piAgentAuthOptions(
  input: RuntimeInput,
): Pick<AgentOptions, "getApiKey" | "streamFn"> {
  const auth = input.auth;
  switch (auth.type) {
    case "api-key":
    case "oauth":
      return {
        getApiKey: (provider) =>
          provider === input.provider ? auth.token : undefined,
      };
    case "aws":
      return {
        streamFn: (model, context, options) =>
          stream(model, context, {
            ...options,
            ...(auth.region ? { region: auth.region } : {}),
            ...(auth.profile ? { profile: auth.profile } : {}),
          }),
      };
    case "bedrock-bearer":
      return {
        streamFn: (model, context, options) =>
          stream(model, context, {
            ...options,
            bearerToken: auth.token,
            ...(auth.region ? { region: auth.region } : {}),
          }),
      };
  }
}

export interface SnapshotResolver {
  resolve(
    repositoryPath: string,
    baseSha: string,
    headSha: string,
  ): Promise<RepositorySnapshot>;
}

export function providerModel(
  provider: RuntimeInput["provider"],
  id: string,
): Model<import("@mariozechner/pi-ai").Api> {
  if (!id.trim())
    throw new Error("Pi audit runtime requires a configured model.");
  const known = getModel(provider as never, id as never);
  if (known) return known;
  const template = getModels(provider as never)[0];
  if (!template) throw new Error(`Pi does not support provider '${provider}'.`);
  return { ...template, id, name: id };
}

export function extractJson(text: string): string {
  const trimmed = redactSecrets(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}
