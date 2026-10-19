import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { expandGrid, type BenchmarkCell } from "./grid.js";
import { costCeilingUsd, renderReport, renderTable } from "./report.js";
import type { Outcome, RunRecord } from "./run.js";

const cells = expandGrid();
const [first, second] = cells as [BenchmarkCell, BenchmarkCell];

function usage(input: number, output: number): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: input,
    output_tokens: output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  };
}

function record(
  cell: BenchmarkCell,
  rep: number,
  outcome: Outcome,
  score: number | undefined,
  latencyMs: number | undefined,
  costUsd: number | undefined,
  tokens: [number, number] | undefined,
): RunRecord {
  return {
    cell,
    rep,
    outcome,
    score,
    latencyMs,
    // A quarter of the latency, so the column's mean is checkable at a glance.
    firstTextMs: latencyMs === undefined ? undefined : latencyMs / 4,
    usage: tokens === undefined ? undefined : usage(...tokens),
    costUsd,
    stopReason: undefined,
    text: undefined,
    error: outcome === "error" ? "The request kept failing." : undefined,
  };
}

// Out of rep order on purpose: the table must list them by rep.
const records = [
  record(first, 3, "malformed", undefined, 3_000, 0.003, [1_000, 30]),
  record(first, 1, "scored", 70, 1_000, 0.001, [1_000, 10]),
  record(first, 2, "scored", 76, 2_000, 0.002, [1_000, 20]),
];

function rows(table: string): string[][] {
  return table.split("\n").map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
}

describe("renderTable", () => {
  const [header, separator, ...body] = rows(renderTable(cells, records));

  it("has a row for every cell, including those with no runs yet", () => {
    expect(body).toHaveLength(cells.length);
    expect(body[1]).toEqual([
      second.benchmarkCase.id,
      second.technique,
      second.model.id,
      String(second.temperature),
      "not run",
      "—",
      "—",
      "0/0",
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  it("shows every repetition's result in rep order, with the mean and spread of the scores", () => {
    const row = Object.fromEntries((header ?? []).map((title, index) => [title, body[0]?.[index]]));

    expect(row).toEqual({
      Case: "baseline",
      Technique: "zero-shot",
      Model: "claude-haiku-4-5",
      Temp: "0",
      "Scores by rep": "70, 76, malformed",
      Mean: "73.0",
      Spread: "6",
      Failed: "1/3",
      "Latency s, mean (min–max)": "2.0 (1.0–3.0)",
      "First text s, mean": "0.5",
      "Tokens in / out, mean": "1,000 / 20",
      "Cost per run, mean": "$0.00200",
    });
  });

  it("is a well-formed Markdown table with aligned columns", () => {
    const lines = renderTable(cells, records).split("\n");

    expect(separator?.every((cell) => /^-{3,}$/.test(cell))).toBe(true);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it('labels a cell that sends no temperature "default"', () => {
    const opus = body.find((row) => row[2] === "claude-opus-5-5");

    expect(opus?.[3]).toBe("default");
  });
});

describe("renderReport", () => {
  const meta = { dryRun: false, startedAt: new Date("2026-10-19T12:00:00Z"), reps: 3 };

  it("states the totals, with failures broken down by outcome", () => {
    const report = renderReport(cells, records, meta);

    expect(report).toContain("- Requests: 3 sent, 2 scored, 1 failed (1 malformed)");
    expect(report).toContain("- Total cost: $0.00600");
    expect(report).toContain("- Repetitions per cell: 3");
  });

  it("marks a dry run so its numbers cannot be mistaken for results", () => {
    expect(renderReport(cells, records, { ...meta, dryRun: true })).toContain("**Dry run.**");
    expect(renderReport(cells, records, meta)).not.toContain("Dry run");
  });

  it("says why a run stopped early", () => {
    const report = renderReport(cells, [], { ...meta, abortedBecause: "The key was rejected." });

    expect(report).toContain("**Stopped early:** The key was rejected.");
  });

  it("describes each case once", () => {
    const report = renderReport(cells, records, meta);

    expect(report.match(/^- `baseline`:/gm)).toHaveLength(1);
    expect(report).toContain("- `unrelated-job`:");
    expect(report).toContain("- `missing-sections`:");
  });
});

describe("costCeilingUsd", () => {
  it("prices every reply at max_tokens, so it bounds what a run can cost", () => {
    const opus = cells.find((cell) => cell.model.id === "claude-opus-4-6");
    if (opus === undefined) throw new Error("no claude-opus-4-6 cell");

    const ceiling = costCeilingUsd([{ cell: opus, rep: 1 }]);

    // 32,000 output tokens at $25 per million, plus a few thousand input tokens at $5.
    expect(ceiling).toBeGreaterThan(0.8);
    expect(ceiling).toBeLessThan(0.85);
    expect(
      costCeilingUsd([
        { cell: opus, rep: 1 },
        { cell: opus, rep: 2 },
      ]),
    ).toBeCloseTo(ceiling * 2, 10);
  });
});
