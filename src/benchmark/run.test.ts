import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { MAX_TOKENS } from "@/config.js";
import { expandGrid, type BenchmarkCell } from "./grid.js";
import { buildRequest, planRequests, recordToJson, runRequest, type RunOptions } from "./run.js";

function reply(
  text: string,
  stopReason: Anthropic.StopReason = "stop_sequence",
  tokens = { input: 1_000, output: 10 },
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text, citations: null }],
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: stopReason === "stop_sequence" ? "</score>" : null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function apiError(status: number, type: string) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: `${type} message` } },
    undefined,
    new Headers(),
  );
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
 * A fake client answering with each of `outcomes` in turn, and a clock that
 * returns each of `ticks` in turn.
 */
function options(outcomes: Array<Anthropic.Message | Error>, ticks: number[] = []) {
  const sleeps: number[] = [];
  let requests = 0;
  const opts: RunOptions = {
    client: {
      messages: {
        create: async () => {
          requests++;
          const outcome = outcomes.shift();
          if (outcome === undefined) throw new Error("the fake client has no more outcomes");
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      },
    },
    maxRetries: 2,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => ticks.shift() ?? 0,
  };
  return { opts, sleeps, requests: () => requests };
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

  it("records the score, the latency and the cost computed from usage", async () => {
    const { opts } = options(
      [reply("<score>72", "stop_sequence", { input: 1_000, output: 10 })],
      [100, 1_350],
    );

    const record = await runRequest({ cell: sonnet, rep: 2 }, opts);

    expect(record).toMatchObject({ rep: 2, outcome: "scored", score: 72, latencyMs: 1_250 });
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

  it("records a refusal as a refusal, not a score", async () => {
    const { opts } = options([reply("<score>50", "refusal")]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(record).toMatchObject({ outcome: "refusal", score: undefined });
  });

  it("retries a transient failure and times only the attempt that got a reply", async () => {
    const { opts, sleeps, requests } = options(
      [apiError(529, "overloaded_error"), reply("<score>80")],
      [0, 5_000, 5_800],
    );

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(requests()).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(record).toMatchObject({ outcome: "scored", score: 80, latencyMs: 800 });
  });

  it("records a request that kept failing as an error, with no usage or cost", async () => {
    const { opts, requests } = options([
      apiError(500, "api_error"),
      apiError(500, "api_error"),
      apiError(500, "api_error"),
    ]);

    const record = await runRequest({ cell: sonnet, rep: 1 }, opts);

    expect(requests()).toBe(3);
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

    expect(requests()).toBe(1);
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
    const { opts } = options([reply("<score>55")], [0, 2_000]);
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
      text: "<score>55",
    });
  });
});
