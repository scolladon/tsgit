---
subjects:
  - biome.json
  - .claude/workflow/mutation.md
  - stryker.config.mjs
phases: [refactoring, validation]
kind: gotcha
trigger: npm run check or validate is red on the formatting of a generated, untracked config at the worktree root
evidence:
  - biome.json
  - .claude/workflow/mutation.md
source: { run: rev-parse-corrupt-input, phase: refactoring, date: 2026-11-05 }
status: active
supersedes: []
last-verified: 2026-11-05
---
# 029 — A generated harness config at the root is linted by the gate

## Context

The refactoring phase gate ran red on one script, `check`, with "Formatter would have printed
the following content" for five `vitest.narrow-*.config.ts` files a script had just generated
for the narrowed Stryker buckets, double-quoted and with an array indented by the script. No
tracked file was wrong: biome lints every file under the root its configuration includes,
untracked ones too. `biome check --write` on the five files turned the gate green on a re-run
with nothing else changed.

## Lesson

To the linter a generated config is a repo file. A gate red that names only untracked files
is environmental: format or move the files, re-run, and change no source.

## How to apply

Run `./node_modules/.bin/biome check --write` on every generated config the moment it is written, before any gate.
Generate with the repo's style (single quotes, two-space indents) so the write pass is a no-op.
Read the failing script's output before diagnosing: a red naming only `vitest.narrow-*` or `stryker.narrow-*` needs no source commit.
Leave the generated files untracked; never `git add` them with a triage commit.

## Evidence

`biome.json` — the include set covers the worktree root, where the generated configs live.
`.claude/workflow/mutation.md` — the narrowed-bucket procedure that generates a `vitest.narrow-*.config.ts` per bucket.
