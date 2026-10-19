import {
  BILLED_REFUSAL_CATEGORIES,
  costUsd,
  countTokens,
  formatUsd,
  type ModelInfo,
  type TokenUsage,
} from "./models.js";
import type { TurnOutcome } from "./turn.js";

/**
 * How a request ended: its turn's status, or `refused` for a reply that
 * completed with `stop_reason: "refusal"`.
 */
export type RequestEnding = TurnOutcome["status"] | "refused";

/**
 * One request that reported usage, priced at the rates of the model it was
 * sent to. `usage` is what the stream itself reported, so a reply that broke
 * off is priced on the counts the API had sent when it stopped.
 */
export interface RequestSpend {
  readonly model: ModelInfo;
  readonly ending: RequestEnding;
  readonly usage: TokenUsage;
  /**
   * Whether Anthropic bills the request. Only a refusal that arrived before
   * any output, in a category outside {@link BILLED_REFUSAL_CATEGORIES}, is
   * not billed.
   */
  readonly billed: boolean;
  /** {@link costUsd} of `usage` when `billed`, and 0 when not. */
  readonly costUsd: number;
}

/**
 * What the request `outcome` ended cost, or `undefined` when its stream never
 * started and so reported no usage: a request that failed before
 * `message_start` adds nothing. Any other outcome is priced on exactly the
 * usage the stream reported, never on an estimate of what it did not report —
 * except a refusal that arrived before any output, with no content, in a
 * category Anthropic does not bill, which is kept at $0.
 */
export function priceTurn(model: ModelInfo, outcome: TurnOutcome): RequestSpend | undefined {
  if (outcome.usage === undefined) {
    return undefined;
  }
  let ending: RequestEnding = outcome.status;
  let billed = true;
  if (outcome.status === "complete" && outcome.message.stop_reason === "refusal") {
    ending = "refused";
    billed =
      outcome.message.content.length > 0 ||
      BILLED_REFUSAL_CATEGORIES.has(outcome.message.stop_details?.category ?? null);
  }
  return {
    model,
    ending,
    usage: outcome.usage,
    billed,
    costUsd: billed ? costUsd(model, outcome.usage) : 0,
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

function note(request: RequestSpend): string {
  switch (request.ending) {
    case "complete":
      return "";
    case "refused":
      return request.billed ? "(refused)" : "(refused, not billed)";
    case "interrupted":
      return "(interrupted)";
    case "failed":
      return "(failed partway)";
  }
}

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
 * models were first used, and for the whole session. A request that was not
 * billed is still listed, with the tokens it reported and its $0, so every
 * column of the totals is the sum of the rows above it.
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
    spend.map((request) => [request.model.id, ...amounts(sum([request])), note(request)]),
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
