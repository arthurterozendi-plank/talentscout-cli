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
pnpm cli --model claude-haiku-4-5 --temperature 0 "Suggest one interview question for a backend role"
```

Each run sends one prompt and prints the reply. The reply goes to stdout; the settings the request
is sent with, any retries, and errors go to stderr, so `pnpm -s cli ... > reply.txt` captures the
reply alone.

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

Retries back off exponentially from 0.5 s to 8 s with jitter, and wait at least as long as the
API's `retry-after` header asks. When they run out, the CLI says what kept failing and exits `1`.

`--help`/`-h`, or no arguments, prints usage and exits `0`. Any failure — a bad flag, a missing
key, a rejected request, exhausted retries — is explained on stderr and exits `1`.

## Check

```bash
pnpm check
```

Runs typecheck, lint, test, and a Prettier format check, in that order. Run it before handing work
back.
