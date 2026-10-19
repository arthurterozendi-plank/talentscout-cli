import type Anthropic from "@anthropic-ai/sdk";
import { parseCommand, runCommand } from "./commands.js";
import type { ChatConfig } from "./config.js";
import { streamTurn, type TurnIo, type TurnOutcome } from "./turn.js";

/**
 * What a conversation carries from one turn to the next. `config` is read
 * afresh for every request, so replacing it between turns changes the model
 * (or any other setting) for the turns after, while `history` stays as it is:
 * nothing in it depends on which model wrote it.
 */
export interface Session {
  config: ChatConfig;
  /**
   * Completed exchanges only, oldest first: each user message followed by the
   * assistant reply to it, with every content block the API returned —
   * thinking blocks included, since the API expects those sent back unchanged.
   * Append-only, with one exception: `/system` removes every thinking block,
   * which a new system prompt would otherwise make the API reject.
   */
  readonly history: Anthropic.MessageParam[];
}

/** A conversation with no turns yet. */
export function createSession(config: ChatConfig): Session {
  return { config, history: [] };
}

/**
 * Whether the conversation keeps the exchange `outcome` ended: only a reply
 * that finished, and was not a refusal, does. An interrupted, failed or
 * refused turn leaves the history exactly as it was before the message was
 * sent, so roles keep alternating and no partial reply is ever sent back.
 */
export function isKept(outcome: TurnOutcome): boolean {
  return outcome.status === "complete" && outcome.message.stop_reason !== "refusal";
}

/**
 * Sends `text` as the next user message, with the conversation so far, and
 * streams the reply. The exchange joins `session.history` only when
 * {@link isKept} says so.
 */
export async function sendMessage(
  session: Session,
  text: string,
  io: TurnIo,
): Promise<TurnOutcome> {
  const message: Anthropic.MessageParam = { role: "user", content: text };
  const outcome = await streamTurn(session.config, [...session.history, message], io);
  if (outcome.status === "complete" && isKept(outcome)) {
    session.history.push(message, { role: "assistant", content: outcome.message.content });
  }
  return outcome;
}

/** What {@link handleInput} needs: what a turn needs, and where a command answers. */
export interface InputIo extends TurnIo {
  /** Receives a command's answer: a note about the conversation, never a reply. */
  notice: (text: string) => void;
}

/**
 * The one place a line typed in a conversation is acted on. A line starting
 * with `/` is a command, run here and never sent; any other line that is not
 * blank is a message for Claude. Resolves the outcome of the request the line
 * sent, or `undefined` when it sent none — a blank line or a command, known or
 * not — so only a real turn can count as answered or unanswered.
 */
export async function handleInput(
  session: Session,
  line: string,
  io: InputIo,
): Promise<TurnOutcome | undefined> {
  const text = line.trim();
  if (text === "") {
    return undefined;
  }
  const command = parseCommand(text);
  if (command !== undefined) {
    runCommand(command, { session, notice: io.notice });
    return undefined;
  }
  return sendMessage(session, text, io);
}
