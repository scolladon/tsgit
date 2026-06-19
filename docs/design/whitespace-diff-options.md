# Design — whitespace diff options

> Brief: surface git's whitespace diff family (`-w` / `-b` / `--ignore-space-at-eol`
> / `--ignore-cr-at-eol` / `--ignore-blank-lines`) as STRUCTURED modes on the diff
> options. Today there is no `--ignore-all-space` family; the spike emulated it by
> strip-and-compare over modified blob pairs (O(blob bytes) per file). Replace that
> with normalization paid once per line inside the existing Myers pass, byte-faithful
> to real `git` — pinned, not recalled.
> Status: draft → self-reviewed ×3

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
**which files appear in the diff at all**, and **the numstat counts** (§3.2 pins a
whitespace-only file vanishing entirely from `--name-status`/`--numstat`/`--raw`
under `-w`). That is the structured DATA and the on-disk-equivalent change set, not
the display string. They legitimately belong on the options surface; the doc states
this so a reviewer does not mistake them for forbidden rendering knobs.

### 1.2 Constraining decisions (FIXED — not re-litigated here)

| Source | Decision this design must implement |
|---|---|
| ADR-226 / CLAUDE.md | Replicate git's observable change-set + counts byte-for-byte; pin against real `git`, never from memory. |
| ADR-249 | Whitespace modes are structured fields; the library emits no `-w`/`-b` text — the data outcome (dropped change, recounted numstat, reshaped hunks) IS the faithfulness target, reconstructed in the interop test. |
| 24.12 (`diff-recursive-tree-diff`) | Recursive flattening already lands per-file full-path changes into the patch path; whitespace normalization composes on top, per file, unchanged. |
| 24.13 (`similarity-rename-detection`) | The diffcore-rename similarity scorer (`estimateSimilarity`, spanhash) is its own pipeline. §4 pins that git's whitespace flags do NOT reach it. |

## 2. Requirements

1. `DiffOptions`/`DiffTreesOptions` carry a structured whitespace mode covering
   `-w`, `-b`, `--ignore-space-at-eol`, `--ignore-cr-at-eol`, and (scope per D2)
   `--ignore-blank-lines`. Default = today's exact byte comparison.
