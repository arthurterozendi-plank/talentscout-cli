import { parseArgs } from "node:util";
import type { MessagesClient } from "./client.js";
import { buildConfig, DEFAULT_MAX_RETRIES, describeConfig } from "./config.js";
import { describeFailure, describeRetry } from "./errors.js";
import { DEFAULT_MODEL_ID, MODEL_ALIASES, MODELS, type ModelInfo } from "./models.js";
import { createSession, handleInput, isKept, sendMessage, type Session } from "./session.js";
import type { TurnIo, TurnOutcome } from "./turn.js";

/**
 * Everything `run` needs from the outside world. `main.ts` supplies the real
 * process, terminal, SDK client and clock; tests supply fakes, so `run` is
 * exercised end to end without a subprocess or a network call.
 */
export interface CliDeps {
  /** Read for `ANTHROPIC_API_KEY` and nothing else. */
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  createClient: (apiKey: string) => MessagesClient;
  /** Waits `ms`, rejecting early if `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
  /**
   * Shows `prompt` and resolves the next line typed, or `undefined` once
   * input has ended or `interrupt` has aborted. Called only in a conversation,
   * never for a prompt given as arguments.
   */
  readLine: (prompt: string) => Promise<string | undefined>;
  /** Aborted when the user presses Ctrl-C. */
  interrupt: AbortSignal;
}

/** The exit code after Ctrl-C: 128 plus SIGINT's number, as shells report it. */
export const EXIT_INTERRUPTED = 130;

/** What a conversation shows before each line it reads. */
export const PROMPT = "> ";

function modelLine(model: ModelInfo): string {
  const notes = [...MODEL_ALIASES]
    .filter(([, id]) => id === model.id)
    .map(([alias]) => `alias "${alias}"`);
  if (model.id === DEFAULT_MODEL_ID) {
    notes.push("default");
  }
  const name = `${model.id}${model.acceptsTemperature ? " *" : ""}`;
  return notes.length === 0 ? `  ${name}` : `  ${name.padEnd(20)}${notes.join(", ")}`;
}

const USAGE = `Usage: talentscout-cli [--model <model>] [--temperature <0-1>] [--max-retries <n>] [<prompt>]

With a <prompt>, sends it to Claude and streams the reply. Without one, starts
a conversation: each line you type is sent along with the turns before it, and
Ctrl-D or Ctrl-C ends it. The API key is read from the ANTHROPIC_API_KEY
environment variable.

Options:
  --model <model>       A model ID or alias from the list below
                        (default ${DEFAULT_MODEL_ID}).
  --temperature <0-1>   Sampling temperature. Omit it to use the model's default.
  --max-retries <n>     Retries on a 429, 5xx or dropped connection, with
                        exponential backoff (default ${DEFAULT_MAX_RETRIES}, at most 10).
  -h, --help            Show this help.

Models (* accepts --temperature):
${MODELS.map(modelLine).join("\n")}
`;

// A real key is a long random string. Masking a short placeholder such as "x"
// would mangle ordinary words ("max_tokens") and protect nothing.
const MIN_MASKED_KEY_LENGTH = 20;

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string" },
      temperature: { type: "string" },
      "max-retries": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** Says on stderr whatever the reply itself does not about how a turn ended. */
function report(outcome: TurnOutcome, session: Session, stderr: (text: string) => void): void {
  if (outcome.status === "failed") {
    stderr(describeFailure(outcome.error, outcome.model));
  } else if (outcome.status === "complete" && outcome.message.stop_reason === "refusal") {
    stderr("Claude declined to answer this prompt (stop_reason: refusal).");
  } else if (outcome.status === "complete" && outcome.message.stop_reason === "max_tokens") {
    stderr(`the reply was cut off at max_tokens=${session.config.maxTokens}.`);
  }
}

/**
 * Reads and sends lines until input ends. Exits `1` if any turn went
 * unanswered — failed or refused — so `cat prompts.txt | talentscout-cli` can
 * tell that some input got no usable reply; `0` only when every turn completed.
 */
async function converse(
  session: Session,
  io: TurnIo,
  readLine: CliDeps["readLine"],
  stderr: (text: string) => void,
): Promise<number> {
  stderr("Type a message and press Enter. Ctrl-D or Ctrl-C ends the conversation.");
  let unanswered = false;
  for (;;) {
    const line = await readLine(PROMPT);
    if (io.signal.aborted) {
      return EXIT_INTERRUPTED;
    }
    if (line === undefined) {
      return unanswered ? 1 : 0;
    }
    const outcome = await handleInput(session, line, io);
    if (outcome === undefined) {
      continue;
    }
    report(outcome, session, stderr);
    if (outcome.status === "interrupted") {
      return EXIT_INTERRUPTED;
    }
    if (!isKept(outcome)) {
      unanswered = true;
      stderr("That message was left out of the conversation; send it again to retry.");
    }
  }
}

/**
 * Runs one CLI invocation from raw argv and resolves to its exit code: a
 * single turn for a prompt given as arguments, or a conversation read line by
 * line when there is none. All output goes through `deps.stdout` /
 * `deps.stderr`: replies on stdout as they stream, and everything about the
 * run (settings, retries, errors) on stderr, so replies can be piped on their
 * own. Any text containing the API key is masked before it is written.
 */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const apiKey = deps.env["ANTHROPIC_API_KEY"]?.trim() ? deps.env["ANTHROPIC_API_KEY"] : undefined;
  const mask = (text: string) =>
    apiKey === undefined || apiKey.length < MIN_MASKED_KEY_LENGTH
      ? text
      : text.replaceAll(apiKey, "[redacted]");
  const stdout = (text: string) => deps.stdout(mask(text));
  const stderr = (text: string) =>
    deps.stderr(`talentscout-cli: ${mask(text)}${text.endsWith("\n") ? "" : "\n"}`);

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown option.";
    stderr(`${message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;

  if (values.help === true) {
    stdout(USAGE);
    return 0;
  }

  const result = buildConfig({
    model: values.model,
    temperature: values.temperature,
    maxRetries: values["max-retries"],
  });
  if (!result.ok) {
    stderr(result.error);
    return 1;
  }

  const prompt = positionals.join(" ").trim();
  if (positionals.length > 0 && prompt === "") {
    stderr(`the prompt is empty. Leave it out to start a conversation.\n\n${USAGE}`);
    return 1;
  }

  if (apiKey === undefined) {
    stderr("ANTHROPIC_API_KEY is not set. Export your Anthropic API key in it and run again.");
    return 1;
  }

  stderr(describeConfig(result.config));

  const session = createSession(result.config);
  const io: TurnIo = {
    client: deps.createClient(apiKey),
    write: stdout,
    signal: deps.interrupt,
    sleep: deps.sleep,
    random: deps.random,
    onRetry: (event) => stderr(describeRetry(event)),
  };

  if (positionals.length === 0) {
    return converse(session, io, deps.readLine, stderr);
  }
  const outcome = await sendMessage(session, prompt, io);
  report(outcome, session, stderr);
  if (outcome.status === "interrupted") {
    return EXIT_INTERRUPTED;
  }
  return isKept(outcome) ? 0 : 1;
}
