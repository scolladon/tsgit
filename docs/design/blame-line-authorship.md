# Design — `blame` (line-by-line authorship via reverse-diff history walk)

> Tier-1 `blame` answers "which commit last touched each line of a file?". It is
> an **inspection** command in the same family as `log` / `show` / `describe`:
> it walks history and returns **structured data only** — per line, the commit it
> is blamed to, that line's position in the originating commit, and the path the
> file had there; per commit, the author / committer / subject / boundary flag.
> The library renders nothing. Assembling `git blame`'s `^abc1234 (Author …)` or
> `--porcelain` text from these fields is the caller's concern (the project-wide
> "structured output, not cosmetics" rule, ADR-249).

## 1. What git computes (grounded against real `git`)

Isolated env (scrubbed `GIT_*`, signing off, deterministic dates). Four
observations fix the design.

### 1.1 Porcelain is a normalized (commit, line) projection

`git blame --porcelain f.txt` on a two-commit history (c1 added three lines; c2
modified line 2 and appended line 4):

```
<sha-c1> 1 1 1          # <orig-line> <final-line> <count>
author A
author-mail <a@x>
author-time 1609459200
author-tz +0000
committer A … summary c1: initial three lines
boundary
filename f.txt
	line1
<sha-c2> 2 2 1
author B … summary c2: modify line2, add line4
previous <sha-c1> f.txt
filename f.txt
	line2-modified
<sha-c1> 3 3 1
	line3
<sha-c2> 4 4 1
	line4-new
```

The format is exactly a **commit table** (metadata emitted once, on a commit's
first occurrence) plus a **flat per-line list** keyed `<sha> <orig> <final>
<count>`. The library returns the *denormalized* projection of this (ADR-257) —
each line carries its commit's metadata inline; the renderer re-derives
porcelain's once-per-commit dedup from the per-line fields.

