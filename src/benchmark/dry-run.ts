import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@/client.js";

function characters(params: Anthropic.MessageCreateParamsNonStreaming): number {
  const system = typeof params.system === "string" ? params.system.length : 0;
  return params.messages.reduce(
    (count, message) => count + (typeof message.content === "string" ? message.content.length : 0),
    system,
  );
}

/**
 * A client that answers every request at once with a made-up score, shaped
 * like a real reply that hit the stop sequence. It lets `--dry-run` drive the
 * whole pipeline — grid, requests, parsing, cost, table — with no key and no
 * spend. Its usage is a rough four-characters-per-token guess so the cost
 * column has something to show; nothing it returns is a measurement.
 */
export function createDryRunClient(random: () => number): MessagesClient {
  return {
    messages: {
      create: async (params) => {
        const score = Math.floor(random() * 101);
        const text = `<score>${score}`;
        return {
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
          usage: {
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
          },
        };
      },
    },
  };
}
