import { parseArgs } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { buildMessageParams, responseText, type MessagesClient } from "./client.js";
import { buildConfig, DEFAULT_MAX_RETRIES, describeConfig } from "./config.js";
import { describeFailure, describeRetry } from "./errors.js";
import { DEFAULT_MODEL_ID, MODEL_ALIASES, MODELS, type ModelInfo } from "./models.js";
import { withRetry } from "./retry.js";

/**
 * Everything `run` needs from the outside world. `main.ts` supplies the real
 * process, SDK client and clock; tests supply fakes, so `run` is exercised end
 * to end without a subprocess or a network call.
 */
export interface CliDeps {
  /** Read for `ANTHROPIC_API_KEY` and nothing else. */
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  createClient: (apiKey: string) => MessagesClient;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in `[0, 1)`, like `Math.random`. */
  random: () => number;
}

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

const USAGE = `Usage: talentscout-cli [--model <model>] [--temperature <0-1>] [--max-retries <n>] <prompt>

Sends <prompt> to Claude once and prints the reply. The API key is read from
the ANTHROPIC_API_KEY environment variable.

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

/**
 * Runs one CLI invocation from raw argv and resolves to its exit code. All
 * output goes through `deps.stdout` / `deps.stderr`: the reply on stdout,
 * everything about the run (settings, retries, errors) on stderr, so the reply
 * can be piped on its own. Any text containing the API key is masked before
 * it is written.
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

  if (values.help === true || argv.length === 0) {
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
  const { config } = result;

  const prompt = positionals.join(" ").trim();
  if (prompt === "") {
    stderr(`no prompt given.\n\n${USAGE}`);
    return 1;
  }

  if (apiKey === undefined) {
    stderr("ANTHROPIC_API_KEY is not set. Export your Anthropic API key in it and run again.");
    return 1;
  }

  stderr(describeConfig(config));

  const client = deps.createClient(apiKey);
  const params = buildMessageParams(config, [{ role: "user", content: prompt }]);
  let message: Anthropic.Message;
  try {
    message = await withRetry(() => client.messages.create(params), {
      maxRetries: config.maxRetries,
      sleep: deps.sleep,
      random: deps.random,
      onRetry: (event) => stderr(describeRetry(event)),
    });
  } catch (error) {
    stderr(describeFailure(error, config.model.id));
    return 1;
  }

  if (message.stop_reason === "refusal") {
    stderr("Claude declined to answer this prompt (stop_reason: refusal).");
    return 1;
  }

  const text = responseText(message);
  stdout(text.endsWith("\n") ? text : `${text}\n`);
  if (message.stop_reason === "max_tokens") {
    stderr(`the reply was cut off at max_tokens=${config.maxTokens}.`);
  }
  return 0;
}
