# Design — Conflict-marker size + merge-context labels

## Goal

Two coupled faithfulness gaps in the three-way content merge that underlies
`merge` / `cherry-pick` / `revert` / `rebase` / `stash`:

1. **Conflict-marker size** — git's `conflict-marker-size` gitattributes attribute sets the
   length of the `<<<<<<<` / `=======` / `>>>>>>>` markers (default 7) and the
   external merge-driver `%L` placeholder. tsgit hardcodes 7 in both
   `writeConflictMarkers` and `runMergeDriver`.
2. **Merge-context labels** — the strings git writes after the open/close markers
   (`<<<<<<< HEAD`, `>>>>>>> feature`) and passes to a driver as `%X` (ours) /
   `%Y` (theirs) / `%S` (base) are derived from the operation context. tsgit
   hardcodes `ours` / `theirs` for the built-in markers and emits `%S` / `%X` /
   `%Y` **literally** (unsubstituted) for drivers.

These are one feature because the label strings written into the built-in markers
are the **same** strings passed to the driver as `%X`/`%Y` — they share one
per-operation computation. Shipping them apart would build the computation twice.

Faithfulness (prime directive): the marked-up blob bytes in the working tree, the
stage-1/2/3 index, and the `%L`/`%S`/`%X`/`%Y` a driver receives must match
canonical `git` byte-for-byte, pinned by cross-tool interop tests.

## Scope decisions (ADR-306, ADR-307)

- **No `merge.conflictMarkerSize` config.** git has **no** such config — only the
  `conflict-marker-size` *attribute* (verified: `git help config` has no key;
  `git help attributes` documents the attribute). Implementing a config would be
  inventing a divergence. We ship the attribute only. (ADR-306.)
- **Combine the driver `%S`/`%X`/`%Y` placeholders (24.9b) with the built-in
  marker labels (24.9e).** They share the per-operation label computation; both
  land here. (ADR-307.)
- **Fixed 7-char abbreviation** for label SHAs, per the project-wide **ADR-169**
  policy (no object-DB walk to auto-extend) and the existing `stash` precedent
  (`base.b.slice(0, 7)`). git's dynamic abbrev is 7 on the small interop repos,
  so this is byte-faithful there; it diverges only on very large histories, an
  accepted ADR-169 wart, not a new one.

## git's exact behaviour (pinned against git 2.54.0)

### `conflict-marker-size` attribute

The attribute value is parsed with git's strict `strtol_i` (full-string base-10),
then clamped: a parsed integer **> 0** is the marker size; anything else falls
back to **7**. Verified:

| value     | size | value     | size |
|-----------|------|-----------|------|
| `7`       | 7    | `+5`      | 5    |
| `1`       | 1    | `00008`   | 8    |
| `70`      | 70   | `0`       | 7    |
| `-3`      | 7    | `12abc`   | 7    |
| `0x10`    | 7    | `15.9`    | 7    |
| bare set / unset / unspecified | 7 |

All three markers (`<`, `=`, `>`) scale to the size; the trailing label is
appended after a single space (`<<<<<<< HEAD`).

### Per-operation labels

`%X` = ours label (open marker), `%Y` = theirs label (close marker), `%S` = base
label (driver `%S` only — tsgit writes no diff3 `|||||||` base marker in v1).

| operation    | `%S` (base)                     | `%X` (ours)        | `%Y` (theirs)                   |
|--------------|---------------------------------|--------------------|---------------------------------|
| merge        | `<merge-base-abbrev>`           | `HEAD`             | `<rev-as-typed>`                |
| cherry-pick  | `parent of <abbrev> (<subj>)`   | `HEAD`             | `<abbrev> (<subj>)`             |
| revert       | `<abbrev> (<subj>)`             | `HEAD`             | `parent of <abbrev> (<subj>)`   |
| rebase       | `parent of <abbrev> (<subj>)`   | `HEAD`             | `<abbrev> (<subj>)`             |
| stash        | `Stash base`                    | `Updated upstream` | `Stashed changes`               |

- `<abbrev>` = the replayed/reverted commit's oid, 7 chars (ADR-169).
- `<subj>` = git's `find_commit_subject`: the **first line** of the commit
  message body (not the folded `%s`), verbatim (interior tabs/parens/unicode
  kept; trailing/leading whitespace already removed by commit-time stripspace).
  → `subjectLine(commit.data.message)`.
- merge `<rev-as-typed>` = the rev argument verbatim (`feature`,
  `refs/heads/feature`, a tag name, or a full sha — git does **not** normalise
  it). → `opts.rev`.
