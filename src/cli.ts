import { parseArgs } from "node:util";

/** Which stream a {@link CliResult} should be written to. */
export type OutputStream = "stdout" | "stderr";

/**
 * What `run` decided to do, described rather than performed: `main.ts` is the
 * only module that writes `text` to `stream` or sets `process.exitCode` to
 * `exitCode`.
 */
export interface CliResult {
  text: string;
  stream: OutputStream;
  exitCode: number;
}

const USAGE = `Usage: talentscout-cli [--help]

Scaffold for the TalentScout Week 2 CLI chatbot. No subcommands yet — the
only recognised flag is --help/-h.
`;

/**
 * Decides what the CLI should print, on which stream, and with which exit
 * code, from raw argv. Performs no I/O, so it can be tested directly without
 * spawning a process — see `cli.test.ts`.
 *
 * There are no subcommands yet, so any argv that parses cleanly (including
 * an empty one) prints usage and succeeds; only an unrecognised flag is a
 * usage error. `main.ts` revisits this the moment a real subcommand exists.
 */
export function run(argv: string[]): CliResult {
  try {
    parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown option.";
    return {
      text: `talentscout-cli: ${message}\n\n${USAGE}`,
      stream: "stderr",
      exitCode: 1,
    };
  }

  return {
    text: USAGE,
    stream: "stdout",
    exitCode: 0,
  };
}
