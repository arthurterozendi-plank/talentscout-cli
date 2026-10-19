import { describe, expect, it } from "vitest";
import { describeCommands, parseCommand, runCommand, type Command } from "./commands.js";
import type { ChatConfig } from "./config.js";
import { createSession } from "./session.js";

const config: ChatConfig = {
  model: { id: "claude-haiku-4-5", acceptsTemperature: true },
  temperature: undefined,
  maxTokens: 32_000,
  maxRetries: 0,
};

describe("parseCommand", () => {
  it("returns undefined for a line that does not start with a slash", () => {
    expect(parseCommand("What is /model for?")).toBeUndefined();
  });

  it("splits the name from the argument, keeping the argument's inner whitespace", () => {
    expect(parseCommand("/system Be  terse.\tAlways.")).toEqual({
      name: "system",
      argument: "Be  terse.\tAlways.",
    });
  });

  it("gives an empty argument when there is none, and an empty name for a lone slash", () => {
    expect(parseCommand("/model")).toEqual({ name: "model", argument: "" });
    expect(parseCommand("/")).toEqual({ name: "", argument: "" });
  });
});

describe("runCommand", () => {
  // Stands in for a command a later change registers, to show that an entry
  // in the list is all it takes to be run and listed.
  const echo: Command = {
    name: "echo",
    argument: "<text>",
    summary: "say it back",
    run: (argument, { session, notice }) => notice(`${session.config.model.id}: ${argument}`),
  };

  it("runs the registered command with its argument and the session", () => {
    const notices: string[] = [];

    runCommand(
      { name: "echo", argument: "hello" },
      { session: createSession(config), notice: (text) => notices.push(text) },
      [echo],
    );

    expect(notices).toEqual(["claude-haiku-4-5: hello"]);
  });

  it("lists the registered commands for a name none of them has", () => {
    const notices: string[] = [];

    runCommand(
      { name: "ech", argument: "" },
      { session: createSession(config), notice: (text) => notices.push(text) },
      [echo],
    );

    expect(notices).toEqual([
      'unknown command "/ech"; nothing was sent. Commands:\n  /echo <text>  say it back',
    ]);
  });
});

describe("describeCommands", () => {
  it("aligns the summaries in one column after the longest usage", () => {
    const commands: Command[] = [
      { name: "a", argument: "", summary: "first", run: () => {} },
      { name: "long", argument: "<value>", summary: "second", run: () => {} },
    ];

    expect(describeCommands(commands)).toBe(
      ["  /a             first", "  /long <value>  second"].join("\n"),
    );
  });
});
