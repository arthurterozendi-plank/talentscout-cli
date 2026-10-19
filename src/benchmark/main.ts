import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createAnthropicClient } from "@/client.js";
import { runBenchmark } from "./command.js";

/**
 * The benchmark's counterpart to `src/main.ts`, and the only benchmark module
 * allowed to touch `process` or the file system. It hands `runBenchmark()`
 * the real environment, streams, SDK client, clocks and files. An error
 * `runBenchmark()` did not anticipate is caught here so a bug never reaches
 * the user as a raw stack trace.
 */
async function main(): Promise<void> {
  try {
    process.exitCode = await runBenchmark(process.argv.slice(2), {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      createClient: createAnthropicClient,
      sleep: (ms) => delay(ms),
      random: Math.random,
      now: () => performance.now(),
      date: () => new Date(),
      appendFile: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, text);
      },
      writeFile: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      },
    });
  } catch {
    process.stderr.write("benchmark: an unexpected error occurred.\n");
    process.exitCode = 1;
  }
}

await main();