- merge `<merge-base-abbrev>` = `abbreviateOid(base)`; `''` when there is no
  single merge base (an existing tsgit no-recursive-merge limitation — base label
  only feeds the driver `%S`, never the built-in markers).

## Architecture

The two payloads have different shapes:

- **marker size** is **per-path** (an attribute) → resolved in
  `build-content-merger` alongside the merge driver, from one `sourcesForPath`.
- **labels** are a **per-operation constant** (same for every path) → computed by
  each command, passed into `buildContentMerger`.

Both ride the seams that already exist — `ConflictMarkerOptions` (built-in) and
`DriverPlaceholders` (external) — so the threading is additive.

```
domain/attributes/
  conflict-marker-size.ts   (NEW) resolveMarkerSize(AttributeValue) → number   (strtol_i + clamp)
  driver-command.ts         DriverPlaceholders gains S/X/Y; substituteOne adds the three cases

domain/merge/
  merge-labels.ts           (NEW) MergeLabels + abbreviateOid + commitLabel + replayLabels
                                  + revertLabels + mergeLabels + STASH_LABELS   (pure)
  merge-types.ts            ConflictMarkerOptions gains `markerSize?: number`
  conflict-markers.ts       marker length = options.markerSize ?? 7 (all three markers)
  three-way-content.ts      (no change — options flow through renderWithMarkers verbatim)

application/primitives/
  resolve-merge-driver.ts   resolvePathMergeSpec(ctx, provider, path) → { driver, markerSize }
                                  (one sourcesForPath, resolves `merge` + `conflict-marker-size`)
  run-merge-driver.ts       MergeDriverInput gains markerSize + labels; builds %L/%S/%X/%Y
  build-content-merger.ts   buildContentMerger(ctx, labels): resolve spec per path; thread both
  apply-merge-to-worktree.ts  ApplyMergeInput + mergeTreesToTree input gain `labels`

application/commands/
  merge.ts        mergeLabels(opts.rev, base)            → buildContentMerger
  cherry-pick.ts  replayLabels(source, subjectLine(msg)) → applyMergeToWorktree
  revert.ts       revertLabels(source, subjectLine(msg)) → applyMergeToWorktree
  rebase.ts       replayLabels(source, subjectLine(msg)) → applyMergeToWorktree (thread source oid in)
  stash.ts        STASH_LABELS                           → applyMergeToWorktree / mergeTreesToTree
```

**Dependency rule** honoured: `merge-labels` and `conflict-marker-size` are pure
domain (no platform deps). The command tier does the I/O (read the commit for its
subject) and calls the pure builders. `buildContentMerger` resolves the per-path
attribute via the existing `AttributeProvider`.

### `MergeLabels` (domain/merge/merge-labels.ts)

```ts
export interface MergeLabels {
  readonly ours: string;   // %X, open marker
  readonly theirs: string; // %Y, close marker
  readonly base: string;   // %S, driver only
}
```

Pure builders (no I/O — the command reads the commit and supplies oid + subject):

```ts
const HEAD = 'HEAD';
const ABBREV_LEN = 7;                                           // ADR-169
export const abbreviateOid = (oid: ObjectId): string => oid.slice(0, ABBREV_LEN);
const commitLabel = (oid, subj) => `${abbreviateOid(oid)} (${subj})`;
const parentOf = (label) => `parent of ${label}`;

export const replayLabels = (oid, subj): MergeLabels =>          // cherry-pick + rebase
  ({ ours: HEAD, theirs: commitLabel(oid, subj), base: parentOf(commitLabel(oid, subj)) });
export const revertLabels = (oid, subj): MergeLabels =>
  ({ ours: HEAD, theirs: parentOf(commitLabel(oid, subj)), base: commitLabel(oid, subj) });
export const mergeLabels = (revName, base?): MergeLabels =>
  ({ ours: HEAD, theirs: revName, base: base !== undefined ? abbreviateOid(base) : '' });
export const STASH_LABELS: MergeLabels =
  { ours: 'Updated upstream', theirs: 'Stashed changes', base: 'Stash base' };
```

### Marker-size resolution (domain/attributes/conflict-marker-size.ts)

```ts
export const DEFAULT_CONFLICT_MARKER_SIZE = 7;
// strtol_i: full-string base-10, optional sign; trailing garbage / overflow → reject.
export const resolveMarkerSize = (value: AttributeValue): number => {
  if (typeof value !== 'object') return DEFAULT_CONFLICT_MARKER_SIZE; // true/false/'unspecified'
  const n = strtolI(value.set);
  return n !== undefined && n > 0 ? n : DEFAULT_CONFLICT_MARKER_SIZE;
};
```

`strtolI` matches git: `/^[+-]?[0-9]+$/` over the (already whitespace-trimmed)
attribute token, `Number`-parsed, rejected if it does not fit a 32-bit int.

