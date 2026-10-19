import Anthropic, { type APIError } from "@anthropic-ai/sdk";
import { RetriesExhaustedError, type RetryEvent } from "./retry.js";

/** The notice printed while the CLI waits to retry, so a pause is never silent. */
export function describeRetry(event: RetryEvent): string {
  const seconds = (event.delayMs / 1000).toFixed(1);
  return `${transientReason(event.error)}; retrying in ${seconds}s (retry ${event.retry} of ${event.maxRetries}).`;
}

function transientReason(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) {
    return "rate limited (429)";
  }
  if (error instanceof Anthropic.InternalServerError && error.status === 529) {
    return "API overloaded (529)";
  }
  if (error instanceof Anthropic.InternalServerError) {
    return `server error (${error.status})`;
  }
  return "connection failed";
}

/**
 * A sentence or two telling the user what failed and what to do about it,
 * for any error a request can end in. Never includes a stack trace.
 */
export function describeFailure(error: unknown, modelId: string): string {
  if (error instanceof RetriesExhaustedError) {
    const attempts = `${error.attempts} attempt${error.attempts === 1 ? "" : "s"}`;
    return `${describeTransient(error.lastError)} Gave up after ${attempts}.`;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API rejected the key in ANTHROPIC_API_KEY (401). Check that it is current and copied in full.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not allowed to make that request (403): ${serverMessage(error)}`;
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Model ${modelId} was not found, or this API key's organisation cannot use it (404).`;
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `The Anthropic API rejected the request (400): ${serverMessage(error)}`;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return "The request to the Anthropic API timed out.";
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    return `The Anthropic API returned an error (${error.status}): ${serverMessage(error)}`;
  }
  return "An unexpected error occurred.";
}

function describeTransient(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) {
    return "The Anthropic API kept rate-limiting the request (429). Wait a minute, or send requests less often.";
  }
  if (error instanceof Anthropic.InternalServerError && error.status === 529) {
    return "The Anthropic API is overloaded (529). Try again shortly, or choose another --model.";
  }
  if (error instanceof Anthropic.InternalServerError) {
    return `The Anthropic API kept failing with a server error (${error.status}). See https://status.anthropic.com.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Anthropic API. Check your network connection.";
  }
  return "The request kept failing.";
}

function serverMessage(error: APIError): string {
  const body = error.error;
  if (typeof body === "object" && body !== null && "error" in body) {
    const detail = body.error;
    if (typeof detail === "object" && detail !== null && "message" in detail) {
      if (typeof detail.message === "string") {
        return detail.message;
      }
    }
  }
  return "no details were given.";
}
