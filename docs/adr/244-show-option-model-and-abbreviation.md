# ADR-244: `show` v2 option model — additive typed fields, `-s`, fixed-7 abbreviation

## Status

Accepted (at `4492407b`)

## Context

23.1b layers six git `show` flag-groups onto the existing `repo.show(input?,
opts?)`. The shared questions across all of them: how to model CLI flags in a
library API, and how to abbreviate object ids.

git's CLI surfaces these as flags (`-s`, `--pretty=<s>`, `--date=<s>`,
`--stat=<w>`, `-c`/`--cc`). A library has no argv; it must expose typed options.
Two shapes were weighed:

- **A — typed fields.** Grow `ShowOptions` with optional, typed fields
  (`noPatch?: boolean`, `format?: string`, `date?: string`,
  `stat?: boolean | ShowStatOptions`, `numstat?: boolean`,
  `mergeDiff?: MergeDiffMode`). `format`/`date` stay strings (git's own grammar)
  parsed/validated at the command boundary.
- **B — raw argv array.** Accept a `string[]` of git-style flags and parse them.
  Faithful to the CLI but re-implements an argv parser, leaks primitive flag
  strings deep into the core, and is un-typed for callers.

Separately, git abbreviates oids dynamically (shortest unique prefix, floor 7,
growing with repo size). The codebase already standardised on a fixed
`OID_ABBREV_LENGTH = 7` for `Merge:` lines and patch `index` lines.

## Decision

**Option A — additive typed fields.** Every new field is optional, so the
existing `repo.show()` contract is unchanged (no breaking change, matching the
backlog's "additive on the same return shape"). `format` and `date` remain
strings carrying git's own sub-grammar, parsed once into a resolved plan by a
pure `parseShowOptions` at the command boundary; invalid values raise typed
`INVALID_OPTION` errors (never silent divergence). `-s` maps to
`noPatch: boolean`, which suppresses every diff surface (patch / stat / numstat /
combined) while preserving the header+message block.

Object-id abbreviation stays **fixed at 7** (`OID_ABBREV_LENGTH`) for `%h`/`%t`/
`%p`, `oneline`/`reference`, `Merge:`, and combined/patch `index` lines —
consistent with existing rendering and byte-faithful on the small interop
fixtures (unique prefix is always 7 there). Dynamic abbreviation is an explicit,
documented divergence deferred to a follow-up.

## Consequences

### Positive

- Zero breaking change; callers opt in field-by-field with full typing.
- One validation seam; the core never sees an unparsed flag string.
- Abbreviation is consistent with the established constant and faithful on the
  test corpus.

### Negative

- `ShowOptions` grows by six fields (additive, documented).
- Fixed-7 abbreviation diverges from git on large repos where the unique prefix
  exceeds 7 — out of scope, recorded for a follow-up.

### Neutral

- `format`/`date` are strings, not enums, so the placeholder/mode grammars live
  in `domain/show/` parsers rather than the type system.
