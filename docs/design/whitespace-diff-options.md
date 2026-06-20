# Design — whitespace diff options

> Brief: surface git's whitespace diff family (`-w` / `-b` / `--ignore-space-at-eol`
> / `--ignore-cr-at-eol` / `--ignore-blank-lines`) as STRUCTURED modes on the diff
> options. Today there is no `--ignore-all-space` family; the spike emulated it by
> strip-and-compare over modified blob pairs (O(blob bytes) per file). Replace that
> with normalization paid once per line inside the existing Myers pass, byte-faithful
> to real `git` — pinned, not recalled.
> Status: draft → self-reviewed ×3 → revised against the ratified decisions
> (whitespace surface is a flat enum + inline toggles; all five modes — including
> `--ignore-blank-lines` — ship now; whitespace + rename config defaults land on
> `RepositoryConfig`, consumed by `diff`).

## 1. Context

The textual diff core is `diffLines(ours, theirs): LineDiff`
(`src/domain/diff/line-diff.ts`). It splits both blobs into LF-terminated
`Uint8Array` lines (`splitLines`, keeps the trailing `\n` in each line), runs a
Myers trace whose only line-equality test is `bytesEqual(oursLines[x], theirsLines[y])`
(`advanceSnake`, line 105), and emits `common` / `ours-only` / `theirs-only`
hunks that index back into the original line arrays. The lines stay raw bytes so
every downstream consumer renders the **original** content, not a normalized copy.

`diffLines` has **eight call sites** and they are NOT all "diff display" — this is
the load-bearing scoping fact for this feature:

| Caller | File | Role | Must whitespace modes reach it? |
|---|---|---|---|
| `buildEdits` | `patch-serializer.ts:194` | unified-patch hunks | **YES** — `git diff -w` reshapes the patch |
| `computeStatFields` | `stat-fields.ts:34` | numstat counts | **YES** — `git diff -w --numstat` counts change |
| `mergeFromDiffs` | `merge/three-way-content.ts:85` | three-way **merge** | **NO** — `git merge` has no `-w`; changing this diverges |
| `splitAgainstParent` | `blame.ts:158` | **blame** line attribution | **NO** — `git blame -w` is a separate default-off opt-in, out of scope |
| diff-of-diffs | `range-diff/interleave.ts:64` | range-diff | **NO** — `git range-diff` has no whitespace knob |
| blame arbitraries | test fixture | test only | **NO** |

So normalization **cannot** live unconditionally inside `diffLines` — that would
silently change merge resolution and blame output, a faithfulness regression on two
unrelated commands. The whitespace mode must be an **opt-in parameter threaded into
`diffLines`, defaulting to "no normalization"**, so merge / blame / range-diff are
byte-unchanged and only the diff + numstat path passes it through.

The structured surface today: `DiffOptions` (`commands/diff.ts:8`) →
`DiffTreesOptions` (`primitives/types.ts:187`) → `diffTrees` primitive
(`primitives/diff-trees.ts`). The primitive resolves trees, runs
`domainDiffTrees` (pure OID-level classification), composes rename detection, and
optionally `attachStats` (which calls `computeStatFields` → `diffLines`). The patch
path runs `materialisePatchFiles` then the serializer's `buildEdits` → `diffLines`.

### 1.1 ADR-249 — these are DATA modes, not cosmetic flags

