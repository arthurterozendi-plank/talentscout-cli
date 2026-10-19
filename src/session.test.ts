import { describe, expect, it, vi } from "vitest";
import { COMMANDS, describeCommands } from "./commands.js";
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
import { createSession, handleInput, sendMessage, type InputIo } from "./session.js";

function model(id: string): ModelInfo {
  const found = findModel(id);
  if (found === undefined) throw new Error(`unknown model ${id}`);
  return found;
}

const haiku: ChatConfig = {
  model: model("claude-haiku-4-5"),
  temperature: undefined,
  system: undefined,
  maxTokens: 16_000,
  maxRetries: 0,
};

const opus: ChatConfig = { ...haiku, model: model("claude-opus-5-5") };

function setup(replies: ScriptedReply[]) {
  const fake = fakeClient(replies);
  const interrupt = new AbortController();
  const writes: string[] = [];
  const notices: string[] = [];
  const io: InputIo = {
    client: fake.client,
    write: (text) => writes.push(text),
    signal: interrupt.signal,
    sleep: async () => {},
    random: () => 0.5,
    onRetry: () => {},
    notice: (text) => notices.push(text),
  };
  return {
    io,
    interrupt,
    requests: fake.requests,
    notices,
    written: () => writes.join(""),
  };
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

describe("handleInput: /model", () => {
  it("switches the model the next request goes to, sending the history unchanged", async () => {
    const chat = setup([
      [
        messageStart({}, "claude-haiku-4-5"),
        ...thinkingBlock(0, "sig-haiku"),
        textStart(1),
        textDelta("Ask about on-call.", 1),
        blockStop(1),
        messageDelta(),
        messageStop,
      ],
      reply("Ask about incidents."),
    ]);
    const session = createSession(haiku);
    await handleInput(session, "One question, please", chat.io);
    const history = structuredClone(session.history);

    await expect(handleInput(session, "/model opus", chat.io)).resolves.toBeUndefined();
    expect(chat.requests).toHaveLength(1);
    await handleInput(session, "Another", chat.io);

    expect(chat.requests[1]?.model).toBe("claude-opus-5-5");
    expect(chat.requests[1]?.messages).toEqual([...history, { role: "user", content: "Another" }]);
    expect(chat.notices.join("\n")).toContain(
      "switched from claude-haiku-4-5 to claude-opus-5-5, keeping the conversation so far.",
    );
  });

  it("keeps the current model, and says so, for a name it does not know", async () => {
    const chat = setup([reply("Hi")]);
    const session = createSession(haiku);

    await handleInput(session, "/model gpt-5", chat.io);
    await handleInput(session, "Hello", chat.io);

    expect(session.config).toBe(haiku);
    expect(chat.notices).toEqual([
      expect.stringMatching(/^unknown model "gpt-5"; still using claude-haiku-4-5\. Choose /),
    ]);
    expect(chat.requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
  });

  it("keeps the current model when the new one would reject the conversation's temperature", async () => {
    const chat = setup([reply("Hi")]);
    const cold = { ...haiku, temperature: 0 };
    const session = createSession(cold);

    await handleInput(session, "/model sonnet", chat.io);
    await handleInput(session, "Hello", chat.io);

    expect(session.config).toBe(cold);
    expect(chat.notices[0]).toContain(
      "claude-sonnet-5-5 does not accept a temperature, and this conversation sends " +
        "temperature=0; still using claude-haiku-4-5.",
    );
    expect(chat.requests[0]).toMatchObject({ model: "claude-haiku-4-5", temperature: 0 });
  });

  it("carries the temperature over to a model that accepts one", async () => {
    const chat = setup([reply("Hi")]);
    const session = createSession({ ...haiku, temperature: 0 });

    await handleInput(session, "/model claude-sonnet-4-6", chat.io);
    await handleInput(session, "Hello", chat.io);

    expect(chat.requests[0]).toMatchObject({ model: "claude-sonnet-4-6", temperature: 0 });
  });

  it("names the current model and changes nothing when given no name", async () => {
    const chat = setup([]);
    const session = createSession(haiku);

    await handleInput(session, "/model", chat.io);

    expect(session.config).toBe(haiku);
    expect(chat.notices).toEqual([
      expect.stringMatching(/^the model is claude-haiku-4-5\. To switch, choose a model ID \(/),
    ]);
  });

  it("says so when the name, or its alias, is the model already in use", async () => {
    const chat = setup([]);
    const session = createSession(opus);

    await handleInput(session, "/model opus", chat.io);

    expect(session.config).toBe(opus);
    expect(chat.notices).toEqual(["already using claude-opus-5-5."]);
  });
});

describe("handleInput: other slash commands", () => {
  it("lists every command, and sends nothing, for one it does not know", async () => {
    const chat = setup([reply("Hi")]);
    const session = createSession(haiku);

    await expect(handleInput(session, "/foo bar", chat.io)).resolves.toBeUndefined();

    expect(chat.requests).toEqual([]);
    expect(session.history).toEqual([]);
    const [listing = ""] = chat.notices;
    expect(listing).toMatch(/^unknown command "\/foo"; nothing was sent\. Commands:\n/);
    for (const command of COMMANDS) {
      expect(listing).toContain(`/${command.name} ${command.argument}`.trim());
    }
  });

  it("lists every command, without calling it unknown, for a lone slash", async () => {
    const chat = setup([]);

    await handleInput(createSession(haiku), "/", chat.io);

    expect(chat.notices).toEqual([`Commands:\n${describeCommands()}`]);
  });
});

describe("handleInput: /system", () => {
  /** A reply as current models send it: an empty thinking block with a signature, then text. */
  function thoughtReply(text: string, signature: string): ScriptedReply {
    return [
      messageStart(),
      ...thinkingBlock(0, signature),
      textStart(1),
      textDelta(text, 1),
      blockStop(1),
      messageDelta(),
      messageStop,
    ];
  }

  it("sends the new system prompt with the next request, and the history without thinking", async () => {
    const chat = setup([thoughtReply("Ask about on-call.", "sig-1"), reply("On-call?")]);
    const session = createSession(haiku);
    await handleInput(session, "One question, please", chat.io);

    await expect(handleInput(session, "/system Be terse.", chat.io)).resolves.toBeUndefined();
    expect(chat.requests).toHaveLength(1);
    await handleInput(session, "Another", chat.io);

    expect(chat.requests[1]?.system).toBe("Be terse.");
    expect(chat.requests[1]?.messages).toEqual([
      { role: "user", content: "One question, please" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Ask about on-call.", citations: null }],
      },
      { role: "user", content: "Another" },
    ]);
  });

  it("confirms the change, showing the old prompt and the new, and that reasoning was dropped", async () => {
    const chat = setup([thoughtReply("Ask about on-call.", "sig-1")]);
    const session = createSession(haiku);
    await handleInput(session, "One question, please", chat.io);

    await handleInput(session, "/system Be terse.", chat.io);
    await handleInput(session, "/system Answer in French.", chat.io);

    expect(chat.notices).toEqual([
      'system prompt replaced. Was: none. Now: "Be terse.".\n' +
        "Earlier reasoning was dropped: the API rejects reasoning written under a different " +
        "system prompt, so earlier replies keep only their text.",
      'system prompt replaced. Was: "Be terse.". Now: "Answer in French.".',
    ]);
  });

  it("drops an exchange whose reply was only reasoning, so roles still alternate", async () => {
    const chat = setup([
      [messageStart(), ...thinkingBlock(0, "sig-1"), messageDelta(), messageStop],
      thoughtReply("Ask about incidents.", "sig-2"),
      reply("Incidents?"),
    ]);
    const session = createSession(haiku);
    await handleInput(session, "First", chat.io);
    await handleInput(session, "Second", chat.io);

    await handleInput(session, "/system Be terse.", chat.io);
    await handleInput(session, "Third", chat.io);

    expect(chat.requests[2]?.messages).toEqual([
      { role: "user", content: "Second" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Ask about incidents.", citations: null }],
      },
      { role: "user", content: "Third" },
    ]);
    expect(chat.notices.at(-1)).toMatch(
      /\n1 exchange whose reply held nothing but reasoning left the conversation\.$/,
    );
  });

  it("strips nothing, and says so, when the prompt is the one already in effect", async () => {
    const chat = setup([thoughtReply("Ask about on-call.", "sig-1")]);
    const config = { ...haiku, system: "Be terse." };
    const session = createSession(config);
    await handleInput(session, "One question, please", chat.io);
    const history = structuredClone(session.history);

    await handleInput(session, "/system Be terse.", chat.io);

    expect(session.config).toBe(config);
    expect(session.history).toEqual(history);
    expect(chat.notices).toEqual(['the system prompt is already "Be terse."; nothing changed.']);
  });

  it("shows the prompt, or none, and changes nothing when given no text", async () => {
    const chat = setup([thoughtReply("Ask about on-call.", "sig-1")]);
    const session = createSession(haiku);
    await handleInput(session, "One question, please", chat.io);
    const history = structuredClone(session.history);

    await handleInput(session, "/system", chat.io);

    expect(session.config).toBe(haiku);
    expect(session.history).toEqual(history);
    expect(chat.notices).toEqual(["system prompt: none. Type /system <prompt> to replace it."]);

    await handleInput(session, "/system Be terse.", chat.io);
    await handleInput(session, "/system", chat.io);

    expect(chat.notices.at(-1)).toBe(
      'system prompt: "Be terse.". Type /system <prompt> to replace it.',
    );
  });

  it("keeps the system prompt across a /model switch", async () => {
    const chat = setup([reply("Hi")]);
    const session = createSession(haiku);

    await handleInput(session, "/system Be terse.", chat.io);
    await handleInput(session, "/model opus", chat.io);
    await handleInput(session, "Hello", chat.io);

    expect(chat.requests[0]).toMatchObject({ model: "claude-opus-5-5", system: "Be terse." });
  });
});
