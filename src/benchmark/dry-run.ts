import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient, ReplyStream } from "@/client.js";

function characters(params: Anthropic.MessageStreamParams): number {
  const system = typeof params.system === "string" ? params.system.length : 0;
  return params.messages.reduce(
    (count, message) => count + (typeof message.content === "string" ? message.content.length : 0),
    system,
  );
}

/**
 * A client that answers every request at once with a made-up score, streamed
 * like a real reply that hit the stop sequence. Every run without `--live`
 * uses it, so the whole pipeline — grid, requests, parsing, cost, table —
 * runs with no key and no spend. Its usage is a rough four-characters-per-token
 * guess so the cost column has something to show; nothing it returns is a
 * measurement.
 */
export function createDryRunClient(random: () => number): MessagesClient {
  return {
    messages: {
      stream: (params): ReplyStream => {
        const text = `<score>${Math.floor(random() * 101)}`;
        const usage: Anthropic.Usage = {
          cache_creation: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          inference_geo: null,
          input_tokens: Math.ceil(characters(params) / 4),
          output_tokens: Math.ceil(text.length / 4),
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: null,
          speed: null,
        };
        const message: Anthropic.Message = {
          id: "msg_dry_run",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "text", text, citations: null }],
          container: null,
          diagnostics: null,
          stop_details: null,
          stop_reason: "stop_sequence",
          stop_sequence: params.stop_sequences?.[0] ?? null,
          usage,
        };
        const events: Anthropic.MessageStreamEvent[] = [
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null, stop_sequence: null },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              container: null,
              stop_details: null,
              stop_reason: message.stop_reason,
              stop_sequence: message.stop_sequence,
            },
            usage: {
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              input_tokens: null,
              output_tokens: usage.output_tokens,
              output_tokens_details: null,
              server_tool_use: null,
            },
          },
          { type: "message_stop" },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => message,
        };
      },
    },
  };
}
