import { findModel, MODELS, type ModelInfo } from "./models.js";

/** The settings every request in a run is sent with. */
export interface ChatConfig {
  readonly model: ModelInfo;
  /** `undefined` leaves the parameter out, so the model uses its own default. */
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly maxRetries: number;
}

/** The raw flag values, as typed on the command line. */
export interface ConfigFlags {
  model?: string;
  temperature?: string;
  maxRetries?: string;
}

/** Either a usable {@link ChatConfig} or the reason the flags were rejected. */
export type ConfigResult = { ok: true; config: ChatConfig } | { ok: false; error: string };

/**
 * A ceiling, not a target: only generated tokens are billed. It leaves room
 * for the thinking that later models always do, which counts against it, and
 * stays below the size at which the SDK insists on streaming.
 */
export const MAX_TOKENS = 16_000;

/** Retries after the first attempt when `--max-retries` is not given. */
export const DEFAULT_MAX_RETRIES = 4;

const MAX_RETRIES_LIMIT = 10;

/**
 * Validates the flags and turns them into a {@link ChatConfig}. Every check
 * that can be made without the API happens here, so a bad model name or
 * temperature never costs a request.
 */
export function buildConfig(flags: ConfigFlags): ConfigResult {
  if (flags.model === undefined) {
    return { ok: false, error: "--model is required." };
  }
  const model = findModel(flags.model);
  if (model === undefined) {
    const known = MODELS.map((candidate) => candidate.id).join(", ");
    return { ok: false, error: `unknown model "${flags.model}". Choose one of: ${known}.` };
  }

  let temperature: number | undefined;
  if (flags.temperature !== undefined) {
    temperature = Number(flags.temperature);
    if (flags.temperature.trim() === "" || !(temperature >= 0 && temperature <= 1)) {
      return {
        ok: false,
        error: `--temperature must be a number from 0 to 1; got "${flags.temperature}".`,
      };
    }
    if (!model.acceptsTemperature) {
      const accepting = MODELS.filter((candidate) => candidate.acceptsTemperature)
        .map((candidate) => candidate.id)
        .join(", ");
      return {
        ok: false,
        error:
          `${model.id} does not accept --temperature: models released after Claude Opus 4.6 ` +
          `reject any value but their default. Omit --temperature, or choose one of: ${accepting}.`,
      };
    }
  }

  let maxRetries = DEFAULT_MAX_RETRIES;
  if (flags.maxRetries !== undefined) {
    maxRetries = Number(flags.maxRetries);
    if (!/^\d+$/.test(flags.maxRetries) || maxRetries > MAX_RETRIES_LIMIT) {
      return {
        ok: false,
        error: `--max-retries must be a whole number from 0 to ${MAX_RETRIES_LIMIT}; got "${flags.maxRetries}".`,
      };
    }
  }

  return { ok: true, config: { model, temperature, maxTokens: MAX_TOKENS, maxRetries } };
}

/**
 * One line naming exactly what each request will be sent with, so a run's
 * output can be read without knowing which flags produced it.
 */
export function describeConfig(config: ChatConfig): string {
  const temperature = config.temperature === undefined ? "default" : String(config.temperature);
  return (
    `model=${config.model.id} temperature=${temperature} ` +
    `max_tokens=${config.maxTokens} max_retries=${config.maxRetries}`
  );
}
