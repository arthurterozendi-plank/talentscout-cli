import Anthropic from "@anthropic-ai/sdk";
import type { ChatConfig } from "./config.js";

/**
 * The part of the SDK client the CLI calls. Kept this narrow so a test can
 * hand `run()` a fake without reproducing the whole SDK.
 */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * Builds the SDK client from an API key the caller has already read from the
 * environment.
 *
 * `authToken: null` stops the SDK falling back to `ANTHROPIC_AUTH_TOKEN`: with
 * both set it sends both headers and the API rejects the request. `maxRetries:
 * 0` hands retrying to `withRetry`, which would otherwise multiply with the
 * SDK's own attempts.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, authToken: null, maxRetries: 0 });
}

/** The one place a {@link ChatConfig} becomes request parameters. */
export function buildMessageParams(
  config: ChatConfig,
  messages: Anthropic.MessageParam[],
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: config.model.id,
    max_tokens: config.maxTokens,
    messages,
    // The SDK marks `temperature` deprecated because later models reject it;
    // `buildConfig` only lets it through for a model that still accepts it.
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
  };
}

/** The reply's text blocks joined, skipping thinking and any other block type. */
export function responseText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
