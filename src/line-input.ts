import { createInterface } from "node:readline";

/** The lines a conversation reads, one per call. */
export interface LineInput {
  /**
   * Shows `prompt` (in a terminal) and resolves the next line, or `undefined`
   * once input has ended — Ctrl-D, the end of piped input, or `interrupt`
   * aborting.
   */
  readLine(prompt: string): Promise<string | undefined>;
  close(): void;
}

/** Where {@link createLineInput} reads from and writes its prompt to. */
export interface LineInputOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Whether `input` and `output` are a terminal: only then is the prompt shown. */
  terminal: boolean;
  /**
   * Aborted when Ctrl-C is pressed in the terminal. Aborting it from
   * elsewhere — a SIGINT — ends input as well.
   */
  interrupt: AbortController;
}

/**
 * Reads lines with `node:readline`. Takes its streams as arguments rather than
 * reaching for `process`, so `main.ts` stays the only module that does.
 */
export function createLineInput({
  input,
  output,
  terminal,
  interrupt,
}: LineInputOptions): LineInput {
  const rl = createInterface({ input, output, terminal });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  // In a terminal readline reads keys raw, so Ctrl-C arrives here instead of
  // as a SIGINT to the process — at the prompt and while a reply streams.
  rl.on("SIGINT", () => interrupt.abort());
  interrupt.signal.addEventListener("abort", () => rl.close(), { once: true });
  // Iterating queues the lines that arrive together — a paste, or piped
  // input — where a one-off "line" listener would drop all but the first.
  const lines = rl[Symbol.asyncIterator]();

  return {
    async readLine(prompt) {
      if (terminal && !closed) {
        rl.setPrompt(prompt);
        rl.prompt();
      }
      const next = await lines.next();
      if (next.done === true) {
        // The cursor is still after the prompt; the shell's own prompt
        // belongs on a line of its own.
        if (terminal) {
          output.write("\n");
        }
        return undefined;
      }
      return next.value;
    },
    close: () => rl.close(),
  };
}
