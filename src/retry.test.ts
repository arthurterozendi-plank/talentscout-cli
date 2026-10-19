import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  isRetryable,
  RetriesExhaustedError,
  withRetry,
  type RetryEvent,
} from "./retry.js";

function apiError(status: number, type: string, headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: `${type} message` } },
    undefined,
    new Headers(headers),
  );
}

const rateLimited = () => apiError(429, "rate_limit_error");
const overloaded = () => apiError(529, "overloaded_error");

/** An operation that fails with each of `failures` in turn, then succeeds. */
function failingThen<T>(failures: Error[], value: T) {
  let calls = 0;
  const operation = async () => {
    const failure = failures[calls];
    calls += 1;
    if (failure !== undefined) {
      throw failure;
    }
    return value;
  };
  return { operation, calls: () => calls };
}

function recorder(random = () => 0.5) {
  const sleeps: number[] = [];
  const events: RetryEvent[] = [];
  return {
    sleeps,
    events,
    options: (maxRetries: number) => ({
      maxRetries,
      random,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      onRetry: (event: RetryEvent) => events.push(event),
    }),
  };
}

describe("backoffDelayMs", () => {
  it("doubles the wait with each retry", () => {
    const lowest = [1, 2, 3, 4, 5].map((retry) => backoffDelayMs(retry, () => 0));
    const highest = [1, 2, 3, 4, 5].map((retry) => backoffDelayMs(retry, () => 1));

    expect(lowest).toEqual([250, 500, 1000, 2000, 4000]);
    expect(highest).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it("adds jitter, so different random draws give different waits within the step", () => {
    const early = backoffDelayMs(3, () => 0.1);
    const late = backoffDelayMs(3, () => 0.9);

    expect(early).not.toBe(late);
    expect(early).toBeGreaterThanOrEqual(1000);
    expect(late).toBeLessThanOrEqual(2000);
  });

  it("stops growing at 8 seconds", () => {
    expect(backoffDelayMs(20, () => 1)).toBe(8000);
  });
});

describe("isRetryable", () => {
  it("retries rate limits, server errors including 529, and dropped connections", () => {
    expect(isRetryable(rateLimited())).toBe(true);
    expect(isRetryable(overloaded())).toBe(true);
    expect(isRetryable(apiError(500, "api_error"))).toBe(true);
    expect(isRetryable(new Anthropic.APIConnectionError({ message: "socket hang up" }))).toBe(true);
  });

  it("does not retry client errors, timeouts, or errors from outside the SDK", () => {
    expect(isRetryable(apiError(400, "invalid_request_error"))).toBe(false);
    expect(isRetryable(apiError(401, "authentication_error"))).toBe(false);
    expect(isRetryable(apiError(404, "not_found_error"))).toBe(false);
    expect(isRetryable(new Anthropic.APIConnectionTimeoutError())).toBe(false);
    expect(isRetryable(new Error("bug"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without waiting", async () => {
    const { operation, calls } = failingThen([], "reply");
    const record = recorder();

    await expect(withRetry(operation, record.options(4))).resolves.toBe("reply");
    expect(calls()).toBe(1);
    expect(record.sleeps).toEqual([]);
  });

  it("backs off exponentially with jitter through repeated 429s and then succeeds", async () => {
    const { operation, calls } = failingThen(
      [rateLimited(), rateLimited(), rateLimited()],
      "reply",
    );
    const record = recorder(() => 0.5);

    await expect(withRetry(operation, record.options(4))).resolves.toBe("reply");
    expect(calls()).toBe(4);
    expect(record.sleeps).toEqual([375, 750, 1500]);
    expect(record.events.map((event) => event.retry)).toEqual([1, 2, 3]);
  });

  it("retries a 529 overloaded response", async () => {
    const { operation, calls } = failingThen([overloaded()], "reply");

    await expect(withRetry(operation, recorder().options(4))).resolves.toBe("reply");
    expect(calls()).toBe(2);
  });

  it("waits at least as long as the API's retry-after header asks", async () => {
    const { operation } = failingThen(
      [apiError(429, "rate_limit_error", { "retry-after": "3" })],
      1,
    );
    const record = recorder();

    await withRetry(operation, record.options(4));
    expect(record.sleeps).toEqual([3000]);
  });

  it("caps a retry-after wait at a minute", async () => {
    const { operation } = failingThen(
      [apiError(429, "rate_limit_error", { "retry-after": "3600" })],
      1,
    );
    const record = recorder();

    await withRetry(operation, record.options(4));
    expect(record.sleeps).toEqual([60_000]);
  });

  it("rethrows a non-retryable error at once", async () => {
    const badRequest = apiError(400, "invalid_request_error");
    const { operation, calls } = failingThen([badRequest], "reply");
    const record = recorder();

    await expect(withRetry(operation, record.options(4))).rejects.toBe(badRequest);
    expect(calls()).toBe(1);
    expect(record.sleeps).toEqual([]);
  });

  it("gives up after maxRetries retries and reports the attempts and the last error", async () => {
    const last = overloaded();
    const { operation, calls } = failingThen([overloaded(), overloaded(), last], "never");
    const record = recorder();

    const failure = await withRetry(operation, record.options(2)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RetriesExhaustedError);
    expect(failure).toMatchObject({ attempts: 3, lastError: last });
    expect(calls()).toBe(3);
    expect(record.sleeps).toHaveLength(2);
  });

  it("makes a single attempt when maxRetries is 0", async () => {
    const { operation, calls } = failingThen([rateLimited()], "reply");

    const failure = await withRetry(operation, recorder().options(0)).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ attempts: 1 });
    expect(calls()).toBe(1);
  });
});
