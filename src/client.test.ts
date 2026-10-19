import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessageParams, createAnthropicClient } from "./client.js";
import type { ChatConfig } from "./config.js";

const config: ChatConfig = {
  model: {
    id: "claude-haiku-4-5",
    acceptsTemperature: true,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  },
  temperature: undefined,
  maxTokens: 16_000,
  maxRetries: 4,
};

const prompt: Anthropic.MessageParam[] = [{ role: "user", content: "Hello" }];

describe("buildMessageParams", () => {
  it("sends the configured model, max_tokens and messages", () => {
    expect(buildMessageParams(config, prompt)).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 16_000,
      messages: prompt,
    });
  });

  it("sends a temperature of 0 rather than dropping it as falsy", () => {
    expect(buildMessageParams({ ...config, temperature: 0 }, prompt)).toHaveProperty(
      "temperature",
      0,
    );
  });

  it("leaves temperature out entirely when it is unset", () => {
    expect(buildMessageParams(config, prompt)).not.toHaveProperty("temperature");
  });
});

describe("createAnthropicClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables the SDK's own retries so they do not multiply with withRetry's", () => {
    expect(createAnthropicClient("fake-key-for-tests").maxRetries).toBe(0);
  });

  it("authenticates with the given key only, ignoring ANTHROPIC_AUTH_TOKEN", () => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "a-bearer-token");

    const client = createAnthropicClient("fake-key-for-tests");

    expect(client.apiKey).toBe("fake-key-for-tests");
    expect(client.authToken).toBeNull();
  });
});
