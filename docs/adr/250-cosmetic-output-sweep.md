# ADR-250: Cosmetic-output sweep — `show` becomes structured-only

## Status

Accepted (at `010cdce1`)

## Context

ADR-249 set the library-wide rule — **data in a structured shape; representing it is
the caller's job** — and built `describe` under it, while explicitly deferring the
reconciliation of the pre-rule rendering-bearing commands to backlog `23.2a`,
naming `show` and noting ADR-240 (`show`'s `bytes`) would be superseded there.

This is that sweep. An audit of the tier-1 inspection commands found `log`,
`reflog`, `status`, and `cat-file` already compliant (pure structured fields, data
selectors only). The offenders are `show` and `diff`. `show` is the bulk: every
`ShowResult` carries a pre-rendered `text`, the output carries `bytes`, and
`ShowOptions` is almost entirely rendering knobs (`format`/`--pretty`, `date`,
`stat`/`numstat`, `noPatch`, `mergeDiff`) backed by a 21-file, ~1400-LOC
`domain/show/*` rendering subsystem.

Two forces had to be weighed. **Sequencing**: `23.2a` was parked as a v4 cleanup,
but doing it *now* — ahead of the rest of v3 (`blame`, `shortlog`, …) — shrinks the
rendered surface those later commands would otherwise be tempted to mirror.
**Faithfulness**: the prime directive (ADR-226) binds git's observable bytes, and
`show`'s whole value was byte-faithful `git show` output; removing it must not lose
that pin.

## Decision

Sweep `show` + `diff` in **one breaking PR** (a major version bump), ahead of the
rest of v3. `diff`'s strip is ADR-251; this ADR records `show`.

`repo.show(rev | revs, opts?)` returns **structured data only**:

```ts
interface ShowOptions { readonly withStat?: boolean; }   // ADR-252; no rendering knobs

type ShowResult =
  | { kind:'commit'; id; commit: CommitData; patch?: TreeDiff }                  // 0–1 parent
  | { kind:'commit'; id; commit: CommitData; perParent: ReadonlyArray<TreeDiff> } // merge — ADR-253
  | { kind:'tag';    id; tag: TagData; target: ShowResult }
  | { kind:'tree';   id; entries: ReadonlyArray<ShowTreeEntry> }
  | { kind:'blob';   id; content: Uint8Array };

show(ctx, rev: string,             opts?): Promise<ShowResult>;
show(ctx, revs: ReadonlyArray<…>,  opts?): Promise<ReadonlyArray<ShowResult>>;
```

Removed (cosmetic — option **and** code):

- `text` on every result variant; `bytes` + the `ShowOutput` wrapper.
- `ShowOptions.{ format, date, stat, numstat, noPatch, mergeDiff }`, plus
  `ShowStatOptions`, `MergeDiffMode`.
- The entire `domain/show/*` rendering subsystem and the
  `internal/show-{options,combined,decoration}.ts` modules — **deleted from `src`**.

Retained (data / behavior):

- Parsed object data (`CommitData`, `TagData`, tree entries, blob bytes) and the
  structured `patch` / `perParent` diffs.
- Rename detection on by default for `show`'s diffs (ADR-242 — a data behavior) and
  recursive flattening. The `<rev>:<path>` rev-parse grammar (ADR-245) is data
  resolution and is untouched.
- Multi-rev input returns **one result per input rev, in order, with no
  de-duplication** (ADR-241's de-dup + separators are a stream-rendering artifact).

Faithfulness is re-pinned where the prime directive actually binds the bytes — **in
the interop test**. A test-side reconstruction module (the relocated `domain/show/*`)
rebuilds the `git show` stream from a structured `ShowResult` — medium format,
default date, tag/tree/blob rendering, merge combined-diff, multi-rev de-dup +
separators — and compares it byte-for-byte to real `git show`. Every format / date
mode / decoration / stat case the v2 flags exercised survives **as a reconstruction
case in the test**, not as a library option.

## Consequences

### Positive

- `show` returns honest data; no pixels on the surface. Surface shrinks by ~1400 LOC.
- Later v3 inspection commands inherit the structured-only norm instead of a
  rendering precedent.
- Byte-faithfulness is preserved exactly, pinned in the interop test where ADR-249
  says it belongs.

### Negative

- Breaking: callers reading `show().bytes` / `.text` or passing `--pretty`/`--date`
  must render themselves (or read the structured fields).
- Forces the major bump now rather than batching more breaking changes into it.

### Neutral

- Supersedes ADR-240 (`bytes`/`text`); supersedes the *rendering* halves of ADR-241
  (de-dup) and ADRs 244–248 (pretty/date/stat/combined), retaining their
  data-resolution halves. `diff` is ADR-251; counts ADR-252; merges ADR-253.
