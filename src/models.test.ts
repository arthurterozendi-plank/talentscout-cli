import { describe, expect, it } from "vitest";
import {
  costUsd,
  countTokens,
  DEFAULT_MODEL_ID,
  findModel,
  formatUsd,
  MODEL_ALIASES,
  MODELS,
  type ModelInfo,
  type TokenUsage,
} from "./models.js";

function model(id: string): ModelInfo {
  const found = findModel(id);
  if (found === undefined) throw new Error(`unknown model ${id}`);
  return found;
}

function usage(fields: Partial<TokenUsage>): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    cache_creation: null,
    ...fields,
  };
}

describe("findModel", () => {
  it("finds a model by its exact ID", () => {
    expect(findModel("claude-haiku-4-5")?.id).toBe("claude-haiku-4-5");
  });

  it("resolves each alias to the current model of its family", () => {
    expect(findModel("opus")?.id).toBe("claude-opus-5-5");
    expect(findModel("sonnet")?.id).toBe("claude-sonnet-5-5");
    expect(findModel("haiku")?.id).toBe("claude-haiku-5-5");
  });

  it.each(["claude-haiku-4.5", "Haiku", "claude-haiku", "constructor", ""])(
    "does not recognise %j",
    (name) => {
      expect(findModel(name)).toBeUndefined();
    },
  );
});

describe("the alias table and the default", () => {
  it("point only at models the CLI knows", () => {
    for (const id of [...MODEL_ALIASES.values(), DEFAULT_MODEL_ID]) {
      expect(findModel(id), id).toBeDefined();
    }
  });
});

describe("pricing", () => {
  // The pricing page states the cache rules for every rate card, and on
  // 2026-10-19 every card's output price was five times its input price.
  // Checking the table against both catches a mistyped price; a new model that
  // breaks the output ratio has to be checked against the page and the ratio
  // dropped here.
  const cacheReadMultiplier: Record<string, number> = {
    "claude-fable-5-1": 0.025,
    "claude-opus-5-5": 0.05,
    "claude-sonnet-5-5": 0.05,
  };

  it.each(MODELS.map((candidate) => [candidate.id, candidate] as const))(
    "%s follows the published price ratios",
    (id, candidate) => {
      const cards = [candidate.pricing, candidate.pricing.longPrompt].filter((card) => !!card);
      for (const card of cards) {
        expect(card.output).toBeCloseTo(card.input * 5, 10);
        expect(card.cacheWrite5m).toBeCloseTo(card.input * 1.25, 10);
        expect(card.cacheWrite1h).toBeCloseTo(card.input * 2, 10);
        expect(card.cacheRead).toBeCloseTo(card.input * (cacheReadMultiplier[id] ?? 0.1), 10);
      }
    },
  );
});

describe("costUsd", () => {
  it("prices input and output tokens per million at the model's rates", () => {
    // claude-sonnet-4-6: $3 input, $15 output per million tokens.
    const cost = costUsd(
      model("claude-sonnet-4-6"),
      usage({ input_tokens: 2_000, output_tokens: 500 }),
    );

    expect(cost).toBeCloseTo(0.006 + 0.0075, 10);
  });

  it("prices cache reads and each cache-write TTL at their own rates", () => {
    // claude-opus-5-5: $4 input, $20 output, $0.20 cache read, $5 5m write, $8 1h write.
    const cost = costUsd(
      model("claude-opus-5-5"),
      usage({
        input_tokens: 1_000,
        output_tokens: 100,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
      }),
    );

    expect(cost).toBeCloseTo(0.004 + 0.002 + 0.002 + 0.01 + 0.008, 10);
  });

  it("prices cache writes from the TTL breakdown when the total is missing", () => {
    // claude-haiku-4-5: $1.25 per million 5-minute writes, $2 per million 1-hour writes.
    const cost = costUsd(
      model("claude-haiku-4-5"),
      usage({
        cache_creation_input_tokens: null,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    );

    expect(cost).toBeCloseTo(2, 10);
  });

  it("prices cache writes without a TTL breakdown at the 5-minute rate", () => {
    const cost = costUsd(
      model("claude-haiku-4-5"),
      usage({ cache_creation_input_tokens: 1_000_000, cache_creation: null }),
    );

    expect(cost).toBeCloseTo(1.25, 10);
  });

  it("treats null cache counts as zero", () => {
    expect(costUsd(model("claude-haiku-4-5"), usage({ input_tokens: 1_000_000 }))).toBeCloseTo(
      1,
      10,
    );
  });

  it("keeps claude-haiku-5-5 on its standard card for a prompt of exactly 100,000 tokens", () => {
    const cost = costUsd(
      model("claude-haiku-5-5"),
      usage({ input_tokens: 100_000, output_tokens: 1_000_000 }),
    );

    expect(cost).toBeCloseTo(0.01 + 0.5, 10);
  });

  it("moves claude-haiku-5-5 to its long-prompt card when cached tokens push the prompt past 100,000", () => {
    const cost = costUsd(
      model("claude-haiku-5-5"),
      usage({ input_tokens: 1_000, output_tokens: 1_000_000, cache_read_input_tokens: 100_000 }),
    );

    // $0.50 input, $2.50 output, $0.05 cache read per million on the long-prompt card.
    expect(cost).toBeCloseTo(0.0005 + 2.5 + 0.005, 10);
  });
});

describe("countTokens", () => {
  it("reads one count per rate, splitting cache writes by TTL and treating null as zero", () => {
    expect(
      countTokens(
        usage({
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 3_000,
          cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
        }),
      ),
    ).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite5m: 2_000, cacheWrite1h: 1_000 });
  });
});

describe("formatUsd", () => {
  it("shows five decimal places, so a fraction of a cent is still visible", () => {
    expect(formatUsd(0.0019)).toBe("$0.00190");
    expect(formatUsd(12.5)).toBe("$12.50000");
    expect(formatUsd(0)).toBe("$0.00000");
  });

  it("never shows a cost that rounds to nothing as free", () => {
    expect(formatUsd(0.0000035)).toBe("<$0.00001");
  });
});
