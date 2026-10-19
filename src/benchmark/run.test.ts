import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { MAX_TOKENS } from "@/config.js";
import {
  apiError,
  blockStop,
  fakeClient,
  LiveReply,
  messageDelta,
  messageStart,
  messageStop,
  streamError,
  textDelta,
  textStart,
  type ScriptedReply,
} from "@/fake-client.js";
import { expandGrid, type BenchmarkCell } from "./grid.js";
import { buildRequest, planRequests, recordToJson, runRequest, type RunOptions } from "./run.js";

/** Every event of a streamed reply whose text is `text`. */
function reply(
  text: string,
  stopReason: Anthropic.StopReason = "stop_sequence",
  tokens = { input: 1_000, output: 10 },
): Anthropic.MessageStreamEvent[] {
  return [
    messageStart({ input_tokens: tokens.input }),
    textStart(),
    textDelta(text),
    blockStop(),
    messageDelta(stopReason, { output_tokens: tokens.output }),
    messageStop,
  ];
}

function cell(modelId: string, temperature: number | undefined): BenchmarkCell {
  const found = expandGrid().find(
    (candidate) =>
      candidate.model.id === modelId &&
      candidate.temperature === temperature &&
      candidate.benchmarkCase.id === "baseline" &&
      candidate.technique === "zero-shot",
  );
  if (found === undefined) throw new Error(`no ${modelId} cell at ${temperature}`);
  return found;
}

/**
 * The fake streaming client answering with each of `replies` in turn, and a
 * clock that returns each of `ticks` in turn. `now()` is read when an attempt
 * is sent, when its first text arrives, and when its message is complete.
 */
function options(replies: ScriptedReply[], ticks: number[] = []) {
  const sleeps: number[] = [];
  const fake = fakeClient(replies);
  let clockReads = 0;
  const opts: RunOptions = {
    client: fake.client,
    maxRetries: 2,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => {
      clockReads++;
      return ticks.shift() ?? 0;
    },
  };
  return { opts, sleeps, requests: fake.requests, clockReads: () => clockReads };
}

describe("buildRequest", () => {
  it("sends no temperature at all to a model that rejects one", () => {
    const params = buildRequest(cell("claude-opus-5-5", undefined));

    expect(params.model).toBe("claude-opus-5-5");
    expect(params).not.toHaveProperty("temperature");
  });

  it("sends a temperature of 0 rather than dropping it as falsy", () => {
    expect(buildRequest(cell("claude-haiku-4-5", 0))).toHaveProperty("temperature", 0);
  });

  it("sends the technique's system prompt, the stop sequence and the shared max_tokens", () => {
    const params = buildRequest(cell("claude-sonnet-4-6", 0.7));

    expect(params.system).toContain("You are TalentScout");
    expect(params.stop_sequences).toEqual(["</score>"]);
    expect(params.max_tokens).toBe(MAX_TOKENS);
    expect(params.temperature).toBe(0.7);
  });
});

describe("planRequests", () => {
  it("plans every cell once per repetition, finishing each repetition before the next", () => {
    const cells = expandGrid();
    const plan = planRequests(cells, 3);

    expect(plan).toHaveLength(cells.length * 3);
    expect(plan.slice(0, cells.length).every((request) => request.rep === 1)).toBe(true);
    expect(plan.slice(-cells.length).every((request) => request.rep === 3)).toBe(true);
    expect(plan.slice(-cells.length).map((request) => request.cell)).toEqual(cells);
  });
});

