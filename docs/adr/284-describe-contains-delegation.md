# ADR-284: `describe --contains` delegates to `name-rev` via an overloaded return

## Status

Accepted (at `30466f56`)

## Context

`git describe --contains <c>` is implemented in git as a thin exec of
`git name-rev --tags --no-undefined --peel-tag --name-only [--refs=refs/tags/<m>]`
(and, under `--all`, all refs). Backlog 23.8 bundles it with `name-rev`. Its
output is a name-rev name (`v1.0~3`), **not** `describe`'s nearest-ancestor-tag
`{ tag, distance, exact }` data — so folding it into the existing `DescribeResult`
shape would be lossy (`~3^2~1` is not a single `distance`).

Two load-bearing choices:

1. **Surface** — how `repo.describe` exposes the contains mode given it yields a
   different data shape than normal `describe`.
2. **Unused options** — `describe`'s ancestor-walk options
   (`candidates`/`exactMatch`/`firstParent`/`dirty`/`broken`) have no meaning in
   contains mode. git silently ignores them.

## Decision

1. **Overloaded `repo.describe`.** `describe(rev, { contains: true })` returns a
   `NameRevResult` (ADR-283); `describe` without `contains` keeps returning
   `DescribeResult`. The split is expressed with TypeScript overloads and a
   hand-written facade binding — the same pattern `show`/`diff` already use for
   their overloaded surfaces. The contains branch maps the relevant
   `DescribeOptions` onto `nameRev`: default → `tags: true` with
   `match`/`exclude` prefixed to `refs/tags/<pat>`; `all: true` → all refs; and
   `always` turns the `--no-undefined` refusal back into an `undefined`-ref
   result. An unnameable commit without `always` refuses with a new
   `CANNOT_DESCRIBE { oid }` error, co-refusing with git's `fatal: cannot
   describe '<oid>'`.

2. **Refuse** the ancestor-only options when combined with `contains`, with
   `INVALID_OPTION`. This is a deliberate, documented **divergence** from git
   (which ignores them): a library boundary should reject a meaningless
   combination rather than silently drop a passed option (an
   illegal-state-unrepresentable preference; a passed-but-ignored option is a
   silent footgun).

Rejected alternatives for (1): a separate `containsName` field on
`DescribeResult` (one type carrying two disjoint modes, with the tag/distance
fields meaningless in contains mode); and exposing only `repo.nameRev`, omitting
`contains` from `describe` (diverges from the backlog and from git's surface,
which offers both).

## Consequences

### Positive

- Mirrors git exactly: `describe --contains` *is* `name-rev`, and tsgit's
  delegation returns the same data, reconstructing git's line in interop.
- Clean typing — the caller of `describe({ contains: true })` gets
  `NameRevResult` statically; normal `describe` is unchanged.
- One refusal (`CANNOT_DESCRIBE`) plus the existing `INVALID_OPTION` cover the
  contains-mode error surface; both are co-refusal-pinned.

### Negative

- `describe`'s return type is now overload-dependent on an option value, adding a
  hand-written facade binding (precedented by `show`/`diff`, but more surface to
  maintain than a single signature).
- Refusing the ancestor-only-options combination is a divergence from git's
  silent-ignore; documented here and pinned so it is intentional, not accidental.

### Neutral

- `DescribeOptions` gains one field (`contains`); `DescribeResult` is unchanged.
- The `--peel-tag` / `--name-only` flags git passes internally are rendering
  concerns already absorbed by ADR-283 (`tagDeref` + caller short-naming).
