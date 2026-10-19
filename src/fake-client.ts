import Anthropic from "@anthropic-ai/sdk";
import { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { MessagesClient } from "./client.js";

// Test support: the CLI itself never imports this module.

const encoder = new TextEncoder();

/**
 * A reply whose events a test sends one at a time, to observe what the CLI
 * does before the stream has finished.
 */
export class LiveReply {
  /** What `MessageStream.fromReadableStream` reads: one JSON event per line. */
  readonly body: ReadableStream<Uint8Array>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;

  constructor() {
    this.body = new ReadableStream({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }

  send(...events: Anthropic.MessageStreamEvent[]): void {
    for (const event of events) {
      this.#controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    }
  }

  /** Ends the stream cleanly, as the API does after `message_stop`. */
  end(): void {
    this.#controller.close();
  }

  /** Breaks the stream with `error`, as a failed request or connection would. */
  fail(error: Error): void {
    this.#controller.error(error);
  }
}

/**
 * One scripted reply: its events followed by a clean end, an error the
 * request fails with before any event, or a {@link LiveReply} the test drives.
 */
export type ScriptedReply = Anthropic.MessageStreamEvent[] | Error | LiveReply;

function toLive(reply: ScriptedReply): LiveReply {
  if (reply instanceof LiveReply) {
    return reply;
  }
  const live = new LiveReply();
  if (reply instanceof Error) {
    live.fail(reply);
  } else {
    live.send(...reply);
    live.end();
  }
  return live;
}

/**
 * A client that answers each request with the next of `replies`, recording
 * the parameters of every request as they were when it was sent.
 *
 * Each reply is the SDK's own `MessageStream`, fed from the script instead of
 * an HTTP response, so everything after the network — how the SDK assembles
 * the message, delivers events, surfaces errors and reacts to an abort — is
 * the real code the CLI runs against.
 */
export function fakeClient(replies: ScriptedReply[], onRequest?: () => void) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client: MessagesClient = {
    messages: {
      stream(params, { signal }) {
        requests.push(structuredClone(params));
        onRequest?.();
        const next = replies.shift();
        if (next === undefined) {
          throw new Error("the fake client has no more replies");
        }
        const live = toLive(next);
        const stream = MessageStream.fromReadableStream(live.body);
        // What the real client does on abort: cancel the request, whose
        // pending read then fails with an AbortError.
        const abort = () => {
          stream.abort();
          live.fail(new DOMException("This operation was aborted", "AbortError"));
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
        return stream;
      },
    },
  };
  return { client, requests };
}

/** An APIError as the SDK raises it for a response with this status. */
export function apiError(status: number, type: string, message = `${type} message`) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
  );
}

/** An `error` event arriving inside a stream that had already started. */
export function streamError(type: string, message = `${type} message`) {
  return new Anthropic.APIError(
    undefined,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
    type as Anthropic.ErrorType,
  );
}

export function messageStart(
  usage: Partial<Anthropic.Usage> = {},
  model = "claude-sonnet-5-5",
): Anthropic.MessageStreamEvent {
  return {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [],
      container: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        input_tokens: 10,
        output_tokens: 1,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
        ...usage,
      },
    },
  };
}

export function textStart(index = 0): Anthropic.MessageStreamEvent {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  };
}

export function textDelta(text: string, index = 0): Anthropic.MessageStreamEvent {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function blockStop(index = 0): Anthropic.MessageStreamEvent {
  return { type: "content_block_stop", index };
}

/** A thinking block as the current models stream it by default: no text, a signature. */
export function thinkingBlock(index: number, signature: string): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
    blockStop(index),
  ];
}

export function messageDelta(
  stopReason: Anthropic.StopReason = "end_turn",
  usage: Partial<Anthropic.MessageDeltaUsage> = {},
): Anthropic.MessageStreamEvent {
  return {
    type: "message_delta",
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: null,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      ...usage,
    },
  };
}

export const messageStop: Anthropic.MessageStreamEvent = { type: "message_stop" };

/** Every event of a whole reply whose text arrives as `chunks`. */
export function reply(
  chunks: string | string[],
  stopReason: Anthropic.StopReason = "end_turn",
): Anthropic.MessageStreamEvent[] {
  const pieces = typeof chunks === "string" ? [chunks] : chunks;
  const text = pieces.filter((piece) => piece !== "");
  return [
    messageStart(),
    ...(text.length === 0
      ? []
      : [textStart(), ...text.map((piece) => textDelta(piece)), blockStop()]),
    messageDelta(stopReason),
    messageStop,
  ];
}