ADR-249 forbids options whose only job is to steer rendered text (`--abbrev`,
`--color`, `--date`, `--pretty`). Whitespace modes are categorically different:
they change **which lines are considered changed**, hence **which hunks exist**,
**which files appear in the diff at all**, and **the numstat counts** (§3.4 pins a
whitespace-only file vanishing entirely from `--name-status`/`--numstat`/`--raw`
under a line-key mode, #D1; and the subtler #BL1 case where `--ignore-blank-lines`
makes git's per-mode output deliberately inconsistent). That is the structured DATA
and the on-disk-equivalent change set, not the display string. They legitimately
belong on the options surface; the doc states this so a reviewer does not mistake
them for forbidden rendering knobs. Per §3.3a the library ships only the underlying
fields (oids, counts, modes, hunks) and the caller reconstructs each git output
mode — no pre-rendered line and no bespoke "suppressed" marker.

### 1.2 Constraining decisions (FIXED — not re-litigated here)

| Source | Decision this design must implement |
|---|---|
| ADR-226 / CLAUDE.md | Replicate git's observable change-set + counts byte-for-byte; pin against real `git`, never from memory. |
| ADR-249 | Whitespace modes are structured fields; the library emits no `-w`/`-b` text — the data outcome (dropped change, recounted numstat, reshaped hunks) IS the faithfulness target, reconstructed in the interop test. |
| 24.12 (`diff-recursive-tree-diff`) | Recursive flattening already lands per-file full-path changes into the patch path; whitespace normalization composes on top, per file, unchanged. |
| 24.13 (`similarity-rename-detection`) | The diffcore-rename similarity scorer (`estimateSimilarity`, spanhash) is its own pipeline. §4 pins that git's whitespace flags do NOT reach it. |

All five §6 decisions are now RESOLVED (see §6); this section's deltas reflect the
ratified choices: a flat enum + inline toggles for the surface, `--ignore-blank-lines`
in scope as a hunk/numstat suppressor, the file-drop gated on a line-key mode, and
`RepositoryConfig` whitespace + rename defaults consumed by `diff`.

## 2. Requirements

1. `DiffOptions`/`DiffTreesOptions` carry the whitespace surface as **three flat
   root fields** (D1): a mutually-exclusive `ignoreWhitespace?: 'all' | 'change' |
   'at-eol'` enum (`-w` / `-b` / `--ignore-space-at-eol`) plus the orthogonal
   booleans `ignoreCrAtEol?` (`--ignore-cr-at-eol`) and `ignoreBlankLines?`
   (`--ignore-blank-lines`). All five modes ship in 24.14. Default (all absent) =
   today's exact byte comparison.
2. The **line-key** modes (the `ignoreWhitespace` enum + `ignoreCrAtEol`) normalize
   the **line-equality key** inside the Myers pass once per line — not a separate
   full-blob strip — so cost stays O(blob bytes) within the existing pass, never a
   doubled pass (corrects the spike's strip-and-compare).
3. Emitted line content is the **original** bytes (the new side's whitespace shows
   verbatim in context/changed lines) — matching git (§3.4 #M1).
4. A file whose only change is normalized away **disappears** from the structured
   `TreeDiff.changes` — but ONLY under an active **line-key** mode (the
   `ignoreWhitespace` enum or `ignoreCrAtEol`), matching git's name-status drop
   (§3.4 #D1). numstat for such a dropped file is absent, not `0 0`.
   `ignoreBlankLines` ALONE never drops a file (§3.3a / §3.4 #BL1): it suppresses
   the file's hunks and numstat row but keeps the `modify` in `TreeDiff.changes`,
   reproducing git's deliberately mode-inconsistent output (file present in
   name-status/raw/quiet; absent from numstat; empty patch).
5. `withStat` counts (`computeStatFields`) reflect the active line-key mode AND
   blank-line suppression automatically, because they flow through the same
   `diffLines` + the same emission filter — `git diff -w --numstat` /
   `git diff --ignore-blank-lines --numstat` parity.
6. Rename/copy/break **similarity scoring is UNAFFECTED** by whitespace modes
   (pinned §4) — the diffcore pipeline is not touched.
7. `merge`, `blame`, `range-diff` are byte-unchanged: their `diffLines` calls pass
   no mode (default).
8. Each mode's exact normalization semantics (what is "whitespace", leading vs
   trailing vs internal, CR, blank) are byte-faithful to the pinned matrix (§3).
9. Mode combinability matches git: the modes are independently combinable; `-w`
   dominates `-b` where they overlap (pinned §3.4 #C1 / §3.5), encoded structurally
   by the `ignoreWhitespace` enum (D1).
10. The full matrix is pinned by a new `*-interop` test (twin real-`git` vs tsgit),
    double-pinned against a frozen golden like `diff-recursive-interop`.

## 3. Design

### 3.1 Where normalization lives — the line-key, threaded as a mode

git maps the family to xdiff `XDF_*` flags consumed inside `xdl_recmatch` /
`xdl_hash_record` during the diff — i.e. at line comparison, not as a pre-pass.
tsgit mirrors this with a pure **line-key transform** applied at exactly the two
points `diffLines` decides line equality:

- `advanceSnake`'s `bytesEqual(oursLines[x], theirsLines[y])` (forward snake);
- (and the same key feeds any equality test the trace reconstruction relies on).

The public surface is **flat** (D1): `DiffOptions` / `DiffTreesOptions` /
`RepositoryConfig` each carry `ignoreWhitespace?: 'all' | 'change' | 'at-eol'`,
`ignoreCrAtEol?: boolean`, and `ignoreBlankLines?: boolean` directly on the root.
`diffTrees` **resolves** those flat fields into one internal mode descriptor that
the domain comparator consumes — the descriptor is a tsgit implementation detail,
not a second public surface:

```ts
// internal (src/domain/diff/whitespace.ts) — NOT a public flag bag
type WhitespaceMode = 'all' | 'change' | 'at-eol' | 'none';
interface LineKey { readonly mode: WhitespaceMode; readonly ignoreCrAtEol: boolean; }
```

`ignoreBlankLines` is NOT part of the line-key (it is mechanically distinct — the
emission suppressor of §3.3a), so it does NOT enter `LineKey`. A pure normalizer
`normalizeLine(line: Uint8Array, key: LineKey): Uint8Array` (or, for hot-path
efficiency, a `linesEqualUnder(a, b, key): boolean` comparator that avoids
allocating a normalized copy per compare) consumes `LineKey`. `diffLines` gains an
**optional** trailing options arg:

```ts
export interface LineDiffOptions {
  readonly lineKey?: LineKey;   // absent ⇒ exact bytesEqual (today)
}
export function diffLines(ours, theirs, options?: LineDiffOptions): LineDiff;
```

Default (`options` absent / `lineKey` absent, equivalently `mode: 'none'` with
`ignoreCrAtEol: false`) is `bytesEqual` — every current caller compiles and behaves
identically (Requirement 7). Only `buildEdits` and `computeStatFields` thread the
resolved `LineKey` down from `DiffTreesOptions`; `ignoreBlankLines` threads
separately to the emission filter (§3.3a).

**Why a comparator, not a pre-normalized line array (perf, Requirement 2/3).**
Pre-normalizing `splitLines` output would (a) lose the original bytes needed for
display (Requirement 3) and (b) allocate a second line array. A `linesEqualUnder`
comparator normalizes lazily during the O(D·snake) comparisons the Myers pass
already performs — one normalization per *comparison*, original bytes retained for
emission. This is the "paid once per line during the existing pass" the brief asks
for, replacing the spike's separate O(blob bytes) strip.

### 3.2 The file-drop: a line-key-empty modify must be removed

`domainDiffTrees` classifies a whitespace-only edit as a `modify` (the blob OIDs
differ). git drops it entirely under a **line-key** mode (#D1). So a
post-classification pass in the `diffTrees` **primitive** must, when a line-key mode
is active (the `ignoreWhitespace` enum OR `ignoreCrAtEol`), re-evaluate each
`modify` and **drop** it if its line-key-normalized `diffLines` — *after* blank-line
suppression (§3.3a) — yields no `ours-only`/`theirs-only` hunk. This is a
primitive-tier concern (it reads blob bytes, which the pure domain classifier
never does) and reuses the bounded-pool blob hydration already used by
`attachStats` / `materialisePatchFiles`. The drop runs **after** rename/copy
detection (which scores on raw bytes and is whitespace-agnostic, §4): rename
detection sees the complete raw change-set first, then the drop prunes the
whitespace-only `modify` entries it left behind. A whitespace-only *rename* is paired
into a `rename` change before the drop, and the drop targets only `modify`, so a
whitespace-only rename is never dropped (the two orderings are observationally
equivalent for renames, since a same-path whitespace-only modify is not a rename
candidate; running after keeps the change-set git-faithful and matches ADR-380). The
drop is independent of `withStat` (it is faithful to the change-set, not the counts).

**`ignoreBlankLines` ALONE is NOT a drop trigger (CORRECTED).** Pinned against real
git 2.54.0 (#BL1): a blank-only change under `--ignore-blank-lines` keeps the file
as `M` in `--name-status` and `--raw` and exits nonzero under `--quiet`, while the
patch body is empty and `--numstat` omits the row. The file therefore STAYS in
`TreeDiff.changes`; only its emitted hunks and stat counts are suppressed (§3.3a).
The drop predicate is gated strictly on a **line-key** mode. The combined case
(`--ignore-blank-lines -w` on a spaces-only insert, #BL-combo) DOES drop — but
because `-w` is a line-key mode that turns the inserted line blank, so the line-key
`diffLines` itself yields no hunk; the drop fires on the line-key mode, not on
`ignoreBlankLines`.

**Binary and type-change never drop.** Binary files ignore whitespace flags in git
(the line diff never runs), and a type-change carries a real mode change; git keeps
both, so the drop predicate excludes them (D3).

**Cost.** When a line-key mode is active, the tree-level diff can no longer be
OID-only: deciding the drop requires reading both blob sides and running the
normalized line diff per candidate `modify`. git pays exactly this cost (`git diff
-w` reads blobs even without `--numstat`). The drop pass therefore hydrates blobs
through the same bounded pool as `attachStats`/`materialisePatchFiles`, and the
line-key-normalized `diffLines` it runs is *reused* by the patch/stat path when
those are also requested (one line diff per file, not two). With no line-key mode
active the OID-only fast path is unchanged — zero new cost for the default diff.
`ignoreBlankLines` alone does not force blob reads for the drop (no drop pass runs),
but the suppressor still needs the hunks where `withStat`/patch are requested — the
same `diffLines` those already run.

### 3.3 Per-mode normalization semantics (PINNED — §3.4 matrix)

Each mode transforms a line's comparison key. "Whitespace" = space (0x20) and tab
(0x09) (git's `XDL_ISSPACE` over the record; the matrix confirms tab↔space are
interchangeable under `-b`/`-w`). The line terminator handling: `splitLines` keeps
the trailing `\n` in the line, and the LAST line may be unterminated (#D2 pins the
drop holding without a terminating LF). The transforms operate on the line content
up to (and excluding) the terminating `\n`; the `\n` itself is preserved in the key
when present and simply absent for an unterminated line. "Trailing whitespace at
eol" = the whitespace run immediately before the terminator (or end of an
unterminated line). A trailing CR before the terminator is in scope for `-w`/`-b`/
`--ignore-space-at-eol` (it is EOL whitespace for them) and for `--ignore-cr-at-eol`
(its sole purpose) — see the per-mode CR note below.

- **`-w` ignore-all-space (`XDF_IGNORE_WHITESPACE`)** — drop ALL space/tab bytes
  from the key before compare. `a b` ≡ `ab` ≡ `a   b` ≡ `\tab`. The most
  aggressive; subsumes `-b` and `--ignore-space-at-eol`.
- **`-b` ignore-space-change (`XDF_IGNORE_WHITESPACE_CHANGE`)** — collapse each
  run of space/tab to a single space; drop trailing run; leading-run *amount*
  ignored. KEY DISTINCTION (pinned #B-none, #B-zero): a run going from *some* to
  *none* (or none→some) is a CHANGE (`a b`→`ab` shows under `-b`), but
  some→different-amount is ignored (`a b`→`a    b` hidden). So `-b` ignores
  whitespace *amount* but not whitespace *presence*.
- **`--ignore-space-at-eol` (`XDF_IGNORE_WHITESPACE_AT_EOL`)** — drop only the
  trailing whitespace run (before the line terminator) from the key. Leading and
  internal whitespace are significant.
- **`--ignore-cr-at-eol` (`XDF_IGNORE_CR_AT_EOL`)** — drop a single trailing CR
  (0x0d) immediately before the line terminator. `a\r\n` ≡ `a\n`. NARROW: a
  mid-line CR is significant (#CR-narrow). Note (#CR1): `-w`, `-b`, and
  `--ignore-space-at-eol` ALSO ignore a trailing CR (CR is whitespace-at-eol for
  them); `--ignore-cr-at-eol` is the only mode that ignores the trailing CR
  *without* also ignoring trailing space/tab. The normalizer must therefore
  classify a trailing-CR-before-terminator as droppable under all four of those
  modes, and droppable under nothing else.
- **`--ignore-blank-lines` (`XDF_IGNORE_BLANK_LINES`)** — MECHANICALLY DISTINCT:
  not a line-key transform, and NOT a member of `LineKey`. git suppresses change
  groups whose added/deleted lines are entirely blank, at hunk emission. "Blank" =
  empty after the *other* active normalization: a spaces-only line is NOT blank
  under `--ignore-blank-lines` alone (#BL-spaces: still counted), but IS blank under
  `--ignore-blank-lines -w` (#BL-combo: dropped). It hooks at hunk-emission /
  stat aggregation (§3.3a), NEVER in `linesEqualUnder`, and NEVER as a file-drop on
  its own (§3.2).

### 3.3a Blank-line suppression: the emission/numstat hook (no bespoke flag)

`ignoreBlankLines` is the second hook point. After `diffLines` produces hunks (under
whatever `LineKey` is active), a change group consisting **solely of blank lines**
(empty after the active line-key normalization) is suppressed from the patch body
and from the `added`/`deleted` counts. The file itself stays in the change-set —
git's output is deliberately inconsistent across modes here, and tsgit reproduces
that inconsistency from the **structured fields it already ships**, not from a
"suppressed" marker.

git's per-mode output for a blank-only `--ignore-blank-lines` change, and how a
caller reconstructs each from the structured `TreeDiff` / `StatTreeDiff`:

| git output mode | git shows | reconstructed from |
|---|---|---|
| `--name-status` / `--raw` | file PRESENT (`M f.txt`, real dst OID for tree-to-tree) | the `modify` is in `TreeDiff.changes` (membership) |
| `--quiet` | exit nonzero (change present) | `TreeDiff.changes` non-empty |
| patch | empty body (no hunks, not even a `diff --git` header) | the change carries zero emitted hunks |
| `--numstat` | row OMITTED | derived omit rule (below) |

**The numstat-omit rule is DERIVABLE — no bespoke flag.** `StatDiffChange` already
carries `added`, `deleted`, `binary` (from `StatFields`) and `oldMode`, `newMode`
(from `DiffChange`). The caller omits a numstat row iff
`added === 0 && deleted === 0 && !binary && oldMode === newMode`. This omits the
fully-suppressed blank-only file (zero counts, mode unchanged) yet PRINTS
`0\t0\tf.txt` for a chmod-only / mode-change file (`oldMode !== newMode`) and
`-\t-\tf.txt` for a binary file (`binary === true`) — exactly git's own omit logic.
The library ships the underlying fields; the consumer applies the rule. We therefore
do **not** add a `suppressed` boolean: it would be a redundant denormalization of
data already present, and ADR-249 prefers shipping the fields over a derived marker.

So the suppressor's job is purely to make `added`/`deleted` and the emitted hunks
faithful (drop blank-only change groups before counting/emitting); membership and
mode fields are untouched, and the four output modes fall out of the shipped data.
Blank-line suppression composes with the line-key normalization (the blank
definition reads the active `LineKey`), and runs in `computeStatFields` (counts) and
`buildEdits` (patch) on the one `diffLines` result per file.

### 3.4 Pinned faithfulness matrix

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off,
isolated `HOME`, throwaway `mktemp -d` repo. `git diff --no-ext-diff <mode>
--numstat` / `--name-status` / `--quiet` / patch. The blank-line rows below are the
CORRECTED pins (the earlier #BL1 "file dropped" reading was wrong — see §3.2).

| # | Scenario (old → new) | mode | `git` result | Load-bearing fact |
|---|---|---|---|---|
| W1 | `\tbeta gamma` → `  beta  gamma   ` (indent kind + internal run + trailing) | `-w` | no diff (file dropped) | `-w` erases all-space differences |
| W2 | same | `-b` | no diff | `-b` collapses runs + trailing |
| W3 | same | `--ignore-space-at-eol` | **diff** (1/1) | only EOL ws ignored; internal still differs |
| B-amt | `\tx` → `    x` (leading tab→spaces, amount/kind differ) | `-b` | no diff | `-b` ignores leading-ws *amount/kind* |
| B-amt2 | same | `--ignore-space-at-eol` | **diff** (1/1) | leading ws not an EOL concern |
| B-none | `x` → `  x` (none → leading ws) | `-b` | **diff** (1/1) | `-b`: presence change is significant |
| B-none | same | `-w` | no diff | `-w`: all space dropped, presence irrelevant |
| B-run | `xx a b yy` → `xx a    b yy` (internal run grows) | `-b` | no diff | run-collapse |
| B-zero | `a b` → `ab` (internal space removed) | `-b` | **diff** (1/1) | run→zero ≠ collapse; presence change |
| B-zero | same | `-w` | no diff | `-w` ignores even removal |
| B-tab | `a\tb` → `a b` (tab→space) | `-b` | no diff | tab and space both ws, collapse to one |
| CR1 | `a\r\nb\n` → `a\nb\n` (CRLF→LF) | `--ignore-cr-at-eol` | no diff | trailing CR ignored (narrow mode) |
| CR1 | same | `--ignore-space-at-eol` | no diff | CR counts as whitespace-at-eol for `-b`/`--ignore-space-at-eol` too |
| CR1 | same | `-b` | no diff | `-b` also treats trailing CR as ignorable EOL whitespace |
| CR1 | same | `-w` | no diff | `-w` drops the CR (it is whitespace) |
| CR-narrow | `a\rb\n` → `ab\n` (CR mid-line, not at eol) | `--ignore-cr-at-eol` | **diff** | `--ignore-cr-at-eol` is EOL-only; a non-EOL CR is significant |
| EOL1 | `a\nb\n` → `a   \nb\n` (trailing ws added) | `--ignore-space-at-eol` | no diff | trailing-ws-only dropped |
| EOL1 | same | (plain) | **diff** | baseline: trailing ws is a change |
| C1 | `a b` → `ab` (`-w` ignores, `-b` shows) | `-w -b` AND `-b -w` | no diff (both orders) | modes combine; `-w` dominates `-b`; order-independent |
| C2 | `a b\r\n` → `a    b\n` (run grows + CRLF→LF) | `-b` | no diff | `-b` collapses run AND treats CR as ws-at-eol |
| M1 | `  ws`→`    ws` (ws-only) AND `real`→`REAL` (real) in one file | `-w` | patch: `ws` shows as **context with NEW whitespace** (` ` `    ws`), `real`/`REAL` as -/+; numstat `1 1` | normalized line emitted with original (new) bytes; only real line counts |
| D1 | file f ws-only, file g real change | `-w` | name-status: only `M g.txt`; numstat: only `g.txt`; raw: only `g.txt` | ws-only file VANISHES from the change-set entirely (line-key drop) |
| D2 | `a\n  b` → `a\n      b`, **no trailing newline** both sides | `-w` | no diff | drop holds without terminating LF |
| BL1 | insert a blank line (blank-only change) | `--ignore-blank-lines` | name-status: `M f.txt` (PRESENT); raw: `M f.txt` present; numstat: **NO row**; patch: **empty body** (0 bytes, no `diff --git` header); `--quiet`: **exit 1** | file STAYS in change-set; hunks + numstat suppressed; git is mode-INCONSISTENT (present in name-status/raw/quiet, absent from numstat/patch) — CORRECTED (was wrongly "file dropped") |
| BL-two | file g blank-only change, file h real change | `--ignore-blank-lines` | name-status: BOTH `M g.txt; M h.txt`; numstat: **only** `h.txt` | suppression is per-file at numstat, but both files stay in the change-set |
| BL2 | insert blank line + `c`→`C` in one file | `--ignore-blank-lines` | patch keeps the real change, numstat `2 1` | blank suppression is per-change-group; the real change survives |
| BL-spaces | insert a `   ` (spaces-only) line | `--ignore-blank-lines` | **diff** (1/0) | spaces-only is NOT blank under blank-lines ALONE (no line-key mode to strip the spaces) — still counted |
| BL-combo | same spaces-only insert | `--ignore-blank-lines -w` | no diff (file dropped) | `-w` (line-key) makes the line blank ⇒ the line-key `diffLines` yields no hunk ⇒ the §3.2 line-key drop fires |

### 3.5 Combinability / dominance (PINNED #C1, #C2)

The five modes are **independently combinable** (git accepts any subset). `-w`
dominates `-b` and `--ignore-space-at-eol` where they overlap, and the result is
order-independent (#C1: `-w -b` ≡ `-b -w` ≡ no diff on `a b`→`ab`). The flat surface
(D1, resolved) models exactly the legal combinations: the `ignoreWhitespace?:
'all' | 'change' | 'at-eol'` enum makes the trio mutually exclusive and encodes
`-w`'s dominance **at the type level** — a caller cannot ask for "`all` and `change`
as distinct effects" because the enum admits only one value, so dominance is
structural, not a runtime precedence rule. `ignoreCrAtEol` and `ignoreBlankLines`
are orthogonal booleans that combine freely with the enum and each other (#C2,
#BL-combo). A legal-but-redundant combination git also accepts (e.g.
`ignoreWhitespace: 'all'` + `ignoreCrAtEol: true`, since `-w` already ignores a
trailing CR) is permitted and collapses to the same outcome — faithful to git
accepting `-w --ignore-cr-at-eol`.

## 4. CRITICAL faithfulness — similarity scoring is whitespace-AGNOSTIC (PINNED)

The brief flagged a contradiction: the reconnaissance suggested whitespace modes
might reach the similarity pipeline; the strong prior (xdiff `XDF_*` flags do not
reach `diffcore_count_changes`) said the opposite. Resolved **empirically**:

Pinned (`mktemp` repo, a rename whose dst differs from src ONLY by leading
whitespace, 70% spanhash-similar):

```
git diff -M --name-status         → R070 src.txt dst.txt   similarity index 70%
git diff -M -w --name-status      → R070 src.txt dst.txt   similarity index 70%   (IDENTICAL)
```

`-w` does **not** change the reported similarity, the pairing, or the percent.
git's diffcore-rename similarity is whitespace-agnostic — the xdiff flags operate
in the textual diff (`diffcore-pickaxe`/patch), not in `estimate_similarity`'s
spanhash counter. **Therefore the 24.13 similarity pipeline
(`estimateSimilarity`, `detectSimilarityRenames`, `buildChunkMap`) is NOT touched
by this feature.** Applying normalization to spanhash fingerprinting would
DIVERGE. The interop test pins the `-M -w` ≡ `-M` equality as a regression guard.

Consequence for ordering: rename/copy detection runs FIRST on the raw change-set
(scoring on raw bytes regardless of the mode), and the §3.2 file-drop runs AFTER,
removing only the leftover whitespace-only *modify* entries. A whitespace-only
*rename* (a `git mv` plus a whitespace edit) is paired and scored exactly as without
`-w` before the drop, and the drop targets only `modify`, so the rename survives.

## 5. Consumer audit

| Consumer | File:line | Today | Impact |
|---|---|---|---|
| line diff core | `line-diff.ts:255` `diffLines`; `:105` `advanceSnake` `bytesEqual` | exact byte compare | gains optional `LineDiffOptions` (`lineKey?`); equality routed through `linesEqualUnder(a,b,key)`; default = `bytesEqual` |
| new normalizer | (new) `src/domain/diff/whitespace.ts` | — | pure `LineKey` (`WhitespaceMode` + `ignoreCrAtEol`) + `linesEqualUnder` / `normalizeLine`; resolves the flat fields into the `LineKey` descriptor; exports the public-facing types |
| blank-line suppressor | `stat-fields.ts` + `patch-serializer.ts` (§3.3a) | — | new emission/count filter: drops blank-only change groups (blank = empty after the active `LineKey`) before counting/emitting; gated on `ignoreBlankLines`; NEVER a file-drop |
| patch hunks | `patch-serializer.ts:194` `buildEdits` | `diffLines(old,new)` | thread `lineKey`: `diffLines(old,new,{lineKey})`; emitted lines stay original bytes (#M1); apply blank-line suppression (§3.3a) |
| numstat | `stat-fields.ts:34` `computeStatFields` | `diffLines(old,next)` | thread `lineKey` + blank-line suppression; counts follow (#W2, #BL2, Requirement 5) |
| primitive | `primitives/diff-trees.ts` | classify → rename → stat | new line-key-gated drop pass (§3.2) AFTER rename detection, before stat; `LineKey` + `ignoreBlankLines` threaded to `attachStats` and to the patch path |
| public option | `commands/diff.ts:8` `DiffOptions` | `from/to/detectRenames/renameOptions/recursive/withStat` | add the three FLAT fields `ignoreWhitespace?`, `ignoreCrAtEol?`, `ignoreBlankLines?` (D1) |
| primitive option | `primitives/types.ts:187` `DiffTreesOptions` | same minus from/to | add the same three FLAT fields (D1) |
| facade config | `ports/context.ts:64` `RepositoryConfig` | `detectRenames?` declared-but-UNCONSUMED | add the three FLAT whitespace fields (D5); `diff` now CONSUMES them AND the pre-existing `detectRenames` via per-call `??` config `??` default precedence (§5.1) |
| diff command wiring | `commands/diff.ts:34` `diff()` | reads only `opts.detectRenames`, etc.; never `ctx.config` | resolve `ignoreWhitespace`/`ignoreCrAtEol`/`ignoreBlankLines`/`detectRenames` as `opts.X ?? ctx.config?.X ?? default` before building `DiffTreesOptions` (§5.1) |
| public re-export | `src/index.ts` / `public-types.ts:32` (`export type * from domain/diff`) | exports diff types | the whitespace enum / `LineKey` re-export automatically; `reports/api.json` regenerates |
| **merge** | `merge/three-way-content.ts:85` | `diffLines(base,ours/theirs)` | **NO CHANGE** — passes no `lineKey`; merge stays exact-byte (faithful) |
| **blame** | `blame.ts:158` | `diffLines(headBlob,workingBlob)` | **NO CHANGE** — `git blame -w` is out of scope |
| range-diff | `range-diff/interleave.ts:64` | `diffLines(...)` | **NO CHANGE** — no whitespace knob |

The merge/blame/range-diff "NO CHANGE" rows are the safety contract: the optional
`lineKey` parameter defaults to exact compare, so these three are provably
byte-unchanged.

### 5.1 Config consumption precedence and the `detectRenames` behavior-change audit

ADR-382 ratified D5: `RepositoryConfig` gains the flat whitespace keys as
**programmatic** facade defaults (like `parallelism` / `maxResponseBytes`), and the
`diff` command resolves every field as **per-call option `??` config default `??`
today's default**. The SAME wiring retires the dead `RepositoryConfig.detectRenames`
(consumed via the identical precedence). `renameOptions` is NOT added to config.

Faithfulness framing the doc must keep front-and-centre: `RepositoryConfig` is
tsgit's **programmatic facade-tier config** (caller-supplied via `openRepository`),
**not** git's on-disk `.git/config`. These keys are never read from `.git/config`.
Verified against real git 2.54.0: git has **no** on-disk config that defaults the
`-w`/`-b` diff-ignore family (`diff.ignoreAllSpace`/`diff.ignoreWhitespace` do not
exist; `core.whitespace` governs whitespace-*error* detection for `apply` /
`diff --check`, NOT diff output). So these are tsgit ergonomic defaults with no git
on-disk counterpart — not a faithfulness divergence (no invented on-disk key, no
observable git artifact changes), and explicitly **NOT** `core.whitespace`.

**Behavior-change audit for `detectRenames` (pre-chewed for the planner).** Because
the field goes dead → consumed, every call site that sets `config.detectRenames`
WITHOUT a per-call `opts.detectRenames` would START getting rename detection. The
audit was run empirically (Serena `find_referencing_symbols` on
`RepositoryConfig/detectRenames` → `{}` no reads; ripgrep multiline scan
`config[^;]*detectRenames` across all `*.ts` → zero hits; scan for any
`RepositoryConfig` / `config` literal carrying `detectRenames` → zero hits):

- **Zero existing call sites set `config.detectRenames`** — in `src/` or in `test/`.
  The field is BOTH unread AND unwritten today (consistent with ADR-373's
  declared-but-unconsumed finding). Wiring it is therefore behaviorally **inert** for
  every current consumer: nothing silently flips to rename detection.
- The three internal callers that DO want renames pass `detectRenames: true` as a
  **per-call option**, which sits at the top of the precedence chain and is
  unaffected: `commands/internal/commit-diff.ts:23` (`diffCommitAgainstParent`, used
  by `show` / `log --raw`), `range-diff.ts:72` (`hydrate`), and `blame.ts` (the
  commit-diff path). All pass it to `diffTrees` options, never to `config`.
- All other `detectRenames` occurrences in tests
  (`test/unit/application/commands/diff.test.ts`,
  `test/unit/application/primitives/diff-trees.test.ts`,
  `test/integration/rename-similarity-interop.test.ts`,
  `test/integration/diff-patch.test.ts`) pass it as a **per-call `diff`/`diffTrees`
  option**, not via `config` — also unaffected.

**Planner slice for the audit is a GUARD, not a remediation.** Since no call site
breaks, the audit slice ships (a) a test proving `config.detectRenames: true` with no
per-call option NOW yields rename detection, (b) a test proving a per-call
`detectRenames: false` OVERRIDES `config.detectRenames: true` (precedence), and the
symmetric whitespace precedence tests. If a future call site sets
`config.detectRenames`, this guard documents the intended (not accidental) effect.

## 6. Decision candidates

ADRs 226 / 249 and backlog 24.12 / 24.13 fix faithfulness, the structured-data
rule, the recursive composition, and the similarity-pipeline boundary. The five
load-bearing choices this feature introduces are now **RESOLVED** — each was
ratified by an ADR (378–382), in several cases AGAINST the designer's original
recommendation. The table records the resolved decision and its ADR; the original
alternatives are kept for the record.

| # | Choice | Resolution (ADR) | Why |
|---|---|---|---|
| D1 | Whitespace surface shape on `DiffOptions`/`DiffTreesOptions`/`RepositoryConfig` | **RESOLVED — flat enum + inline toggles (ADR-378).** Three FLAT root fields: `ignoreWhitespace?: 'all' \| 'change' \| 'at-eol'` (the mutually-exclusive trio as one enum; absent ⇒ exact byte compare), `ignoreCrAtEol?: boolean`, `ignoreBlankLines?: boolean`. No `whitespace?: {...}` sub-object. (Original recommendation was (a) the sub-object; chosen was the flat enum — variant (c) in the original list.) | The enum makes the illegal `{all + change}` state unrepresentable and encodes `-w`'s dominance over `-b`/`--ignore-space-at-eol` at the type level (only one trio value selectable) — dominance is structural, not a runtime rule. Flat matches the existing options style (`detectRenames`/`recursive`/`withStat`). `ignoreCrAtEol`/`ignoreBlankLines` are orthogonal so they stay booleans. The resolved internal `LineKey` descriptor (§3.1) re-exports via `export type *`. |
| D2 | `--ignore-blank-lines` in scope for 24.14? | **RESOLVED — IN scope now, as a hunk/numstat SUPPRESSOR (ADR-379).** All five modes ship. `--ignore-blank-lines` is a hunk-emission + numstat suppressor (§3.3a), NOT a line-key transform and NOT a file-drop: the `modify` STAYS in `TreeDiff.changes`; only its hunks + counts are suppressed. "Blank" = empty after the active line-key normalization. (Original recommendation was (b) defer; chosen was (a) in scope now.) | Ships git's whitespace family complete. The naive line-comparator hook (original (c)) is provably wrong — #BL2 shows blank suppression is per-change-group at emission, not per-line equality. The blank definition reads the active `LineKey`, so the two hook points compose. |
| D3 | File-drop predicate for a line-key-empty change | **RESOLVED — drop via mode-normalized `diffLines` (ADR-380).** Drop a `modify` iff its line-key-normalized `diffLines` (after blank-line suppression) yields zero `ours-only`/`theirs-only` hunks; binary and type-changes never drop; `--ignore-blank-lines` ALONE never triggers the drop (it only empties the hunks/stat of a file that stays present). Reuse the one `diffLines` for drop + stat + patch. | #D1 proves git removes the file entirely, not as an empty modify (original (c) diverges). Reusing the same `diffLines` the patch/stat path runs makes the drop, the patch, and the counts mutually consistent (one line diff per file). The cheap bytes-equal pre-check (original (b)) is admissible later only as a behavior-preserving optimization. |
| D4 | Where the mode threads through the primitive | **RESOLVED — carry on `DiffTreesOptions` (ADR-381).** `diffTrees` resolves the flat fields into the `LineKey` + blank flag and threads them into the drop pass and the stat/patch path; `diffLines` gains an optional trailing options arg defaulting to exact compare; `merge`/`blame`/`range-diff` pass no mode (byte-unchanged). | Leaf-only (original (b)) cannot express the file-drop (which lives in the primitive); computing the drop in the domain classifier (original (c)) violates the dependency rule (the drop needs blob I/O the pure classifier must never do). One channel feeds drop + stat + patch consistently; the three exact-byte callers are provably unchanged. |
| D5 | `RepositoryConfig` config-driven default | **RESOLVED — config key AND wire BOTH (ADR-382).** Add the flat whitespace keys to `RepositoryConfig` as programmatic defaults; `diff` resolves each field as per-call option `??` config default `??` today's default. The SAME wiring retires the DEAD `RepositoryConfig.detectRenames`. `renameOptions` NOT added to config. `RepositoryConfig` is tsgit's PROGRAMMATIC facade config, not git's `.git/config` (§5.1). (Original recommendation was (a) option-surface only; chosen was config key + wire both.) | Leaves no dead config field (the inconsistency of wiring whitespace while `detectRenames` stays dead is the rejected option (2)). The behavior-change audit (§5.1) finds ZERO existing call sites set `config.detectRenames`, so the wiring is behaviorally inert today; the planner's audit slice is a precedence guard. |

## 7. Test strategy

**Unit — `src/domain/diff/whitespace.test.ts`** (new, pure normalizer): per-mode
`linesEqualUnder(a,b,key)` / `normalizeLine(line,key)` truth tables drawn straight
from §3.4 — `-w` (#W1, #B-none-w, #CR1-w), `-b` amount-vs-presence (#B-amt, #B-none,
#B-run, #B-zero, #B-tab), `--ignore-space-at-eol` (#EOL1, #B-amt2),
`--ignore-cr-at-eol` (#CR1 trailing-CR ignored by all four EOL-touching modes,
#CR-narrow mid-line CR significant only under `--ignore-cr-at-eol`). Also test the
flat-fields → `LineKey` resolution (`ignoreWhitespace: 'all'` → `mode: 'all'`;
`ignoreCrAtEol: true` → `ignoreCrAtEol` set; `ignoreBlankLines` does NOT enter
`LineKey`). Isolated guard tests per boundary (presence-change vs amount-change for
`-b`; mid-line CR vs trailing CR) — these are the StringLiteral/Conditional mutation
hot spots; assert the exact equality verdict, never a generic truthy.

**Unit — `src/domain/diff/whitespace.properties.test.ts`** (new, `fast-check`).
The normalizer is a strong property-test candidate (lens 2 compositional matcher +
lens 4 idempotence) and there is no `line-diff.properties` sibling today:
- **idempotence**: `normalizeLine(normalizeLine(x, m), m) ≡ normalizeLine(x, m)`
  for every mode (`numRuns` 200, cheap).
- **dominance**: `linesEqualUnder(a,b,'all')` is true whenever
  `linesEqualUnder(a,b,'change')` is (the matrix #C1 dominance as an invariant).
- **reflexivity**: `linesEqualUnder(x,x,m)` always true.
- **whitespace-only equivalence under `-w`**: for arbitrary `x` and an arbitrary
  space/tab re-sprinkling `x'`, `linesEqualUnder(x,x','all')` holds.
Examples (§3.4) stay (literal git semantics); the property proves the grammar.

**Unit — `line-diff.test.ts`**: `diffLines(old,new,{lineKey})` reshapes hunks
(#M1: ws-only line becomes common, real line stays changed); default arg (no
options) is byte-identical to today (regression guard for merge/blame/range-diff).

**Unit — `stat-fields.test.ts`**: `computeStatFields` with a `LineKey` returns the
mode's counts (#W2 `0`/dropped, #B-* counts); with `ignoreBlankLines` the blank-only
change group is suppressed from `added`/`deleted` (#BL1 → `0 0`, #BL2 → `2 1`,
#BL-spaces → `1 0` since spaces-only is not blank alone); binary short-circuit
unaffected. Isolated guard tests: blank suppression fires only on blank-only groups,
and the blank definition reads the active `LineKey` (#BL-combo).

**Unit — blank-line suppressor / numstat-omit derivation**: assert the structured
`StatDiffChange` for a blank-only `--ignore-blank-lines` change carries `added: 0`,
`deleted: 0`, `binary: false`, `oldMode === newMode`, and the `modify` REMAINS in
`changes` (membership) — proving §3.3a's claim that the four git output modes are
reconstructable WITHOUT a `suppressed` flag. Contrast a chmod-only change
(`oldMode !== newMode`, counts `0 0`) which the omit rule KEEPS as `0\t0\tf.txt`.

**Unit — `diff-trees.test.ts`**: the drop pass removes a ws-only `modify` under a
line-key mode (`-w`, #D1) and keeps it with no mode; a mixed two-file diff drops
only the ws-only file (#D1); `--ignore-blank-lines` ALONE does NOT drop a blank-only
`modify` — it stays in `changes` with suppressed hunks/stat (#BL1, #BL-two);
`--ignore-blank-lines -w` DOES drop the spaces-only insert (#BL-combo, via the
line-key drop); binary/type-change never dropped (D3); the mode composes with
`recursive` and `detectRenames` (a whitespace-only rename still pairs — §4); the
drop runs AFTER rename detection and never removes a paired `rename`. Isolated
per-branch guard tests (mutation-resistant), one per gate (line-key active vs
`ignoreBlankLines`-only vs binary vs type-change).

**Unit — `diff.test.ts`**: the three flat fields (`ignoreWhitespace`,
`ignoreCrAtEol`, `ignoreBlankLines`) thread from `DiffOptions` to the primitive;
`withStat: true` + a mode reflects mode counts; default options unchanged. **Config
precedence (§5.1):** with `ctx.config` carrying `detectRenames: true` and no per-call
option, `diff` now performs rename detection (proves the dead field is consumed); a
per-call `detectRenames: false` OVERRIDES `config.detectRenames: true`; the
symmetric whitespace precedence — `config.ignoreWhitespace: 'all'` applies as the
standing default, a per-call `ignoreWhitespace` overrides it, and absent both falls
back to exact compare. Isolated guard tests per field and per precedence rung
(per-call present, config present, both absent).

**Interop — `test/integration/diff-whitespace-interop.test.ts`** (new, twin
real-`git` vs tsgit + frozen golden, mirroring `diff-recursive-interop`): build the
§3.4 fixtures in real `git` and tsgit; for each mode and each combination, assert
tsgit's structured result reconstructs ALL of live git's per-mode output:

- `--name-status`-equivalent change-set from `TreeDiff.changes` membership
  (including the #D1 line-key file-drop AND the #BL1/#BL-two blank-only files that
  STAY present);
- `--numstat`-equivalent rows by applying the §3.3a omit rule
  (`added===0 && deleted===0 && !binary && oldMode===newMode` ⇒ row omitted) — pin
  that a blank-only `--ignore-blank-lines` file is name-status-present yet
  numstat-omitted (git's mode inconsistency), and that #BL-two yields name-status
  `g,h` but numstat `h` only;
- `--quiet`-equivalent exit (`changes` non-empty ⇒ nonzero) for the blank-only case;
- reconstructed `git diff <mode>` patch bytes (empty body for the blank-only file)
  equal live `git` + the frozen golden.

Pin the §4 similarity invariant (`-M -w` ≡ `-M`). Combination cases #C1 (`-w -b`
order-independence) and #BL-combo. Compare conflict-/marker-sensitive bytes with the
peer pinned `-c merge.conflictStyle=merge` is N/A here, but DO scrub `GIT_*`, isolate
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off (faithfulness procedure). Skips when
`git` is absent; uses one shared `beforeAll` repo + 60s timeout (per the interop
load→validate flake note).

## 8. Out of scope

- **`git blame -w`** — blame's `diffLines` call stays exact-byte; whitespace-aware
  blame is a separate blame-surface feature, not a diff-options change.
- **Whitespace-aware merge** (`merge -Xignore-all-space` family) — merge stays
  exact-byte; the merge strategy-option surface is its own backlog item.
- **Reading whitespace/rename defaults from `.git/config`** — the `RepositoryConfig`
  keys (D5/ADR-382) are PROGRAMMATIC facade defaults consumed by `diff` in this
  change; the `.git/config` → facade mapping (and the fact git has no on-disk
  diff-ignore config to map, §5.1) remains a separate future concern. Explicitly NOT
  `core.whitespace` (a whitespace-error knob, not a diff-output knob).
- **`renameOptions` on `RepositoryConfig`** — only `detectRenames` (boolean) is
  wired from config (ADR-382); rename-detection fine-tuning stays per-call.
- **Whitespace *error/warning* detection** (`--check`, `diff.wsErrorHighlight`,
  trailing-whitespace flagging) — that is a rendering/lint concern (ADR-249), a
  different feature from ignore-on-compare.
- **`--rename-empty` and whitespace-insensitive similarity** — pinned §4 as a
  non-divergence (git's similarity is already whitespace-agnostic); nothing to do.
