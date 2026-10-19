import { describe, expect, it } from "vitest";
import { CASES } from "./fixtures.js";
import { expandGrid } from "./grid.js";
import { TECHNIQUES } from "./prompts.js";

const settingsOf = (cells: ReturnType<typeof expandGrid>) =>
  cells.map((cell) => `${cell.model.id}@${cell.temperature ?? "default"}`);

describe("expandGrid", () => {
  const cells = expandGrid();

  it("runs every case with every technique on every model setting", () => {
    expect(cells).toHaveLength(CASES.length * TECHNIQUES.length * 9);
  });

  it("compares temperature 0 and 0.7 on the models that accept one, and runs the current models at their default", () => {
    expect(new Set(settingsOf(cells))).toEqual(
      new Set([
        "claude-haiku-4-5@0",
        "claude-haiku-4-5@0.7",
        "claude-sonnet-4-6@0",
        "claude-sonnet-4-6@0.7",
        "claude-opus-4-6@0",
        "claude-opus-4-6@0.7",
        "claude-haiku-5-5@default",
        "claude-sonnet-5-5@default",
        "claude-opus-5-5@default",
      ]),
    );
  });

  it("never gives a temperature to a model that rejects one", () => {
    for (const cell of cells) {
      if (!cell.model.acceptsTemperature) {
        expect(cell.temperature, cell.model.id).toBeUndefined();
      }
    }
  });

  it("gives every case and technique the same nine model settings", () => {
    for (const benchmarkCase of CASES) {
      for (const technique of TECHNIQUES) {
        const group = cells.filter(
          (cell) => cell.benchmarkCase === benchmarkCase && cell.technique === technique,
        );
        expect(settingsOf(group), `${benchmarkCase.id} ${technique}`).toHaveLength(9);
        expect(new Set(settingsOf(group)).size).toBe(9);
      }
    }
  });

  it("rejects a temperature for a model that does not accept one, before any request", () => {
    expect(() => expandGrid([{ modelId: "claude-sonnet-5-5", temperature: 0.7 }])).toThrow(
      "claude-sonnet-5-5 does not accept --temperature",
    );
  });

  it.each(["claude-sonnet-9", "sonnet"])(
    "rejects %j, which is not an exact model ID",
    (modelId) => {
      expect(() => expandGrid([{ modelId, temperature: undefined }])).toThrow(
        `unknown model ID: ${modelId}`,
      );
    },
  );
});
