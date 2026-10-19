import { describe, expect, it, vi } from "vitest";
import { EXIT_INTERRUPTED, PROMPT, run, type CliDeps } from "./cli.js";
import {
  apiError,
  fakeClient,
  LiveReply,
  messageStart,
  reply,
  streamError,
  textDelta,
  textStart,
  type ScriptedReply,
} from "./fake-client.js";

const API_KEY = "fake-key-for-tests-0123456789";

type Event = { kind: "stdout" | "stderr" | "request" | "prompt"; text: string };

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  /** What the user types in a conversation, one entry per line; input ends after the last. */
  lines?: string[];
}

/**
 * Fakes everything `run` touches. The fake client answers each request with
 * the next of `replies`; `readLine` hands out `lines` in order.
 */
function harness(replies: ScriptedReply[], options: HarnessOptions = {}) {
  const env = options.env ?? { ANTHROPIC_API_KEY: API_KEY };
  const lines = [...(options.lines ?? [])];
  const events: Event[] = [];
  const sleeps: number[] = [];
  const clientKeys: string[] = [];
  const interrupt = new AbortController();
  const fake = fakeClient(replies, () => events.push({ kind: "request", text: "" }));
  const deps: CliDeps = {
    env,
    stdout: (text) => events.push({ kind: "stdout", text }),
    stderr: (text) => events.push({ kind: "stderr", text }),
    createClient: (apiKey) => {
      clientKeys.push(apiKey);
      return fake.client;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    readLine: async (prompt) => {
      events.push({ kind: "prompt", text: prompt });
      return lines.shift();
    },
    interrupt: interrupt.signal,
  };
  const output = (kind: Event["kind"]) =>
    events
      .filter((event) => event.kind === kind)
      .map((event) => event.text)
      .join("");
  return {
    deps,
    events,
    interrupt,
    requests: fake.requests,
    sleeps,
    clientKeys,
    prompts: () => events.filter((event) => event.kind === "prompt").length,
    stdout: () => output("stdout"),
    stderr: () => output("stderr"),
  };
}

describe("help and usage", () => {
  it.each([["--help"], ["-h"]])("prints usage to stdout and exits 0 for %s", async (flag) => {
    const cli = harness([]);

    await expect(run([flag], cli.deps)).resolves.toBe(0);
    expect(cli.stdout()).toMatch(/^Usage: talentscout-cli \[--model <model>\]/);
    expect(cli.stderr()).toBe("");
    expect(cli.clientKeys).toEqual([]);
  });

  it("lists the models, marking temperature support, the aliases and the default", async () => {
    const cli = harness([]);

    await run(["--help"], cli.deps);

    expect(cli.stdout()).toMatch(/^ {2}claude-haiku-4-5 \*$/m);
    expect(cli.stdout()).toMatch(/^ {2}claude-haiku-5-5 +alias "haiku"$/m);
    expect(cli.stdout()).toMatch(/^ {2}claude-sonnet-5-5 +alias "sonnet", default$/m);
  });

  it("prints usage to stderr, names the flag, and exits 1 for an unknown flag", async () => {
    const cli = harness([]);

    await expect(run(["--bogus"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("--bogus");
    expect(cli.stderr()).toContain("Usage:");
    expect(cli.stderr()).not.toContain("    at ");
  });

  it("exits 1 for a prompt argument that is empty", async () => {
    const cli = harness([]);

    await expect(run(["--model", "claude-haiku-4-5", "  "], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("the prompt is empty");
    expect(cli.requests).toEqual([]);
    expect(cli.prompts()).toBe(0);
  });
});

describe("a prompt given as arguments", () => {
  it("streams the reply to stdout while it is still arriving", async () => {
    const live = new LiveReply();
    const cli = harness([live]);

    const exitCode = run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);
    live.send(messageStart(), textStart(), textDelta("Hel"));
    await vi.waitFor(() => expect(cli.stdout()).toBe("Hel"));
    live.send(...reply("lo").slice(2));
    live.end();

    await expect(exitCode).resolves.toBe(0);
    expect(cli.stdout()).toBe("Hello\n");
    expect(cli.prompts()).toBe(0);
  });

  it("exits 130 on Ctrl-C mid-reply, leaving no partial line behind", async () => {
    const live = new LiveReply();
    const cli = harness([live]);

    const exitCode = run(["--model", "claude-haiku-4-5", "Tell me about the role"], cli.deps);
    live.send(messageStart(), textStart(), textDelta("The role is"));
    await vi.waitFor(() => expect(cli.stdout()).toBe("The role is"));
    cli.interrupt.abort();

    await expect(exitCode).resolves.toBe(EXIT_INTERRUPTED);
    expect(cli.stdout()).toBe("The role is\n");
  });

  it("keeps what was printed when the reply breaks off, explains why, and exits 1", async () => {
    const live = new LiveReply();
    const cli = harness([live]);

    const exitCode = run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);
    live.send(messageStart(), textStart(), textDelta("Ask about"));
    await vi.waitFor(() => expect(cli.stdout()).toBe("Ask about"));
    live.fail(streamError("overloaded_error", "Overloaded"));

    await expect(exitCode).resolves.toBe(1);
    expect(cli.stdout()).toBe("Ask about\n");
    expect(cli.stderr()).toContain("stopped the reply with an error (overloaded_error)");
    expect(cli.requests).toHaveLength(1);
  });
});

describe("model and temperature", () => {
  it("sends --model and --temperature to the API and echoes them before the request", async () => {
    const cli = harness([reply("Ask about their last migration.")]);

    const exitCode = await run(
      ["--model", "claude-haiku-4-5", "--temperature", "0", "Suggest an interview question"],
      cli.deps,
    );

    expect(exitCode).toBe(0);
    expect(cli.requests).toEqual([
      {
        model: "claude-haiku-4-5",
        temperature: 0,
        max_tokens: 32_000,
        messages: [{ role: "user", content: "Suggest an interview question" }],
      },
    ]);
    const echo = cli.events.findIndex(
      (event) =>
        event.kind === "stderr" && event.text.includes("model=claude-haiku-4-5 temperature=0"),
    );
    const request = cli.events.findIndex((event) => event.kind === "request");
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(echo).toBeLessThan(request);
    expect(cli.stdout()).toBe("Ask about their last migration.\n");
  });

  it("omits temperature from the request, and says so, when the flag is absent", async () => {
    const cli = harness([reply("Hi")]);

    await run(["--model", "claude-opus-5-5", "Hello"], cli.deps);

    expect(cli.requests[0]).not.toHaveProperty("temperature");
    expect(cli.stderr()).toContain("temperature=default");
  });

  it("sends to claude-sonnet-5-5, and says so, when --model is omitted", async () => {
    const cli = harness([reply("Hi")]);

    await expect(run(["Hello"], cli.deps)).resolves.toBe(0);

    expect(cli.requests[0]?.model).toBe("claude-sonnet-5-5");
    expect(cli.stderr()).toContain("model=claude-sonnet-5-5");
  });

  it.each([
    ["opus", "claude-opus-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ])("sends --model %s to the API as %s", async (alias, id) => {
    const cli = harness([reply("Hi")]);

    await run(["--model", alias, "Hello"], cli.deps);

    expect(cli.requests[0]?.model).toBe(id);
    expect(cli.stderr()).toContain(`model=${id}`);
  });

  it("joins unquoted words into one prompt", async () => {
    const cli = harness([reply("Hi")]);

    await run(["--model", "claude-opus-5-5", "Rank", "these", "candidates"], cli.deps);

    expect(cli.requests[0]?.messages).toEqual([{ role: "user", content: "Rank these candidates" }]);
  });
});

describe("rejected before any request is sent", () => {
  it("rejects an unknown model", async () => {
    const cli = harness([]);

    await expect(run(["--model", "haiku-9", "Hello"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain('unknown model "haiku-9"');
    expect(cli.clientKeys).toEqual([]);
    expect(cli.requests).toEqual([]);
  });

  it.each([["1.5"], ["--temperature=-0.1"], ["warm"]])(
    "rejects the out-of-range temperature %s",
    async (temperature) => {
      const flag = temperature.startsWith("--") ? [temperature] : ["--temperature", temperature];
      const cli = harness([]);

      await expect(run(["--model", "claude-haiku-4-5", ...flag, "Hello"], cli.deps)).resolves.toBe(
        1,
      );
      expect(cli.stderr()).toContain("--temperature must be a number from 0 to 1");
      expect(cli.requests).toEqual([]);
    },
  );

  it("rejects --model haiku --temperature 0, naming the models that accept a temperature", async () => {
    const cli = harness([]);

    await expect(run(["--model", "haiku", "--temperature", "0", "Hello"], cli.deps)).resolves.toBe(
      1,
    );
    expect(cli.stderr()).toContain("claude-haiku-5-5 does not accept --temperature");
    expect(cli.stderr()).toContain("claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5");
    expect(cli.clientKeys).toEqual([]);
    expect(cli.requests).toEqual([]);
  });

  it("rejects --temperature without --model, since the default model does not accept one", async () => {
    const cli = harness([]);

    await expect(run(["--temperature", "0.7", "Hello"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("claude-sonnet-5-5 does not accept --temperature");
    expect(cli.requests).toEqual([]);
  });
});

describe("retries", () => {
  it("backs off through 429s with growing, jittered waits and then prints the reply", async () => {
    const cli = harness([
      apiError(429, "rate_limit_error"),
      apiError(429, "rate_limit_error"),
      apiError(429, "rate_limit_error"),
      reply("Done"),
    ]);

    const exitCode = await run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);

    expect(exitCode).toBe(0);
    expect(cli.requests).toHaveLength(4);
    expect(cli.sleeps).toEqual([375, 750, 1500]);
    expect(cli.stderr()).toContain("rate limited (429); retrying in 0.4s (retry 1 of 4)");
    expect(cli.stdout()).toBe("Done\n");
  });

  it("explains what failed and exits 1 once retries run out", async () => {
    const cli = harness([
      apiError(529, "overloaded_error"),
      apiError(529, "overloaded_error"),
      apiError(529, "overloaded_error"),
    ]);

    const exitCode = await run(
      ["--model", "claude-haiku-4-5", "--max-retries", "2", "Hello"],
      cli.deps,
    );

    expect(exitCode).toBe(1);
    expect(cli.requests).toHaveLength(3);
    expect(cli.stderr()).toContain("The Anthropic API is overloaded (529).");
    expect(cli.stderr()).toContain("Gave up after 3 attempts.");
    expect(cli.stderr()).not.toContain("    at ");
    expect(cli.stdout()).toBe("");
  });

  it("does not retry a request the API rejected outright", async () => {
    const cli = harness([apiError(400, "invalid_request_error", "messages: text too long")]);

    await expect(run(["--model", "claude-haiku-4-5", "Hello"], cli.deps)).resolves.toBe(1);
    expect(cli.requests).toHaveLength(1);
    expect(cli.stderr()).toContain("rejected the request (400): messages: text too long");
  });
});

describe("the API key", () => {
  it("is read from ANTHROPIC_API_KEY and handed to the client", async () => {
    const cli = harness([reply("Hi")]);

    await run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);

    expect(cli.clientKeys).toEqual([API_KEY]);
  });

  it.each([{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_API_KEY: "   " }])(
    "is required: %j exits 1 without building a client",
    async (env) => {
      const cli = harness([], { env });

      await expect(run(["--model", "claude-haiku-4-5", "Hello"], cli.deps)).resolves.toBe(1);
      expect(cli.stderr()).toContain("ANTHROPIC_API_KEY is not set");
      expect(cli.clientKeys).toEqual([]);
    },
  );

  it("does not mask a placeholder short enough to match ordinary words", async () => {
    const cli = harness([reply("Hi")], { env: { ANTHROPIC_API_KEY: "x" } });

    await run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);

    expect(cli.stderr()).toContain("max_tokens=32000 max_retries=4");
  });

  it("never appears in output, even when an error message repeats it", async () => {
    const cli = harness([
      apiError(400, "invalid_request_error", `bad header x-api-key: ${API_KEY}`),
    ]);

    await run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);

    expect(cli.stderr()).toContain("x-api-key: [redacted]");
    expect(cli.stdout() + cli.stderr()).not.toContain(API_KEY);
  });

  it("is reported as rejected on a 401 without being printed", async () => {
    const cli = harness([apiError(401, "authentication_error")]);

    await expect(run(["--model", "claude-haiku-4-5", "Hello"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("rejected the key in ANTHROPIC_API_KEY (401)");
    expect(cli.stdout() + cli.stderr()).not.toContain(API_KEY);
  });
});

describe("how the reply ended", () => {
  it("exits 1 and says so when the model declines to answer", async () => {
    const cli = harness([reply("", "refusal")]);

    await expect(run(["--model", "claude-opus-5-5", "Hello"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("declined to answer");
    expect(cli.stdout()).toBe("");
  });

  it("prints a reply cut off at max_tokens and warns that it was", async () => {
    const cli = harness([reply("A very long", "max_tokens")]);

    await expect(run(["--model", "claude-opus-5-5", "Hello"], cli.deps)).resolves.toBe(0);
    expect(cli.stdout()).toBe("A very long\n");
    expect(cli.stderr()).toContain("cut off at max_tokens=32000");
  });
});

describe("a conversation, started by giving no prompt", () => {
  it("sends each line with the turns before it and ends with exit 0 when input ends", async () => {
    const cli = harness([reply("Ask about on-call."), reply("Ask how they handle incidents.")], {
      lines: ["Suggest an interview question", "Another, on the same theme"],
    });

    await expect(run(["--model", "haiku"], cli.deps)).resolves.toBe(0);

    expect(cli.requests.map((request) => request.model)).toEqual([
      "claude-haiku-5-5",
      "claude-haiku-5-5",
    ]);
    expect(cli.requests[1]?.messages).toEqual([
      { role: "user", content: "Suggest an interview question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Ask about on-call.", citations: null }],
      },
      { role: "user", content: "Another, on the same theme" },
    ]);
    expect(cli.stdout()).toBe("Ask about on-call.\nAsk how they handle incidents.\n");
    expect(cli.events.filter((event) => event.kind === "prompt")).toEqual([
      { kind: "prompt", text: PROMPT },
      { kind: "prompt", text: PROMPT },
      { kind: "prompt", text: PROMPT },
    ]);
  });

  it("echoes the settings and checks the key before reading any input", async () => {
    const missing = harness([], { env: {}, lines: ["Hello"] });
    const present = harness([], { lines: [] });

    await expect(run([], missing.deps)).resolves.toBe(1);
    await expect(run([], present.deps)).resolves.toBe(0);

    expect(missing.stderr()).toContain("ANTHROPIC_API_KEY is not set");
    expect(missing.prompts()).toBe(0);
    const echo = present.events.findIndex(
      (event) => event.kind === "stderr" && event.text.includes("model=claude-sonnet-5-5"),
    );
    const prompt = present.events.findIndex((event) => event.kind === "prompt");
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(echo).toBeLessThan(prompt);
  });

  it("sends nothing for a blank line", async () => {
    const cli = harness([reply("Hi")], { lines: ["", "   ", "Hello"] });

    await expect(run([], cli.deps)).resolves.toBe(0);

    expect(cli.requests.map((request) => request.messages)).toEqual([
      [{ role: "user", content: "Hello" }],
    ]);
  });

  it("explains a failed turn, says it was left out, carries on, and exits 1 at the end", async () => {
    const cli = harness([apiError(400, "invalid_request_error", "bad"), reply("Hi")], {
      lines: ["First", "Second"],
    });

    await expect(run([], cli.deps)).resolves.toBe(1);

    expect(cli.stderr()).toContain("rejected the request (400): bad");
    expect(cli.stderr()).toContain("left out of the conversation");
    expect(cli.requests[1]?.messages).toEqual([{ role: "user", content: "Second" }]);
    expect(cli.stdout()).toBe("Hi\n");
  });

  it("exits 1 at the end when a turn was refused, though later turns completed", async () => {
    const cli = harness([reply("", "refusal"), reply("Hi")], { lines: ["First", "Second"] });

    await expect(run([], cli.deps)).resolves.toBe(1);

    expect(cli.stderr()).toContain("declined to answer");
    expect(cli.requests).toHaveLength(2);
  });

  it("exits 0 at the end only when every turn completed, a cut-off reply included", async () => {
    const cli = harness([reply("Hi"), reply("A very long", "max_tokens")], {
      lines: ["First", "Second"],
    });

    await expect(run([], cli.deps)).resolves.toBe(0);

    expect(cli.requests).toHaveLength(2);
  });

  it("ends with exit 130 on Ctrl-C at the prompt", async () => {
    const cli = harness([]);
    cli.deps.readLine = async () => {
      cli.interrupt.abort();
      return undefined;
    };

    await expect(run([], cli.deps)).resolves.toBe(EXIT_INTERRUPTED);
    expect(cli.requests).toEqual([]);
  });

  it("ends with exit 130 on Ctrl-C mid-reply, ending the line and reading nothing more", async () => {
    const live = new LiveReply();
    const cli = harness([live], { lines: ["Tell me about the role", "Never read"] });

    const exitCode = run([], cli.deps);
    live.send(messageStart(), textStart(), textDelta("The role is"));
    await vi.waitFor(() => expect(cli.stdout()).toBe("The role is"));
    cli.interrupt.abort();

    await expect(exitCode).resolves.toBe(EXIT_INTERRUPTED);
    expect(cli.stdout()).toBe("The role is\n");
    expect(cli.prompts()).toBe(1);
  });
});
