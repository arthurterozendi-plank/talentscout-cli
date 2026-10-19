import type Anthropic from "@anthropic-ai/sdk";
import { buildMessageParams, type MessagesClient, type ReplyStream } from "./client.js";
import type { ChatConfig } from "./config.js";
import { withRetry, type RetryEvent } from "./retry.js";

/** What one turn needs from the outside world. */
export interface TurnIo {
  client: MessagesClient;
  /** Receives the reply's text a piece at a time, as each piece arrives. */
  write: (text: string) => void;
  /** Aborted on Ctrl-C: cancels the request in flight, or the wait before a retry. */
  signal: AbortSignal;
  /** Waits `ms`, rejecting early if `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
  onRetry: (event: RetryEvent) => void;
}

/**
 * How one request ended. `model` is the model ID it was sent to. `usage` is
 * what the stream itself reported — `message_start`'s counts, updated by
 * `message_delta` — so after an interruption or a failure it covers only what
 * the API reported before the stream stopped, and it is `undefined` when the
 * reply never started.
 */
export type TurnOutcome =
  | {
      readonly status: "complete";
      readonly model: string;
      readonly usage: Anthropic.Usage;
      readonly message: Anthropic.Message;
    }
  | {
      readonly status: "interrupted";
      readonly model: string;
      readonly usage: Anthropic.Usage | undefined;
    }
  | {
      readonly status: "failed";
      readonly model: string;
      readonly usage: Anthropic.Usage | undefined;
      readonly error: unknown;
    };

interface OpenedStream {
  stream: ReplyStream;
  events: AsyncIterator<Anthropic.MessageStreamEvent>;
  first: IteratorResult<Anthropic.MessageStreamEvent>;
}

async function open(
  client: MessagesClient,
  params: Anthropic.MessageStreamParams,
  signal: AbortSignal,
): Promise<OpenedStream> {
  const stream = client.messages.stream(params, { signal });
  const events = stream[Symbol.asyncIterator]();
  return { stream, events, first: await events.next() };
}

/**
 * `usage` as a streamed reply's `message_delta` updates it. Every counter in
 * the delta is a running total for the whole message, so it replaces the one
 * from `message_start` rather than adding to it; a null means this delta does
 * not report that counter. `undefined` until `message_start` has arrived.
 */
export function withDelta(
  usage: Anthropic.Usage | undefined,
  delta: Anthropic.MessageDeltaUsage,
): Anthropic.Usage | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return {
    ...usage,
    output_tokens: delta.output_tokens,
    input_tokens: delta.input_tokens ?? usage.input_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
    cache_read_input_tokens: delta.cache_read_input_tokens ?? usage.cache_read_input_tokens,
    output_tokens_details: delta.output_tokens_details ?? usage.output_tokens_details,
    server_tool_use: delta.server_tool_use ?? usage.server_tool_use,
  };
}

/**
 * Sends `messages` with `config` and writes the reply's text through
 * `io.write` as it arrives, ending its last line once the reply is over —
 * however it ends, so an interruption never leaves a partial line behind.
 *
 * Only opening the stream is retried, up to the reply's first event. Once
 * `message_start` has arrived the attempt is never repeated: text may already
 * be on screen, and a second attempt would print it again and bill the input
 * twice. A failure after that point ends the turn as `failed`.
 *
 * Never rejects: every way the turn can end is a {@link TurnOutcome}.
 */
export async function streamTurn(
  config: ChatConfig,
  messages: Anthropic.MessageParam[],
  io: TurnIo,
): Promise<TurnOutcome> {
  const model = config.model.id;
  const params = buildMessageParams(config, messages);
  let usage: Anthropic.Usage | undefined;
  let lineOpen = false;
  const write = (text: string) => {
    if (text !== "") {
      io.write(text);
      lineOpen = !text.endsWith("\n");
    }
  };
  const endLine = () => {
    if (lineOpen) {
      write("\n");
    }
  };

  try {
    const { stream, events, first } = await withRetry(() => open(io.client, params, io.signal), {
      maxRetries: config.maxRetries,
      sleep: (ms) => io.sleep(ms, io.signal),
      random: io.random,
      onRetry: io.onRetry,
    });
    for (let next = first; next.done !== true; next = await events.next()) {
      const event = next.value;
      switch (event.type) {
        case "message_start":
          // Copied, because the SDK goes on updating this object in place as
          // later events arrive.
          usage = { ...event.message.usage };
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            write(event.delta.text);
          }
          break;
        case "message_delta":
          usage = withDelta(usage, event.usage);
          break;
        case "message_stop":
          endLine();
          break;
        case "content_block_start":
        case "content_block_stop":
          break;
      }
    }
    // Also rejects with a failure the event iterator ended on quietly, which
    // it does when the error lands between two reads.
    const message = await stream.finalMessage();
    return { status: "complete", model, usage: usage ?? message.usage, message };
  } catch (error) {
    endLine();
    return io.signal.aborted
      ? { status: "interrupted", model, usage }
      : { status: "failed", model, usage, error };
  }
}