### Driver placeholders

`DriverPlaceholders` gains `S`/`X`/`Y`; `substituteOne` adds the three cases.
**Critical**: today `%S`/`%X`/`%Y` hit the default branch and are emitted
literally (`%S`) — a divergence the moment a driver uses them. The cases must be
added even for an otherwise-unchanged driver.

### Built-in markers (conflict-markers.ts)

`OURS_MARKER`/`SEPARATOR_MARKER`/`THEIRS_MARKER`/`BASE_MARKER` become
`'<'.repeat(size)` etc., with `size = options.markerSize ?? 7`. Labels already
flow via `options.labels` (default `ours`/`theirs`). The forbidden-substring
label validation is unchanged (a label can still not contain a marker run).

## Threading detail

- `build-content-merger`: `buildContentMerger(ctx, labels)`. Per path resolve
  `{ driver, markerSize }` via `resolvePathMergeSpec`. Built-in →
  `mergeContent(base, ours, theirs, { favor, markerSize, labels: { ours, theirs } })`.
  External → `runMergeDriver(ctx, ctx.command, { …, markerSize, labels })`.
- `apply-merge-to-worktree`: `ApplyMergeInput` and `mergeTreesToTree`'s input gain
  `labels: MergeLabels`, passed straight to `buildContentMerger`.
- `rebase`: `mergeUnderLock` gains a `source: ObjectId` parameter (the replayed
  commit's oid) so it can build `replayLabels`; both the non-interactive
  `replayOne` and the interactive engine already hold the oid.
- The vestigial whole-file fallback in `merge.ts` `materialiseConflictBytes`
  (reached only when a content conflict somehow lacks `conflictContent`, which the
  live merger never produces) is left untouched — unreachable in production, and
  it already used default labels/size, so no faithfulness regression.

## Faithfulness pins

Extend the merge-driver / merge-conflict interop suites (twin git/tsgit) with:

- **size**: `conflict-marker-size=15` (and `=1`, `=0`→7, `12abc`→7) → built-in
  marker length **and** the driver `%L` match git.
- **labels** per operation: `merge <branch>` / `merge <tag>` / cherry-pick /
  revert / rebase / stash → built-in `<<<<<<<`/`>>>>>>>` labels match git; a
  driver capturing `%S %X %Y` receives git's exact strings.
- subject edge cases (multi-line first paragraph → first line only; interior
  tab/paren/unicode preserved).
- memory-adapter fallback unchanged (no `CommandRunner` → built-in markers, which
  now still carry correct labels + size).

## Test plan

- `domain/attributes/conflict-marker-size.test.ts` — the strtol_i table above,
  each branch isolated (mutation: StringLiteral/EqualityOperator on the clamp).
- `domain/merge/merge-labels.test.ts` — each builder's exact output incl. abbrev
  truncation, the `parent of` prefix, empty-base merge.
- `domain/merge/conflict-markers.test.ts` — size 1 / 7 / large; all three markers
  scale; label still appended; forbidden-substring still rejected.
- `domain/attributes/driver-command.test.ts` — `%S`/`%X`/`%Y` substitution +
  unknown `%Z` still literal + `%%`.
- `primitives/resolve-merge-driver.test.ts` → `resolvePathMergeSpec` (driver +
  size from one fetch; attribute precedence for `conflict-marker-size`).
- `primitives/run-merge-driver.test.ts` — `%L`/`%S`/`%X`/`%Y` reach the runner.
- `primitives/build-content-merger.test.ts` — labels + size flow to both branches.
- command tests (`merge`/`cherry-pick`/`revert`/`rebase`/`stash`) — one labelled
  conflict each proving the seam is live end-to-end.
- `test/integration/conflict-marker-size-and-labels-interop.test.ts` (real git).
- property tests where a lens fits: `resolveMarkerSize` is a total function over
  the `AttributeValue` algebra (case 3) → `*.properties.test.ts` proving it never
  throws and always returns a positive integer.

GWT/AAA, `sut`, 100% coverage, 0 killable mutants. Error/value assertions specific.

## Out of scope (documented)

- `merge.conflictMarkerSize` config (does not exist in git — ADR-306).
- Dynamic unique-abbrev (`find_unique_abbrev`) — fixed 7 per ADR-169.
- diff3 `|||||||` base marker (no diff3 in v1 — `writeConflictMarkers` still
  refuses it); `%S` is therefore driver-only.
- Recursive-merge "merged common ancestors" base label (tsgit does single-base
  merges; criss-cross is a separate existing limitation).
- System `/etc/gitattributes` (parked, ADR-302).
