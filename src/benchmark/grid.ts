import { checkTemperatureSupport } from "@/config.js";
import { findModel, type ModelInfo } from "@/models.js";
import { CASES, type BenchmarkCase } from "./fixtures.js";
import { TECHNIQUES, type Technique } from "./prompts.js";

/** One configuration of the benchmark: a case, a technique, a model and a temperature. */
export interface BenchmarkCell {
  readonly benchmarkCase: BenchmarkCase;
  readonly technique: Technique;
  readonly model: ModelInfo;
  /** `undefined` sends no temperature, so the model uses its default. */
  readonly temperature: number | undefined;
}

/** A model and the temperature it is run at. */
export interface ModelSetting {
  readonly modelId: string;
  readonly temperature: number | undefined;
}

/** The temperatures compared on every model that still accepts one. */
export const TEMPERATURES = [0, 0.7] as const;

/**
 * The last generation of each family that accepts a temperature. Only these
 * can show what temperature does.
 */
export const TEMPERATURE_MODEL_IDS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"];

/**
 * The current generation of each family. Each rejects any temperature but its
 * default, so each is run once, at that default, with none sent.
 */
export const DEFAULT_TEMPERATURE_MODEL_IDS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
];

/**
 * Every model setting the benchmark runs: the temperature axis
 * ({@link TEMPERATURE_MODEL_IDS} × {@link TEMPERATURES}), then the current
 * models at their default temperature.
 */
export const MODEL_SETTINGS: readonly ModelSetting[] = [
  ...TEMPERATURE_MODEL_IDS.flatMap((modelId) =>
    TEMPERATURES.map((temperature) => ({ modelId, temperature })),
  ),
  ...DEFAULT_TEMPERATURE_MODEL_IDS.map((modelId) => ({ modelId, temperature: undefined })),
];

/**
 * Every cell of the benchmark — each case × technique × model setting — in
 * the order the results table lists them. Throws if a setting names an
 * unknown model or a temperature the model would reject: that is a mistake
 * in the grid, and it should cost nothing to find.
 */
export function expandGrid(
  settings: readonly ModelSetting[] = MODEL_SETTINGS,
  cases: readonly BenchmarkCase[] = CASES,
  techniques: readonly Technique[] = TECHNIQUES,
): BenchmarkCell[] {
  const models = settings.map(({ modelId, temperature }) => {
    const model = findModel(modelId);
    if (model === undefined || model.id !== modelId) {
      throw new Error(`The benchmark grid names an unknown model ID: ${modelId}.`);
    }
    const unsupported = checkTemperatureSupport(model, temperature);
    if (unsupported !== undefined) {
      throw new Error(`The benchmark grid is invalid: ${unsupported}`);
    }
    return { model, temperature };
  });

  return cases.flatMap((benchmarkCase) =>
    techniques.flatMap((technique) =>
      models.map(({ model, temperature }) => ({ benchmarkCase, technique, model, temperature })),
    ),
  );
}

/** A short, stable label for a cell, used in progress lines and the raw records. */
export function cellLabel(cell: BenchmarkCell): string {
  const temperature = cell.temperature === undefined ? "default" : String(cell.temperature);
  return `${cell.benchmarkCase.id} ${cell.technique} ${cell.model.id} t=${temperature}`;
}
