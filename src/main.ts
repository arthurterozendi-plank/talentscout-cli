import { run } from "./cli.js";

/**
 * The sole module allowed to touch `process`: `process.argv`,
 * `process.stdout`, `process.stderr`, `process.exitCode`. Everything else
 * delegates to the pure `run()` in `cli.ts`. An error `run()` did not
 * anticipate is caught here so a bug never reaches the user as a raw stack
 * trace.
 */
function main(): void {
  try {
    const result = run(process.argv.slice(2));
    const target = result.stream === "stderr" ? process.stderr : process.stdout;
    target.write(result.text);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write("talentscout-cli: an unexpected error occurred.\n");
    process.exitCode = 1;
  }
}

main();
