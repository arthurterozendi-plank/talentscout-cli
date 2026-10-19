import { setTimeout as delay } from "node:timers/promises";
import { run } from "./cli.js";
import { createAnthropicClient } from "./client.js";

/**
 * The sole module allowed to touch `process`: `process.argv`, `process.env`,
 * `process.stdout`, `process.stderr`, `process.exitCode`. It hands `run()` the
 * real environment, streams, SDK client and clock, and does nothing else. An
 * error `run()` did not anticipate is caught here so a bug never reaches the
 * user as a raw stack trace.
 */
async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      createClient: createAnthropicClient,
      sleep: (ms) => delay(ms),
      random: Math.random,
    });
  } catch {
    process.stderr.write("talentscout-cli: an unexpected error occurred.\n");
    process.exitCode = 1;
  }
}

await main();
