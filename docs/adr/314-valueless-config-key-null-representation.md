# ADR-314: Valueless config keys are `value: null` on the structured read surfaces

## Status

Accepted (at `3a5605c1`)

## Context

git's config grammar accepts a `key` line with no `=` inside a section; the internal value is NULL. The state is observable and distinct from both an absent key and an empty value: `--list` renders the bare key (`core.bare`, no `=`) where an empty value renders `x.empty=`; `--type=bool` reads NULL as `true` but `''` as `false`. tsgit's tokenizer previously skipped such lines, so every read surface needs a representation for "present, no value".

The read surfaces already use `undefined` to mean **key absent** (`ConfigGetResult`'s absent arm), so NULL needs a third state. Candidates: `value: string | null`, a discriminated entry union (`{kind:'valued'}/{kind:'valueless'}`), or coercing to the string `'true'`.

## Decision

`IniSection` entries and every structured read surface they feed (`collectValues`, `ConfigEntryView`, `configGet`/`configGetAll` results, `ConfigUnsetResult.previousValue`) widen to `value: string | null`, where `null` is git's internal NULL — key present, no `=`. `undefined` keeps meaning key-absent.

Boolean interpretation (`parseGitBoolean`) maps `null → true`. Value-pattern matching (`configGetRegexp`) matches `null` as the empty string, as pinned against git 2.54.

## Consequences

### Positive

- Three states map 1:1 to git: absent (`undefined`), valueless (`null`), valued (`string`, possibly `''`).
- `null` survives JSON serialization (`undefined` would vanish) — a caller can faithfully reconstruct `git config --list` output from the structured fields (ADR-249).
- Minimal ripple: a type widening, no shape change for existing valued entries.

### Negative

- Public type change: `ConfigEntryView.value`, `ConfigGetResult`, `ConfigGetAllResult`, `ConfigUnsetResult.previousValue` widen — consumers must handle `null` (caught at compile time).
- `null` vs `undefined` carrying distinct meanings is subtle; mitigated by doc comments on each surface.

### Neutral

- The writer gains no way to emit valueless entries — git's CLI cannot either; `ConfigEntry.value` stays `string`.
