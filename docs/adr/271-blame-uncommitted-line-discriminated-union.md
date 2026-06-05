# ADR-271: the "Not Committed Yet" line is a discriminated `BlameLine` variant

## Status

Accepted (at `cbae090a`)

## Context

Working-tree blame (ADR-270) introduces git's "Not Committed Yet" pseudo-commit.
`git blame --porcelain` renders it as a synthetic commit:

- oid `0000000000000000000000000000000000000000`,
- identity `Not Committed Yet <not.committed.yet>` at the **current wall-clock
  time** / local tz,
- summary `Version of <path> from <path>`,
- `previous <HEAD-oid> <path>` (when the path is tracked in HEAD), no `boundary`.

Only some of this is **data**: the fact that a line is uncommitted, where its
committed base lives (`previous`), its working position and content. The zero oid
is a constant; the identity, timestamp, and summary are git's *rendering* of "not
committed" — fabricated display, not authorship, and the timestamp is inherently
non-deterministic. ADR-249 ("structured output, not cosmetics") makes that
rendering the **caller's** responsibility.

Today `BlameLine` is a single flat shape with required `commit` / `author` /
`committer` / `summary` / `boundary`. Representing the pseudo-commit forces a choice:

1. **Discriminated union** — `BlameLine = CommittedBlameLine | UncommittedBlameLine`
   on a `committed: true | false` tag; the uncommitted variant omits the fabricated
   oid/identity/summary/boundary, keeping only `finalLine`/`sourceLine`/`sourcePath`/
   `content`/`previous?`.
2. **Flat shape, optional identity fields** — make `commit?`/`author?`/… optional,
   undefined on uncommitted lines.
3. **Fabricate the full synthetic identity** — emit the zero oid, `Not Committed
   Yet`, current-time identity, and `Version of …` summary like git.

## Decision

**Option 1 — discriminated union.** A `committed: true` variant carries the existing
committed fields verbatim; a `committed: false` variant carries only the structural
fields (`finalLine`, `sourceLine`, `sourcePath`, `content`, `previous?`) and the
`committed: false` tag. The library emits **none** of git's fabricated oid /
`Not Committed Yet` / timestamp / summary — a consumer mimicking `git blame`
reconstructs them from `committed: false` (zero oid, the fixed identity strings, a
caller-chosen "now", `Version of <p> from <p>`), exactly as the interop renderer does.

## Consequences

### Positive

- ADR-249-clean: no fabricated cosmetics in the data; git's non-deterministic
  `<NOW>` timestamp never enters the library's output, so results stay deterministic.
- Illegal states unrepresentable: a committed line cannot lack an oid, an
  uncommitted line cannot carry a fake author — the union encodes the invariant in
  the type (the project's "types > runtime checks" / make-illegal-states-
  unrepresentable stance, cf. ADR-263).
- The committed shape is unchanged; committed-rev blame returns only
  `committed: true` lines.

### Negative

- Breaking to the `BlameLine` type (a new `committed` discriminator + the split).
  Allowed in the 23.4 window; consumers narrow on `committed`.
- Committed-rev tests/consumers that read `line.commit` directly need a mechanical
  narrowing (`if (line.committed)`), since `commit` now lives on one arm.

### Neutral

- The zero oid is not exposed as a field; `committed: false` losslessly encodes it
  (every pseudo-commit line has the identical constant oid), avoiding a magic
  sentinel in the surface.
- `previous` stays on the shared base: a committed line's `previous` is its
  committed parent; an uncommitted line's is `HEAD` (absent for a staged-new file).
