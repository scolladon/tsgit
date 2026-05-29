# ADR-201: `mv` v1 ships `force`, `dryRun`, and `skipErrors`

## Status

Accepted (at `a7e54c4`)

## Context

`git mv` has four behaviour-bearing flags: `-f/--force`, `-n/--dry-run`,
`-k` (skip errors), and `-v/--verbose`. The v1 `mv` command must decide which
to honour. Each flag is an independent, well-defined branch:

- `force` — overwrite an existing destination (file source only; a directory
  source over a non-directory is refused regardless, per git).
- `dryRun` — validate and report the plan, mutate nothing.
- `skipErrors` — skip refused (source → target) pairs instead of the default
  atomic abort; flips the contract from all-or-nothing to partial-proceed.
- `verbose` — emit a per-move line on the CLI.

Prior phase commands (e.g. pull deferring `--rebase` until 22.3, ADR-198) show
the project is comfortable shipping a scoped option set when a flag carries
disproportionate complexity. The question is whether `skipErrors` (which
changes the atomicity guarantee) belongs in v1.

## Decision

Ship `force`, `dryRun`, and `skipErrors`. Omit `verbose` — the structured
`MvResult` (`moved: ReadonlyArray<{from,to}>`, `skipped: ReadonlyArray<…>`)
already carries everything a `--verbose` line would print, so a verbose flag
would be redundant in a library that returns data rather than prints text.

`skipErrors` is included despite altering the atomicity contract: the
validate-all-then-execute plan makes "collect skips vs. throw on first" a single
branch at the same decision point, so it adds little code and is fully testable.
`breakStaleLockMs` is also carried, consistent with `rm`/`add`.

## Consequences

### Positive

- Full behavioural parity with `git mv`'s meaningful flags in one shipment — no
  follow-up needed for `-k`.
- `dryRun` gives callers a safe "what would happen" path, valuable for tools
  built on top of the library.

### Negative

- `skipErrors` introduces a second result-reporting path (`skipped[]`) and a
  weaker (partial-proceed) atomicity mode that must be tested in isolation.

### Neutral

- `verbose` is intentionally absent; re-introducing it later (if a CLI wrapper
  ever wants it) is a non-breaking additive change.