2. The mode normalizes the **line-equality key** inside the Myers pass once per
   line — not a separate full-blob strip — so cost stays O(blob bytes) within the
   existing pass, never a doubled pass (corrects the spike's strip-and-compare).
3. Emitted line content is the **original** bytes (the new side's whitespace shows
   verbatim in context/changed lines) — matching git (§3.2 #M1).
4. A file whose only change is normalized away **disappears** from the structured
   `TreeDiff.changes` under the active mode — matching git's name-status drop
   (§3.2 #D1). numstat for such a file is absent, not `0 0`.
5. `withStat` counts (`computeStatFields`) reflect the active mode automatically,
   because they flow through the same `diffLines` — `git diff -w --numstat` parity.
6. Rename/copy/break **similarity scoring is UNAFFECTED** by whitespace modes
   (pinned §4) — the diffcore pipeline is not touched.
7. `merge`, `blame`, `range-diff` are byte-unchanged: their `diffLines` calls pass
   no mode (default).
8. Each mode's exact normalization semantics (what is "whitespace", leading vs
   trailing vs internal, CR, blank) are byte-faithful to the pinned matrix (§3).
9. Mode combinability matches git: the modes are independently combinable; `-w`
   dominates `-b` where they overlap (pinned §3.2 #C1).
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

A `WhitespaceMode` (shape per D1) selects a pure normalizer
`normalizeLine(line: Uint8Array, mode): Uint8Array` (or, for hot-path efficiency,
a `linesEqualUnder(a, b, mode): boolean` comparator that avoids allocating a
normalized copy per compare). `diffLines` gains an **optional** trailing options
arg:

```ts
export interface LineDiffOptions {
  readonly whitespace?: WhitespaceMode;   // absent ⇒ exact bytesEqual (today)
}
export function diffLines(ours, theirs, options?: LineDiffOptions): LineDiff;
```

Default (`options` absent / `whitespace` absent) is `bytesEqual` — every current
caller compiles and behaves identically (Requirement 7). Only `buildEdits` and
`computeStatFields` thread the mode down from `DiffTreesOptions`.

**Why a comparator, not a pre-normalized line array (perf, Requirement 2/3).**
Pre-normalizing `splitLines` output would (a) lose the original bytes needed for
display (Requirement 3) and (b) allocate a second line array. A `linesEqualUnder`
comparator normalizes lazily during the O(D·snake) comparisons the Myers pass
already performs — one normalization per *comparison*, original bytes retained for
emission. This is the "paid once per line during the existing pass" the brief asks
for, replacing the spike's separate O(blob bytes) strip.

### 3.2 The file-drop: a normalized-empty modify must be removed

`domainDiffTrees` classifies a whitespace-only edit as a `modify` (the blob OIDs
differ). git drops it entirely under `-w` (#D1). So a post-classification pass in
the `diffTrees` **primitive** must, when a whitespace mode is active, re-evaluate
each `modify` (and the modify-equivalent sides) and **drop** it if its
mode-normalized `diffLines` yields no `ours-only`/`theirs-only` hunk. This is a
primitive-tier concern (it reads blob bytes, which the pure domain classifier
never does) and reuses the bounded-pool blob hydration already used by
`attachStats` / `materialisePatchFiles`. The drop happens **before** rename
detection composes (a dropped modify is not a rename source), and is independent
of `withStat` (the drop is faithful to the change-set, not the counts).

**Cost.** When a whitespace mode is active, the tree-level diff can no longer be
OID-only: deciding the drop requires reading both blob sides and running the
normalized line diff per candidate `modify`. git pays exactly this cost (`git diff
-w` reads blobs even without `--numstat`). The drop pass therefore hydrates blobs
through the same bounded pool as `attachStats`/`materialisePatchFiles`, and the
normalized `diffLines` it runs is *reused* by the patch/stat path when those are
also requested (one line diff per file, not two). With no mode active the OID-only
fast path is unchanged — zero new cost for the default diff.

> Open sub-question folded into D3: does the drop also apply to a `modify` that is
> a *type-change* or a binary file? Binary files ignore whitespace flags in git
> (the line diff never runs). D3 governs the precise drop predicate.

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
- **`--ignore-blank-lines` (`XDF_IGNORE_BLANK_LINES`)** — MECHANICALLY DISTINCT
  (D2): not a line-key transform. git suppresses hunks whose added/deleted lines
  are entirely blank, at hunk emission. "Blank" = empty after the *other* active
  normalization: a spaces-only line is NOT blank under `--ignore-blank-lines`
  alone (#BL-spaces: still counted), but IS blank under `--ignore-blank-lines -w`
  (#BL-combo: dropped). If in scope, it hooks at hunk-emission in `diffLines` /
  the stat aggregation, NOT in `linesEqualUnder`.

### 3.4 Pinned faithfulness matrix

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off,
isolated `HOME`, throwaway `mktemp -d` repo. `git diff --no-ext-diff <mode>
--numstat` / `--name-status` / `--quiet` / patch.

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
| D1 | file f ws-only, file g real change | `-w` | name-status: only `M g.txt`; numstat: only `g.txt`; raw: only `g.txt` | ws-only file VANISHES from the change-set entirely |
| D2 | `a\n  b` → `a\n      b`, **no trailing newline** both sides | `-w` | no diff | drop holds without terminating LF |
| BL1 | insert a blank line | `--ignore-blank-lines` | no diff (file dropped) | pure-blank insertion suppressed |
| BL2 | insert blank line + `c`→`C` | `--ignore-blank-lines` | patch keeps blank as +context-ish, numstat `2 1` | blank suppression is per-change-group, real change survives |
| BL-spaces | insert a `   ` (spaces-only) line | `--ignore-blank-lines` | **diff** (1/0) | spaces-only ≠ blank under blank-lines alone |
| BL-combo | same spaces-only insert | `--ignore-blank-lines -w` | no diff | "blank" = empty after active ws normalization |

### 3.5 Combinability / dominance (PINNED #C1, #C2)

The five modes are **independently combinable** (git accepts any subset). `-w`
dominates `-b` and `--ignore-space-at-eol` where they overlap, and the result is
order-independent (#C1: `-w -b` ≡ `-b -w` ≡ no diff on `a b`→`ab`). This means the
options surface must be able to express **any combination** of {all-space OR
space-change OR space-at-eol} × {cr-at-eol} × {blank-lines} — but NOT the
nonsensical "`-w` and `-b` simultaneously as distinct effects" (they aren't
distinct; `-w` simply wins). D1 weighs how to model exactly the legal combinations.

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

Consequence for ordering: the file-drop pass (§3.2) removes a whitespace-only
*modify*, but it runs and a rename's two halves are scored on **raw** bytes
regardless of the mode. A whitespace-only *rename* (a `git mv` plus a whitespace
edit) still pairs and scores exactly as without `-w`.

## 5. Consumer audit

| Consumer | File:line | Today | Impact |
|---|---|---|---|
| line diff core | `line-diff.ts:255` `diffLines`; `:105` `advanceSnake` `bytesEqual` | exact byte compare | gains optional `LineDiffOptions`; equality routed through `linesEqualUnder(a,b,mode)`; default = `bytesEqual` |
| new normalizer | (new) `src/domain/diff/whitespace.ts` | — | pure `WhitespaceMode` + `linesEqualUnder` / `normalizeLine`; exports the mode type |
| patch hunks | `patch-serializer.ts:194` `buildEdits` | `diffLines(old,new)` | thread the mode: `diffLines(old,new,{whitespace})`; emitted lines stay original bytes (#M1) |
| numstat | `stat-fields.ts:34` `computeStatFields` | `diffLines(old,next)` | thread the mode; counts follow (#W2, Requirement 5) |
| primitive | `primitives/diff-trees.ts` | classify → rename → stat | new mode-gated drop pass (§3.2) before rename; mode threaded to `attachStats` and to the patch path |
| public option | `commands/diff.ts:8` `DiffOptions` | `from/to/detectRenames/renameOptions/recursive/withStat` | add the whitespace field (D1) |
| primitive option | `primitives/types.ts:187` `DiffTreesOptions` | same minus from/to | add the whitespace field (D1) |
| facade config | `ports/context.ts:84` `RepositoryConfig` | `detectRenames?` only | OPTIONAL config pass-through (out of scope unless D1 says otherwise) |
| public re-export | `src/index.ts` / `public-types.ts:32` (`export type * from domain/diff`) | exports diff types | `WhitespaceMode` re-exports automatically; `reports/api.json` regenerates |
| **merge** | `merge/three-way-content.ts:85` | `diffLines(base,ours/theirs)` | **NO CHANGE** — passes no mode; merge stays exact-byte (faithful) |
| **blame** | `blame.ts:158` | `diffLines(headBlob,workingBlob)` | **NO CHANGE** — `git blame -w` is out of scope |
| range-diff | `range-diff/interleave.ts:64` | `diffLines(...)` | **NO CHANGE** — no whitespace knob |

The merge/blame/range-diff "NO CHANGE" rows are the safety contract: the optional
parameter defaults to exact compare, so these three are provably byte-unchanged.

## 6. Decision candidates

ADRs 226 / 249 and backlog 24.12 / 24.13 fix faithfulness, the structured-data
rule, the recursive composition, and the similarity-pipeline boundary. The choices
below are the new load-bearing ones this feature introduces; ≤3 options each, with
a recommendation. The user ratifies in the ADR phase.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Whitespace surface shape on `DiffOptions`/`DiffTreesOptions` | (a) `whitespace?: { mode?: 'all' \| 'change' \| 'at-eol'; ignoreCrAtEol?: boolean; ignoreBlankLines?: boolean }` — one sub-object; the mutually-exclusive trio is an enum, the orthogonal toggles are booleans; (b) independent booleans mirroring git flags (`ignoreAllSpace?`, `ignoreSpaceChange?`, `ignoreSpaceAtEol?`, `ignoreCrAtEol?`, `ignoreBlankLines?`); (c) a single flat enum `ignoreWhitespace?: 'all' \| 'change' \| 'at-eol'` plus the orthogonal toggles inline on the options root | **(a)** | the matrix proves all-space/space-change/space-at-eol are mutually exclusive with `-w` dominating (#C1) — an enum models exactly the legal trio, no illegal `{all:true,change:true}` state (which (b) admits); CR-at-eol and blank-lines ARE orthogonal (combine freely, #C2/#BL-combo) so they stay booleans; the sub-object groups one concern cohesively and re-exports cleanly via `export type *`. (b) admits nonsensical combos and pushes dominance logic onto callers; (c) clutters the options root with four whitespace keys |
| D2 | `--ignore-blank-lines` in scope for 24.14? | (a) IN scope, hooked at hunk-emission (not the line comparator), with "blank" defined as empty-after-active-ws-normalization (#BL-spaces/#BL-combo); (b) DEFERRED to a follow-up — ship the four line-key modes now, blank-lines later; (c) IN scope but a naive line-comparator hook (treat blank lines as always-equal) | **(b)** | the four line-key modes (`-w`/`-b`/`--ignore-space-at-eol`/`--ignore-cr-at-eol`) are one cohesive mechanism (a line-key transform) the brief centres on; `--ignore-blank-lines` is mechanically different (hunk-emission filtering, with a subtle blank-definition that *depends on* the other active modes per #BL-combo) and carries its own pinned edge matrix — folding it in widens the blast radius and the test surface materially. Recommend D2=defer; if the user wants it now, (a) is the only faithful hook ((c) is wrong — #BL2 proves blank suppression is per-change-group, not per-line-equality). The user decides scope. |
| D3 | File-drop predicate for a normalized-empty change | (a) drop a `modify` iff its mode-normalized `diffLines` yields zero `ours-only`+`theirs-only` hunks; binary files never drop (line diff never runs, git keeps them); type-changes never drop (mode change is real); (b) drop based on a cheap normalized-bytes-equal pre-check before any line diff; (c) never drop — keep a `modify` with empty hunks and let the caller filter | **(a)** | #D1 proves git removes the file from the change-set entirely, not as an empty modify — (c) diverges from `--name-status`/`--raw`. (a) reuses the same `diffLines` the patch/stat path already runs (no second mechanism) and correctly scopes out binary/type-change (which git keeps); (b) is a viable perf shortcut but duplicates normalization logic and risks disagreeing with the line-diff result on edge cases (e.g. trailing-newline). Recommend (a), with (b) as a possible behaviour-preserving optimization evaluated in the refactor phase. |
| D4 | Where the mode threads through the primitive | (a) carry `whitespace` on `DiffTreesOptions`, thread to BOTH the drop pass and `attachStats`/patch path from `diffTrees`; (b) only thread to the patch/stat leaf functions, leave the drop pass out (accept divergence on #D1); (c) compute the drop in the domain classifier | **(a)** | (b) fails Requirement 4 / #D1 (ws-only file would wrongly survive in the structured `TreeDiff`); (c) violates the dependency rule — the drop needs blob bytes (I/O), which the pure domain classifier must never read (it only sees OIDs). (a) keeps I/O in the primitive tier, mirroring `attachStats`/`detectSimilarityRenames`, and is the only option that satisfies the pinned change-set drop. |
| D5 | `RepositoryConfig` (`core.whitespace`-style) config-driven default | (a) NO — ship only the per-call option surface; config-file plumbing is a separate concern (matches how 24.13 deferred `diff.renames` config); (b) YES — add `whitespace?` to `RepositoryConfig` and have the facade map it | **(a)** | git's whitespace defaults come from `core.whitespace` / per-command flags, a config-mapping concern orthogonal to the diff mechanism; 24.13 set the precedent of shipping the option surface without the config-file mapping. (a) keeps this change bounded; the facade can map config to the option later. |

## 7. Test strategy

**Unit — `src/domain/diff/whitespace.test.ts`** (new, pure normalizer): per-mode
`linesEqualUnder` / `normalizeLine` truth tables drawn straight from §3.4 —
`-w` (#W1, #B-none-w, #CR1-w), `-b` amount-vs-presence (#B-amt, #B-none, #B-run,
#B-zero, #B-tab), `--ignore-space-at-eol` (#EOL1, #B-amt2), `--ignore-cr-at-eol`
(#CR1 trailing-CR ignored by all four EOL-touching modes, #CR-narrow mid-line CR
significant only under `--ignore-cr-at-eol`). Isolated guard tests per boundary
(presence-change vs amount-change for `-b`; mid-line CR vs trailing CR) — these are the
StringLiteral/Conditional mutation hot spots; assert the exact equality verdict,
never a generic truthy.

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

**Unit — `line-diff.test.ts`**: `diffLines(old,new,{whitespace})` reshapes hunks
(#M1: ws-only line becomes common, real line stays changed); default arg (no
options) is byte-identical to today (regression guard for merge/blame/range-diff).

**Unit — `stat-fields.test.ts`**: `computeStatFields` with a mode returns the
mode's counts (#W2 `0`/dropped, #BL2 `2 1`); binary short-circuit unaffected.

**Unit — `diff-trees.test.ts`**: the drop pass removes a ws-only `modify` under
`-w` (#D1) and keeps it with no mode; a mixed two-file diff drops only the ws-only
file (#D1); binary/type-change never dropped (D3); the mode composes with
`recursive` and `detectRenames` (a whitespace-only rename still pairs — §4); drop
runs before rename detection. Isolated per-branch guard tests (mutation-resistant).

**Unit — `diff.test.ts`**: `DiffOptions.whitespace` threads to the primitive;
`withStat: true` + mode reflects mode counts; default options unchanged.

**Interop — `test/integration/diff-whitespace-interop.test.ts`** (new, twin
real-`git` vs tsgit + frozen golden, mirroring `diff-recursive-interop`): build the
§3.4 fixtures in real `git` and tsgit; for each mode and each combination, assert
tsgit's `--numstat`-equivalent counts, `--name-status`-equivalent change-set
(including the #D1 file-drop), and reconstructed `git diff <mode>` patch bytes
equal live `git` + the golden. Pin the §4 similarity invariant (`-M -w` ≡ `-M`).
Combination cases #C1 (`-w -b` order-independence) and #BL-combo. Skips when `git`
is absent; uses one shared `beforeAll` repo + 60s timeout (per the interop
load→validate flake note).

## 8. Out of scope

- **`--ignore-blank-lines`** if D2 lands as "defer" — its hunk-emission mechanics
  and blank-definition matrix are a follow-up; the four line-key modes ship now.
- **`git blame -w`** — blame's `diffLines` call stays exact-byte; whitespace-aware
  blame is a separate blame-surface feature, not a diff-options change.
- **Whitespace-aware merge** (`merge -Xignore-all-space` family) — merge stays
  exact-byte; the merge strategy-option surface is its own backlog item.
- **`core.whitespace` / per-command config defaults** (D5=a) — the facade may map
  config to the option later; this change ships the option surface only.
- **Whitespace *error/warning* detection** (`--check`, `diff.wsErrorHighlight`,
  trailing-whitespace flagging) — that is a rendering/lint concern (ADR-249), a
  different feature from ignore-on-compare.
- **`--rename-empty` and whitespace-insensitive similarity** — pinned §4 as a
  non-divergence (git's similarity is already whitespace-agnostic); nothing to do.
