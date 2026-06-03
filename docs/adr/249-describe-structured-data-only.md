# ADR-249: `describe` returns structured data only — cosmetics are the caller's

## Status

Accepted (at `a2e8722e`)

## Context

`23.2` adds `repo.describe` — name a commit by its nearest reachable tag, faithful
to `git describe`. The first design (following the `show` precedent, ADR-240)
returned `bytes` / `text` — the byte-faithful `git describe` stdout line — plus a
`--long` toggle, an `--abbrev=<n>` length, and a `--dirty[=<mark>]` marker string.

Mid-design the project owner set a library-wide direction: **the library provides
data in a structured shape; representing it (date formats, output layout,
abbreviation, suffixes) is the caller's responsibility.** Options whose only job
is to steer rendered output — and the code behind them — should not exist on the
library surface. (A backlog item + a project rule will sweep the existing commands
that already violate this; `describe` is the first command built under the rule.)

This reframes the git-faithfulness prime directive (ADR-226): faithfulness binds
the **data and on-disk state** (selected tag, exact distance, SHAs, refusal
conditions), not the **human-readable line** `git describe` prints to stdout. The
describe line is display, not state, so reproducing it is the caller's concern.

Two questions were put to the owner. Scope: **Maximal** — ship every *data/behavior*
flag (`tags`, `all`, `exactMatch`, `candidates`, `always`, `firstParent`, `match`,
`exclude`, `dirty`, `broken`), deferring only `--contains` (a different `name-rev`
algorithm) and multi-commit-ish args. Output: **structured-only** — drop `bytes` /
`text`.

## Decision

`repo.describe(input?, opts?)` returns a structured `DescribeResult`:

```ts
{ tag: RefName | undefined; name: string; distance: number;
  oid: ObjectId; exact: boolean; dirty: boolean }
```

and ships **no** rendered output and **no** cosmetic-formatting option:

- **Dropped (cosmetic) — option + code:** `--long` (suffix toggle, derivable from
  `exact`), `--abbrev=<n>` (display length — the result carries the full `oid`; the
  caller slices), the `--dirty`/`--broken` `=<mark>` strings (the result carries
  `dirty: boolean`; the caller appends any marker). The library therefore never
  abbreviates and has no `format.ts`.
- **Kept (data / behavior selectors):** `tags`, `all`, `exactMatch`, `candidates`,
  `always`, `firstParent`, `match`, `exclude`, `dirty` (boolean), `broken`
  (boolean). Each changes *which* ref is selected, *whether* a result or a refusal
  is produced, or *what* is reported — none steer cosmetics.

Faithfulness is pinned on the data: the interop test reconstructs git's line from
the structured fields (`tag === undefined ? oid.slice(0,7) : exact ? name :
\`${name}-${distance}-g${oid.slice(0,7)}\``) and compares it to real `git
describe`, including the `--long` / `--abbrev` renderings driven through the
matching caller-side variant. The `--dirty` mark is compared as git's `-dirty`
suffix against `dirty: true`.

This intentionally diverges from ADR-240 (`show`'s `bytes`). ADR-240 is **not**
superseded here — reconciling `show` and the other rendering-bearing commands with
the structured-output rule is the dedicated backlog sweep, not this PR.

## Consequences

### Positive

- Smaller, honest surface: every `describe` option changes data, never pixels.
- No abbreviation logic in the library → no fixed-7-vs-unique-prefix question, no
  divergence risk in large/colliding repos (the caller owns prefix length).
- Establishes the structured-output rule with a concrete first example for the
  upcoming sweep of `show` / `log` / date-format options.
- Faithfulness stays fully testable — on the data, where the prime directive
  actually binds.

### Negative

- Inconsistent with `show` until the backlog sweep lands (two patterns coexist).
- Callers wanting the literal `git describe` string must assemble it (a one-liner),
  rather than reading a ready-made field.

### Neutral

- `dirty`/`broken` remain (they compute a data field, `dirty: boolean`); only their
  cosmetic mark strings are gone.
- `--contains` and multi-commit-ish input stay deferred to follow-up `23.2a`.
