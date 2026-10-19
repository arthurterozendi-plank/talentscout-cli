import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runBenchmark, type BenchmarkDeps } from "./command.js";
import { expandGrid } from "./grid.js";

const API_KEY = "fake-key-for-tests-0123456789";
const CELLS = expandGrid().length;

function reply(
  text: string,
  stopReason: Anthropic.StopReason = "stop_sequence",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text, citations: null }],
    container: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 800,
      output_tokens: 5,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function apiError(status: number, type: string, message = `${type} message`) {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
  );
}

/**
 * Fakes everything the benchmark touches. The fake client answers with
 * `answer(n)` for the n-th request (0-based), throwing it if it is an error.
 */
function harness(
  answer: (index: number) => Anthropic.Message | Error = () => reply("<score>70"),
  env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: API_KEY },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const appended = new Map<string, string>();
  const written = new Map<string, string>();
  const clientKeys: string[] = [];
  let tick = 0;
  const deps: BenchmarkDeps = {
    env,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    createClient: (apiKey) => {
      clientKeys.push(apiKey);
      return {
        messages: {
          create: async (params) => {
            const outcome = answer(requests.length);
            requests.push(params);
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
        },
      };
    },
    sleep: async () => {},
    random: () => 0.5,
    now: () => (tick += 1_500),
    date: () => new Date("2026-10-19T12:34:56.789Z"),
    appendFile: async (path, text) => {
      appended.set(path, (appended.get(path) ?? "") + text);
    },
    writeFile: async (path, text) => {
      written.set(path, text);
    },
  };
  return {
    deps,
    requests,
    clientKeys,
    appended,
    written,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

const tableRows = (report: string) =>
  report.split("\n").filter((line) => /^\| (baseline|missing-sections|unrelated-job) /.test(line));

describe("runBenchmark", () => {
  it("prints usage for --help without building a client", async () => {
    const h = harness();

    expect(await runBenchmark(["--help"], h.deps)).toBe(0);
    expect(h.stdout()).toContain("Usage: pnpm benchmark");
    expect(h.clientKeys).toEqual([]);
  });

  it("refuses a live run without ANTHROPIC_API_KEY before anything is sent or written", async () => {
    const h = harness(undefined, {});

    expect(await runBenchmark([], h.deps)).toBe(1);
    expect(h.stderr()).toContain("ANTHROPIC_API_KEY is not set");
    expect(h.stderr()).toContain("--dry-run");
    expect(h.clientKeys).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.written.size + h.appended.size).toBe(0);
  });

  it.each(["1", "11", "abc", "2.5", ""])("rejects --reps %j", async (reps) => {
    const h = harness();

    expect(await runBenchmark(["--reps", reps], h.deps)).toBe(1);
    expect(h.stderr()).toContain("--reps must be a whole number from 2 to 10");
    expect(h.requests).toEqual([]);
  });

  it("rejects an unknown flag and prints usage", async () => {
    const h = harness();

    expect(await runBenchmark(["--model", "opus"], h.deps)).toBe(1);
    expect(h.stderr()).toContain("Usage: pnpm benchmark");
    expect(h.requests).toEqual([]);
  });

  it("runs the whole pipeline in a dry run with no key, no client and no files", async () => {
    const h = harness(undefined, {});

    expect(await runBenchmark(["--dry-run"], h.deps)).toBe(0);

    expect(h.clientKeys).toEqual([]);
    expect(h.written.size + h.appended.size).toBe(0);
    expect(h.stdout()).toContain("**Dry run.**");
    const rows = tableRows(h.stdout());
    expect(rows).toHaveLength(CELLS);
    expect(rows.every((row) => !row.includes("not run"))).toBe(true);
    expect(h.stderr()).toContain(`a live run would send ${CELLS * 3} requests`);
    expect(h.stderr()).toMatch(/cannot cost more than \$\d+\.\d\d/);
  });

  it("sends every cell --reps times, never a temperature to a model that rejects one", async () => {
    const h = harness();

    expect(await runBenchmark(["--reps", "2"], h.deps)).toBe(0);

    expect(h.clientKeys).toEqual([API_KEY]);
    expect(h.requests).toHaveLength(CELLS * 2);
    for (const params of h.requests) {
      if (params.model.endsWith("-5-5")) {
        expect(params, params.model).not.toHaveProperty("temperature");
      } else {
        expect([0, 0.7], params.model).toContain(params.temperature);
      }
    }
  });

  it("appends one raw record per request and writes the same table it prints", async () => {
    const h = harness();

    await runBenchmark(["--reps", "2", "--out", "results"], h.deps);

    const lines = h.appended.get("results/2026-10-19T12-34-56-789Z.jsonl")?.trimEnd().split("\n");
    expect(lines).toHaveLength(CELLS * 2);
    expect(JSON.parse(lines?.[0] ?? "")).toMatchObject({ outcome: "scored", score: 70 });
    const report = h.written.get("results/2026-10-19T12-34-56-789Z.md");
    expect(report).toBe(h.stdout());
    expect(tableRows(report ?? "")[0]).toContain("70, 70");
    expect(report).not.toContain("Dry run");
  });

  it("records malformed replies and failed requests in the table and still finishes", async () => {
    const h = harness((index) =>
      index === 0
        ? reply("Strong candidate.", "end_turn")
        : index === 1
          ? apiError(400, "invalid_request_error")
          : reply("<score>70"),
    );

    expect(await runBenchmark(["--reps", "2"], h.deps)).toBe(0);
    const rows = tableRows(h.stdout());
    expect(rows[0]).toContain("malformed, 70");
    expect(rows[1]).toContain("error, 70");
    expect(h.stdout()).toContain("2 failed (1 malformed, 1 error)");
  });

  it("stops at a rejected API key and reports what it had", async () => {
    const h = harness(() => apiError(401, "authentication_error"));

    expect(await runBenchmark([], h.deps)).toBe(1);

    expect(h.requests).toHaveLength(1);
    expect(h.stdout()).toContain("**Stopped early:** The Anthropic API rejected the key");
    expect(h.written.size).toBe(1);
    expect(h.appended.size).toBe(0);
  });

  it("never writes the API key, even when the server echoes it", async () => {
    const h = harness(() => apiError(400, "invalid_request_error", `bad key ${API_KEY}`));

    await runBenchmark(["--reps", "2"], h.deps);

    const everything = [h.stdout(), h.stderr(), ...h.appended.values(), ...h.written.values()];
    expect(everything.join("")).not.toContain(API_KEY);
    expect(h.stderr()).toContain("[redacted]");
  });
});
