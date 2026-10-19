# talentscout-cli

The Day 6 CLI chatbot and prompting benchmark, and the Day 7 tool sandbox, for **TalentScout**,
the AI recruiting copilot built across the [ai-eng-training](../ai-eng-training) programme. This
is its own repository, not a workspace of that monorepo — see `CLAUDE.md` for why and for this
repo's conventions.

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

### Commands in a conversation

A line starting with `/` is a command for the CLI and is never sent to Claude. Commands answer on
stderr, beside the settings, and `--help` lists them too.

| Command          | Effect                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `/model <name>`  | Sends the turns after it to another model — an ID or an alias — with the history so far. |
| `/system <text>` | Replaces the system prompt for the turns after it. `/system` alone shows the prompt.     |
| `/cost`          | Shows the tokens and dollars spent so far: request by request, per model, and in total.  |

**`/model` changes the model without restarting, so the same question can be put to two models in
one conversation.** The history goes to the new model as it is; nothing is stripped. Not every
model can read the thinking another model wrote: where the new model cannot use an earlier reply's
reasoning, the API leaves it out of the request, unbilled, and the model still sees every earlier
message and reply. A name the CLI does not know leaves the model as it was and says so, as does a
model that would reject the conversation's `--temperature`: the switch is refused rather than the
temperature dropped, so a comparison never changes two settings at once. `/model` alone names the
model in use.

**The CLI sends no system prompt until `/system` sets one.** `/system <text>` replaces it — it does
not add to the earlier one — and shows the old prompt and the new. Earlier replies stay in the
conversation, but the reasoning behind them is dropped. A model's thinking is bound to the system
prompt it was written under ("Change the top-level `system` string or blocks | Invalid", in
Anthropic's
[preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
docs): on Claude Fable 5.1 and the 5.5 Opus, Sonnet and Haiku models, the API answers thinking sent
back under a different prompt with a 400, by default for accounts created on or after 2026-08-31.
Removing it once is the recovery those docs give. A reply that was nothing but reasoning leaves the
conversation together with the message it answered, and the confirmation says how many did.
Setting the prompt already in effect changes nothing. This is the one time the CLI changes the
history it keeps; everywhere else it only appends.

**`/cost` shows what the conversation has cost so far, computed from the `usage` each response
reported — never estimated.** It lists every request in the order it was sent, then the same
tokens and dollars summed for each model, each at that model's own rate, and for the whole session,
so a `/model` switch shows up as two models side by side. Input read from or written to the prompt
cache has its own columns and its own rates, apart from uncached input, ready for the prompt caching
that arrives on Day 10. Dollars are Anthropic's list prices for the standard tier, to five decimal
places, so a short Claude Haiku 5.5 reply still shows a non-zero amount; amounts too small for that
show as `<$0.00001`.

**What `/cost` counts is what the API reported, however the request ended.** A request that failed
before its reply started reported no usage and adds nothing. A reply that failed partway adds
exactly the usage its stream had reported when it stopped, and is marked `(failed partway)`.
Anthropic's docs do not say what is billed for a reply cut off by an error or by Ctrl-C, so the CLI
counts what was reported; and since the API sends its final output count only at the end of a
reply, the output shown for one that broke off can be less than what was generated — the CLI does
not guess the difference. A refusal is marked `(refused)` and counted like any reply, except that,
following Anthropic's
[billing rule for refusals](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#how-refusals-are-billed),
one that arrives before any output is billed only in the categories `bio`, `frontier_llm` and
`reasoning_extraction` (as of September 2026): a refusal before any output in any other category
stays in the list with the tokens it reported, at $0, marked `(refused, not billed)`, so its tokens
count in the totals and its dollars do not. `/system` and `/model` never reset the record; nothing
is kept once the CLI exits.

**Cost is shown when asked for, not after every reply.** `/cost` is the per-turn view: one row per
request. A line after each reply would repeat that on every turn, and a prompt given as arguments —
which has no way to type `/cost` — prints nothing about cost, so its output stays exactly the reply.

**An unknown command lists the commands instead of being sent.** So does a lone `/`. Nothing is
added to the conversation, and a command — known or not — never makes the CLI exit `1`.

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

## Benchmark

```bash
pnpm benchmark          # dry run: no key, no spend; proves the pipeline, prints the cost ceiling
pnpm benchmark --live   # the paid run: 243 requests; see the write-up for where results go
```

**Only `--live` sends requests.** A plain `pnpm benchmark` is a dry run against a fake client even
when `ANTHROPIC_API_KEY` is set, because a key exported for other tools must not turn a plain run
into spend.

The resume-scoring benchmark (AI-52) runs one task the product needs — scoring a resume against a
job description — with zero-shot, few-shot and chain-of-thought prompts on six models, each
configuration three times, and produces one comparison table of every configuration's scores,
latency and cost. `benchmarks/resume-scoring/README.md` is the write-up: the method, why
temperature is compared on its own axis, what the live run will cost, and the pending conclusion.

**It is a package script, not a CLI flag,** because it is a one-off experiment whose grid is fixed
in code, and keeping it out of `cli.ts` leaves the chat CLI's contract as it is.

**Prices live on each model in `src/models.ts`, and `costUsd` there is the only place tokens
become dollars.** A request's cost is computed from its response's `usage`, never estimated, so
the benchmark and `/cost` agree, and a price change is one edit.

## Check

```bash
pnpm check
```

Runs typecheck, lint, test, and a Prettier format check, in that order. Run it before handing work
back.
