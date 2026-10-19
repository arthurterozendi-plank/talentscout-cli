import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { ChatConfig } from "./config.js";
import {
  apiError,
  blockStop,
  fakeClient,
  LiveReply,
  messageDelta,
  messageStart,
  messageStop,
  reply,
  streamError,
  textDelta,
  textStart,
  type ScriptedReply,
} from "./fake-client.js";
import { findModel, type ModelInfo } from "./models.js";
import { RetriesExhaustedError } from "./retry.js";
import { streamTurn, type TurnIo } from "./turn.js";

function model(id: string): ModelInfo {
  const found = findModel(id);
  if (found === undefined) throw new Error(`unknown model ${id}`);
  return found;
}

const config: ChatConfig = {
  model: model("claude-haiku-4-5"),
  temperature: undefined,
  maxTokens: 16_000,
  maxRetries: 2,
};

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Suggest an interview question for a backend role" },
];

function setup(replies: ScriptedReply[]) {
  const fake = fakeClient(replies);
  const interrupt = new AbortController();
  const writes: string[] = [];
  const sleeps: number[] = [];
  const io: TurnIo = {
    client: fake.client,
    write: (text) => writes.push(text),
    signal: interrupt.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onRetry: () => {},
  };
  return { io, interrupt, writes, sleeps, requests: fake.requests, written: () => writes.join("") };
}

