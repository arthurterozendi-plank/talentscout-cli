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
}

/**
 * Every model `--model` accepts. A name missing from this list is rejected
 * before any request is sent. The Project Glasswing-only Mythos models are
 * left out because a training engineer's key cannot use them.
 */
export const MODELS: readonly ModelInfo[] = [
  { id: "claude-fable-5-1", acceptsTemperature: false },
  { id: "claude-fable-5", acceptsTemperature: false },
  { id: "claude-opus-5-5", acceptsTemperature: false },
  { id: "claude-opus-5", acceptsTemperature: false },
  { id: "claude-opus-4-8", acceptsTemperature: false },
  { id: "claude-opus-4-7", acceptsTemperature: false },
  { id: "claude-opus-4-6", acceptsTemperature: true },
  { id: "claude-sonnet-5-5", acceptsTemperature: false },
  { id: "claude-sonnet-5", acceptsTemperature: false },
  { id: "claude-sonnet-4-6", acceptsTemperature: true },
  { id: "claude-haiku-5-5", acceptsTemperature: false },
  { id: "claude-haiku-4-5", acceptsTemperature: true },
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

/**
 * Every name a model can be chosen by, worded to follow "Choose": the model
 * IDs, then the aliases. `--model` and `/model` both use it, so the two offer
 * the same choices in the same words.
 */
export function describeModelChoices(): string {
  const ids = MODELS.map((model) => model.id).join(", ");
  const aliases = [...MODEL_ALIASES.keys()].join(", ");
  return `a model ID (${ids}) or an alias (${aliases})`;
}
