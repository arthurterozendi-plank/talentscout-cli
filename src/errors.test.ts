import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { describeFailure, describeRetry } from "./errors.js";
import { RetriesExhaustedError } from "./retry.js";

function apiError(status: number, type: string, message = `${type} message`) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
  );
}

const MODEL = "claude-haiku-4-5";

describe("describeFailure", () => {
  it("explains exhausted rate-limit retries and how many attempts were made", () => {
    const message = describeFailure(
      new RetriesExhaustedError(5, apiError(429, "rate_limit_error")),
      MODEL,
    );

    expect(message).toContain("rate-limiting the request (429)");
    expect(message).toContain("Gave up after 5 attempts.");
  });

  it("explains exhausted retries against an overloaded API", () => {
    const message = describeFailure(
      new RetriesExhaustedError(3, apiError(529, "overloaded_error")),
      MODEL,
    );

    expect(message).toContain("overloaded (529)");
    expect(message).toContain("Gave up after 3 attempts.");
  });

  it("explains exhausted retries on other server errors and on dropped connections", () => {
    expect(
      describeFailure(new RetriesExhaustedError(2, apiError(500, "api_error")), MODEL),
    ).toContain("server error (500)");
    expect(
      describeFailure(
        new RetriesExhaustedError(1, new Anthropic.APIConnectionError({ message: "reset" })),
        MODEL,
      ),
    ).toBe(
      "Could not reach the Anthropic API. Check your network connection. Gave up after 1 attempt.",
    );
  });

  it("points a 401 at ANTHROPIC_API_KEY", () => {
    expect(describeFailure(apiError(401, "authentication_error"), MODEL)).toContain(
      "rejected the key in ANTHROPIC_API_KEY (401)",
    );
  });

  it("names the model on a 404", () => {
    expect(describeFailure(apiError(404, "not_found_error"), MODEL)).toContain(
      "Model claude-haiku-4-5 was not found",
    );
  });

  it("passes on the API's own explanation of a 400", () => {
    const message = describeFailure(
      apiError(400, "invalid_request_error", "max_tokens: must be at least 1"),
      MODEL,
    );

    expect(message).toBe(
      "The Anthropic API rejected the request (400): max_tokens: must be at least 1",
    );
  });

  it("names the error type of a stream that failed after it started", () => {
    const midStream = new Anthropic.APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      new Headers(),
      "overloaded_error",
    );

    expect(describeFailure(midStream, MODEL)).toBe(
      "The Anthropic API stopped the reply with an error (overloaded_error): Overloaded",
    );
  });

  it("never repeats the detail of an error it does not recognise", () => {
    const message = describeFailure(new Error("ENOENT /home/someone/.secrets"), MODEL);

    expect(message).toBe("An unexpected error occurred.");
  });
});

describe("describeRetry", () => {
  it("names the failure, the wait and how many retries remain", () => {
    expect(
      describeRetry({
        retry: 2,
        maxRetries: 4,
        delayMs: 1234,
        error: apiError(529, "overloaded_error"),
      }),
    ).toBe("API overloaded (529); retrying in 1.2s (retry 2 of 4).");
  });
});