/** Runs `body`, then fails if any promise was rejected with nothing to handle it. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    await body();
    // Node reports an unhandled rejection only once the microtask queue has
    // drained, so give it a turn of the event loop to do so.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", record);
  }
}

describe("streamTurn writing the reply", () => {
  it("writes each piece of text as it arrives, before the reply has finished", async () => {
    const live = new LiveReply();
    const turn = setup([live]);

    const outcome = streamTurn(config, messages, turn.io);
    live.send(messageStart(), textStart(), textDelta("Ask them "));
    await vi.waitFor(() => expect(turn.writes).toEqual(["Ask them "]));
    live.send(textDelta("about their last "), textDelta("migration."));
    await vi.waitFor(() =>
      expect(turn.writes).toEqual(["Ask them ", "about their last ", "migration."]),
    );
    live.send(blockStop(), messageDelta(), messageStop);
    live.end();

    await expect(outcome).resolves.toMatchObject({ status: "complete" });
    expect(turn.written()).toBe("Ask them about their last migration.\n");
  });

  it("ends the reply's line as soon as message_stop arrives", async () => {
    const live = new LiveReply();
    const turn = setup([live]);

    const outcome = streamTurn(config, messages, turn.io);
    live.send(messageStart(), textStart(), textDelta("Done"), blockStop(), messageDelta());
    await vi.waitFor(() => expect(turn.written()).toBe("Done"));
    live.send(messageStop);
    await vi.waitFor(() => expect(turn.written()).toBe("Done\n"));
    live.end();

    await expect(outcome).resolves.toMatchObject({ status: "complete" });
  });

  it("writes the text and nothing of the thinking streamed before it", async () => {
    const turn = setup([
      [
        messageStart(),
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Weighing seniority first." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "s" },
        },
        blockStop(0),
        textStart(1),
        textDelta("Ask about on-call.", 1),
        blockStop(1),
        messageDelta(),
        messageStop,
      ],
    ]);

    await streamTurn(config, messages, turn.io);

    expect(turn.written()).toBe("Ask about on-call.\n");
  });

  it("does not end a line the reply already ended", async () => {
    const turn = setup([reply(["First line.\n", "Second line.\n"])]);

    await streamTurn(config, messages, turn.io);

    expect(turn.written()).toBe("First line.\nSecond line.\n");
  });
});

describe("streamTurn's outcome", () => {
  it("carries the model and the usage message_start and message_delta reported", async () => {
    const turn = setup([
      [
        messageStart({ input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 1 }),
        textStart(),
        textDelta("Hi"),
        blockStop(),
        messageDelta("end_turn", { output_tokens: 42 }),
        messageStop,
      ],
    ]);

    const outcome = await streamTurn(config, messages, turn.io);

    expect(outcome).toMatchObject({
      status: "complete",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 42 },
      message: { content: [{ type: "text", text: "Hi" }], stop_reason: "end_turn" },
    });
  });

  it("fails a reply whose stream ends before message_stop, ending its line", async () => {
    const turn = setup([[messageStart(), textStart(), textDelta("Half a"), blockStop()]]);

    const outcome = await streamTurn(config, messages, turn.io);

    expect(outcome.status).toBe("failed");
    expect(turn.written()).toBe("Half a\n");
  });
});

describe("streamTurn retrying", () => {
  it("retries a failure that comes before the reply starts", async () => {
    const turn = setup([apiError(529, "overloaded_error"), reply("Hello")]);

    const outcome = await streamTurn(config, messages, turn.io);

    expect(outcome.status).toBe("complete");
    expect(turn.requests).toHaveLength(2);
    expect(turn.sleeps).toEqual([375]);
    expect(turn.written()).toBe("Hello\n");
  });

  it("gives up once retries run out, having written nothing", async () => {
    const turn = setup([
      apiError(429, "rate_limit_error"),
      apiError(429, "rate_limit_error"),
      apiError(429, "rate_limit_error"),
    ]);

    const outcome = await streamTurn(config, messages, turn.io);

    expect(outcome).toMatchObject({ status: "failed", usage: undefined });
    expect(outcome.status === "failed" && outcome.error).toBeInstanceOf(RetriesExhaustedError);
    expect(turn.requests).toHaveLength(3);
    expect(turn.written()).toBe("");
  });

  it("never retries once message_start has arrived, even an error it would otherwise retry", async () => {
    const live = new LiveReply();
    const turn = setup([live, reply("Ask about their last migration.")]);

    const outcome = streamTurn(config, messages, turn.io);
    live.send(messageStart({ input_tokens: 30 }), textStart(), textDelta("Ask about"));
    await vi.waitFor(() => expect(turn.written()).toBe("Ask about"));
    const dropped = new Anthropic.APIConnectionError({ message: "socket hang up" });
    live.fail(dropped);

    await expect(outcome).resolves.toEqual({
      status: "failed",
      model: "claude-haiku-4-5",
      usage: expect.objectContaining({ input_tokens: 30 }),
      error: dropped,
    });
    expect(turn.requests).toHaveLength(1);
    expect(turn.written()).toBe("Ask about\n");
  });

  it("reports the error a stream stopped with after it started", async () => {
    const live = new LiveReply();
    const turn = setup([live]);

    const outcome = streamTurn(config, messages, turn.io);
    live.send(messageStart(), textStart(), textDelta("Ask"));
    await vi.waitFor(() => expect(turn.written()).toBe("Ask"));
    const overloaded = streamError("overloaded_error", "Overloaded");
    live.fail(overloaded);

    await expect(outcome).resolves.toMatchObject({ status: "failed", error: overloaded });
  });
});

describe("streamTurn on Ctrl-C", () => {
  it("stops mid-reply, ends the partial line, and keeps the usage reported so far", async () => {
    await withoutUnhandledRejections(async () => {
      const live = new LiveReply();
      const turn = setup([live]);

      const outcome = streamTurn(config, messages, turn.io);
      live.send(messageStart({ input_tokens: 25 }), textStart(), textDelta("The candidate"));
      await vi.waitFor(() => expect(turn.written()).toBe("The candidate"));
      turn.interrupt.abort();

      await expect(outcome).resolves.toEqual({
        status: "interrupted",
        model: "claude-haiku-4-5",
        usage: expect.objectContaining({ input_tokens: 25, output_tokens: 1 }),
      });
      expect(turn.written()).toBe("The candidate\n");
    });
  });

  it("stops before the reply starts, having written nothing", async () => {
    await withoutUnhandledRejections(async () => {
      const turn = setup([new LiveReply()]);

      const outcome = streamTurn(config, messages, turn.io);
      turn.interrupt.abort();

      await expect(outcome).resolves.toEqual({
        status: "interrupted",
        model: "claude-haiku-4-5",
        usage: undefined,
      });
      expect(turn.written()).toBe("");
    });
  });

  it("stops during the wait before a retry, without sending it", async () => {
    const turn = setup([apiError(429, "rate_limit_error"), reply("never requested")]);
    turn.io.sleep = async () => {
      turn.interrupt.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    };

    const outcome = await streamTurn(config, messages, turn.io);

    expect(outcome.status).toBe("interrupted");
    expect(turn.requests).toHaveLength(1);
  });
});
