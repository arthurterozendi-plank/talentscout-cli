# talentscout-cli

## What this repo is

This is the Day 6 CLI chatbot and prompting benchmark, and the Day 7 tool sandbox, for
**TalentScout**, the AI recruiting copilot built across the training programme. It is a sibling of
`ai-eng-training` — the monorepo that hosts the web app — not a workspace inside it: this repo
shares no code with `ai-eng-training` and inherits none of its rules. Its own `CLAUDE.md` (this
file) is the complete set of conventions for working here; do not assume anything from the
monorepo's `CLAUDE.md` applies unless it is restated below.

The separation is deliberate, not incidental: Day 4 of the programme practises switching between
two genuinely different codebases — different lockfile, different lint and TypeScript rules, its
own `CLAUDE.md` — and a directory inside the monorepo sharing all three would not exercise that.

## Toolchain

- Node `>=22`, pnpm `11.5.0` (see `pnpm-workspace.yaml` for why a workspace file exists in a
  single-package repo).
- `tsx` runs `src/main.ts` and `src/benchmark/main.ts` directly; there is no build step and no
  `bin` field yet — see `package.json`'s `cli` and `benchmark` scripts.
- TypeScript 5.9, `strict`, `moduleResolution: "nodenext"`.
- ESLint 9 with `typescript-eslint` 8's recommended rules, `eslint-config-prettier` last.
- Vitest 4, default `node` environment. `vitest.config.ts` exists only to resolve the `@/` alias.
- Prettier 3, with `@ianvs/prettier-plugin-sort-imports` and no Tailwind plugin — this repo has no
  Tailwind.
- `@anthropic-ai/sdk` is the only runtime dependency. Tests never call the API: `run()` and
  `runBenchmark()` take their client as a dependency and the tests hand them a fake.

## Layout and the import rule

`src/` holds the CLI, one module per concern, each with its test beside it:

| Module      | Owns                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `main.ts`   | The only CLI module touching `process`; wires the real deps into `run()`.        |
| `cli.ts`    | `run(argv, deps)`: flag parsing, the order of checks, what goes to which stream. |
| `models.ts` | `MODELS`, which take a temperature and what each costs; `costUsd`; the aliases.  |
| `config.ts` | `buildConfig`, `checkTemperatureSupport`, and the startup echo.                  |
| `client.ts` | SDK client construction and the one place a config becomes request params.       |
| `retry.ts`  | `withRetry`: which errors are retried and how long to wait between attempts.     |
| `errors.ts` | The human-readable text for every way a request can fail or be retried.          |

`src/benchmark/` holds the resume-scoring benchmark (AI-52), a separate program built on the same
modules; `benchmarks/resume-scoring/README.md` is its write-up and `results/` beside it its output:

| Module        | Owns                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| `main.ts`     | The only benchmark module touching `process` or the file system.                 |
| `command.ts`  | `runBenchmark(argv, deps)`: flags, the key check, the run loop, writing results. |
| `fixtures.ts` | The resumes and job descriptions, as `CASES`.                                    |
| `prompts.ts`  | The system prompt, each technique's user message, and `parseScore`.              |
| `grid.ts`     | Which models run at which temperatures, expanded into every cell.                |
| `run.ts`      | One request: building it, sending it with retries, recording its outcome.        |
| `report.ts`   | The comparison table, the report around it, and the cost ceiling.                |
| `dry-run.ts`  | The fake client `--dry-run` uses.                                                |

**`@/*` maps to `src/*`.** An import that crosses a directory uses it — `@/models.js` from
`src/benchmark/` — and one within a directory stays relative. `tsconfig.json`'s `paths` declares
it; `tsx` reads that directly and Vitest through `resolve.tsconfigPaths`. Prettier sorts `@/`
imports after packages and before relative ones.

**Imports must carry a `.js` extension**, e.g. `import { run } from "./cli.js"`, even though the
source file is `cli.ts` — `@/` imports too. Under `moduleResolution: "nodenext"`, an extensionless
specifier fails `tsc --noEmit` with `TS2835` — it still runs fine under `tsx`, which is what makes
this easy to miss: the code works locally and only `pnpm check` catches it.

## The seam and the CLI contract

