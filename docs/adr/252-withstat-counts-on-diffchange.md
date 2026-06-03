# ADR-252: `withStat` opt-in line counts, on each `DiffChange`

## Status

Accepted (at `010cdce1`)

## Context

`show`'s `--stat` / `--numstat` (ADR-247) carried two things: a cosmetic graph
(`scale_linear` widths, `Bin … bytes`, summary pluralisation) — clearly rendering —
and the per-file line counts (`added` / `deleted`, binary flag), which are the
genuine **data** `git --numstat` reports.

Removing the graph is uncontested (ADR-250). The counts are not: they are data, but
they live at a *different layer* than `TreeDiff`. `TreeDiff` is tree-level — it
compares tree-entry oids and reads **no** blob contents. Counts are line-level: they
require materialising both blobs and running Myers per file. Making counts always
present would force every diff (even "which paths changed?") down to line-level,
violating the performance priorities.

The owner also required **symmetry**: however counts attach, they attach identically
to `diff()`, `show`'s `patch`, and each merge `perParent[i]` — not on `show` only.

## Decision

Per-file counts attach via a single **`withStat` data selector**, as optional fields
**on each `DiffChange` inside the `TreeDiff`** — not a separate `StatEntry[]` array,
not a separate result type:

```ts
// withStat omitted/false — tree-level, no blob reads (fast path unchanged)
ModifyChange = { type:'modify', path, oldId, newId, oldMode, newMode }

// withStat: true — counts populated on the same change record
ModifyChange = { type:'modify', path, oldId, newId, oldMode, newMode,
                 added, deleted, binary }
```

`withStat` is honored identically by `diff({ withStat:true })` and
`show({ withStat:true })` (populating `patch` and every `perParent[i]`). It is a
**data selector** — it chooses *which fields exist*, never how text is rendered — so
it is permitted under ADR-249.

The *counting* logic (today `buildStatEntries`, in `domain/show/diff-stat`) moves
into the diff layer to feed `withStat`; the *graph rendering* (`renderDiffStat` /
`renderNumstat`) relocates to the interop test reconstruction.

Typing: `withStat:true` is keyed to a change variant whose count fields are
guaranteed present (an overload, mirroring the former `format:'patch'` overload), so
opt-in callers read `added` without `?`-narrowing while the default stays
count-free. (Exact mechanics finalised in the plan; the surface decision — counts on
the change, gated by `withStat`, symmetric everywhere — is fixed here.)

## Consequences

### Positive

- The `--numstat` *data* survives; only the graph is gone.
- The tree-level diff stays blob-free by default — no perf regression for path-level
  queries.
- One uniform shape across `diff` / `show.patch` / `perParent`; no `stat[]` side-array.

### Negative

- A second typed shape for `DiffChange` (with/without counts); callers wanting counts
  must pass `withStat`.

### Neutral

- Supersedes the *count* half of ADR-247 (`--stat`/`--numstat`); the graph half is
  superseded by ADR-250. The counting code is preserved, relocated into the diff
  layer.
