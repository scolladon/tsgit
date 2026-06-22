# `rangeDiff`

Compare two versions of a patch series — git's `git range-diff`. Reports, commit
by commit, which patches were **added**, **removed**, left **unchanged**, or
**changed** between an old range and a new range. Returns **structured data
only**: the ordered correspondence list (the data behind `git range-diff
--no-patch`), each changed pair carrying the structured diff-of-diffs. The `-s`
line, the oid abbreviation, the number padding, and the rendered diff-of-diffs
body are caller projections.

## Signature

```ts
repo.rangeDiff(opts: RangeDiffOptions): Promise<ReadonlyArray<RangeDiffEntry>>;

interface RangeDiffRange {
  readonly base: string;   // commit-ish (full rev grammar)
  readonly tip: string;    // commit-ish
}

interface RangeDiffOptions {
  readonly old: RangeDiffRange;        // the first / "old" range (base..tip)
  readonly new: RangeDiffRange;        // the second / "new" range
  readonly creationFactor?: number;    // git --creation-factor; default 60
}

type RangeDiffStatus = 'unchanged' | 'changed' | 'only-old' | 'only-new'; // git's = ! < >

interface RangeDiffCommit {
  readonly position: number;   // 1-based index in its merge-filtered, oldest-first series
  readonly id: ObjectId;       // full oid; the caller abbreviates
}

interface RangeDiffEntry {
  readonly status: RangeDiffStatus;
  readonly old?: RangeDiffCommit;      // absent iff status === 'only-new'
  readonly new?: RangeDiffCommit;      // absent iff status === 'only-old'
  readonly subject: string;            // folded subject of (old ?? new)
  readonly diffOfDiffs?: LineDiff;     // present iff status === 'changed'
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `old` | `RangeDiffRange` | (required) | The first range, `base..tip` — the "old" version of the series. `base`/`tip` resolve through the full rev grammar (`~`/`^`/`@{…}`/oid-prefix/annotated-tag peel). |
| `new` | `RangeDiffRange` | (required) | The second range — the "new" version. |
| `creationFactor` | `number` | `60` | git's `--creation-factor` percentage. Lower values pair fewer commits (more `<`/`>`); higher values pair more aggressively. Must be a non-negative integer. |

## Behaviour

- **Patch series.** Each range walks `base..tip` in committer-date order,
  oldest-first, with merge commits excluded (git's `--no-merges`), numbered
  `1..n` — the same series `git range-diff` numbers.
- **Matching.** Commits with byte-identical diffs are paired first (cherry-pick
  equivalents); the rest are paired by a min-cost assignment over a
  "diff-of-diffs" cost matrix. The `creationFactor` (default 60) is the threshold
  between pairing and treating a commit as a pure creation/deletion — because of
  git's integer arithmetic, very small patches often stay unpaired even when
  similar.
- **Status** (git's marker): `unchanged` (`=`) — paired, full patch identical;
  `changed` (`!`) — paired, patch differs; `only-old` (`<`) — dropped; `only-new`
  (`>`) — added. A pair whose diff is identical but whose message or author
  differs is `changed`.
- **Order.** Entries are emitted in **new-range order**, with dropped old commits
  slotted in once their predecessors are shown (git's `output` order).
- **Subject** is the folded subject (`%s`) of the old commit when present, else
  the new — git prints the old side's oneline for a pair.
- **Diff-of-diffs.** Each `changed` entry carries `diffOfDiffs`, a `LineDiff`
  between the two commits' git-format `## ` patch texts. The caller renders git's
  body by walking the hunks and applying the outer `+`/`-`/` ` prefix and a
  4-space indent.

### Caller projections (the library ships data, not rendering)

- **`-s` line:** `printf("%*d:  %s %c %*d:  %s %s", width, position, abbrev(id),
  marker, …)`, padding the number to the width of `1 + max(oldCount, newCount)`.
- **`--left-only` / `--right-only`:** `entries.filter(e => e.old)` /
  `entries.filter(e => e.new)`.
- **The diff-of-diffs body:** render each pair's `diffOfDiffs` hunks with the
  2-level prefix.

### Divergences (documented)

- **Userdiff-driver funcname patterns** (`.gitattributes diff=<lang>`) are not
  supported — only git's default funcname heuristic. For the default config the
  matching is byte-faithful (pinned by the cross-tool interop suite).
- **`diff=<name>` textconv** is NOT applied to range-diff output — the
  diff-of-diffs is computed over raw committed bytes, not textconv output.
- **Rename-with-edit** shows as delete+add (the diff machinery detects exact
  renames only).
- On an **unstructured** cost matrix git's solver may leave a commit unpaired; for
  the structured matrices range-diff builds this never occurs.

## Examples

```ts
// Compare two versions of a topic branch reworked over the same base.
const entries = await repo.rangeDiff({
  old: { base: 'main', tip: 'topic@{1}' },
  new: { base: 'main', tip: 'topic' },
});

// Render git's `-s` lines.
const width = String(1 + Math.max(
  ...entries.flatMap((e) => (e.old ? [e.old.position] : [0])),
  ...entries.flatMap((e) => (e.new ? [e.new.position] : [0])),
)).length;
const cell = (c?: { position: number; id: string }) =>
  c ? `${String(c.position).padStart(width)}:  ${c.id.slice(0, 7)}` : `${'-'.padStart(width)}:  -------`;
const marker = { unchanged: '=', changed: '!', 'only-old': '<', 'only-new': '>' };
for (const e of entries) {
  console.log(`${cell(e.old)} ${marker[e.status]} ${cell(e.new)} ${e.subject}`);
}

// Pair more conservatively.
await repo.rangeDiff({ old, new: next, creationFactor: 90 });
```

## Throws

- `INVALID_OPTION` — `creationFactor` is not a non-negative integer.
- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — a range endpoint cannot be
  resolved (co-refuses with git's `bad revision`).

## See also

- Primitives: [`walkCommitsByDate`](../primitives/walk-commits-by-date.md)
- Related commands: [`log`](log.md) · [`diff`](diff.md) · [`shortlog`](shortlog.md)
- ADRs: 279 (output shape) · 280 (old/new vocabulary) · 281 (assignment + funcname fidelity)
