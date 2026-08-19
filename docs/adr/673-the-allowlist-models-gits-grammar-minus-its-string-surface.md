# 673 — The allowlist models git's grammar minus its string-surface artefacts

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D5) · **Refines:** ADR-657

## Context

`safe.directory` is a repeated **string** config key. tsgit's equivalent is an **array
argument** (ADR-671). Some of git's measured semantics are properties of the grammar; others are
artefacts of parsing a repeated string key, and have no analogue in an array.

Measured semantics with an array analogue: exact match on the repository path; a trailing
separator is insignificant; `*` matches all repositories; a trailing `/*` matches every path
strictly **below** the prefix at any depth (never the prefix itself); values and repository path
are both realpath'd before comparison; matching is case-sensitive even on a case-insensitive
volume; `$T/nor*` is **not** fnmatch — only a literal trailing `/*` is special.

Artefacts without an analogue: a valueless entry **clears everything accumulated so far** (an
array *is* the final list — there is nothing to reset); the `warning: … not absolute` on a
relative value; and `.` alone normalising against cwd while `./` and `..` do not.

## Options considered

1. **Exact + trailing-slash-insensitive + `*` + `/*` any-depth prefix, absolute-only, realpath'd
   on node and lexical in sandboxes** (design recommendation) — pros: models every row with an
   array analogue and refuses the rest loudly / cons: three grammar rows are deliberately absent.
2. **Exact + `*` only** — pros: minimal / cons: drops `/*`, which is the row that makes the
   feature usable for "trust everything under `/workspace`" — the CI case that is most real
   `safe.directory` usage; without it every repository needs its own entry.
3. **Full git grammar including the reset, the relative warning and the `.` quirk** — pros:
   maximal faithfulness / cons: transplants string-surface artefacts into an array where the
   reset has nothing to reset, and the relative-value *warning* contradicts ADR-657's ratified
   *refusal*.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

Entries must be absolute; a relative entry is refused, not warned about (ADR-657). The three
string-surface artefacts are deliberately not modelled, and their absence is recorded here so it
reads as a decision rather than an omission.

## Consequences

- The matcher is a compositional predicate over an entry list, which makes it a genuine
  property-test candidate under the repository's lens 2 — the design's test strategy takes it.
- Sandbox adapters match lexically because they have no realpath; that split is asserted rather
  than a raw path total (platform-dependent oracles do not transfer).
- Adding the reset semantic later would be a breaking change to an argument's meaning; it is
  foreclosed deliberately.
