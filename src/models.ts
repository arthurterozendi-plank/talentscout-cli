import type Anthropic from "@anthropic-ai/sdk";

/**
 * One rate card, in USD per million tokens, for the Claude API's standard
 * tier at standard speed with the default global routing.
 */
export interface TokenPrices {
  /** Input tokens that were neither read from nor written to the cache. */
  readonly input: number;
  readonly output: number;
  /** Input tokens served from the prompt cache ("cache hits and refreshes"). */
  readonly cacheRead: number;
  /** Input tokens written to the cache with the default 5-minute TTL. */
  readonly cacheWrite5m: number;
  /** Input tokens written to the cache with the 1-hour TTL. */
  readonly cacheWrite1h: number;
}

/**
 * What a model costs. Most models have one rate card for every prompt length;
 * `longPrompt` is the second card a model switches to for a prompt longer
 * than `aboveTokens`, counting cached tokens as part of the prompt.
 */
export interface ModelPricing extends TokenPrices {
  readonly longPrompt?: TokenPrices & { readonly aboveTokens: number };
}

/** A Claude model the CLI will send requests to. */
export interface ModelInfo {
  /** The exact model ID sent to the API. */
  readonly id: string;
  /**
   * Whether the model accepts a `temperature` other than its default. Only
   * models released up to Claude Opus 4.6 do; every later model answers any
   * other value with a 400.
   */
  readonly acceptsTemperature: boolean;
  /**
   * List prices from Anthropic's pricing page,
   * https://platform.claude.com/docs/en/about-claude/pricing, as published on
   * 2026-10-19. Every cost the repo reports is computed from these by
   * {@link costUsd}, so a price change is made here and nowhere else.
   */
  readonly pricing: ModelPricing;
}

/**
 * Every model `--model` accepts. A name missing from this list is rejected
 * before any request is sent. The Project Glasswing-only Mythos models are
 * left out because a training engineer's key cannot use them.
 */
export const MODELS: readonly ModelInfo[] = [
  {
    id: "claude-fable-5-1",
    acceptsTemperature: false,
    pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
  {
    id: "claude-fable-5",
    acceptsTemperature: false,
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
  {
    id: "claude-opus-5-5",
    acceptsTemperature: false,
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  },
  {
    id: "claude-opus-5",
    acceptsTemperature: false,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  {
    id: "claude-opus-4-8",
    acceptsTemperature: false,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  {
    id: "claude-opus-4-7",
    acceptsTemperature: false,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  {
    id: "claude-opus-4-6",
    acceptsTemperature: true,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  {
    id: "claude-sonnet-5-5",
    acceptsTemperature: false,
    pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
  {
    id: "claude-sonnet-5",
    acceptsTemperature: false,
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
  {
    id: "claude-sonnet-4-6",
    acceptsTemperature: true,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  },
  {
    id: "claude-haiku-5-5",
    acceptsTemperature: false,
    pricing: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      longPrompt: {
        aboveTokens: 100_000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite5m: 0.625,
        cacheWrite1h: 1,
      },
    },
  },
  {
    id: "claude-haiku-4-5",
    acceptsTemperature: true,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  },
];

/**
 * Short names `--model` accepts, mapped to the model ID each stands for. They
 * follow Anthropic's own naming, so each names the current generation of its
 * family — none of which accepts `--temperature`.
 */
export const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["opus", "claude-opus-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
]);

/** The model a request goes to when `--model` is not given. */
export const DEFAULT_MODEL_ID = "claude-sonnet-5-5";

/**
 * Looks up a model by its exact ID or by an alias from
 * {@link MODEL_ALIASES}; `undefined` when the CLI does not know the name.
 */
export function findModel(name: string): ModelInfo | undefined {
  const id = MODEL_ALIASES.get(name) ?? name;
  return MODELS.find((model) => model.id === id);
}

/** The fields of a response's `usage` that are billed per token. */
export type TokenUsage = Pick<
  Anthropic.Usage,
  | "input_tokens"
  | "output_tokens"
  | "cache_read_input_tokens"
  | "cache_creation_input_tokens"
  | "cache_creation"
>;

/**
 * What one response cost in USD, computed from the `usage` the API returned
 * and the model's {@link ModelInfo.pricing}. Each kind of token is priced at
 * its own rate: uncached input, cache reads, 5-minute and 1-hour cache writes,
 * and output (which includes any thinking).
 *
 * Cache writes the API does not break down by TTL are priced at the 5-minute
 * rate, the default TTL. A model with a `longPrompt` rate card is priced on it
 * when the whole prompt — uncached, read and written tokens together — is
 * longer than its threshold. Only the standard tier is priced: batch, fast mode
 * and US-only inference are billed at other rates this does not model.
 */
export function costUsd(model: ModelInfo, usage: TokenUsage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;

  const { longPrompt } = model.pricing;
  const prices =
    longPrompt !== undefined && promptTokens > longPrompt.aboveTokens ? longPrompt : model.pricing;

  const perMillion =
    usage.input_tokens * prices.input +
    usage.output_tokens * prices.output +
    cacheRead * prices.cacheRead +
    cacheWrite5m * prices.cacheWrite5m +
    cacheWrite1h * prices.cacheWrite1h;
  return perMillion / 1_000_000;
}
