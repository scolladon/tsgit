# ADR-283: `name-rev` returns a structured path, not a rendered name

## Status

Accepted (at `30466f56`)

## Context

Backlog 23.8 adds `name-rev` — git's `git name-rev`, which names a commit by a
ref that **contains** it, printing a string like `tags/v2.0~3^2~1`: a ref short
name followed by a `~`/`^` navigation path (`~n` = n first-parents back, `^n` =
n-th parent, `^0` = peel an annotated tag to its commit). tsgit returns
structured data only (ADR-249), so the question is what shape replaces git's
printed string.

The string carries three kinds of information mixed together: the **ref**, an
**abbreviation** of it (the strip rule is flag-dependent — `tags/v1.0` for plain
name-rev, `v1.0` for `describe --contains`), and the **path** (a sequence of
first-parent counts and parent numbers). The path components are integers; the
abbreviation is display layout.

## Decision

`repo.nameRev` returns

```ts
interface NameRevResult {
  readonly oid: ObjectId;                       // queried commit, full 40-hex
  readonly ref: RefName | undefined;            // naming ref, FULL name; undefined ⇒ unnameable
  readonly tagDeref: boolean;                   // ref is an annotated tag (the ^0 peel)
  readonly steps: ReadonlyArray<NameRevStep>;   // ordered navigation from the ref's commit to oid
}
type NameRevStep =
  | { readonly kind: 'ancestor'; readonly count: number }   // ~count, first-parent, count ≥ 1
  | { readonly kind: 'parent'; readonly number: number };   // ^number, number-th parent, number ≥ 2
```

The library renders **no** name string and **no** abbreviation: it returns the
**full** `ref` and the structured `steps`; the caller assembles
`shortName(ref) + steps`. The `^0` deref is encoded as `tagDeref` (rendered only
at the tip, when `steps` is empty — git strips it once any step exists). An
unnameable commit returns `ref: undefined` (git prints `undefined`); `name-rev`
itself never throws.

The flag-dependent short-name rule (strip `refs/heads/` else `refs/`, vs the
rev-parse shortest-unambiguous form) is therefore a **caller** concern, applied
in the interop test to reconstruct whichever git command is being compared.

## Consequences

### Positive

- Faithful to ADR-249: no pre-rendered line; the `~n`/`^n` counts are data, and
  the abbreviation (a display choice that varies by invocation) stays caller-side.
- The structured `steps` reconstruct git's string byte-for-byte under both the
  plain-`name-rev` and `describe --contains` abbreviation rules — pinned by
  interop — without the library committing to either.
- `ref: undefined` models git's `undefined` and its `--always` (oid) line from
  the same data, so neither `--always` nor `--name-only` needs to be an option
  (both are pure rendering of `ref`/`oid`).

### Negative

- A caller wanting the literal `git name-rev` string must write a small render
  helper (provided verbatim in the docs and the interop test). The library does
  not hand back the ready string.

### Neutral

- `steps` keeps the merge `^n` jumps and first-parent `~n` runs distinct, which
  is exactly git's internal `tip_name`/`generation` split surfaced as data.
