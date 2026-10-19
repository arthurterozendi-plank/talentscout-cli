import {
  DEFAULT_MODEL_ID,
  describeModelChoices,
  findModel,
  MODELS,
  type ModelInfo,
} from "./models.js";

/** The settings every request in a run is sent with. */
export interface ChatConfig {
  readonly model: ModelInfo;
  /** `undefined` leaves the parameter out, so the model uses its own default. */
  readonly temperature: number | undefined;
  /**
   * The top-level system prompt. `undefined` sends none, which is how every
   * run starts: only `/system` sets one.
   */
  readonly system: string | undefined;
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
 * A ceiling, not a target: only generated tokens are billed. Requests stream,
 * so the SDK's size limit on non-streaming requests no longer applies; this
 * leaves room for the thinking later models always do, which counts against
 * it, while still capping what a runaway reply can cost.
 */
export const MAX_TOKENS = 32_000;

/** Retries after the first attempt when `--max-retries` is not given. */
export const DEFAULT_MAX_RETRIES = 4;

const MAX_RETRIES_LIMIT = 10;

/**
 * Validates the flags and turns them into a {@link ChatConfig}. Every check
 * that can be made without the API happens here, so a bad model name or
 * temperature never costs a request.
 */
export function buildConfig(flags: ConfigFlags): ConfigResult {
  const name = flags.model ?? DEFAULT_MODEL_ID;
  const model = findModel(name);
  if (model === undefined) {
    return { ok: false, error: `unknown model "${name}". Choose ${describeModelChoices()}.` };
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
  }
  const unsupported = checkTemperatureSupport(model, temperature);
  if (unsupported !== undefined) {
    return { ok: false, error: unsupported };
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

  return {
    ok: true,
    config: { model, temperature, system: undefined, maxTokens: MAX_TOKENS, maxRetries },
  };
}

/**
 * Why `model` cannot be sent `temperature`, or `undefined` when it can (an
 * unset temperature always can). The one place this rule lives, so a check
 * made at startup and one made after switching models cannot disagree.
 */
export function checkTemperatureSupport(
  model: ModelInfo,
  temperature: number | undefined,
): string | undefined {
  if (temperature === undefined || model.acceptsTemperature) {
    return undefined;
  }
  const accepting = MODELS.filter((candidate) => candidate.acceptsTemperature)
    .map((candidate) => candidate.id)
    .join(", ");
  return (
    `${model.id} does not accept --temperature: models released after Claude Opus 4.6 reject ` +
    `any value but their default. Omit --temperature, or pass --model with one of: ${accepting}.`
  );
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
