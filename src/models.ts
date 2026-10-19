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

/** Looks up a model by its exact ID; `undefined` when the CLI does not know it. */
export function findModel(name: string): ModelInfo | undefined {
  return MODELS.find((model) => model.id === name);
}
