import Anthropic from "@anthropic-ai/sdk";

const BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** What {@link withRetry} reports just before it waits and tries again. */
export interface RetryEvent {
  /** 1 for the first retry, 2 for the second, and so on. */
  retry: number;
  maxRetries: number;
  delayMs: number;
  error: unknown;
}

/**
 * How {@link withRetry} retries. `sleep` and `random` are injected so the
 * backoff schedule is deterministic under test.
 */
export interface RetryOptions {
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
  onRetry?: (event: RetryEvent) => void;
}

/** Thrown when every attempt failed with an error worth retrying. */
export class RetriesExhaustedError extends Error {
  /** Total attempts made, including the first. */
  readonly attempts: number;
  /** The error the final attempt failed with. */
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(`Gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}.`, { cause: lastError });
    this.name = "RetriesExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Whether a failed request is worth repeating unchanged: a 429 rate limit, a
 * 5xx (which includes 529 overloaded), or a dropped connection. A timeout is
 * not retried, because each attempt already waited the full timeout.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return false;
  }
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  );
}

/**
 * The wait before retry number `retry` (1-based): exponential backoff from
 * 500 ms, capped at 8 s, with "equal jitter" — half the step is fixed, so the
 * wait still grows, and half is random, so clients that failed together do not
 * retry together.
 */
export function backoffDelayMs(retry: number, random: () => number): number {
  const step = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** (retry - 1));
  return step / 2 + (random() * step) / 2;
}

function retryAfterMs(error: unknown): number {
  if (!(error instanceof Anthropic.APIError) || error.headers === undefined) {
    return 0;
  }
  const seconds = Number(error.headers.get("retry-after") ?? "");
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 0;
}

/**
 * Runs `operation`, retrying it with {@link backoffDelayMs} while it fails
 * with a {@link isRetryable} error. A `retry-after` header from the API raises
 * the wait to at least what the server asked for. Any other error is rethrown
 * at once; running out of retries throws {@link RetriesExhaustedError}.
 *
 * The SDK client must be built with `maxRetries: 0`, or its own retries
 * multiply with these.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      if (attempt > options.maxRetries) {
        throw new RetriesExhaustedError(attempt, error);
      }
      const delayMs = Math.max(backoffDelayMs(attempt, options.random), retryAfterMs(error));
      options.onRetry?.({ retry: attempt, maxRetries: options.maxRetries, delayMs, error });
      await options.sleep(delayMs);
    }
  }
}
