# ADR-169: OID abbreviation = 7 chars, default context = 3 lines

## Status

Accepted (at `<sha-after-merge>`)

## Context

Two numeric defaults in the patch serializer have a "right answer"
upstream:

- **`core.abbrev`** controls how many leading hex chars of an `ObjectId`
  appear on the `index <old>..<new>` line. Git default is 7. Modern
  git auto-extends abbreviation length when collisions are detected,
  but 7 is the floor and the default for stable output.
- **`diff.context`** controls how many lines of equal context bracket
  each hunk. Git default is 3 (`-U3`).

Both are user-configurable in `gitconfig`. Plumbing them through
`Context.config` and the per-call options costs implementation
complexity (config reader path + per-call override + interaction with
`diff.color` etc.) that 20.3 should not pay.

## Decision

Freeze:

- **`oidAbbrev`** to **7** chars. Not configurable via options; not
  read from gitconfig.
- **`contextLines`** default to **3**. Configurable via
  `DiffOptions.contextLines` (per-call), validated as a non-negative
  integer. Not read from gitconfig.

Both choices match `git diff`'s defaults byte-for-byte.

## Consequences

### Positive

- Output matches `git diff` defaults out of the box. Golden tests use
  literal 7-char abbreviations and 3 lines of context — same as a
  bare `git diff` invocation.
- The serializer surface stays small: one option (`contextLines`)
  exposed publicly, one constant (`OID_ABBREV_LENGTH = 7`) internal.
- Future config plumbing is additive — when `core.abbrev` and
  `diff.context` get wired, the serializer just receives the resolved
  numbers from the caller. No surface change.

### Negative

- A repo with hash-collision-prone abbreviations (very large
  histories) gets ambiguous `index` lines until config plumbing
  arrives. Mitigated: `git diff` itself auto-extends only when there
  IS a collision, which is rare at 7 chars on typical repos; an
  ambiguous abbreviation is a UX wart, not a correctness break.
- Callers wanting `-U5` or `-U0` use `contextLines: 5` /
  `contextLines: 0`. Those wanting per-repo config-driven values must
  read the config themselves and pass the resolved number.

### Neutral

- `OID_ABBREV_LENGTH` lives as a domain-internal constant in
  `patch-serializer.ts`. Exporting it is unnecessary — the serializer
  is the only caller.
- `contextLines: 0` is legal (and matches `git diff -U0`). Validation
  rejects negative numbers.

## Alternatives considered

- **Auto-extend abbreviation on collision.** Rejected: requires
  walking the object database to detect collisions, which makes the
  domain serializer impure and forces a port plumbing. Defer to a
  future ADR that decides whether to thread `objectDb.hasCollision`
  through.
- **Read both from gitconfig at facade time.** Rejected: config
  plumbing is its own phase (Phase 20.6). Hardcoding the defaults now
  unblocks 20.3 without locking the config story in early.
