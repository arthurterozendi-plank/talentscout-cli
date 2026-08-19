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
pnpm cli --help
```

There are no subcommands yet: `--help`/`-h` and no arguments both print usage and exit `0`; an
unrecognised flag prints usage on stderr and exits `1`.

## Check

```bash
pnpm check
```

Runs typecheck, lint, test, and a Prettier format check, in that order. Run it before handing work
back.
