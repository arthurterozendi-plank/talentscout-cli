# Resume scoring benchmark

Spike **AI-52** (Day 6): run one task the product needs — scoring a resume against a job
description — across prompting techniques, temperatures and models, so later defaults are chosen
from evidence.

> **Status: the harness is complete; the live run has not happened yet.** No API key is
> provisioned (AI-29), so there are no results, no conclusion and no winning prompt below — only
> the method, what the run will cost, and what it has to decide. Nothing in this document is a
> measurement.

## Method

### The task and its output contract

Every request asks for one whole-number score from 0 to 100 inside `<score></score>` tags, and
sets the stop sequence `</score>`, so generation ends the moment the score is written and nothing
after it is billed. A reply that does not contain a whole number from 0 to 100 in the last
`<score>` tag is recorded as **malformed** — it is not repaired or guessed at. Native structured
outputs (`output_config.format`) were left out: the ticket asks for XML tags or a stop sequence,
and the point is to see how reliably each technique follows a plain-text contract.

The system prompt — role, a five-band rubric, the output contract — is the same for every
technique. Only the user message differs:

| Technique          | The user message adds                                                         |
| ------------------ | ----------------------------------------------------------------------------- |
| `zero-shot`        | Nothing: the job, the resume, "reply with only the score".                    |
| `few-shot`         | Three short scored examples first (a strong, a partial and an unrelated one). |
| `chain-of-thought` | An instruction to list the must-haves and the evidence in `<analysis>` first. |

All three prompts are in `src/benchmark/prompts.ts`.

### The cases

One fixed resume and job description, plus the two edge cases the ticket asks for. All three are
invented (`src/benchmark/fixtures.ts`). What the rubric implies a sensible score is, which the
conclusion should check the results against:

| Case               | Resume                                   | Job                     | Rubric implies                 |
| ------------------ | ---------------------------------------- | ----------------------- | ------------------------------ |
| `baseline`         | Backend engineer, six years, complete    | Senior Backend Engineer | 70–89: every must-have, no AWS |
| `missing-sections` | The same candidate: name and skills only | Senior Backend Engineer | Clearly below `baseline`       |
| `unrelated-job`    | The `baseline` resume                    | Pastry Chef             | 0–9: a different kind of work  |

### Models and temperature: two axes, not one grid

Every model released after Claude Opus 4.6 answers any `temperature` but its default with a 400 —
the SDK marks the parameter deprecated for that reason, and this CLI already refuses it for those
models. A single models × temperatures grid is therefore impossible, so the benchmark runs two
axes:

| Axis        | Models                                                                           | Temperature                            |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| Temperature | `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-6`                       | `0` and `0.7`                          |
| Model       | the three above, plus `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | the current models' default: none sent |

The temperature axis can only be measured on the last generation that accepts one; the current
models are what a default would actually be set to. `src/benchmark/grid.ts` builds both axes and
checks every cell with the CLI's own `checkTemperatureSupport`, so a mistake in the grid fails
before any request is sent.

That makes **81 configurations**: 3 cases × 3 techniques × 9 model settings.

### Repetitions and what is measured

Each configuration runs **3 times** by default (`--reps`, 2 to 10), one repetition of every cell
before the next, so a run stopped part-way still covers every cell. The table lists every
repetition's score, then the mean and the spread (highest minus lowest): two configurations whose
means differ by less than their spreads have not been shown to differ.

For every request the run records the outcome (`scored`, `malformed`, `truncated`, `refusal`,
`error`), the latency of the attempt that got a reply (retry waits excluded), the token counts the
API returned, and the cost computed from them by `costUsd` in `src/models.ts`, using Anthropic's
list prices as published on 2026-10-19. No cost is estimated.

Held fixed for every request: `max_tokens` 16,000, no prompt caching (so no repetition is cheaper
or faster for a cache hit), non-streaming requests sent one at a time, and thinking and effort left
at each model's default.

### Known confounds

- **The current models think; the older ones do not.** `claude-haiku-5-5`, `claude-sonnet-5-5`
  and `claude-opus-5-5` run adaptive thinking by default (on Claude Opus 5.5 it cannot be turned
  off), and its tokens are billed as output. The three 4.x models run without extended thinking.
  So on the current models every technique comes with internal reasoning, and chain-of-thought is
  reasoning on top of reasoning. The model axis compares each model as it would be used by
  default, not at an equal reasoning budget.
- **Temperature differs across the model axis.** The 4.x models run at 0 and 0.7, the current
  models at their default.
- **Tokenizers differ.** Newer models count the same text as more tokens. Each model's cost is
  computed from its own counts, so costs compare fairly; the token columns do not compare across
  generations.
- **The sample is small.** Three cases show whether a configuration behaves sensibly and
  consistently; they do not measure accuracy. Automated quality evals are AI-117.

## What the live run will cost

**243 requests** (81 configurations × 3 repetitions). The run prints both figures below before it
sends anything.

- **Ceiling: $52.98.** What the run would cost if every reply ran to `max_tokens` with every prompt
  costed at two characters per token. No run can cost more.
- **Expected: about $2.35, and under $4 if the models write much more.** Computed with the
  assumptions below; the heavier case doubles the current models' output to 3,000 tokens and raises
  a chain-of-thought analysis on the 4.x models from 600 to 1,000.

| Model               | Requests | Expected cost |
| ------------------- | -------: | ------------: |
| `claude-haiku-4-5`  |       54 |         $0.11 |
| `claude-sonnet-4-6` |       54 |         $0.32 |
| `claude-opus-4-6`   |       54 |         $0.53 |
| `claude-haiku-5-5`  |       27 |         $0.02 |
| `claude-sonnet-5-5` |       27 |         $0.46 |
| `claude-opus-5-5`   |       27 |         $0.91 |
| **Total**           |  **243** |     **$2.35** |

Assumptions: input of 770 tokens zero-shot, 1,290 few-shot and 815 chain-of-thought (the prompts'
length at four characters per token, plus 35% for the newer tokenizers); output of 5 tokens for a
bare score and 600 for a chain-of-thought analysis on the 4.x models, and 1,500 tokens for every
request to a current model, since their thinking is billed as output. How much the current models
think is the largest unknown.

Requests go out one at a time, so expect the run to take tens of minutes.

## How to run it

```bash
pnpm benchmark --dry-run   # no key, requests or files: made-up replies, the plan and the ceiling
export ANTHROPIC_API_KEY=...
pnpm benchmark             # the live run
```

`--reps <n>` sets the repetitions (2 to 10) and `--out <dir>` where results go. A live run without
`ANTHROPIC_API_KEY` is refused before anything is sent.

A live run writes two files to `benchmarks/resume-scoring/results/`, both named for the time the
run started:

- `<timestamp>.jsonl` — one line per request, appended as each completes: the configuration, the
  outcome, the score, the reply's full text, its `usage`, latency and cost.
- `<timestamp>.md` — the single comparison table, one row per configuration, written at the end
  and also printed to stdout.

Transient failures (429, 5xx, dropped connections) are retried with the CLI's backoff; a request
that still fails is recorded as `error` and the run continues. A rejected API key stops the run, and
the table is written with what it had.

## What the run has to decide

Apply these in order; each narrows what the next compares.

1. **Reliability.** Drop any technique or model that produces malformed, truncated or refused
   replies — a default that sometimes yields no score cannot ship.
2. **Sensible scores.** On what remains, check the cases against the rubric: `baseline` in 70–89,
   `missing-sections` clearly below it, `unrelated-job` in 0–9. A configuration that scores the
   skills-only resume like the complete one has not degraded gracefully.
3. **Consistency.** Prefer the smaller spread. On the temperature axis, see whether 0 actually
   narrows it compared with 0.7; if the current models' spreads at their default are as narrow,
   temperature is not a lever the product needs.
4. **Cost and latency.** Among the configurations still standing, the cheapest and fastest wins.

## Results — pending the live run

> Pending. Commit the run's `results/<timestamp>.md` and `.jsonl`, then replace this section.

- **Comparison table:** pending — link the committed `results/<timestamp>.md`.
- **Conclusion:** pending — name the winning technique, temperature and model, and why, by the
  steps above.
- **Winning prompt:** pending — name the technique whose prompt in `src/benchmark/prompts.ts`
  (`SYSTEM_PROMPT` plus `buildPrompt(<technique>, …)`) won. That prompt is the seed for the Day 19
  golden set, **AI-118**.
