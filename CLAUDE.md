# talentscout-cli

## What this repo is

This is the Day 6 CLI chatbot and Day 7 tool sandbox for **TalentScout**, the AI recruiting
copilot built across the training programme. It is a sibling of `ai-eng-training` — the monorepo
that hosts the web app — not a workspace inside it: this repo shares no code with `ai-eng-training`
and inherits none of its rules. Its own `CLAUDE.md` (this file) is the complete set of conventions
for working here; do not assume anything from the monorepo's `CLAUDE.md` applies unless it is
restated below.

The separation is deliberate, not incidental: Day 4 of the programme practises switching between
two genuinely different codebases — different lockfile, different lint and TypeScript rules, its
own `CLAUDE.md` — and a directory inside the monorepo sharing all three would not exercise that.

## Toolchain

- Node `>=22`, pnpm `11.5.0` (see `pnpm-workspace.yaml` for why a workspace file exists in a
  single-package repo).
- `tsx` runs `src/main.ts` directly; there is no build step and no `bin` field yet — see
  `package.json`'s `cli` script.
- TypeScript 5.9, `strict`, `moduleResolution: "nodenext"`.
- ESLint 9 with `typescript-eslint` 8's recommended rules, `eslint-config-prettier` last.
- Vitest 4, default `node` environment (no config file needed).
- Prettier 3, with `@ianvs/prettier-plugin-sort-imports` and no Tailwind plugin — this repo has no
  Tailwind.

## Layout and the import rule

`src/` is flat: `cli.ts`, `cli.test.ts`, `main.ts`. There is no `@/` alias — with no
subdirectories, a relative import cannot cross one, so the alias has nothing to earn its keep
against yet. Add it the moment a second directory under `src/` exists.

**Relative imports must carry a `.js` extension**, e.g. `import { run } from "./cli.js"`, even
though the source file is `cli.ts`. Under `moduleResolution: "nodenext"`, an extensionless
specifier fails `tsc --noEmit` with `TS2835` — it still runs fine under `tsx`, which is what makes
this easy to miss: the code works locally and only `pnpm check` catches it.

## The seam and the CLI contract

`src/cli.ts` exports a pure `run(argv)` (`argv: string[]`) that returns
`{ text, stream, exitCode }` — what to print, on which stream, with which exit code — and
performs no I/O. `src/main.ts` is the
sole module that touches `process.argv`, `process.stdout`, `process.stderr`, or
`process.exitCode`; it calls `run()` and does exactly what it says. This seam is what lets
`cli.test.ts` assert real CLI behaviour without spawning a subprocess.

The observable contract `run()` implements:

- `--help` or `-h` (or no arguments — there are no subcommands yet, so nothing else could have
  been typed): usage on stdout, exit `0`.
- An unrecognised flag: usage on stderr, naming the offending flag, exit `1`.
- Any error `run()` did not anticipate: a generic message on stderr, exit `1` — never a stack
  trace to the user. `main.ts` guards this at the boundary.

## Verification

Run `pnpm check` — typecheck, lint, test, then a Prettier format check — before handing work back.
It also covers this file and `README.md`: Prettier's `.prettierignore` here only excludes
`pnpm-lock.yaml`, so hand-wrapped markdown is checked too.