describe("runRequest", () => {
  const sonnet = cell("claude-sonnet-4-6", 0);

  it("records the score, both latencies and the cost computed from usage", async () => {
    const { opts } = options(
      [reply("<score>72", "stop_sequence", { input: 1_000, output: 10 })],
      [100, 600, 1_350],
    );

    const record = await runRequest({ cell: sonnet, rep: 2 }, opts);

    expect(record).toMatchObject({
      rep: 2,
      outcome: "scored",
      score: 72,
      firstTextMs: 500,
      latencyMs: 1_250,
    });
    // claude-sonnet-4-6: $3 per million input tokens, $15 per million output tokens.
    expect(record.costUsd).toBeCloseTo((1_000 * 3 + 10 * 15) / 1_000_000, 10);
    expect(record.usage?.input_tokens).toBe(1_000);
  });

  it("records a reply without a valid score as malformed, keeping its text and cost", async () => {
    const { opts } = options([reply("I would give this candidate 72.", "end_turn")]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(record).toMatchObject({
      outcome: "malformed",
      score: undefined,
      text: "I would give this candidate 72.",
    });
    expect(record.costUsd).toBeGreaterThan(0);
  });

  it("records a reply cut off at max_tokens before the score as truncated", async () => {
    const { opts } = options([reply("<analysis>still going", "max_tokens")]);

    expect((await runRequest({ cell: sonnet, rep: 1 }, opts)).outcome).toBe("truncated");
  });

  it.each(["max_tokens", "model_context_window_exceeded"] as const)(
    "never reads a score from a reply cut off by %s, whose last digit may be missing",
    async (stopReason) => {
      const { opts } = options([reply("<score>7", stopReason)]);

      const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

      expect(record).toMatchObject({ outcome: "truncated", score: undefined });
    },
  );

  it("records a refusal as a refusal, not a score", async () => {
    const { opts } = options([reply("<score>50", "refusal")]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(record).toMatchObject({ outcome: "refusal", score: undefined });
  });

  it("retries a failure to open the stream and times only the attempt that got a reply", async () => {
    const { opts, sleeps, requests } = options(
      [apiError(529, "overloaded_error"), reply("<score>80")],
      [0, 5_000, 5_300, 5_800],
    );

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(record).toMatchObject({
      outcome: "scored",
      score: 80,
      firstTextMs: 300,
      latencyMs: 800,
    });
  });

  it("never retries once the reply has started, and keeps the usage it reported", async () => {
    const live = new LiveReply();
    const { opts, requests, clockReads } = options([live, reply("<score>80")]);

    const pending = runRequest({ cell: sonnet, rep: 1 }, opts);
    live.send(messageStart({ input_tokens: 1_000 }), textStart(), textDelta("<analysis>"));
    // Sent, then first text: the reply is under way.
    await vi.waitFor(() => expect(clockReads()).toBe(2));
    live.fail(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    const record = await pending;

    expect(requests).toHaveLength(1);
    expect(record).toMatchObject({ outcome: "error", score: undefined, latencyMs: undefined });
    expect(record.usage?.input_tokens).toBe(1_000);
    // claude-sonnet-4-6 at $3 per million input tokens; the start reports 1 output token.
    expect(record.costUsd).toBeCloseTo((1_000 * 3 + 1 * 15) / 1_000_000, 10);
    expect(record.error).toEqual(expect.any(String));
  });

  it("records an error event inside a started stream, with the reason the API gave", async () => {
    const live = new LiveReply();
    const { opts, clockReads } = options([live]);

    const pending = runRequest({ cell: sonnet, rep: 1 }, opts);
    live.send(messageStart(), textStart(), textDelta("<analysis>"));
    await vi.waitFor(() => expect(clockReads()).toBe(2));
    live.fail(streamError("overloaded_error", "Overloaded"));

    const record = await pending;
    expect(record.outcome).toBe("error");
    expect(record.error).toContain("stopped the reply with an error (overloaded_error)");
  });

  it("records a request that kept failing as an error, with no usage or cost", async () => {
    const { opts, requests } = options([
      apiError(500, "api_error"),
      apiError(500, "api_error"),
      apiError(500, "api_error"),
    ]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(requests).toHaveLength(3);
    expect(record).toMatchObject({
      outcome: "error",
      score: undefined,
      usage: undefined,
      costUsd: undefined,
    });
    expect(record.error).toContain("server error (500)");
  });

  it("records a rejected request as an error without retrying it", async () => {
    const { opts, requests } = options([apiError(400, "invalid_request_error")]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(requests).toHaveLength(1);
    expect(record.error).toContain("rejected the request (400)");
  });

  it("rethrows a rejected API key, since no later request could succeed", async () => {
    const { opts } = options([apiError(401, "authentication_error")]);

    await expect(runRequest({ cell: sonnet, rep: 1 }, opts)).rejects.toBeInstanceOf(
      Anthropic.AuthenticationError,
    );
  });
});

describe("recordToJson", () => {
  it("flattens the cell to IDs and writes a default temperature as null", async () => {
    const { opts } = options([reply("<score>55")], [0, 400, 2_000]);
    const record = await runRequest({ cell: cell("claude-haiku-5-5", undefined), rep: 3 }, opts);

    expect(JSON.parse(recordToJson(record))).toMatchObject({
      case: "baseline",
      technique: "zero-shot",
      model: "claude-haiku-5-5",
      temperature: null,
      rep: 3,
      outcome: "scored",
      score: 55,
      latencyMs: 2_000,
      firstTextMs: 400,
      text: "<score>55",
    });
  });
});
