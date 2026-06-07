# ADR-278: `shortlog` groups by identity name with per-entry email; range + identity surface

## Status

Accepted

## Context

Backlog **23.5** `shortlog` groups reachable commits by author (or committer)
identity. How the grouping is represented in the structured result, and the
shape of the command's selectors, are load-bearing.

A faithfulness discovery drives the representation: in real `git shortlog`, the
default groups by the identity **name only** — `Alice <a@x>` and `Alice <b@x>`
merge into one `Alice (n)` group — while `-e` **re-groups** by `name <email>`
(it is *not* a pure rendering toggle). Grouping is case- and byte-sensitive
(`Alice` ≠ `alice`); groups are ordered byte-wise ascending by name (git's
`string_list` `strcmp`, i.e. UTF-8 bytes, **not** JS UTF-16 default sort); and
within a group commits are listed oldest-first (the exact reverse of the default
newest-first `git log` walk). Merges are included.

Representation alternatives:

- **(A) Key on name, carry per-entry email** — group = `{ name, commits:
  [{ id, email, subject }] }`.
- **(B) Key on full `name <email>`** — group = `{ name, email, commits }`.
- **(C) Flat list** — return ungrouped entries, caller groups.

Both (A) and (B) are lossless: from (A) a caller reconstructs `-e` by
re-partitioning each name-group by `email` and byte-sorting the `name <email>`
sub-groups; from (B) a caller reconstructs the default by merging same-name
groups. (C) pushes git's grouping/ordering/sort semantics onto every caller.

Selector decisions:

- **Identity:** author vs committer (git's `-c`). `committer: boolean` vs a
  `by: 'author' | 'committer'` enum.
- **Range:** support negative ranges now (`git shortlog A..B` / `^X`) vs defer.

## Decision

- **Representation: (A)** — group keyed on the chosen identity's **name**; each
  `commit` carries its own `email`. This matches the backlog spec and git's
  default, and losslessly reconstructs `-e`. The pure
  `domain/shortlog/group.ts` `groupShortlog(entries)` buckets walk-ordered
  entries by name, reverses each bucket to oldest-first, and emits groups
  byte-sorted by name via the domain `compareBytes` over a UTF-8 `TextEncoder`.
- **Identity selector: `by: 'author' | 'committer'`** (default `'author'`) —
  mirrors `log`'s `order` enum, avoids a boolean param, and is extensible.
- **Range: include `excluding?: ReadonlyArray<string>`** now — a thin
  pass-through to `walkCommitsByDate`'s `until` (resolved through the full rev
  grammar like `log`), a real `git shortlog` capability, not speculative.

The `-e` / `-n` (numbered) / `-s` (summary) renderings stay **caller
projections** (ADR-249): `-e` re-partitions by `email`; `-n` re-sorts groups by
`commits.length`; `-s` reads `commits.length`.

## Consequences

### Positive

- Byte-faithful default grouping/ordering pinned once in the domain; `-e`/`-n`/
  `-s` reconstructable from the data without re-running the walk.
- Surface mirrors `log` (`rev`/`excluding` grammar, enum selector) — familiar,
  no boolean-param smell, extensible.
- UTF-8 byte sort matches git for non-ASCII names where JS default sort diverges.

### Negative

- A caller wanting `-e` output must re-partition + re-sort (a documented, small
  projection), rather than getting `name <email>` groups directly.

### Neutral

- Result is `ReadonlyArray<ShortlogGroup>` (no wrapper type), consistent with
  `log`'s `ReadonlyArray<LogEntry>`.
- `--no-merges` / `--max-count` / pathspec args are out of scope (YAGNI); the
  walk + grouping is the deliverable.
- `.mailmap` canonicalisation deferred (cross-cutting; no mailmap support yet).
