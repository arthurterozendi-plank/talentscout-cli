import { costUsd, countTokens, formatUsd, type ModelInfo, type TokenUsage } from "./models.js";
import type { TurnOutcome } from "./turn.js";

/**
 * One request that reported usage, priced at the rates of the model it was
 * sent to. `usage` is what the stream itself reported, so a reply that broke
 * off is priced on the counts the API had sent when it stopped.
 */
export interface RequestSpend {
  readonly model: ModelInfo;
  /** How the turn ended; only a `complete` turn's reply arrived in full. */
  readonly status: TurnOutcome["status"];
  readonly usage: TokenUsage;
  /** {@link costUsd} of `usage`, computed once when the request ended. */
  readonly costUsd: number;
}

/**
 * What the request `outcome` ended cost, or `undefined` when its stream never
 * started and so reported no usage: a request that failed before
 * `message_start` adds nothing. Any other outcome is priced on exactly the
 * usage the stream reported, never on an estimate of what it did not report.
 */
export function priceTurn(model: ModelInfo, outcome: TurnOutcome): RequestSpend | undefined {
  if (outcome.usage === undefined) {
    return undefined;
  }
  return {
    model,
    status: outcome.status,
    usage: outcome.usage,
    costUsd: costUsd(model, outcome.usage),
  };
}

interface Totals {
  readonly requests: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly costUsd: number;
}

function sum(requests: readonly RequestSpend[]): Totals {
  let totals: Totals = {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
  };
  for (const request of requests) {
    const tokens = countTokens(request.usage);
    totals = {
      requests: totals.requests + 1,
      input: totals.input + tokens.input,
      cacheRead: totals.cacheRead + tokens.cacheRead,
      cacheWrite: totals.cacheWrite + tokens.cacheWrite5m + tokens.cacheWrite1h,
      output: totals.output + tokens.output,
      costUsd: totals.costUsd + request.costUsd,
    };
  }
  return totals;
}

interface Column {
  readonly header: string;
  readonly align: "left" | "right";
}

const left = (header: string): Column => ({ header, align: "left" });
const right = (header: string): Column => ({ header, align: "right" });

const AMOUNT_COLUMNS = ["input", "cache read", "cache write", "output", "cost"].map(right);

const count = (value: number) => value.toLocaleString("en-US");

const amounts = (totals: Totals) => [
  count(totals.input),
  count(totals.cacheRead),
  count(totals.cacheWrite),
  count(totals.output),
  formatUsd(totals.costUsd),
];

const NOTES: Readonly<Record<TurnOutcome["status"], string>> = {
  complete: "",
  interrupted: "(interrupted)",
  failed: "(failed partway)",
};

/** A header line and one line per row, indented, each column padded to its widest cell. */
function table(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map((column) => column.header), ...rows];
  const widths = columns.map((_, index) =>
    Math.max(...lines.map((line) => (line[index] ?? "").length)),
  );
  return lines
    .map((line) => {
      const cells = columns.map((column, index) => {
        const cell = line[index] ?? "";
        const width = widths[index] ?? 0;
        return column.align === "left" ? cell.padEnd(width) : cell.padStart(width);
      });
      return `  ${cells.join("  ")}`.trimEnd();
    })
    .join("\n");
}

/**
 * The `/cost` report: every request that reported usage, in the order sent,
 * then the same tokens and dollars summed for each model, in the order the
 * models were first used, and for the whole session.
 */
export function describeSpend(spend: readonly RequestSpend[]): string {
  if (spend.length === 0) {
    return "nothing spent yet: no request in this session has reported usage.";
  }

  const byModel = new Map<string, RequestSpend[]>();
  for (const request of spend) {
    byModel.set(request.model.id, [...(byModel.get(request.model.id) ?? []), request]);
  }

  const requests = table(
    [left("model"), ...AMOUNT_COLUMNS, left("")],
    spend.map((request) => [request.model.id, ...amounts(sum([request])), NOTES[request.status]]),
  );
  const models = table(
    [left("model"), right("requests"), ...AMOUNT_COLUMNS],
    [
      ...[...byModel].map(([id, entries]) => [id, count(entries.length), ...amounts(sum(entries))]),
      ["total", count(spend.length), ...amounts(sum(spend))],
    ],
  );
  return [
    "spend this session, priced from the usage each response reported:",
    "Requests:",
    requests,
    "By model:",
    models,
  ].join("\n");
}
