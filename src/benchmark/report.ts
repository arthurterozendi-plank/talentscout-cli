import { MAX_TOKENS } from "@/config.js";
import { costUsd } from "@/models.js";
import { cellLabel, type BenchmarkCell } from "./grid.js";
import { STOP_SEQUENCE } from "./prompts.js";
import { buildRequest, type PlannedRequest, type RunRecord } from "./run.js";

/** What the header of a results report says about the run. */
export interface ReportMeta {
  /** True when the replies came from the dry-run fake, not the API. */
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly reps: number;
  /** Why the run stopped early, if it did. */
  readonly abortedBecause?: string;
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const seconds = (ms: number) => (ms / 1000).toFixed(1);

const integer = (value: number) => Math.round(value).toLocaleString("en-US");

// Five decimals, because a claude-haiku-5-5 run costs a few thousandths of a cent.
function usd(value: number): string {
  return value > 0 && value < 0.00001 ? "<$0.00001" : `$${value.toFixed(5)}`;
}

/** The table's columns, and how one cell's records fill each of them. */
const COLUMNS: ReadonlyArray<{
  header: string;
  value: (cell: BenchmarkCell, records: readonly RunRecord[]) => string;
}> = [
  { header: "Case", value: (cell) => cell.benchmarkCase.id },
  { header: "Technique", value: (cell) => cell.technique },
  { header: "Model", value: (cell) => cell.model.id },
  {
    header: "Temp",
    value: (cell) => (cell.temperature === undefined ? "default" : String(cell.temperature)),
  },
  {
    header: "Scores by rep",
    value: (_, records) =>
      records.length === 0
        ? "not run"
        : records.map((record) => record.score ?? record.outcome).join(", "),
  },
  {
    header: "Mean",
    value: (_, records) => {
      const scores = scoresOf(records);
      return scores.length === 0 ? "—" : mean(scores).toFixed(1);
    },
  },
  {
    header: "Spread",
    value: (_, records) => {
      const scores = scoresOf(records);
      return scores.length === 0 ? "—" : String(Math.max(...scores) - Math.min(...scores));
    },
  },
  {
    header: "Failed",
    value: (_, records) =>
      `${records.filter((record) => record.outcome !== "scored").length}/${records.length}`,
  },
  {
    header: "Latency s, mean (min–max)",
    value: (_, records) => {
      const latencies = records.flatMap((record) => record.latencyMs ?? []);
      if (latencies.length === 0) return "—";
      const range = `${seconds(Math.min(...latencies))}–${seconds(Math.max(...latencies))}`;
      return `${seconds(mean(latencies))} (${range})`;
    },
  },
  {
    header: "First text s, mean",
    value: (_, records) => {
      const times = records.flatMap((record) => record.firstTextMs ?? []);
      return times.length === 0 ? "—" : seconds(mean(times));
    },
  },
  {
    header: "Tokens in / out, mean",
    value: (_, records) => {
      const usages = records.flatMap((record) => record.usage ?? []);
      if (usages.length === 0) return "—";
      const input = mean(usages.map((usage) => usage.input_tokens));
      const output = mean(usages.map((usage) => usage.output_tokens));
      return `${integer(input)} / ${integer(output)}`;
    },
  },
  {
    header: "Cost per run, mean",
    value: (_, records) => {
      const costs = records.flatMap((record) => record.costUsd ?? []);
      return costs.length === 0 ? "—" : usd(mean(costs));
    },
  },
];

function scoresOf(records: readonly RunRecord[]): number[] {
  return records.flatMap((record) => record.score ?? []);
}

function markdownTable(header: readonly string[], body: readonly (readonly string[])[]): string {
  const rows = [header, ...body];
  const widths = header.map((_, column) =>
    Math.max(3, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n",
  );
}

/**
 * The single comparison table: one row per cell, in grid order, including
 * cells a stopped run never reached. Every repetition's score is listed, so
 * variation between runs of the same configuration is visible beside the
 * mean, and latency, tokens and cost come from the replies themselves.
 */
export function renderTable(
  cells: readonly BenchmarkCell[],
  records: readonly RunRecord[],
): string {
  const rows = cells.map((cell) => {
    const label = cellLabel(cell);
    const cellRecords = records
      .filter((record) => cellLabel(record.cell) === label)
      .sort((a, b) => a.rep - b.rep);
    return COLUMNS.map((column) => column.value(cell, cellRecords));
  });
  return markdownTable(
    COLUMNS.map((column) => column.header),
    rows,
  );
}

/** A complete Markdown report of a run: what was run, totals, then the table. */
export function renderReport(
  cells: readonly BenchmarkCell[],
  records: readonly RunRecord[],
  meta: ReportMeta,
): string {
  const failures = records.filter((record) => record.outcome !== "scored");
  const byOutcome = [...new Set(failures.map((record) => record.outcome))].map(
    (outcome) => `${failures.filter((record) => record.outcome === outcome).length} ${outcome}`,
  );
  const totalCost = records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const cases = [...new Set(cells.map((cell) => cell.benchmarkCase))];

  const lines = [
    "# Resume scoring benchmark — results",
    "",
    ...(meta.dryRun
      ? [
          "> **Dry run.** Every reply below was made up by a fake client; no request reached the",
          "> API. The scores, latencies and costs show the pipeline works and mean nothing else.",
          "> Pass `--live` for a real run.",
          "",
        ]
      : []),
    ...(meta.abortedBecause === undefined
      ? []
      : [`> **Stopped early:** ${meta.abortedBecause}`, ""]),
    `- Started: ${meta.startedAt.toISOString()}`,
    `- Repetitions per cell: ${meta.reps}`,
    `- Requests: ${records.length} sent, ${records.length - failures.length} scored, ` +
      `${failures.length} failed${byOutcome.length === 0 ? "" : ` (${byOutcome.join(", ")})`}`,
    `- Total cost: ${usd(totalCost)}, summed from each reply's usage`,
    `- Every request: max_tokens ${MAX_TOKENS}, stop sequence \`${STOP_SEQUENCE}\`, no prompt caching, ` +
      "thinking and effort left at each model's default",
    '- Temp "default": no temperature sent; these models reject any value but their default',
    "",
    "Cases:",
    "",
    ...cases.map((benchmarkCase) => `- \`${benchmarkCase.id}\`: ${benchmarkCase.purpose}`),
    "",
    renderTable(cells, records),
    "",
  ];
  return lines.join("\n");
}

/**
 * The most a set of requests could cost: every reply running to
 * `max_tokens`, and every prompt costed at two characters per token, more
 * generous than any current tokenizer. The real cost is far lower. Each
 * request is counted once, because one is retried only while its reply has
 * not started: once the first event arrives, a failure is recorded instead.
 */
export function costCeilingUsd(requests: readonly PlannedRequest[]): number {
  return requests.reduce((sum, { cell }) => {
    const params = buildRequest(cell);
    const characters =
      (typeof params.system === "string" ? params.system.length : 0) +
      params.messages.reduce(
        (count, message) =>
          count + (typeof message.content === "string" ? message.content.length : 0),
        0,
      );
    return (
      sum +
      costUsd(cell.model, {
        input_tokens: Math.ceil(characters / 2),
        output_tokens: MAX_TOKENS,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cache_creation: null,
      })
    );
  }, 0);
}
