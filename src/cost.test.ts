import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeSpend, priceTurn, type RequestSpend } from "./cost.js";
import { costUsd, findModel, type ModelInfo } from "./models.js";
import type { TurnOutcome } from "./turn.js";

function model(id: string): ModelInfo {
  const found = findModel(id);
  if (found === undefined) throw new Error(`unknown model ${id}`);
  return found;
}

const haiku = model("claude-haiku-5-5");
const opus = model("claude-opus-5-5");

function usage(fields: Partial<Anthropic.Usage>): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: 0,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...fields,
  };
}

function spent(
  info: ModelInfo,
  fields: Partial<Anthropic.Usage>,
  status: TurnOutcome["status"] = "complete",
): RequestSpend {
  const reported = usage(fields);
  return { model: info, status, usage: reported, costUsd: costUsd(info, reported) };
}

describe("priceTurn", () => {
  it("adds nothing for a request that failed before its stream reported usage", () => {
    const outcome: TurnOutcome = {
      status: "failed",
      model: haiku.id,
      usage: undefined,
      error: new Error("overloaded"),
    };

    expect(priceTurn(haiku, outcome)).toBeUndefined();
  });

  it.each(["interrupted", "failed"] as const)(
    "prices a reply that ended as %s on exactly the usage its stream reported",
    (status) => {
      const reported = usage({ input_tokens: 3_000, output_tokens: 4 });
      const outcome: TurnOutcome =
        status === "failed"
          ? { status, model: haiku.id, usage: reported, error: new Error("broke off") }
          : { status, model: haiku.id, usage: reported };

      expect(priceTurn(haiku, outcome)).toEqual({
        model: haiku,
        status,
        usage: reported,
        costUsd: costUsd(haiku, reported),
      });
    },
  );
});

describe("describeSpend", () => {
  it("says nothing has been spent before any request reported usage", () => {
    expect(describeSpend([])).toBe(
      "nothing spent yet: no request in this session has reported usage.",
    );
  });

  it("lists every request in order, then each model in first-use order, then the total", () => {
    const report = describeSpend([
      spent(haiku, { input_tokens: 20_000, output_tokens: 4_000 }),
      spent(opus, { input_tokens: 1_000, output_tokens: 500 }, "failed"),
      spent(haiku, { input_tokens: 10_000, cache_read_input_tokens: 50_000, output_tokens: 2_000 }),
    ]);

    expect(report).toBe(
      [
        "spend this session, priced from the usage each response reported:",
        "Requests:",
        "  model              input  cache read  cache write  output      cost",
        "  claude-haiku-5-5  20,000           0            0   4,000  $0.00400",
        "  claude-opus-5-5    1,000           0            0     500  $0.01400  (failed partway)",
        "  claude-haiku-5-5  10,000      50,000            0   2,000  $0.00250",
        "By model:",
        "  model             requests   input  cache read  cache write  output      cost",
        "  claude-haiku-5-5         2  30,000      50,000            0   6,000  $0.00650",
        "  claude-opus-5-5          1   1,000           0            0     500  $0.01400",
        "  total                    3  31,000      50,000            0   6,500  $0.02050",
      ].join("\n"),
    );
  });
});