`src/cli.ts` exports `run(argv, deps)`, which resolves to the exit code. It reaches the outside
world only through `deps` (`CliDeps`): the environment, a `stdout` and a `stderr` writer, a client
factory, `sleep`, and `random`. `src/main.ts` is the sole module that touches `process.argv`,
`process.env`, `process.stdout`, `process.stderr`, or `process.exitCode`; it builds the real deps,
awaits `run()`, and sets the exit code. This seam is what lets `cli.test.ts` assert real CLI
behaviour — including retries and their waits — without a subprocess, a network call, or a real
clock.

The benchmark follows the same pattern: `runBenchmark(argv, deps)` in `src/benchmark/command.ts`
reaches the outside world only through `BenchmarkDeps`, which adds the two clocks (monotonic for
latency, wall for file names) and the two file writers to the CLI's set, and
`src/benchmark/main.ts` alone supplies the real ones.

`run` writes as it goes rather than returning its output, because the settings must be echoed
before the request is sent and each retry announced while the CLI waits. A later streamed reply
needs the same thing.

The observable contract `run()` implements:

- `--help` or `-h`, or no arguments: usage on stdout, exit `0`.
- One prompt per run, from the positional arguments joined with spaces. The reply alone goes to
  stdout; the settings echo, retry notices and errors go to stderr, so the reply can be piped.
- `--model` takes a model ID or an alias (`opus`, `sonnet`, `haiku`, each the current generation
  of its family) and defaults to `claude-sonnet-5-5`. `--temperature` is accepted only for a model
  that takes one. `README.md` records why the aliases and the default are what they are; change
  them there and in `models.ts` together.
- Every check that needs no API call — flags, model, temperature, a prompt, the key — happens
  before the client is built, so a mistake never costs a request.
- Any failure: an explanation on stderr, exit `1`. An unrecognised flag also prints usage.
- Never a stack trace. `run()` turns every SDK error into a sentence (`errors.ts`); `main.ts`
  catches anything else with a generic message.

## Decisions

- **One prompt per run, not an interactive loop.** Without conversation history a loop would only
  send unrelated requests one after another, and a single run gives exhausted retries a plain
  outcome — exit `1` — that a session would have to handle differently. The loop belongs with the
  history that makes it a conversation.
- **The CLI owns retrying, and the SDK client is built with `maxRetries: 0`.** The SDK's built-in
  retry reads `Math.random` and its own timer, so its backoff cannot be observed in a test; with
  both enabled the attempts would also multiply. `withRetry` takes `sleep` and `random` as
  arguments, retries 429, 5xx (529 overloaded among them) and dropped connections, backs off
  exponentially from 0.5 s to 8 s with equal jitter, and still honours `retry-after`.
- **Temperature is accepted only for models that accept it.** Every model released after Claude
  Opus 4.6 answers any temperature but its default with a 400, so `models.ts` records which models
  take one and `buildConfig` rejects the flag for the rest instead of spending a request to learn
  it.
- **The key comes from `ANTHROPIC_API_KEY` and nowhere else.** The client is built with
  `authToken: null` because the SDK would otherwise also read `ANTHROPIC_AUTH_TOKEN`, and with both
  set the API rejects the request. Output is masked against the key as a backstop, since error
  text comes from the server.
- **`max_tokens` is 16,000 for every model.** It is a ceiling, not a target — only generated
  tokens are billed — and it leaves room for the thinking later models always do, while staying
  below the size at which the SDK requires streaming.
- **Prices are data on each `ModelInfo`, and `costUsd` is the only place tokens become dollars.**
  A cost is always computed from a response's `usage` — uncached input, cache reads, each
  cache-write TTL and output at their own rates — never estimated, so the benchmark and any later
  cost display cannot disagree. The prices are copied from Anthropic's pricing page with the date
  in `ModelInfo.pricing`'s JSDoc; `models.test.ts` checks every rate card against the published
  cache multipliers, so a mistyped price fails `pnpm check`.
- **The benchmark is a package script beside the CLI, not a CLI flag.** Its grid is fixed in code
  and it runs once per question, so it has no business in `cli.ts`'s contract. It reuses the CLI's
  request shape (`buildMessageParams`), temperature rule (`checkTemperatureSupport`), retries and
  error text, so a request it sends is one the CLI would send.

## Verification

Run `pnpm check` — typecheck, lint, test, then a Prettier format check — before handing work back.
It also covers this file and the other Markdown: `.prettierignore` excludes only `pnpm-lock.yaml`
and the benchmark's generated `results/`, so hand-wrapped markdown is checked too.
