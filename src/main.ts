import { setTimeout as delay } from "node:timers/promises";
import { run } from "./cli.js";
import { createAnthropicClient } from "./client.js";
import { createLineInput, type LineInput } from "./line-input.js";

/**
 * The sole module allowed to touch `process`: `process.argv`, `process.env`,
 * `process.stdin`, `process.stdout`, `process.stderr`, SIGINT and
 * `process.exitCode`. It hands `run()` the real environment, streams, SDK
 * client, clock and Ctrl-C, and does nothing else. An error `run()` did not
 * anticipate is caught here so a bug never reaches the user as a raw stack
 * trace.
 */
async function main(): Promise<void> {
  const interrupt = new AbortController();
  // `once`, so a second Ctrl-C falls through to Node's default and ends the
  // process even if the first somehow failed to stop it.
  const onSigint = () => interrupt.abort();
  process.once("SIGINT", onSigint);
  let lineInput: LineInput | undefined;
  try {
    process.exitCode = await run(process.argv.slice(2), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      createClient: createAnthropicClient,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      random: Math.random,
      // Created on first use, so a one-shot prompt never reads stdin or puts
      // the terminal into raw mode.
      readLine: (prompt) => {
        lineInput ??= createLineInput({
          input: process.stdin,
          output: process.stderr,
          terminal: process.stdin.isTTY === true && process.stderr.isTTY === true,
          interrupt,
        });
        return lineInput.readLine(prompt);
      },
      interrupt: interrupt.signal,
    });
  } catch {
    process.stderr.write("talentscout-cli: an unexpected error occurred.\n");
    process.exitCode = 1;
  } finally {
    lineInput?.close();
    process.off("SIGINT", onSigint);
  }
}

await main();
