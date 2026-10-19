import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeSpend, priceTurn, type RequestEnding, type RequestSpend } from "./cost.js";
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
  ending: RequestEnding = "complete",
  billed = true,
): RequestSpend {
  const reported = usage(fields);
  return {
    model: info,
    ending,
    usage: reported,
    billed,
    costUsd: billed ? costUsd(info, reported) : 0,
  };
}

/**
 * A reply that completed as a refusal in `category`: before any output when
 * `content` is empty, as the API sends one, or after some had streamed.
 */
function refusal(
  category: Anthropic.RefusalStopDetails["category"],
  content: Anthropic.ContentBlock[] = [],
): Extract<TurnOutcome, { status: "complete" }> {
  const reported = usage({ input_tokens: 400, output_tokens: content.length === 0 ? 0 : 60 });
  return {
    status: "complete",
    model: opus.id,
    usage: reported,
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: opus.id,
      content,
      container: null,
      diagnostics: null,
      stop_details: { type: "refusal", category, explanation: null },
      stop_reason: "refusal",
      stop_sequence: null,
      usage: reported,
    },
  };
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
        ending: status,
        usage: reported,
        billed: true,
        costUsd: costUsd(haiku, reported),
      });
    },
  );

  it.each(["bio", "frontier_llm", "reasoning_extraction"] as const)(
    "prices a refusal before any output in %s, a category Anthropic bills",
    (category) => {
      const outcome = refusal(category);

      expect(priceTurn(opus, outcome)).toMatchObject({ ending: "refused", billed: true });
      expect(priceTurn(opus, outcome)?.costUsd).toBe(costUsd(opus, outcome.usage));
      expect(priceTurn(opus, outcome)?.costUsd).toBeGreaterThan(0);
    },
  );

  it.each(["cyber", "general_harms", null] as const)(
    "prices a refusal before any output in category %s at nothing, as Anthropic does not bill it",
    (category) => {
      const outcome = refusal(category);

      expect(priceTurn(opus, outcome)).toEqual({
        model: opus,
        ending: "refused",
        usage: outcome.usage,
        billed: false,
        costUsd: 0,
      });
    },
  );

  it("prices a refusal that came after output had streamed, whatever its category", () => {
    const outcome = refusal("cyber", [{ type: "text", text: "Here is how", citations: null }]);

    expect(priceTurn(opus, outcome)).toMatchObject({ ending: "refused", billed: true });
    expect(priceTurn(opus, outcome)?.costUsd).toBe(costUsd(opus, outcome.usage));
  });
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

  it("marks refused requests, listing one Anthropic does not bill at $0 with the tokens it reported", () => {
    const report = describeSpend([
      spent(opus, { input_tokens: 400 }, "refused", false),
      spent(opus, { input_tokens: 1_000, output_tokens: 500 }, "refused"),
    ]);

    expect(report).toBe(
      [
        "spend this session, priced from the usage each response reported:",
        "Requests:",
        "  model            input  cache read  cache write  output      cost",
        "  claude-opus-5-5    400           0            0       0  $0.00000  (refused, not billed)",
        "  claude-opus-5-5  1,000           0            0     500  $0.01400  (refused)",
        "By model:",
        "  model            requests  input  cache read  cache write  output      cost",
        "  claude-opus-5-5         2  1,400           0            0     500  $0.01400",
        "  total                   2  1,400           0            0     500  $0.01400",
      ].join("\n"),
    );
  });
});
