# talentscout-cli

The Day 6 CLI chatbot and Day 7 tool sandbox for **TalentScout**, the AI recruiting copilot built
across the [ai-eng-training](../ai-eng-training) programme. This is its own repository, not a
workspace of that monorepo — see `CLAUDE.md` for why and for this repo's conventions.

## Install

```bash
pnpm install
```

## Run

```bash
export ANTHROPIC_API_KEY=...   # read from the environment only; never put it in a file here
pnpm -s cli --model haiku      # a conversation
pnpm -s cli --model claude-haiku-4-5 --temperature 0 "Suggest one interview question for a backend role"
```

**With a prompt, the CLI sends it once; without one, it starts a conversation.** Each line typed is
sent along with every earlier exchange, so a follow-up such as "make it harder" is answered in
context. The flags apply to the whole conversation, and Ctrl-D ends it. Piped input works too, one
turn per line.

Replies stream: text is printed as the model writes it. Replies go to stdout; the settings, the
conversation's `>` prompt, retries and errors go to stderr, so `pnpm -s cli ... > reply.txt`
captures replies alone. `-s` also stops pnpm adding its own "Command failed" line after a non-zero
exit.

| Flag                  | Meaning                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `--model <model>`     | Optional, default `claude-sonnet-5-5`. A model ID or alias; `--help` lists them all. |
| `--temperature <0-1>` | Optional. Omitted means the model's default.                                         |
| `--max-retries <n>`   | Optional, default `4`, at most `10`. Retries after a 429, 5xx or dropped connection. |

### Models, aliases and temperature

**Only `claude-opus-4-6`, `claude-sonnet-4-6` and `claude-haiku-4-5` accept `--temperature`.**
Every model released after Claude Opus 4.6 answers any temperature but its default with a 400, so
the CLI rejects the flag for those models before sending anything. An unknown model or an
out-of-range temperature is rejected the same way.

**The aliases follow Anthropic's naming: `opus`, `sonnet` and `haiku` mean `claude-opus-5-5`,
`claude-sonnet-5-5` and `claude-haiku-5-5`.** An alias pinned to the last generation that accepted
a temperature would quietly send work to an older model — Claude Haiku 4.5 also costs ten times
Claude Haiku 5.5 per token — long after the temperature exercise is over. So
`--model haiku --temperature 0` is rejected with a message naming the three models above; to
compare temperatures, name one of them, e.g. `--model claude-haiku-4-5 --temperature 0`.

**With no `--model`, a request goes to `claude-sonnet-5-5`,** the current Sonnet: Anthropic's
balanced model for everyday work, at half Claude Opus 5.5's per-token price. Like every current
model it takes no temperature, so `--temperature` on its own is rejected too.

**Every request allows up to 32,000 output tokens.** Only the tokens a reply actually uses are
billed. Because replies stream, the SDK's size limit on non-streaming requests no longer applies;
32,000 leaves room for the thinking current models do before answering, which counts against the
limit, while still capping what a runaway reply can cost. A reply that hits it is printed with a
warning that it was cut off.

### Retries, failures and Ctrl-C

Retries back off exponentially from 0.5 s to 8 s with jitter, and wait at least as long as the
API's `retry-after` header asks. When they run out, the CLI says what kept failing.

**A request is retried only until its reply starts.** Once the stream's first event has arrived,
text may already be on screen: a retry would print it a second time and send, and bill, the whole
conversation again. A failure from then on keeps what was printed, ends the line, and explains what
went wrong.

**A conversation keeps only replies that finished.** A message whose reply failed or was refused
is left out of the history, along with any partial reply, and the CLI says so; send it again to
retry. Keeping half an exchange would leave two user messages in a row, or send back a reply cut
off mid-sentence as if it were complete.

**Ctrl-C ends the CLI, mid-reply or at the prompt, and exits `130`**, the code shells report for an
interrupt. A partial reply is ended with a line break, so nothing is left half-written on screen.

`--help`/`-h` prints usage and exits `0`. For a prompt given as arguments, any failure — a bad
flag, a missing key, a rejected request, exhausted retries, a refusal — is explained on stderr and
exits `1`. A conversation explains a failed or refused turn and carries on; when input ends it
exits `1` if any turn failed or was refused, and `0` only if every turn completed, so
`cat prompts.txt | pnpm -s cli` can tell that some input got no usable answer.

## Check

```bash
pnpm check
```

Runs typecheck, lint, test, and a Prettier format check, in that order. Run it before handing work
back.
