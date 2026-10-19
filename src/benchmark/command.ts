import { join } from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@/client.js";
import { DEFAULT_MAX_RETRIES } from "@/config.js";
import { describeFailure, describeRetry } from "@/errors.js";
import { createDryRunClient } from "./dry-run.js";
import { cellLabel, expandGrid } from "./grid.js";
import { costCeilingUsd, renderReport } from "./report.js";
import { planRequests, recordToJson, runRequest, type RunRecord } from "./run.js";

/**
 * Everything the benchmark needs from the outside world. `main.ts` supplies
 * the real process, SDK client, clocks and file system; tests supply fakes.
 */
export interface BenchmarkDeps {
  /** Read for `ANTHROPIC_API_KEY` and nothing else. */
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  createClient: (apiKey: string) => MessagesClient;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
  /** A monotonic clock in milliseconds, like `performance.now`, for latency. */
  now: () => number;
  /** The wall clock, for the report header and the results' file names. */
  date: () => Date;
  /** Appends to a file, creating it and its directory if needed. */
  appendFile: (path: string, text: string) => Promise<void>;
  /** Writes a file, creating its directory if needed. */
  writeFile: (path: string, text: string) => Promise<void>;
}

/** Runs of each configuration when `--reps` is not given. */
export const DEFAULT_REPS = 3;

/** Where a live run writes its results when `--out` is not given. */
export const DEFAULT_OUT_DIR = "benchmarks/resume-scoring/results";

const MIN_REPS = 2;
const MAX_REPS = 10;

// As in the CLI: a real key is long, and masking a short placeholder would
// mangle ordinary words while protecting nothing.
const MIN_MASKED_KEY_LENGTH = 20;

const USAGE = `Usage: pnpm benchmark [--live] [--reps <n>] [--out <dir>]

Scores resumes against job descriptions with every prompting technique, model
and temperature in the grid, each configuration several times, and prints one
comparison table with every configuration's scores, latency and cost.

Without --live this is a dry run: a fake client answers with made-up replies,
so no API key is read, no request is sent and no file is written.

Options:
  --live         Send the requests to the API. This costs money.
  --reps <n>     Runs of each configuration, ${MIN_REPS} to ${MAX_REPS} (default ${DEFAULT_REPS}).
  --out <dir>    Where a live run writes its results
                 (default ${DEFAULT_OUT_DIR}).
  -h, --help     Show this help.

A live run reads the API key from ANTHROPIC_API_KEY, prints the most the run
can cost, then sends every request. It writes <timestamp>.jsonl, one line per
request as it completes, and <timestamp>.md, the table, at the end.
`;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      live: { type: "boolean" },
      reps: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
}

function progress(record: RunRecord): string {
  const outcome =
    record.outcome === "scored"
      ? `score ${record.score}`
      : record.outcome === "error"
        ? `error: ${record.error}`
        : record.outcome;
  const latency =
    record.latencyMs === undefined ? "" : `, ${(record.latencyMs / 1000).toFixed(1)}s`;
  const cost = record.costUsd === undefined ? "" : `, $${record.costUsd.toFixed(4)}`;
  return `${cellLabel(record.cell)} rep ${record.rep}: ${outcome}${latency}${cost}`;
}

/**
 * Runs the benchmark from raw argv and resolves to its exit code: `0` once
 * every request has been made (malformed replies and failed requests are
 * results, recorded in the table), `1` for bad flags, `--live` without a key,
 * or a run stopped by a rejected key. Only `--live` sends requests or writes
 * files; without it the run is a dry run against a fake client, whatever the
 * environment holds. The table goes to stdout; the plan, progress and errors
 * to stderr.
 */
export async function runBenchmark(argv: string[], deps: BenchmarkDeps): Promise<number> {
  const apiKey = deps.env["ANTHROPIC_API_KEY"]?.trim() ? deps.env["ANTHROPIC_API_KEY"] : undefined;
  const mask = (text: string) =>
    apiKey === undefined || apiKey.length < MIN_MASKED_KEY_LENGTH
      ? text
      : text.replaceAll(apiKey, "[redacted]");
  const stdout = (text: string) => deps.stdout(mask(text));
  const stderr = (text: string) => deps.stderr(`benchmark: ${mask(text)}\n`);

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : "Unknown option."}\n\n${USAGE}`);
    return 1;
  }
  const { values } = parsed;
  if (values.help === true) {
    stdout(USAGE);
    return 0;
  }

  const reps = values.reps === undefined ? DEFAULT_REPS : Number(values.reps);
  if (
    values.reps !== undefined &&
    (!/^\d+$/.test(values.reps) || reps < MIN_REPS || reps > MAX_REPS)
  ) {
    stderr(
      `--reps must be a whole number from ${MIN_REPS} to ${MAX_REPS}; got "${values.reps}". ` +
        "One run per configuration cannot tell a real difference from run-to-run variation.",
    );
    return 1;
  }

  // A key exported for other tools must not turn a plain run into spend, so
  // only --live ever builds a real client.
  const live = values.live === true;
  const dryRun = !live;
  if (live && apiKey === undefined) {
    stderr(
      "ANTHROPIC_API_KEY is not set, so no request can be sent. Export your Anthropic API key " +
        "in it and run again, or leave out --live for a dry run.",
    );
    return 1;
  }

  const cells = expandGrid();
  const requests = planRequests(cells, reps);
  const startedAt = deps.date();
  stderr(
    `${live ? "sending" : "dry run — pass --live to send"} ${requests.length} requests ` +
      `(${cells.length} configurations × ${reps} reps). If every reply ran to max_tokens, a ` +
      `live run would cost $${costCeilingUsd(requests).toFixed(2)}; expect a small fraction ` +
      "of that.",
  );

  const client =
    live && apiKey !== undefined ? deps.createClient(apiKey) : createDryRunClient(deps.random);
  const stamp = startedAt.toISOString().replaceAll(/[:.]/g, "-");
  const outDir = values.out ?? DEFAULT_OUT_DIR;
  const recordsPath = join(outDir, `${stamp}.jsonl`);

  const records: RunRecord[] = [];
  let abortedBecause: string | undefined;
  for (const [index, request] of requests.entries()) {
    let record: RunRecord;
    try {
      record = await runRequest(request, {
        client,
        maxRetries: DEFAULT_MAX_RETRIES,
        sleep: deps.sleep,
        random: deps.random,
        now: deps.now,
        onRetry: (event) => stderr(describeRetry(event)),
      });
    } catch (error) {
      if (!(error instanceof Anthropic.AuthenticationError)) {
        throw error;
      }
      abortedBecause = `${describeFailure(error, request.cell.model.id)} No further request was sent.`;
      stderr(abortedBecause);
      break;
    }
    records.push(record);
    if (!dryRun) {
      await deps.appendFile(recordsPath, `${mask(recordToJson(record))}\n`);
    }
    stderr(`[${index + 1}/${requests.length}] ${progress(record)}`);
  }

  const report = renderReport(cells, records, { dryRun, startedAt, reps, abortedBecause });
  stdout(report);
  if (!dryRun) {
    const reportPath = join(outDir, `${stamp}.md`);
    await deps.writeFile(reportPath, mask(report));
    stderr(
      records.length === 0 ? `wrote ${reportPath}.` : `wrote ${reportPath} and ${recordsPath}.`,
    );
  }
  return abortedBecause === undefined ? 0 : 1;
}