Per-commit fields: `author`/`committer` identity, `summary` (the commit subject
— first message line), `boundary` (commit is at the walk's edge), `previous`
(`<sha> <path>` of the parent the file content came from, absent on a root),
`filename` (path the file had *in that commit* — rename-aware).

Per-line fields: the blamed commit, the **original** line number (1-based, in
that commit's version of the file), the **final** line number (1-based, in the
queried file), and the line content.

### 1.2 Original vs final line numbers diverge under shifts

Prepend two lines in c2; the surviving c1 lines keep their **original** numbering
but acquire new **final** positions:

```
<sha-c1> 1 3 2     # orig 1 → final 3, run of 2
	orig1
<sha-c1> 2 4       # orig 2 → final 4
	orig2
```

So each line carries **two** independent indices: `sourceLine` (position in the
blamed commit's blob) and `finalLine` (position in the queried file). The walk
must remap `sourceLine` to the parent's numbering every time it passes blame
down a common region.

### 1.3 Merges blame the parent the line is unchanged in — not the merge

Branch `side` changes line 2 (`b→b-side`); `main` changes line 3 (`c→c-main`);
the merge resolves to `a / b-side / c-main`. Blaming the merge tip:

```
<root>  1 1 1   a          → root commit
<side>  2 2 1   b-side     → side branch  (NOT the merge)
<main>  3 3 1   c-main     → main branch  (NOT the merge)
```

The merge commit itself is blamed for **nothing**: every line is unchanged
against *some* parent, so it passes through. A first-parent-only walk would
wrongly attribute `b-side` to the merge. **Faithfulness mandates diffing the
suspect against every parent** and passing each common region to the matching
parent; only lines that differ from **all** parents stay at the suspect.

### 1.4 Whole-file renames are followed by default

`git mv f.txt renamed.txt` in c3, then `git blame renamed.txt`: the surviving
lines still blame to c1/c2 with `filename f.txt` — git **follows the rename**
without any flag. When the queried path is absent in a parent, git runs rename
detection on the (parent → child) tree diff and continues under the source path.

`-M` / `-C` (intra-/inter-file line *move/copy* detection) are **opt-in** flags,
**off by default** — deferring them keeps v1 faithful to the default. Only
whole-file rename following is part of the default behaviour v1 must replicate.

## 2. What exists already (reused, not rebuilt)

- `diffLines(ours, theirs): LineDiff` (`domain/diff/line-diff.ts`) — Myers line
  diff over `Uint8Array` blobs, returning `common` / `ours-only` / `theirs-only`
  hunks with `oursStart/End` + `theirsStart/End`. **This is the reverse-diff
  engine.** `splitLines` (same module) splits a blob into newline-terminated
  line slices — the canonical line representation reused verbatim.
- `walkCommits` is **not** reused: blame needs a *date-ordered priority queue
  with blame entries attached per commit*, not a plain reachability walk. The
  ordering mirrors `describe.ts`'s proven `enqueue`/`precedes` (date desc, oid
  tie-break); blame adds per-commit entry accumulation.
- `diffTrees(ctx, a, b, { recursive: true, detectRenames: true })`
  (`primitives/diff-trees.ts`) — the rename-detecting recursive tree diff;
  blame queries it to resolve a renamed source path in a parent.
- `flattenTree` / `readTree` / `readBlob` / `readObject` — blob & tree reads.
- `subjectLine(message)` (`domain/objects/commit-message.ts`) — the commit
  subject (porcelain `summary`).
- `resolveCommitIsh` (`commands/internal/commit-ish.ts`) — resolves the start
  rev; `revParse` for `<rev>:<path>`-style needs (not required by v1's surface).
- `AuthorIdentity` carries `name`/`email`/`timestamp`/`timezoneOffset` — the
  exact porcelain identity fields.

## 3. Public surface

```ts
export interface BlameOptions {
  /** Commit-ish to blame as-of (default: HEAD). */
  readonly rev?: string;
  /**
   * Restrict the reported lines to a 1-based inclusive `[start, end]` final-file
   * range (git's `-L`). Out-of-range / inverted bounds refuse like git.
   * Omitted → the whole file. A pure output selector: each line's blame is
   * independent of which lines are requested, so filtering is faithful.
   */
  readonly range?: { readonly start: number; readonly end: number };
}

export interface BlameLine {
  /** 1-based line number in the queried file. */
  readonly finalLine: number;
  /** 1-based line number in the blamed commit's version of the file. */
  readonly sourceLine: number;
  /** Commit this line is blamed to. */
  readonly commit: ObjectId;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  /** Commit subject (first message line) — porcelain `summary`. */
  readonly summary: string;
  /** Blamed commit is at the walk's edge (a root: no parents) — porcelain `boundary`. */
  readonly boundary: boolean;
  /** Path the file had in the blamed commit — rename-aware (porcelain `filename`). */
  readonly sourcePath: FilePath;
  /** Parent the file content came from (porcelain `previous`); absent on a root. */
  readonly previous?: { readonly commit: ObjectId; readonly path: FilePath };
  /** The line's bytes (newline-terminated except a final line without a trailing LF). */
  readonly content: Uint8Array;
}

export interface BlameResult {
  /** The queried path (final name). */
  readonly path: FilePath;
  /** Every reported line, in final-file order. */
  readonly lines: ReadonlyArray<BlameLine>;
}

export const blame = (ctx: Context, path: string, opts?: BlameOptions) => Promise<BlameResult>;
```

`repo.blame(path, opts?)` binds it on the facade (flat method, like `log` /
`describe`).

### 3.1 Result shape rationale (denormalized per-line) — ADR-257

The result is **denormalized**: a single flat `lines` array, each `BlameLine`
carrying the blamed commit's `author` / `committer` / `summary` / `boundary` /
`previous` inline (commit identities are shared references, not deep copies).
A consumer maps a line straight to a rendered row or a UI gutter annotation with
authorship in hand — no oid→metadata lookup, and `-L` filtering is a plain
`Array.filter` with no companion map to keep consistent. Reconstructing
porcelain's deduped commit headers (emit a commit's metadata once, on its first
occurrence) is the renderer's job, derived from the per-line fields. Considered +
rejected (ADR-257): a normalized `commits` map + oid-referencing lines (DRY but a
lookup per line on consumption) and porcelain-style nested groups (bakes one
rendering's grouping into the data).

## 4. Algorithm — the blame scoreboard

A faithful port of git's `blame.c` scoreboard, reduced to the default behaviour.

### 4.1 State

- **Origin** = `(commit, path)` with its lazily-read, cached blob and split
  lines. A commit may (under rename) own more than one origin.
- **BlameEntry** `{ finalStart, count, sourceStart }` — `count` consecutive
  final-file lines starting at `finalStart` (0-based) currently map to the
  suspect origin's lines `[sourceStart, sourceStart + count)`.
- **Priority queue** of suspect origins, the newest **commit date** first
  (`describe`'s `enqueue`/`precedes`: date desc, oid asc tie-break). Newest-first
  is the same date-monotonicity heuristic git relies on: in a normal (monotonic)
  history, an origin pops only after every descendant that could pass blame *to*
  it. Entries are **keyed by origin** `(commit, path)` and **merged** on enqueue,
  so two children passing blame to the same parent accumulate one entry list. An
  origin that receives entries after it was already popped is **re-enqueued**
  (entries only ever descend the DAG toward strictly-older parents, so this
  cannot loop — it terminates at the roots). This reproduces git's behaviour
  including its clock-skew ordering, rather than imposing a stricter topological
  order git does not use.
- **finalized**: entries whose suspect is confirmed (`BlameLine`s accumulate here).

### 4.2 Seed

Resolve `rev` → commit (via `resolveCommitIsh`); validate `path` to `FilePath`;
resolve it in the start commit's tree → blob (refuse with a typed error like git
when the path is absent or names a tree). Split into `N` lines. Seed one entry
`{ finalStart: 0, count: N, sourceStart: 0 }` on origin `(startCommit, path)`.
Empty file → empty `lines`.

The blamed commit's metadata (author/committer/summary/boundary/previous) is
denormalized onto each finalized `BlameLine` (ADR-257) — there is no separate
commit table.

### 4.3 Pass blame to parents (per popped origin)

For origin `(C, p)` with entries `E` and blob `Bc`:

1. `remaining = E`.
2. For each parent `P` of `C` **in order**:
   - Resolve `p` in `P`'s tree → blob `Bp`. If absent, run rename detection
     (`diffTrees(P.tree, C.tree, { recursive, detectRenames })`, find the
     `rename` whose `newPath === p`) → source path `p'` + blob `Bp`. If still
     absent (file added in `C`), this parent contributes nothing; `continue`.
   - `{ passed, kept } = splitAgainstParent(remaining, diffLines(Bp, Bc))`
     (pure domain fn, §4.4). `diffLines(parent, child)`: `common` hunks carry the
     parent↔child line correspondence; `theirs-only` hunks are child-added.
   - For each `passed` entry, remap `sourceStart` into `P`'s numbering and assign
     it to origin `(P, p')`, enqueuing/merging that origin. Record `C.previous =
     { commit: P, path: p' }` (first parent that holds the file).
   - `remaining = kept`.
3. `remaining` (differs from every parent, or `C` is a root) **finalizes** to
   `C`: each entry becomes `count` `BlameLine`s (`sourceLine`/`finalLine`
   1-based, `sourcePath = p`, `content` from `Bc`'s split lines).
   `C.boundary = (C.parents.length === 0)`.

Terminates: every entry either passes to a strictly-older parent or finalizes;
the commit graph is finite and acyclic, and `visited`-guarding origins prevents
re-expansion.

### 4.4 `splitAgainstParent` — the pure core (`domain/blame/`)

Pure, fully unit-testable, zero I/O. Given `entries` (relative to the child
blob) and `lineDiff = diffLines(parentBlob, childBlob)`:

- A `common` hunk maps child lines `[theirsStart, theirsEnd)` ↔ parent lines
  `[oursStart, oursEnd)` (equal length). The slice of any entry intersecting this
  child range is **passed** to the parent, its `sourceStart` shifted by
  `oursStart - theirsStart`.
- Child lines in `theirs-only` hunks (added by the child) are **kept** at the
  suspect. `ours-only` (parent-only) hunks are irrelevant to child lines.

Returns `{ passed: BlameEntry[] (parent-relative), kept: BlameEntry[] (child) }`,
both preserving `finalStart` (final-file position is invariant down the walk).
Entries are split at hunk boundaries; `finalStart`/`count` stay consistent.

### 4.5 `degraded` line diffs

`diffLines` degrades (whole-file fallback) on binary / oversized blobs
(`LineDiff.degraded`). In that mode every line is `ours-only` + `theirs-only`
(no common region) → nothing passes to the parent → the whole file finalizes to
the suspect. That is exactly git's behaviour when content is treated as wholly
rewritten, so no special-casing is needed.

### 4.6 `-L` range and `previous` stability

`range` filters the finalized `lines` to the 1-based inclusive `[start, end]`
window over `finalLine`. Inverted (`start > end`) or out-of-range bounds refuse
with a typed error, mirroring git's `-L` validation. Because each line's blame is
computed independently, the filtered output is identical to what git reports for
the same `-L` — only the (here unbounded) history walk differs, which is
invisible in the data. With denormalized lines (ADR-257) the filter is a plain
`Array.filter`; no companion commit table needs reconciling.

`previous` is recorded per origin and denormalized onto each `BlameLine`. For a
single-file blame without line-level copy detection, a commit blames exactly one
path, so its `previous` is stable across that commit's lines; a commit owning two
source paths (only reachable via deferred `-C`) is out of v1 scope.

## 5. Layering (hexagonal)

```
domain/blame/                 # pure, zero I/O
  types.ts                    # BlameEntry
  split-blame.ts              # splitAgainstParent(entries, lineDiff)
  index.ts
application/commands/blame.ts # Tier-1 orchestration: resolve, drive walk, build result
```

Public types (`BlameOptions`/`BlameResult`/`BlameLine`) live with
the command (mirroring `describe.ts` / `show.ts`) and re-export through
`commands/index.ts`. `repository.ts` binds `repo.blame`. No new port — blame
reads only objects/trees through existing primitives.

## 6. Scope (v1) and deferrals

**In v1 (faithful default):** blame a committed rev (default HEAD) + path;
all-parents merge handling; whole-file rename following; `-L` range selector;
date-ordered walk; normalized structured result.

**Deferred (all non-default in git, so deferral stays faithful):**

- **Working-tree / uncommitted blame** — `git blame f.txt` on a *dirty* tree
  blames uncommitted lines to a zero-oid "Not Committed Yet" pseudo-commit. v1
  blames the committed `rev` content (default HEAD); on a clean tree this equals
  `git blame -- f.txt`, on a dirty tree it diverges. **ADR (faithful divergence).**
  Follow-up: working-tree pseudo-commit.
- **`-M` / `-C`** line move/copy detection (opt-in) — backlog follow-up.
- **`--reverse`**, `-w`/whitespace modes, `--ignore-rev` /
  `.git-blame-ignore-revs`, `-S`/incremental — backlog follow-ups.

## 7. Testing

- **Unit — `domain/blame/split-blame`**: the pure core against hand-built
  `LineDiff`s — common-region pass-through with `sourceStart` shift, entry split
  at hunk boundaries, all-added (nothing passed), all-removed-parent, empty
  entries, multi-hunk interleaving. GWT/AAA, `sut`, 100% + 0 surviving mutants.
- **Unit — `commands/blame`**: seeded on a memory adapter — linear history
  (modify/append → original vs final numbering), prepend shift, merge
  (all-parents attribution), whole-file rename following, `-L` range filtering,
  refusals (missing path, inverted/out-of-range `-L`), empty file, root boundary.
- **Property** (`split-blame.properties.test.ts`): the four lenses —
  `splitAgainstParent` is a *compositional aggregator over hunks*. Invariants:
  (1) `passed.count + kept.count === Σ entries.count` (no line lost or
  duplicated); (2) every output entry preserves its `finalStart`/final-range
  identity (partition of the final lines); (3) an all-`common` diff passes
  everything and keeps nothing; an all-`theirs-only` diff keeps everything and
  passes nothing (identity/annihilator). Tiered `numRuns` 100.
- **Interop — `blame-interop.test.ts`**: build repos with real `git`
  (deterministic dates, signing off), reconstruct `git blame --porcelain` from
  the structured `BlameResult`, assert byte-equal vs real `git blame
  --porcelain`. Cases: linear, prepend-shift, non-trivial merge, whole-file
  rename, `-L` range. Faithfulness is pinned on the **data**; the library emits
  no line.

## 8. Decisions (settled — ADRs 257–258)

1. **Result shape** → **denormalized per-line** (ADR-257): each `BlameLine`
   carries its blamed commit's metadata inline; no `commits` table (§3, §3.1).
2. **Working-tree blame** → **defer** (ADR-258): v1 blames the committed `rev`
   (default HEAD); the not-committed-yet pseudo-commit is a follow-up (§6).
3. **`-L` range** → **include** in v1 as a faithful output selector (§3, §4.6).
4. **Rename following** → whole-file renames followed by default (faithful, the
   prime directive — no ADR); `-M`/`-C` line move/copy deferred (§1.4, §6).
5. **Merge handling** → all-parents attribution (faithful, mandated by §1.3 —
   no ADR).
