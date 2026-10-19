import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLineInput, type LineInput } from "./line-input.js";

const opened: LineInput[] = [];

afterEach(() => {
  for (const lineInput of opened.splice(0)) {
    lineInput.close();
  }
});

function setup(terminal: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  const interrupt = new AbortController();
  const lineInput = createLineInput({ input, output, terminal, interrupt });
  opened.push(lineInput);
  return { input, interrupt, lineInput, written: () => written };
}

describe("createLineInput", () => {
  it("returns piped lines in order, even several in one chunk, then undefined at the end", async () => {
    const { input, lineInput, written } = setup(false);

    input.end("Suggest a question\nAnother\nA third\n");

    expect(await lineInput.readLine("> ")).toBe("Suggest a question");
    expect(await lineInput.readLine("> ")).toBe("Another");
    expect(await lineInput.readLine("> ")).toBe("A third");
    expect(await lineInput.readLine("> ")).toBeUndefined();
    expect(written()).toBe("");
  });

  it("shows the prompt in a terminal and returns the line typed after it", async () => {
    const { input, lineInput, written } = setup(true);

    const line = lineInput.readLine("> ");
    expect(written()).toContain("> ");
    input.write("Hello\r");

    await expect(line).resolves.toBe("Hello");
  });

  it("treats Ctrl-C in a terminal as an interrupt, ending input on a fresh line", async () => {
    const { input, interrupt, lineInput, written } = setup(true);

    const line = lineInput.readLine("> ");
    input.write("\x03");

    await expect(line).resolves.toBeUndefined();
    expect(interrupt.signal.aborted).toBe(true);
    expect(written().endsWith("\n")).toBe(true);
  });

  it("ends input when the interrupt is aborted from elsewhere, as by a SIGINT", async () => {
    const { interrupt, lineInput } = setup(false);

    const line = lineInput.readLine("> ");
    interrupt.abort();

    await expect(line).resolves.toBeUndefined();
  });
});
