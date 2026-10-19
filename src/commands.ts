import type Anthropic from "@anthropic-ai/sdk";
import { checkTemperatureSupport, describeConfig } from "./config.js";
import { describeModelChoices, findModel, MODELS } from "./models.js";
import type { Session } from "./session.js";

/** What a command can read and act on. */
export interface CommandContext {
  /**
   * The conversation the command was typed in. A command may replace
   * `session.config`, which applies from the next request on; only `/system`
   * also rewrites `session.history`.
   */
  readonly session: Session;
  /** Shows the command's answer beside the other notes about the run, never among the replies. */
  readonly notice: (text: string) => void;
}

/**
 * A slash command. An entry in {@link COMMANDS} is all a command needs to be
 * run when typed and listed when an unknown one is.
 */
export interface Command {
  /** What follows the slash: `model` for `/model`. */
  readonly name: string;
  /** How the listing writes its argument, e.g. `<name>`; empty when it takes none. */
  readonly argument: string;
  /** What it does, in a few words, for the listing. */
  readonly summary: string;
  /**
   * Acts on `argument`: the rest of the line after the name, trimmed, or
   * empty when there is none. Sends no request — a line that names a command
   * is never a turn, so it never joins the history or counts as unanswered.
   */
  readonly run: (argument: string, context: CommandContext) => void;
}

/** A typed line split into a command name and its argument. */
export interface CommandLine {
  /** Everything between the slash and the first whitespace; empty for a lone `/`. */
  readonly name: string;
  /** The rest of the line, trimmed; empty when there is none. */
  readonly argument: string;
}

const model: Command = {
  name: "model",
  argument: "<name>",
  summary: "switch model, keeping the conversation so far",
  run(argument, { session, notice }) {
    const current = session.config.model;
    if (argument === "") {
      notice(`the model is ${current.id}. To switch, choose ${describeModelChoices()}.`);
      return;
    }
    const next = findModel(argument);
    if (next === undefined) {
      notice(
        `unknown model "${argument}"; still using ${current.id}. Choose ${describeModelChoices()}.`,
      );
      return;
    }
    if (next.id === current.id) {
      notice(`already using ${current.id}.`);
      return;
    }
    const { temperature } = session.config;
    if (checkTemperatureSupport(next, temperature) !== undefined) {
      const accepting = MODELS.filter((candidate) => candidate.acceptsTemperature)
        .map((candidate) => candidate.id)
        .join(", ");
      notice(
        `${next.id} does not accept a temperature, and this conversation sends ` +
          `temperature=${temperature}; still using ${current.id}. Models that accept one: ${accepting}.`,
      );
      return;
    }
    session.config = { ...session.config, model: next };
    notice(
      `switched from ${current.id} to ${next.id}, keeping the conversation so far.\n` +
        describeConfig(session.config),
    );
  },
};

/** A system prompt as the confirmations show it: quoted, or `none`. */
function showPrompt(prompt: string | undefined): string {
  return prompt === undefined ? "none" : JSON.stringify(prompt);
}

interface StrippedHistory {
  readonly history: Anthropic.MessageParam[];
  /** How many `thinking` and `redacted_thinking` blocks were removed. */
  readonly blocks: number;
  /** How many exchanges were removed whole because their reply was left empty. */
  readonly exchanges: number;
}

// A thinking block is bound to the system prompt it was written under, so once
// the prompt changes, replaying it fails the request on accounts the API
// enforces that check for. Removing every block at once is the recovery the
// API documents; an exchange whose reply held nothing else is removed with the
// message that prompted it, since an empty assistant turn is rejected too and
// dropping the pair keeps roles alternating.
function withoutThinking(history: readonly Anthropic.MessageParam[]): StrippedHistory {
  const kept: Anthropic.MessageParam[] = [];
  let blocks = 0;
  let exchanges = 0;
  for (const message of history) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      kept.push(message);
      continue;
    }
    const content = message.content.filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    blocks += message.content.length - content.length;
    if (content.length === 0) {
      kept.pop();
      exchanges += 1;
    } else {
      kept.push({ ...message, content });
    }
  }
  return { history: kept, blocks, exchanges };
}

const system: Command = {
  name: "system",
  argument: "<prompt>",
  summary: "replace the system prompt; alone, show it",
  run(argument, { session, notice }) {
    const current = session.config.system;
    if (argument === "") {
      notice(`system prompt: ${showPrompt(current)}. Type /system <prompt> to replace it.`);
      return;
    }
    if (argument === current) {
      notice(`the system prompt is already ${showPrompt(current)}; nothing changed.`);
      return;
    }
    const stripped = withoutThinking(session.history);
    session.history.splice(0, session.history.length, ...stripped.history);
    session.config = { ...session.config, system: argument };
    const lines = [
      `system prompt replaced. Was: ${showPrompt(current)}. Now: ${showPrompt(argument)}.`,
    ];
    if (stripped.blocks > 0) {
      lines.push(
        "Earlier reasoning was dropped: the API rejects reasoning written under a different " +
          "system prompt, so earlier replies keep only their text.",
      );
    }
    if (stripped.exchanges > 0) {
      const count = stripped.exchanges === 1 ? "1 exchange" : `${stripped.exchanges} exchanges`;
      lines.push(`${count} whose reply held nothing but reasoning left the conversation.`);
    }
    notice(lines.join("\n"));
  },
};

/** Every command a conversation understands, in the order they are listed. */
export const COMMANDS: readonly Command[] = [model, system];

/**
 * Splits `text` into a command name and argument if it is a command — any
 * line starting with `/`, known or not — or returns `undefined` for a
 * message. `text` is expected trimmed.
 */
export function parseCommand(text: string): CommandLine | undefined {
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, name = "", argument = ""] = match;
  return { name, argument: argument.trim() };
}

/**
 * Runs the command `line` names. An unknown name — or none, for a lone `/` —
 * lists every command instead, and nothing is sent.
 */
export function runCommand(
  line: CommandLine,
  context: CommandContext,
  commands: readonly Command[] = COMMANDS,
): void {
  const command = commands.find((candidate) => candidate.name === line.name);
  if (command === undefined) {
    const unknown = line.name === "" ? "" : `unknown command "/${line.name}"; nothing was sent. `;
    context.notice(`${unknown}Commands:\n${describeCommands(commands)}`);
    return;
  }
  command.run(line.argument, context);
}

/** One indented line per command — its usage, then its summary — aligned in two columns. */
export function describeCommands(commands: readonly Command[] = COMMANDS): string {
  const rows = commands.map((command) => ({
    usage: command.argument === "" ? `/${command.name}` : `/${command.name} ${command.argument}`,
    summary: command.summary,
  }));
  const width = Math.max(0, ...rows.map((row) => row.usage.length));
  return rows.map((row) => `  ${row.usage.padEnd(width)}  ${row.summary}`).join("\n");
}
