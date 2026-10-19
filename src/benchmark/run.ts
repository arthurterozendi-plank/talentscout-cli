import Anthropic from "@anthropic-ai/sdk";
import { buildMessageParams, responseText, type MessagesClient } from "@/client.js";
import { DEFAULT_MAX_RETRIES, MAX_TOKENS, type ChatConfig } from "@/config.js";
import { describeFailure } from "@/errors.js";
import { costUsd } from "@/models.js";
import { withRetry, type RetryEvent } from "@/retry.js";
import { cellLabel, type BenchmarkCell } from "./grid.js";
import { buildPrompt, parseScore, STOP_SEQUENCE } from "./prompts.js";

/**
 * How one request ended. Only `scored` produced a usable score; every other
 * outcome is a result in its own right, recorded rather than thrown.
 */
export type Outcome = "scored" | "malformed" | "truncated" | "refusal" | "error";

/** One request of the benchmark and everything measured about it. */
export interface RunRecord {
  readonly cell: BenchmarkCell;
  /** 1-based repetition number within the cell. */
  readonly rep: number;
  readonly outcome: Outcome;
  readonly score: number | undefined;
  /** Wall-clock time of the attempt that got a reply; retries' waits excluded. */
  readonly latencyMs: number | undefined;
  /** The API's own token counts; `undefined` when no reply came back. */
  readonly usage: Anthropic.Usage | undefined;
  /** Computed from `usage`, never estimated. */
  readonly costUsd: number | undefined;
  readonly stopReason: Anthropic.StopReason | null | undefined;
  /** The reply's text, kept so a malformed one can be read afterwards. */
  readonly text: string | undefined;
  /** Why the request failed, when `outcome` is `error`. */
  readonly error: string | undefined;
}

/** One request to make: a cell and which repetition of it this is. */
export interface PlannedRequest {
  readonly cell: BenchmarkCell;
  readonly rep: number;
}

/** What {@link runRequest} needs from the outside world. */
export interface RunOptions {
  client: MessagesClient;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
  /** A monotonic clock in milliseconds, like `performance.now`. */
  now: () => number;
  onRetry?: (event: RetryEvent) => void;
}

/**
 * Every request of a run, repetition by repetition: each cell once, then each
 * cell again. Once the first repetition is done, a run stopped part-way still
 * covers every cell, and the repetitions of one cell are spread across the run
 * instead of sent back to back.
 */
export function planRequests(cells: readonly BenchmarkCell[], reps: number): PlannedRequest[] {
  return Array.from({ length: reps }, (_, index) =>
    cells.map((cell) => ({ cell, rep: index + 1 })),
  ).flat();
}

/**
 * The request a cell sends: the shared request shape from
 * {@link buildMessageParams} — so a temperature is sent only when the cell
 * sets one — plus the technique's system prompt and the stop sequence.
 */
export function buildRequest(cell: BenchmarkCell): Anthropic.MessageCreateParamsNonStreaming {
  const { system, messages } = buildPrompt(cell.technique, cell.benchmarkCase);
  const config: ChatConfig = {
    model: cell.model,
    temperature: cell.temperature,
    maxTokens: MAX_TOKENS,
    maxRetries: DEFAULT_MAX_RETRIES,
  };
  return { ...buildMessageParams(config, messages), system, stop_sequences: [STOP_SEQUENCE] };
}

/**
 * Sends one request, retrying transient failures, and records what came
 * back. A failed request, a refusal and a reply without a valid score are all
 * recorded as outcomes. The one error rethrown is a rejected API key
 * (`Anthropic.AuthenticationError`), since no later request could succeed.
 */
export async function runRequest(
  { cell, rep }: PlannedRequest,
  options: RunOptions,
): Promise<RunRecord> {
  const params = buildRequest(cell);
  let latencyMs: number | undefined;
  let message: Anthropic.Message;
  try {
    message = await withRetry(
      async () => {
        const started = options.now();
        const reply = await options.client.messages.create(params);
        latencyMs = options.now() - started;
        return reply;
      },
      {
        maxRetries: options.maxRetries,
        sleep: options.sleep,
        random: options.random,
        onRetry: options.onRetry,
      },
    );
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw error;
    }
    return {
      cell,
      rep,
      outcome: "error",
      score: undefined,
      latencyMs: undefined,
      usage: undefined,
      costUsd: undefined,
      stopReason: undefined,
      text: undefined,
      error: describeFailure(error, cell.model.id),
    };
  }

  const text = responseText(message);
  // A cut-off reply is never parsed: "<score>7" may be the start of 72.
  const truncated =
    message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded";
  let outcome: Outcome = "scored";
  let score: number | undefined;
  if (message.stop_reason === "refusal") {
    outcome = "refusal";
  } else if (truncated) {
    outcome = "truncated";
  } else {
    score = parseScore(text);
    outcome = score === undefined ? "malformed" : "scored";
  }
  return {
    cell,
    rep,
    outcome,
    score,
    latencyMs,
    usage: message.usage,
    costUsd: costUsd(cell.model, message.usage),
    stopReason: message.stop_reason,
    text,
    error: undefined,
  };
}

/**
 * A record as one line of JSON, flattened to IDs so the raw results can be
 * read without the code that produced them.
 */
export function recordToJson(record: RunRecord): string {
  return JSON.stringify({
    cell: cellLabel(record.cell),
    case: record.cell.benchmarkCase.id,
    technique: record.cell.technique,
    model: record.cell.model.id,
    temperature: record.cell.temperature ?? null,
    rep: record.rep,
    outcome: record.outcome,
    score: record.score ?? null,
    latencyMs: record.latencyMs ?? null,
    costUsd: record.costUsd ?? null,
    stopReason: record.stopReason ?? null,
    usage: record.usage ?? null,
    text: record.text ?? null,
    error: record.error ?? null,
  });
}
