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
  streamError,
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

describe("handleInput: /cost", () => {
  /** A whole reply whose stream reports `usage` when it starts and `outputTokens` when it ends. */
  function billed(usage: Parameters<typeof messageStart>[0], outputTokens: number): ScriptedReply {
    return [
      messageStart(usage),
      textStart(),
      textDelta("Fine."),
      blockStop(),
      messageDelta("end_turn", { output_tokens: outputTokens }),
      messageStop,
    ];
  }

  const NOTHING_SPENT = "nothing spent yet: no request in this session has reported usage.";

  it("reports each request, then each model at its own rate, then the session total", async () => {
    const chat = setup([
      billed({ input_tokens: 1_000 }, 200),
      billed({ input_tokens: 1_500 }, 300),
      billed({ input_tokens: 2_000 }, 400),
    ]);
    const session = createSession(haiku);

    await handleInput(session, "Suggest an interview question", chat.io);
    await handleInput(session, "Another", chat.io);
    await handleInput(session, "/model opus", chat.io);
    await handleInput(session, "And one more", chat.io);
    await handleInput(session, "/cost", chat.io);

    expect(chat.notices.at(-1)).toBe(
      [
        "spend this session, priced from the usage each response reported:",
        "Requests:",
        "  model             input  cache read  cache write  output      cost",
        "  claude-haiku-4-5  1,000           0            0     200  $0.00200",
        "  claude-haiku-4-5  1,500           0            0     300  $0.00300",
        "  claude-opus-5-5   2,000           0            0     400  $0.01600",
        "By model:",
        "  model             requests  input  cache read  cache write  output      cost",
        "  claude-haiku-4-5         2  2,500           0            0     500  $0.00500",
        "  claude-opus-5-5          1  2,000           0            0     400  $0.01600",
        "  total                    3  4,500           0            0     900  $0.02100",
      ].join("\n"),
    );
  });

  it("counts cache reads and writes apart from input, each at its own rate", async () => {
    const chat = setup([
      billed(
        {
          input_tokens: 100,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 2_000,
          cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 1_000 },
        },
        200,
      ),
    ]);
    const session = createSession(haiku);

    await handleInput(session, "Summarise the job description", chat.io);
    await handleInput(session, "/cost", chat.io);

    // Per million tokens: 100 × $1 input, 10,000 × $0.10 read, 1,000 × $1.25
    // and 1,000 × $2 written for 5 minutes and 1 hour, 200 × $5 output. Priced
    // as plain input, the same tokens would come to $0.01310.
    expect(chat.notices.at(-1)).toContain(
      "\n  claude-haiku-4-5    100      10,000        2,000     200  $0.00535\n",
    );
  });

  it.each([
    ["was rejected", apiError(400, "invalid_request_error")],
    ["found the API overloaded", apiError(529, "overloaded_error")],
  ])("adds nothing for a request that %s before its reply started", async (_, error) => {
    const chat = setup([error]);
    const session = createSession(haiku);

    await expect(handleInput(session, "Hello", chat.io)).resolves.toMatchObject({
      status: "failed",
      usage: undefined,
    });
    await handleInput(session, "/cost", chat.io);

    expect(session.spend).toEqual([]);
    expect(chat.notices).toEqual([NOTHING_SPENT]);
  });

  it("adds exactly the usage a reply reported before it failed partway", async () => {
    const live = new LiveReply();
    const chat = setup([live]);
    const session = createSession(haiku);

    const turn = handleInput(session, "Hello", chat.io);
    live.send(
      messageStart({ input_tokens: 3_000, output_tokens: 4 }),
      textStart(),
      textDelta("Ask"),
    );
    await vi.waitFor(() => expect(chat.written()).toBe("Ask"));
    live.fail(streamError("overloaded_error"));
    await expect(turn).resolves.toMatchObject({ status: "failed" });
    await handleInput(session, "/cost", chat.io);

    expect(chat.notices.at(-1)).toContain(
      "\n  claude-haiku-4-5  3,000           0            0       4  $0.00302  (failed partway)\n",
    );
  });

  it("adds exactly the usage a reply reported before Ctrl-C", async () => {
    const live = new LiveReply();
    const chat = setup([live]);
    const session = createSession(haiku);

    const turn = handleInput(session, "Hello", chat.io);
    live.send(
      messageStart({ input_tokens: 5_000, output_tokens: 2 }),
      textStart(),
      textDelta("Ask"),
    );
    await vi.waitFor(() => expect(chat.written()).toBe("Ask"));
    chat.interrupt.abort();
    await expect(turn).resolves.toMatchObject({ status: "interrupted" });
    await handleInput(session, "/cost", chat.io);

    expect(chat.notices.at(-1)).toContain(
      "\n  claude-haiku-4-5  5,000           0            0       2  $0.00501  (interrupted)\n",
    );
  });

  it("keeps every request through /system and /model", async () => {
    const chat = setup([
      billed({ input_tokens: 1_000 }, 200),
      billed({ input_tokens: 1_500 }, 300),
    ]);
    const session = createSession(haiku);
    await handleInput(session, "First", chat.io);
    await handleInput(session, "Second", chat.io);
    const before = [...session.spend];

    await handleInput(session, "/system Be terse.", chat.io);
    await handleInput(session, "/model opus", chat.io);

    expect(before).toHaveLength(2);
    expect(session.spend).toEqual(before);
  });

  it("sends nothing and answers as a notice, not a reply", async () => {
    const chat = setup([]);
    const session = createSession(haiku);

    await expect(handleInput(session, "/cost", chat.io)).resolves.toBeUndefined();

    expect(chat.requests).toEqual([]);
    expect(chat.written()).toBe("");
    expect(chat.notices).toEqual([NOTHING_SPENT]);
  });
});
