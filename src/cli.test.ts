import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { run, type CliDeps } from "./cli.js";

const API_KEY = "fake-key-for-tests-0123456789";

function reply(text: string, stopReason: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function apiError(status: number, type: string, message = `${type} message`) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
  );
}

type Event = { kind: "stdout" | "stderr" | "request"; text: string };

/**
 * Fakes everything `run` touches. The fake client answers each request with
 * the next of `outcomes`, throwing it if it is an error.
 */
function harness(
  outcomes: Array<Anthropic.Message | Error>,
  env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: API_KEY },
) {
  const events: Event[] = [];
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const sleeps: number[] = [];
  const clientKeys: string[] = [];
  const deps: CliDeps = {
    env,
    stdout: (text) => events.push({ kind: "stdout", text }),
    stderr: (text) => events.push({ kind: "stderr", text }),
    createClient: (apiKey) => {
      clientKeys.push(apiKey);
      return {
        messages: {
          create: async (params) => {
            requests.push(params);
            events.push({ kind: "request", text: "" });
            const outcome = outcomes.shift();
            if (outcome === undefined) {
              throw new Error("the fake client has no more outcomes");
            }
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        },
      };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  };
  const output = (kind: Event["kind"]) =>
    events
      .filter((event) => event.kind === kind)
      .map((event) => event.text)
      .join("");
  return {
    deps,
    events,
    requests,
    sleeps,
    clientKeys,
    stdout: () => output("stdout"),
    stderr: () => output("stderr"),
  };
}

describe("help and usage", () => {
  it.each([["--help"], ["-h"], []])(
    "prints usage to stdout and exits 0 for %j",
    async (...argv) => {
      const cli = harness([]);

      await expect(run(argv, cli.deps)).resolves.toBe(0);
      expect(cli.stdout()).toMatch(/^Usage: talentscout-cli --model <id>/);
      expect(cli.stderr()).toBe("");
      expect(cli.clientKeys).toEqual([]);
    },
  );

  it("marks the models that accept --temperature", async () => {
    const cli = harness([]);

    await run(["--help"], cli.deps);

    expect(cli.stdout()).toMatch(/^ {2}claude-haiku-4-5 \*$/m);
    expect(cli.stdout()).toMatch(/^ {2}claude-haiku-5-5$/m);
  });

  it("prints usage to stderr, names the flag, and exits 1 for an unknown flag", async () => {
    const cli = harness([]);

    await expect(run(["--bogus"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("--bogus");
    expect(cli.stderr()).toContain("Usage:");
    expect(cli.stderr()).not.toContain("    at ");
  });

  it("exits 1 when flags are given but no prompt", async () => {
    const cli = harness([]);

    await expect(run(["--model", "claude-haiku-4-5"], cli.deps)).resolves.toBe(1);
    expect(cli.stderr()).toContain("no prompt given");
    expect(cli.requests).toEqual([]);
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
        max_tokens: 16_000,
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

  it("rejects a temperature for a model that would answer it with a 400", async () => {
    const cli = harness([]);

    await expect(
      run(["--model", "claude-haiku-5-5", "--temperature", "0", "Hello"], cli.deps),
    ).resolves.toBe(1);
    expect(cli.stderr()).toContain("claude-haiku-5-5 does not accept --temperature");
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
      const cli = harness([], env);

      await expect(run(["--model", "claude-haiku-4-5", "Hello"], cli.deps)).resolves.toBe(1);
      expect(cli.stderr()).toContain("ANTHROPIC_API_KEY is not set");
      expect(cli.clientKeys).toEqual([]);
    },
  );

  it("does not mask a placeholder short enough to match ordinary words", async () => {
    const cli = harness([reply("Hi")], { ANTHROPIC_API_KEY: "x" });

    await run(["--model", "claude-haiku-4-5", "Hello"], cli.deps);

    expect(cli.stderr()).toContain("max_tokens=16000 max_retries=4");
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
    expect(cli.stderr()).toContain("cut off at max_tokens=16000");
  });
});
