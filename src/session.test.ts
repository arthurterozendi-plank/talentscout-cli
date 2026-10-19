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
  textDelta,
  textStart,
  thinkingBlock,
  type ScriptedReply,
} from "./fake-client.js";
import { findModel, type ModelInfo } from "./models.js";
import { createSession, handleInput, sendMessage } from "./session.js";
import type { TurnIo } from "./turn.js";

function model(id: string): ModelInfo {
  const found = findModel(id);
  if (found === undefined) throw new Error(`unknown model ${id}`);
  return found;
}

const haiku: ChatConfig = {
  model: model("claude-haiku-4-5"),
  temperature: undefined,
  maxTokens: 16_000,
  maxRetries: 0,
};

const opus: ChatConfig = { ...haiku, model: model("claude-opus-5-5") };

function setup(replies: ScriptedReply[]) {
  const fake = fakeClient(replies);
  const interrupt = new AbortController();
  const writes: string[] = [];
  const io: TurnIo = {
    client: fake.client,
    write: (text) => writes.push(text),
    signal: interrupt.signal,
    sleep: async () => {},
    random: () => 0.5,
    onRetry: () => {},
  };
  return { io, interrupt, requests: fake.requests, written: () => writes.join("") };
}

describe("sendMessage", () => {
  it("sends the earlier turns with each new message, oldest first, roles alternating", async () => {
    const chat = setup([
      [
        messageStart(),
        ...thinkingBlock(0, "sig-1"),
        textStart(1),
        textDelta("Ask about their last migration.", 1),
        blockStop(1),
        messageDelta(),
        messageStop,
      ],
      reply("Ask how they would roll it back."),
    ]);
    const session = createSession(haiku);

    await sendMessage(session, "Suggest an interview question for a backend role", chat.io);
    await sendMessage(session, "And a follow-up to that one?", chat.io);

    expect(chat.requests.map((request) => request.messages)).toEqual([
      [{ role: "user", content: "Suggest an interview question for a backend role" }],
      [
        { role: "user", content: "Suggest an interview question for a backend role" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "sig-1" },
            { type: "text", text: "Ask about their last migration.", citations: null },
          ],
        },
        { role: "user", content: "And a follow-up to that one?" },
      ],
    ]);
  });

  it("leaves a failed turn out, so the next request has no dangling message", async () => {
    const chat = setup([
      reply("Ask about on-call."),
      apiError(400, "invalid_request_error"),
      reply("Ask about code review."),
    ]);
    const session = createSession(haiku);

    await sendMessage(session, "One question, please", chat.io);
    await expect(sendMessage(session, "Another", chat.io)).resolves.toMatchObject({
      status: "failed",
    });
    await sendMessage(session, "A different one", chat.io);

    expect(chat.requests[2]?.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(chat.requests[2]?.messages.at(-1)).toEqual({ role: "user", content: "A different one" });
  });

  it("never sends back a reply that broke off partway", async () => {
    const live = new LiveReply();
    const chat = setup([live, reply("Ask about code review.")]);
    const session = createSession(haiku);

    const broken = sendMessage(session, "One question, please", chat.io);
    live.send(messageStart(), textStart(), textDelta("Ask about"));
    await vi.waitFor(() => expect(chat.written()).toBe("Ask about"));
    live.fail(apiError(500, "api_error"));
    await expect(broken).resolves.toMatchObject({ status: "failed" });
    await sendMessage(session, "Try again", chat.io);

    expect(chat.requests[1]?.messages).toEqual([{ role: "user", content: "Try again" }]);
  });

  it("leaves an interrupted turn out of the history", async () => {
    const live = new LiveReply();
    const chat = setup([reply("Ask about on-call."), live]);
    const session = createSession(haiku);
    await sendMessage(session, "One question, please", chat.io);
    const before = structuredClone(session.history);

    const interrupted = sendMessage(session, "Another", chat.io);
    live.send(messageStart(), textStart(), textDelta("Ask"));
    await vi.waitFor(() => expect(chat.written()).toBe("Ask about on-call.\nAsk"));
    chat.interrupt.abort();

    await expect(interrupted).resolves.toMatchObject({ status: "interrupted" });
    expect(session.history).toEqual(before);
  });

  it("leaves a refused turn out of the history", async () => {
    const chat = setup([reply("", "refusal"), reply("Sure.")]);
    const session = createSession(haiku);

    await sendMessage(session, "Something declined", chat.io);
    await sendMessage(session, "Something else", chat.io);

    expect(chat.requests[1]?.messages).toEqual([{ role: "user", content: "Something else" }]);
  });

  it("keeps the history when the config changes between turns, and sends with the new one", async () => {
    const chat = setup([reply("Ask about on-call."), reply("Ask about incidents.")]);
    const session = createSession(haiku);

    await sendMessage(session, "One question, please", chat.io);
    session.config = opus;
    await sendMessage(session, "Another", chat.io);

    expect(chat.requests.map((request) => request.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5-5",
    ]);
    expect(chat.requests[1]?.messages).toHaveLength(3);
  });
});

describe("handleInput", () => {
  it("sends nothing for a blank line", async () => {
    const chat = setup([]);

    await expect(handleInput(createSession(haiku), "   ", chat.io)).resolves.toBeUndefined();
    expect(chat.requests).toEqual([]);
  });

  it("sends any other line as a message, without its surrounding whitespace", async () => {
    const chat = setup([reply("Hi")]);

    await handleInput(createSession(haiku), "  Hello  \t", chat.io);

    expect(chat.requests[0]?.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});
