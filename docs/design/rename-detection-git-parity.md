# Design — rename detection git parity: hydration, basename, non-regular, copies

> Brief: scope expansion of the `fix/rename-exact-one-shot-delete` PR. The user folded four
> follow-ups of [rename-exact-one-shot-delete.md](rename-exact-one-shot-delete.md) §10
> into the same PR:
> 1. the inexact pass inflates and keeps every candidate blob before the size prefilter
>    runs (memory DoS);
> 2. issue #300 part B, the basename tie-break of the inexact pass;
> 3. non-regular files in the inexact pools (supersedes ADR-898);
> 4. copy-aware exact pairing under `-C` / `-C -C` (rows #9/#10 of the first design).
>
> Status: revised against ADRs 899–906. D1–D9 are ratified (§11). The revision adds one
> new decision candidate, D10 (§12).

## 1. Context

### 1.1 How the passes compose today

```
detectSimilarityRenames (primitives/detect-similarity-renames.ts:818)
  ├─ runBreakPass (:765)        -B: scoreModifies hydrates EVERY modify's old+new bytes at once
  ├─ detectRenames(workingDiff) (domain/diff/rename-detect.ts:110)   exact, -M only, deletes only
  ├─ partitionLeftovers (:347)  gitlinks → other (ADR-405); symlinks stay in the pools
  ├─ resolveCopySources (:699)  copy sources = leftover deletes + modify/type-change preimages
  │                              (+ whole preimage under 'harder'); gitlinks excluded
  ├─ limit gate (:849)          adds × (deletes + copySources) > limit²   ← deletes counted twice
  └─ runInexactPass (:453)
       ├─ hydrateAndFingerprint (:402)  ALL src + dst bytes resident, THEN fingerprint
       ├─ buildRenameTriples / buildCopyTriples   two separate top-4 matrices per destination
       ├─ sortTriples (:260)            score desc; rename before copy at equal score
       └─ greedySelect (:313)           one pass; the triple kind decides R vs C
```

### 1.2 The four gaps

| # | Gap | Where |
|---|---|---|
| 1 | All candidate blobs are inflated and held before the size prefilter (`isSizeRejected`, `:178`) ever runs. 300 distinct 1 MB deletes + one 6-byte add: **1.03 s / 778 MB peak RSS** vs git **0.01 s / 8.4 MB** (§3.1). `scoreModifies` (`:533`) has the same shape under `-B`. | `hydrateAndFingerprint`, `hydrateIds` (`:37`), `scoreModifies` |
| 2 | No basename pre-pass and no `name_score` tie-break. Equal scores fall to path order. | `recordIfBetter` (`:125`), `sortTriples`, `greedySelect` |
| 3 | Symlinks enter the inexact pools and score like regular files. Row #11 of the first design, plus copy sources and `-B` halves. | `partitionLeftovers`, `buildCopySourcesFor*` (`:60`, `:84`) |
| 4 | The exact pass knows nothing of copies. The inexact pass models R vs C as two triple kinds, which is not git's model: git runs one matrix, a rename pass then a copy pass, and labels R vs C from per-source use counts. | `detectRenames`, `buildAllTriples` (`:427`), `greedySelect` |
| 5 | `-B` diverges beyond item 4: symlink↔regular type changes are never broken (ADR-903 folds them in); a broken delete half is kept when its add half pairs (S2); `should_break`'s small-file and empty-source guards are missing (S0, S1, D10). | `attemptBreaks` (`:599`), `computeBreakScores` (`:519`), `remergeOrKeepBroken` (`:659`) |

### 1.3 Constraining decisions (fixed, not re-litigated)

| ADR | Constraint |
|---|---|
| 226 | Byte-faithful to git's pairing; pin with cross-tool interop tests. |
| 249 | Pairing and scores are structured data; `R097`/`C100`/`M100` text is rebuilt in tests. |
| 366 | Pure, byte-free domain scorer and pairing; I/O stays in the primitive. |
| 367 / 368 | `RenameChange` / `CopyChange` shapes; `similarity.score` in `0..MAX_SCORE`. |
| 370 | The exact pass is never limited; `limit` gates the inexact matrix only; `0` = unlimited. |
| 371 | git's greedy `record_if_better` matrix, not an optimal assignment. |
| 405 | Gitlinks are never hydrated; same-oid gitlinks pair exactly. |
| 373 | One cohesive `RenameDetectOptions`; its `copyThreshold` member is superseded by ADR-906. |
| 893–897 | `-M` exact pass = `find_identical_files` (cap 100, basename, mode class); blame single-follow; interop + property pins. |
| 898 | Superseded by ADR-899. |
| 899 | Every non-regular mode leaves similarity scoring and hydration; exact pairing, basename uniqueness and limit counts keep it (D1). |
| 900 | Copy-aware exact pairing and R/C labelling live in the pure domain module `rename-pairing` (D2). |
| 901 | Fingerprint-and-drop always; size pass only above `SIZE_GATE_MIN_IDS` (D3). |
| 902 | Loose-object size from the header alone, inside `readObjectMetadata` (D4). |
| 903 | Every `-B` row follows git, symlink↔regular type changes included; `TypeChangeChange.broken?` (D5, D6). |
| 904 | Crossed size limits rise to measured + 0.25 kB in the crossing commit (D7). |
| 905 | Pins extend `rename-similarity-interop` / `rename-exact-interop`; blame rows in `blame-interop` (D8). |
| 906 | `copyThreshold` removed; `threshold` gates the rename and the copy pass (D9). |

## 2. git's algorithm, read from source

Source: git **v2.55.0** `diffcore-rename.c`, `diffcore-break.c`, `diff.c`. Behaviour pinned
against `git version 2.55.0` (§3). The blocks below paraphrase the source; they are not
verbatim.

### 2.1 Pipeline order (`diffcore_rename_extended`, `diffcore-rename.c:1380`)

```
1. register        adds → rename_dst (single_follow: only that path)
                   deletes → rename_src, rename_used = 0
                     broken delete half with score 0 (it will re-merge) → rename_used = 1
                     broken type-change delete half: score MAX_SCORE    → rename_used = 0
                   want_copies: every other valid pair's preimage → rename_src, rename_used = 1
                     (-C: modified/type-changed pairs; -C -C: unchanged pairs too)
                   rename_src order = queue order = path order, all kinds interleaved
2. exact           find_exact_renames → find_identical_files per dst (first design §2)
                     -C: used sources stay eligible at score 0 + basename
3. MAX_SCORE?      minimum_score == MAX_SCORE → stop
4. cull            want_copies || break_idx:  remove_unneeded_paths_from_src(copies)
                                               → returns early: copies keep all, break keeps all
                   else (-M):  drop used sources
                               → find_basename_matches(min_basename_score)
                               → drop used sources again
5. limit           num_dst (unpaired) × num_src (after step 4) > limit² → skip matrix
                     -C -C only: if dst × (sources that are not unchanged) fits → skip_unmodified
6. matrix          for each unpaired dst (path order), for each src:
                     score = estimate_similarity(src, dst, minimum_score)
                     name_score = basename_same(src, dst)
                     record_if_better(m[4], this)          ← uses score_compare
                     diff_free_filespec_blob(src, dst)     ← bytes dropped, cnt_data kept
7. select          STABLE_QSORT(mx, score_compare)
                   find_renames(copies = 0)   skip paired dst; skip src with rename_used
                   want_copies: find_renames(copies = 1)   any src
8. write back      delete kept iff rename_used == 0 (broken delete: iff its add half unpaired,
                     whatever its own use count; S2, N7f)
   merge_broken    both halves still queued → one pair (old side, new side), score kept;
                     rename_used++ on the source   (diffcore-break.c:239-272)
   resolve         per pair in queue order: same path → M; --rename_used > 0 → C; else R
                   (diff.c:6699)
```

`break_idx` exists only when a broken delete half was registered. It depends on whether a
modify was actually broken, not on whether `-B` was passed (rows B3b vs B3bb).

### 2.2 `estimate_similarity` (`:132`): regular files only, size first

```c
if (!S_ISREG(src->mode) || !S_ISREG(dst->mode)) return 0;
dpf_opt->check_size_only = 1;               /* object header only */
populate(src); populate(dst);
if (max_size * (MAX_SCORE - minimum_score) < delta_size * MAX_SCORE) return 0;
dpf_opt->check_size_only = 0;               /* now the bytes */
populate(src); populate(dst);
diffcore_count_changes(...)                  /* builds and KEEPS cnt_data (spanhash) */
```

The caller frees both blobs right after (`diff_free_filespec_blob`). Peak residency is two
blobs plus every fingerprint built so far. Size-rejected pairs never load a byte. A loose
object's size comes from its inflated header only.

### 2.3 `find_basename_matches` (`:903`), `-M` only

- Runs only when **copies are off and no pair was broken** (step 4). It is not subject to
  the rename limit (B3l), and it runs in blame too (BL1).
- `min_basename_score = minimum_score + (int)(0.5 × (MAX_SCORE − minimum_score))`.
  Default 50% gives 75%; `-M90%` gives 95% (B7). The `0.5` factor is read from the
  `GIT_BASENAME_FACTOR` env var, which the probes scrub.
- Sources: every source still registered after exact culling, **all modes included**.
  A basename counts as unique when exactly one source has it. Destinations: every unpaired
  add, all modes, same uniqueness rule. A symlink sharing the basename makes it non-unique
  (N9, N9d).
- For each source in order whose basename is unique on both sides:
  `score = estimate_similarity(src, dst, min_basename_score)`, and if
  `score >= min_basename_score` the pair is recorded.
  (`idx_possible_rename` is the dir-rename fallback. It needs `dir_rename_info`, which
  only merge-ort sets up, so it returns -1 for `diff`/`log`/`blame`.
  `relevant_sources`, `dirs_removed` and `dir_rename_count` are merge-ort only too.)

### 2.4 Matrix ordering: `score_compare` (`:242`) and `record_if_better` (`:1065`)

```c
score_compare(a, b): unused slots (dst < 0) sink;
                     a->score == b->score ? b->name_score - a->name_score
                                          : b->score - a->score;
record_if_better(m, o): worst = the last slot in score_compare order (lowest index on ties);
                        replace worst iff score_compare(worst, o) > 0   (o strictly better)
```

`name_score` breaks ties both inside the top-4 slots (B8: the 5th equal-score source wins
its slot because its basename matches) and in the global sort (B9). The sort is
`STABLE_QSORT`, so on a full tie the matrix layout decides: destination-major, and slot
order within a destination.

### 2.5 R vs C is a use count, not a candidate kind

- Pass 1 (`copies = 0`) skips every source with `rename_used > 0`. Under `-C` a retained
  source starts at 1, so **pass 1 can only pair deleted sources**. This is why a deleted
  source beats a better-scoring retained one (C19: `R070` from the delete beats `C090`
  from the modify). tsgit's "rename sorts before copy at equal score" rule is an
  approximation of this, and it is wrong when the scores differ.
- Pass 2 pairs the leftover destinations with any source.
- Labels are assigned in output (queue) order. For each pair, `--rename_used`: while the
  count is still above 0 the pair is a copy; the pair that takes it to 0 is the rename.
  A deleted source used k times therefore gives k−1 copies and one rename, and the rename
  is the **last in path order**, whichever pass produced it (C6 vs C7). A retained source
  only ever gives copies. A broken-delete source whose halves re-merge is one extra user
  (K1: `M100 m ; C100 m→q`).

### 2.6 `-B` (`diffcore_break` `diffcore-break.c:131`, `should_break` `:13`, `merge_broken` `:239`)

Candidates (`diffcore_break`, `:189`): both sides valid, both `object_type == OBJ_BLOB`
(regular or symlink; gitlinks and trees excluded, G3), same path. That covers modifies and
symlink↔regular type changes.

`should_break`, in source order:

```c
if (S_ISREG(src->mode) != S_ISREG(dst->mode)) { *merge = MAX_SCORE; return 1; } /* type change */
if (same oid) return 0;
populate(src); populate(dst);                          /* full bytes, no size-only step */
if (max(src->size, dst->size) < MINIMUM_BREAK_SIZE)    /* 400 */  return 0;   /* S1 */
if (!src->size) return 0;                                                      /* S0 */
count_changes(...); *merge = src_removed * MAX_SCORE / src->size;
if (*merge > break_score) return 1;
if ((src_removed + literal_added) * MAX_SCORE / max_size < break_score) return 0;
/* "removed a lot without adding" exclusion (unreachable unless *merge > break_score) */
return 1;
```

- A type change breaks **unconditionally**, before the oid, size and empty checks: a
  same-blob symlink↔regular change breaks too (N7s). No byte is read.
- Its merge score is `MAX_SCORE`. `score < merge_score` is never true (the parsed merge
  score caps at `MAX_SCORE`), so the score is never zeroed. The delete half registers with
  `rename_used = 0`, like a deleted file.
- Halves then run through rename detection like any broken pair:
  - the regular half pairs exactly or inexactly with regular files (N7d, N7e, N7j);
  - the symlink half pairs exactly with an identical symlink only (N7g, N7k), because
    `estimate_similarity` returns 0 for it (ADR-899).
- Write back (`diffcore-rename.c:1669`): a broken delete half is dropped iff its add half
  was paired (`dst->is_rename`), whatever the delete half's own use count. Otherwise it
  stays, and `merge_broken` joins the two halves back into one pair that keeps
  `score = MAX_SCORE` and adds one use to the delete half's source.
- Status (`diff.c:6679`): a joined pair whose file types differ (`DIFF_PAIR_TYPE_CHANGED`) is
  `DIFF_STATUS_TYPE_CHANGED`. With `score` set, `--name-status` / `--raw` print `T100`
  (N7b).
- Rendering is unaffected apart from that score. The patch, `--numstat` and `--stat` are
  byte-identical with and without `-B`: `complete_rewrite` and `dissimilarity index`
  apply to `DIFF_STATUS_MODIFIED` only. `--summary` adds ` rewrite a/p (100%)`, and
  `--diff-filter=B` does not select a `T100`.
- Consequences:
  - a broken type change whose add half pairs **vanishes**; the pairing replaces it
    (N7f: `R100 a/old→a/p`, no `T`, no `D`);
  - a joined type change turns every other user of its preimage into a copy (N7d, N7m);
  - it sets `break_idx`, so it switches the `-M` basename pass off like a broken modify
    does (B3t).
- A symlink→symlink modify goes through the regular path (MINIMUM_BREAK_SIZE, spanhash).
  Its halves can then only pair exactly (N6, N6b).
- git's `-B` works without `-M` (`diffcore_break` then `diffcore_merge_broken`, no rename:
  N7b `-B` alone gives `T100`). tsgit runs `-B` only inside rename detection; that is out
  of scope (§10).

## 3. Pinned matrices (real git 2.55.0 vs tsgit on this branch)

Environment: every `GIT_*` unset, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
isolated `HOME`, signing off, one `mktemp -d` repo per row.
- git column: `git diff --name-status <flags> HEAD~1 HEAD`.
- tsgit column: `diff(ctx, { from:'HEAD~1', to:'HEAD', detectRenames:true, recursive:true,
  renameOptions })` via `createNodeContext`, run from a scratch copy of this branch's `src/`
  (`HEAD 99c7125a`; the later `2c3790e3` refactor is behaviour-preserving) against the
  **same** repo. Name-status is rebuilt from the structured
  fields. The runner does not render the `broken` datum (`M100`/`T100`); where that is the
  only difference, the row says so.
- Revision probes (N7c, N7g–N7s, G3, B3t, S0–S2) use the same runner; `-B` rows use
  `breakRewrites:{score:30000, merge:36000}` (git's defaults).
- Flag mapping: `-C` → `copies:'on'`, `-C -C` → `'harder'`, `-lN` → `limit:N`,
  `-B` → `breakRewrites:{score:30000, merge:36000}`, `-M90%` → `threshold:54000`.
- Content: `body` = 20 lines `body line i`; `edit k` = `body` with the first k lines
  replaced; `gen p n` = n lines `p line i`.

Probe scripts and runner (`lib.sh`, `run.mts`, `*.sh`) are in the session scratchpad
(`p2/`). The interop rows each §8 part lands are the durable copy.

### 3.1 Hydration (item 1)

Hostile repo: 300 distinct 1 MiB random blobs deleted, one 6-byte file added.
`diff -M HEAD~1 HEAD`. Output is 301 changes, the same in every column.

| Store | git 2.55.0 | tsgit today | prototype (size-first + header-only loose size + streaming fingerprint) |
|---|---|---|---|
| loose | 0.01 s, 8.4 MB max RSS | 1061 / 1029 ms, 789 / 778 MB peak RSS | 36 / 36 / 37 ms, 133 / 122 / 122 MB |
| packed (`git gc`) | 0.00 s, 9.3 MB | 991 / 1013 ms, 787 / 790 MB | not measured |

The node + tsx process peaks at 113 MB on a one-change diff, so the prototype's extra
residency is about 9–20 MB. Intermediate prototypes:
- size-first gating on top of `readObjectMetadata`, which fully inflates loose objects:
  118 ms / 305 MB;
- header-only size from a whole-file read: 57 ms / 236 MB;
- header-only size from a 256-byte `readSlice`: 36 ms / 122 MB.

Common-case cost of the size pass. Medians of 20 warm in-process runs, prototype vs this
branch:

| Fixture | today | prototype | delta |
|---|---|---|---|
| F1: 50 files, 3 renamed+edited, loose | 1.38 / 1.42 ms | 1.97 / 1.94 ms | **+0.55 ms (+40%)** |
| F1p: same, packed | 1.10 / 1.12 ms | 1.39 / 2.07 ms | +0.3 ms or more (+27%) |
| F2p: 300 moved+edited 4 KB files, packed | 243.1 / 243.0 ms | 251.8 / 250.2 ms | +8 ms (+3%) |

On small diffs the size pass is pure overhead: every pair passes the gate, so the sizes buy
nothing. This drives D3.

### 3.2 Basename (item 2): `-M` unless noted

| # | Scenario | git 2.55.0 | tsgit today |
|---|---|---|---|
| B1 | issue #300 shape: `a/Aaa.cls-meta.xml`, `a/Foo.cls-meta.xml` (same blob) → `b/Foo.cls-meta.xml` = body+1 line | `D Aaa ; R097 a/Foo→b/Foo` | `D Foo ; R097 a/Aaa→b/Foo` ✗ |
| B1c | B1 with `-C` (no basename pass; `name_score` in the matrix) | same as B1 | ✗ as B1 |
| B1m | 3 identical meta sources → 3 same-named edited dests | `R097` ×3, same-name | ✓ (path order happens to agree) |
| B2 | `a/Aaa.xml`, `a/Foo.xml` distinct, equal score → `b/Foo.xml` | `D Aaa ; R052 Foo→Foo` | `D Foo ; R052 Aaa→Foo` ✗ |
| B3 | reviewer probe: `a/foo.c` (edit 4, 80%), `a/bar.c` (edit 1, 95%) → `b/foo.c` = body | `D bar.c ; R080 foo.c→foo.c` | `D foo.c ; R095 bar.c→foo.c` ✗ |
| B3c | B3 with `-C` | `R095 bar.c→foo.c` | ✓ |
| B3l | B3 with `-l1` | `R080 foo.c→foo.c` (basename pass is not limited) | `D ; D ; A` ✗ |
| B3b | B3 with `-B`, nothing breakable | `R080 foo.c→foo.c` (no `break_idx`) | `R095 bar.c` ✗ |
| B3bb | B3 + a rewritten 40-line `m.txt`, `-M -B` (a pair breaks) | `R095 bar.c→foo.c ; M100 m.txt` | ✓ pairing (`M` rendering only) |
| B3bn | B3bb repo with `-M` only | `R080 foo.c→foo.c ; M m.txt` | ✗ |
| B4 | `foo.c` at 60% (< 75%), `bar.c` 95% | `R095 bar.c` | ✓ |
| B5 | `a/x/foo.c`, `a/y/foo.c`: source basename not unique | `R095 a/y/foo.c` (matrix) | ✓ |
| B6 | `b/x/foo.c`, `b/y/foo.c`: dest basename not unique | `R095 bar.c→b/x/foo.c ; R067 foo.c→b/y/foo.c` | ✓ |
| B7 | `-M90%` (basename gate 95%); `foo.c` 90%, `bar.c` 95% | `R095 bar.c` | ✓ |
| B8 | `A..E.c` all 61% (below gate) → `b/E.c` | `R061 E.c→E.c` (`record_if_better` keeps E in the top 4) | `R061 A.c→E.c` ✗ |
| B8c | B8 with `-C` | `R061 E.c→E.c` | ✗ |
| B9 | `A.c`, `B.c` both 61% → `b/B.c` | `R061 B.c→B.c` | `R061 A.c→B.c` ✗ |
| B10 | B3 + `b/zed.c` (tail edit 1): the basename pass frees `bar.c` | `R080 foo.c→foo.c ; R090 bar.c→zed.c` | `R095 bar.c→foo.c ; R077 foo.c→zed.c` ✗ |
| L2 | `a/foo.c`,`a/x.c` → `b/foo.c`,`b/y.c`, `-l1`: basename pairs one, leftover 1×1 fits | `R090 foo.c ; R099 x.c→y.c` | `D D A A` ✗ |
| N9 | B3 + symlink `a/x/foo.c` (source basename not unique) | `R095 bar.c→foo.c` | ✓ (must stay ✓) |
| N9d | B3 + symlink `b/x/foo.c` (dest basename not unique) | `R095 bar.c→foo.c ; A b/x/foo.c` | ✓ (must stay ✓) |
| BL1 | `git blame --porcelain b/foo.c` in the B3 repo | lines 5–20 → `a/foo.c` | follows `a/bar.c` ✗ † |

† BL1's tsgit cell is derived: blame calls `detectSimilarityRenames`, which pairs as B3.
Part 6 pins it live.

### 3.3 Non-regular (item 3)

| # | Scenario | git 2.55.0 | tsgit today |
|---|---|---|---|
| N1 | row #11: symlink `a/link`→`target` deleted; regular `b/file` = `target` | `D a/link ; A b/file` | `R100 link→file` ✗ |
| N1c | N1 with `-C` | `D ; A` | `R100` ✗ |
| N2 | symlink → symlink, 280-byte target plus 1 char | `D ; A` | `R091` ✗ |
| N3 | regular → symlink, similar | `D ; A` | `R091` ✗ |
| N3r | regular → regular (control) | `R091` | ✓ |
| N4 | `-C`: modified symlink `a/link` (old `old-target`); regular `b/file` = `old-target` | `M a/link ; A b/file` | `C100 link→file` ✗ |
| N4s | `-C`: same, but `b/link2` is a symlink → `old-target` | `M ; C100 link→link2` (exact, same mode) | ✓ |
| N5 | `-C -C`: unchanged symlink; regular add = its target | `A ; M k` | `C100` ✗ |
| N5r | `-C -C`: unchanged regular; symlink add with its content | `A ; M k` | `C100` ✗ |
| N6 | `-M -B`: 540-byte symlink, small retarget | `M a/link` | ✓ |
| N6b | `-M -B`: 540-byte symlink fully retargeted; regular `b/file` = old target | `M100 a/link ; A b/file` | `A a/link ; R100 link→file` ✗ |
| N7 | symlink → regular type change at `a/p` | `T a/p` | ✓ |
| N7b | N7 with `-M -B` | `T100 a/p` (kept-broken datum) | `T a/p` (no datum) ✗ data |
| N7s | N7b where the symlink target and the regular content are the same blob | `T100 a/p` (breaks before the oid check) | `T` ✗ data |
| N7d | `-M -B`: regular→symlink `a/p`; add `b/q` = old regular content | `T100 a/p ; C100 a/p→b/q` | `T ; A b/q` ✗ |
| N7c | N7d with `-C -B` | `T100 a/p ; C100 a/p→b/q` | `T ; C100` ✗ data |
| N7e | N7d with `b/q` = old content + 1 line | `T100 ; C098 a/p→b/q` | `T ; A` ✗ |
| N7m | N7d with two identical adds `b/q`, `b/r` (`-M`: one use per source) | `T100 a/p ; C100 a/p→b/q ; A b/r` | `T ; A ; A` ✗ |
| N7f | `-M -B`: symlink→regular `a/p`; deleted `a/old` = new `a/p` content | `R100 a/old→a/p` (the T vanishes) | `D a/old ; T a/p` ✗ |
| N7j | N7f with `a/old` = new content + 1 line (inexact into the regular add half) | `R097 a/old→a/p` | `D ; T` ✗ |
| N7g | `-M -B`: regular→symlink `a/p` (→`T`); deleted symlink `a/s` → `T` | `R100 a/s→a/p` (symlink half pairs exactly) | `T a/p ; D a/s` ✗ |
| N7h | N7g + add `b/q` = old `a/p` content | `R100 a/s→a/p ; R100 a/p→b/q` | `T ; D ; A` ✗ |
| N7k | `-M -B`: `a/p` regular X→symlink T and `a/r` symlink T→regular X (swap) | `R100 a/r→a/p ; R100 a/p→a/r` | `T a/p ; T a/r` ✗ |
| N7n | `-M -B`: regular→symlink `a/p` (→`T`); deleted regular `a/d` = `T` (cross-mode) | `D a/d ; T100 a/p` | `D ; T` ✗ data |
| N7dn/N7fn/N7kn | N7d / N7f / N7k with `-M` only | `T ; A` / `D ; T` / `T ; T` | ✓ |
| N8 | `-C`: regular→symlink type change used as a copy source | `T ; C100 a/p→b/q` | ✓ |
| G1 | `-C`: modified gitlink `a/sub` (X→Y); added gitlink `b/sub2` = X | `M a/sub ; C100 sub→sub2` | `M ; A` ✗ |
| G2 | `-C -C`: unchanged gitlink = X; added gitlink = X | `C100 ; M k` | `A ; M k` ✗ |
| G3 | `-M -B`: gitlink → regular type change | `T a/sub` (gitlinks never break) | ✓ (must stay ✓) |

N7b, rendering side (git 2.55.0, `HEAD~1 HEAD`):

| Output | `-M -B` | `-M` |
|---|---|---|
| `--raw` | `:120000 100644 fe49470 c3c3aa5 T100\ta/p` | `… T\ta/p` |
| `-p` | byte-identical to `-M` (delete block + add block) | — |
| `--numstat` | `20\t1\ta/p` | `20\t1\ta/p` |
| `--summary` | ` rewrite a/p (100%)` + ` mode change 120000 => 100644` | ` mode change 120000 => 100644 a/p` |
| `--diff-filter=B` / `=T` | empty / `T100\ta/p` | — |
| `-B` without `-M` | `T100\ta/p` | — |

### 3.4 Copies (item 4) and use counts

| # | Scenario | git 2.55.0 | tsgit today |
|---|---|---|---|
| C1 (#9) | `-C`: 1 del `a/Foo.meta` → `b/Bar.meta`,`b/Baz.meta` identical | `C100 Foo→Bar ; R100 Foo→Baz` | `R Foo→Bar ; A Baz` ✗ |
| C2 (#10) | C1 with `-C -C` | same as C1 | `R ; C` ✗ |
| C3 | `-C`: 1 del → 3 identical adds | `C ; C ; R` (last is R) | `R ; A ; A` ✗ |
| C4 | `-C`: modified `a/Foo`; `b/Bar` = old Foo | `M ; C100` | ✓ |
| C5 / C5q / C5m | del Foo + modified Qux share an old blob → `b/Bar` / `b/Qux` (`-C`, `-C`, `-M`) | `R100 a/Foo→…` each (tie 1 vs 0+1 → first source) | ✓ |
| C6 | `-C` inexact: 1 del; `b/Bar` 95%, `b/Baz` 85% | `C095 Foo→Bar ; R085 Foo→Baz` | `R095 ; C085` ✗ |
| C7 | C6 with the scores swapped | `C085 ; R095` | ✓ |
| C8 | `-C -C`: unchanged exact source | `C100` | ✓ |
| C9 | `-C`: 2 identical dels `Foo`,`Qux` → 3 identical adds `A`,`B`,`C` | `C Foo→A ; R Qux→B ; R Foo→C` | `R ; R ; A` ✗ |
| C10 | `-C`: 1 del; `b/Baz` identical, `b/Bar` 90% | `C090 Foo→Bar ; R100 Foo→Baz` | `A Bar ; R100 Baz` ✗ |
| C11 / C12 / C13 / C15n / C17 | modified-source inexact; harder + del; …; modified source ×2 adds | as tsgit | ✓ |
| C14 | `-C`: modified `a/Bar` (first in order) and deleted `z/Aaa` share an old blob → `c/Bar` | `M ; C100 a/Bar→c/Bar ; D z/Aaa` | `M ; R100 z/Aaa→c/Bar` ✗ |
| C15 | C14 with an unchanged `a/Bar`, `-C -C` | `C100 a/Bar→c/Bar ; M k ; D z/Aaa` | `R100 z/Aaa` ✗ |
| C16 | C1 with `-C -l1` | `C ; R` (exact copy fan-out is unlimited) | `R ; A` ✗ |
| C18 | `-C -C -l1`: unchanged exact source | `C100 ; M k` (exact pass sees every source) | `A ; M` ✗ |
| C19 | `-C`: modified `a/M` 90% vs deleted `a/D` 70% → `b/N` | `M a/M ; R070 D→N` (pass 1 first) | `D ; M ; C090 M→N` ✗ |
| C20 | `-C`: `N1` = old M (exact copy), `N2`: D 80% vs M 85% | `C100 M→N1 ; R080 D→N2` | `D ; C100 ; C085 M→N2` ✗ |
| L1 | `-C -l1`: 1 del → 1 add at 90% | `R090` (1×1 fits) | `D ; A` ✗ (deletes counted twice) |
| L1m | L1 with `-M` | `R090` | ✓ |
| L3 | `-C -l1`: exact-used del stays a source; 1×2 > 1 | `M ; A ; R100` | ✓ |
| K1 | `-M -B`: `m` rewritten (40 lines); add `q` = old `m` | `M100 m ; C100 m→q` | `A m ; R100 m→q` ✗ |
| K2 | K1 with `q` = old `m` + 1 line | `M100 m ; C099 m→q` | `A m ; R099` ✗ |
| K3 | K1 but `q` = a deleted `z` | `M100 m ; R100 z→q` | ✓ pairing |

### 3.5 `-B` pass: `should_break` guards, write back, basename interplay

| # | Scenario (`-M -B`) | git 2.55.0 | tsgit today |
|---|---|---|---|
| S0 | empty regular `a/e` grows to 40 lines = deleted `a/d` (> 400 B) | `D a/d ; M a/e` (empty source never breaks) | `D a/e ; R100 a/d→a/e` ✗ |
| S1 | 3-line (< 400 B) `a/s` fully rewritten to deleted `a/d`'s content | `D a/d ; M a/s` (below MINIMUM_BREAK_SIZE) | `D a/s ; R100 a/d→a/s` ✗ |
| S2 | 20-line `a/s` fully rewritten to deleted 40-line `a/d`'s content | `R100 a/d→a/s` (broken delete dropped: its add half paired) | `D a/s ; R100 a/d→a/s` ✗ |
| B3t | B3 + a symlink→regular type change `t` | `D foo.c ; R095 bar.c→foo.c ; T100 t` (a broken type change sets `break_idx`: no basename pass) | `… ; T t` ✗ data only |
| B3tn | B3t with `-M` | `D bar.c ; R080 foo.c→foo.c ; T t` | ✗ (as B3) |

S2 holds for every broken pair whose add half is paired elsewhere (N7f, N7g, N7j): the
existing unit rows "delete-half consumed → add stays" (`detect-similarity-renames.test.ts`
`:1334`) and "add-half consumed → delete stays" (`:2425`) encode the divergent behaviour.

## 4. Design

### 4.1 Target pipeline (transcribes §2.1)

```
detectSimilarityRenames(ctx, diff, options?, preimage?)
  1 runBreakPass                      modifies: streaming scores (§4.2); symlink↔regular
                                      type changes: broken unread (§4.8)
  2 registerCandidates                ordered RenameSource[] + destinations          (primitive)
  3 pairIdenticalFiles                copy-aware exact pass                          (domain, §4.5)
  4 cull ─┬─ copies | broken>0 : keep every source
          └─ else              : drop used → basename pass (§4.3) → drop used
  5 limit gate on the leftovers       counts every mode, each source once (§4.6)
  6 hydrate                           size-first, fingerprint-and-drop (§4.2)
  7 buildMatrix                       one top-4 matrix per destination, name_score (§4.3)
  8 selectPairs                       stable sort; rename pass; copy pass            (domain, §4.5)
  9 writeBack + rejoinBroken          broken delete dropped iff its add half paired;
                                      rejoin counts one extra use (§4.5, §4.8)
 10 labelRenameCopy                   use-count countdown in output order            (domain, §4.5)
```

**New internal type** (domain, `src/domain/diff/rename-pairing.ts`):

```ts
type SourceOrigin = 'deleted' | 'broken-delete' | 'modified' | 'unchanged';
interface RenameSource {
  readonly path: FilePath; readonly id: ObjectId; readonly mode: FileMode;
  readonly origin: SourceOrigin;
  readonly seedUses: 0 | 1;   // git's initial rename_used
}
```

- `seedUses`:
  - `deleted` → 0;
  - `broken-delete` → 1 when its dissimilarity < mergeScore (git's `score = 0`), else 0.
    A broken type change carries dissimilarity `MAX_SCORE`, so it seeds 0 (§4.8);
  - `modified` (a `-C` modify/type-change preimage) and `unchanged` (a `-C -C` preimage
    entry the diff does not touch) → 1. Both are "retained" sources below.
- Source order is **path order over all origins, interleaved** (C14/C15 prove the modified
  `a/Bar` precedes the deleted `z/Aaa`). Use `sortByPath` over `path`, the same comparator
  that already orders the raw diff.
- Use counts are local, mutable working state (`Map<RenameSource, number>` or a
  parallel `number[]`), the same way `detectRenames` keeps its local groups. Inputs and
  outputs stay immutable.

### 4.2 Item 1: bounded hydration (D3, D4)

**Size-first gate.** Before any byte is read:
1. Read one size per unique **regular-file** id in the candidate pools (non-regular
   entries are never hydrated, §4.4) through a header-only size read (D4).
2. An id is *needed* when at least one partner on the other side passes the gate.
   `isSizeRejected(s, d, t)` is monotonic in `d` for fixed `s`: it accepts exactly
   `d ∈ [⌈s·t/MAX⌉, ⌊s·MAX/t⌋]`. With the partner sizes sorted, one binary search finds
   the smallest partner ≥ the lower bound, and `!isSizeRejected` on that partner decides.
   Cost is O((S+D) log D) instead of the O(S·D) matrix walk, so the gate stays cheaper
   than the matrix it protects.
3. Gate threshold: `threshold`, the single `minimum_score` both passes apply (ADR-906).
   The basename pass needs pairs at `min_basename_score`, which is ≥ `threshold`, so its
   candidates are a subset of the needed ids.

**Fingerprint then drop.** `hydrateAndFingerprint` becomes one `boundedMapFor(ctx,
'ioBound', neededIds, id => fingerprint(readBlob(id)))`. The worker returns only
`{ chunkMap, size }`, so the bytes of a blob die with its worker. Residency is bounded by
the ioBound window of blobs plus the fingerprints, the same class as git's "two blobs +
every `cnt_data`". The single shared pool stays (the current doc comment's concurrency
proof carries over).

**Hydrate in phases.** Fingerprints are a `Map<ObjectId, BlobFingerprint>` that each phase
extends:
- the basename pass fingerprints its unique-basename pairs first;
- the limit gate runs next and still decides before any matrix id is read, as today;
- the matrix phase adds only the ids it still lacks.

This matches git: the basename pass keeps `cnt_data` for the pairs it rejected, and the
matrix reuses them.

**`-B` (`scoreModifies`, `:533`).** It becomes a per-modify `boundedMapFor` that reads old
and new, computes `computeBreakScores`, and returns the scores only. git's `should_break`
reads both blobs fully (no size-only step), so there is no gate to add, only the
residency bound. Type changes never enter it: they break without a read (§4.8).

**Size pass on small pools (D3).** §3.1 measures +0.3 to +0.55 ms on a 6-id diff. That is
on the `show`/`log -M` per-commit hot path. Option (b) of D3 runs the size pass only when
the unique regular candidate ids exceed `SIZE_GATE_MIN_IDS`. Below that bound the
unconditional fingerprint-and-drop pass reads at most `SIZE_GATE_MIN_IDS` blobs, which
bounds both CPU and residency.

**Header-only size read (D4).** `readObjectMetadata` (`read-object.ts:281`) fully inflates
loose objects today (`resolveObjectMetadataWithContent` → `readRawObject`). The prototype
read a 256-byte `ctx.fs.readSlice` prefix, streamed it through
`ctx.compressor.createInflateStream()` until the header NUL, and cancelled.
`streamInflate`'s `maxOutputBytes` cannot do this: it is a safety cap and throws
`DECOMPRESS_FAILED` when exceeded (observed). A dynamic-Huffman deflate header can use
more than 256 compressed bytes before the first literal. The route must therefore fall
back to a full read when no NUL appears in the prefix output. The fixed prefix
(`LOOSE_HEADER_PROBE_BYTES`, e.g. 1 KiB) plus fallback keeps the result exact. Packed
objects keep `readPackedMetadata` (pack header, zero or one instruction-stream inflate).

### 4.3 Item 2: basename pass and `name_score` (issue #300 B)

**Basename pass** (new step 4, `-M` only). It runs when `copies === 'off'`,
`broken.length === 0` and `threshold < MAX_SCORE`. `broken` counts broken type changes
too (B3t):

```
minBasename   = threshold + trunc((MAX_SCORE − threshold) / 2)
srcByBase     = unique-basename index over ALL remaining sources (every mode)
dstByBase     = unique-basename index over ALL unpaired destinations (every mode)
for src in sources (order), with base unique in both and the dst still unpaired:
    if either side is not regular → skip      (estimate_similarity returns 0)
    if isSizeRejected(size(src), size(dst), minBasename) → skip
    score = estimateSimilarityFromMaps(...)
    if score >= minBasename → record pair (uses++), dst paired
```

- A pure domain helper, `uniqueBasenamePairs(sources, dests)`, returns the candidate
  `(srcIndex, dstIndex)` list. The primitive scores the pairs, so no bytes enter the
  domain (ADR-366). `hasSameBasename` (`rename-detect.ts:68`) moves to the new domain
  module and is shared.
- It is **not limited** (B3l). The limit gate runs after it, over the leftovers (L2).
- blame's single-follow diff goes through the same pass (BL1): one destination, uniqueness
  over all sources.

**`name_score` in the matrix.**
- `ScoredTriple` gains `nameScore: 0 | 1`. `recordIfBetter` switches from `score`-only to
  `compareCandidates(a, b)` = git's `score_compare` (score desc, then nameScore desc).
  `worst` becomes the lowest-ranked slot (first index on ties). Replacement needs
  `compareCandidates(worst, o) > 0`.
- `sortTriples` uses the same comparator on a stable sort.
- Only pairs at or above `threshold` (§4.2) are recorded. This drops git's below-minimum
  entries, which is equivalent: a below-minimum entry never displaces an above-minimum one
  and is never selected.

### 4.4 Item 3: non-regular files leave the inexact scoring pools (D1)

The rule mirrors git exactly. **A non-regular side never gets an inexact score and is
never hydrated. It stays everywhere else.**

| Stage | Non-regular (symlink, gitlink) | Pin |
|---|---|---|
| exact pass (`-M` and copies) | eligible, same-mode only (ADR-893 mode class) | #12, N4s, G1, G2 |
| basename uniqueness indexes | counted | N9, N9d |
| basename / matrix scoring | skipped: never scored, never hydrated | N1–N3, N4, N5, N5r |
| rename-limit counts (`num_src`, `num_dst`) | counted | derived from source (†) |
| copy sources (`-C` modified, `-C -C` unchanged) | registered: exact only | G1, G2, N4 vs N4s |
| `-B` break candidates | symlink modifies and symlink↔regular type changes eligible (§4.8); gitlink modifies and gitlink type changes never break | N6, N6b, N7b, G3 |

† git counts `rename_src_nr` / `rename_dst_nr` over every registered pair. tsgit's
`partitionLeftovers` removes gitlinks before counting today. Part 4 pins a gitlink-count
row.

Consequence for ADR-405: its predicate `isGitlink` becomes `kindOf(mode) !== 'file'` for
**scoring and hydration only**. The exact pass and the counts keep gitlinks. D1 covers the
ADR form.

`-B` type-change breaking (N7b–N7n) builds on this rule: the symlink half of a broken type
change is never scored, only paired exactly. §4.8 designs it (ADR-903).

### 4.5 Item 4: copy-aware exact pass, two-pass selection, use-count labels (D2, D9)

**Exact pass: `pairIdenticalFiles(sources, dests, mode: 'rename' | 'copy')`** (domain,
pure). It generalises the ADR-893 transcription:
- Groups are keyed by `exactKey(id, mode)` over **all** `RenameSource`s, in source order.
- Per destination in order: scan at most `EXACT_CANDIDATE_CAP` (100) candidates.
  `score = (uses === 0 ? 1 : 0) + hasSameBasename`, strict `>`, early exit at 2.
  - `'rename'`: used sources are skipped **without counting** (today's splice keeps this
    O(1) for k = 1).
  - `'copy'`: used sources are **scored and counted**, and nothing is spliced.
- It returns the pairs plus the updated use counts.
- `detectRenames(diff)` (public, `src/public-types.ts:49`) becomes a thin wrapper:
  deletes → `deleted` sources, `'rename'` mode, output unchanged. ADR-893 through ADR-897
  pins hold as they are.

**Selection: `selectPairs(sortedMatrix, uses, { copies, threshold })`** (domain, pure):
- Pass 1: skip a paired destination, skip a source with `uses > 0`, stop at the first
  `score < threshold`.
- Pass 2 (copies only): skip a paired destination, stop at `score < threshold`. One
  threshold for both passes, git's `minimum_score` (ADR-906).
- Each recorded pair increments `uses`.
- This replaces `greedySelect` and the rename/copy triple split. `buildRenameTriples` and
  `buildCopyTriples` merge into one `buildMatrix(sources, dests, …)`. `sortTriples` loses
  its kind tie-break. The ADR-371 greedy shape is kept.

**Labels: `labelRenameCopy(pairs, uses)`** (domain, pure):
- In output order (`primaryPath`, which equals git's queue order per first-design §4.1),
  apply `--uses > 0 ? copy : rename`.
- A pair whose source path equals its destination path is a re-merged broken pair, i.e. a
  modify. `remergeOrKeepBroken` already emits that pair, and the re-merge adds one use to
  the delete half's source before labelling (K1, K2).

**Write back.** This replaces `consumedDeletes` and `findPresentHalves`.
- A `deleted` source's delete is emitted iff its final `uses` is 0.
- A `broken-delete` source follows git's rule instead (S2): its delete is dropped iff its
  own add half was paired, whatever its use count.
  - Add half paired: the pairing stands in for the broken change (S2, N7f, N7g, N7j).
  - Add half unpaired: the halves rejoin (`rejoinBroken`, §4.8), and the rejoin adds one
    use to the delete half's source (K1, K2, N7d, N7m).
- A broken pair therefore never surfaces as a bare `D` or `A` of its own path.

**Cull (step 4).** With copies on, or any broken pair, used sources **stay in the matrix**
(git's `remove_unneeded_paths_from_src` returns early). Pass 1 still skips them, but they
occupy top-4 slots. This is a derived consequence (no probe isolates it), and Part 3 pins
it.

**`copies: 'harder'` fallback.**
- The exact pass always sees the full preimage (C18). Only the matrix degrades:
  `resolveCopySources`'s limit fallback moves from "replace the source set" to
  `skip_unmodified`, which excludes `retained`-unchanged sources from the matrix only.
- `buildPreimage` (`diff-trees.ts:380`) already supplies the map.
- `skip_unmodified` keys on the `unchanged` origin.

### 4.6 Rename-limit counting

- `num_dst` = unpaired destinations after exact and basename.
- `num_src` = sources after step 4, **each source once**, every mode.
- Today's `deletes.length + copySources.length` counts every leftover delete twice under
  `-C` (L1). The harder degrade test counts non-`unchanged` sources.

### 4.7 Public surface: what changes, what does not

Changes (both ship in the current major):
- `RenameDetectOptions.copyThreshold` is removed (ADR-906). `threshold` gates the rename
  pass, the copy pass, the size gate and, through `min_basename_score`, the basename pass.
  Callers that mapped git's `-C<n>` to `copyThreshold` map it to `threshold`, which is
  what git does (`-C<n>` and `-M<n>` both set `minimum_score`).
- `TypeChangeChange` gains `readonly broken?: SimilarityScore` (ADR-903, §4.8). The field
  is additive and optional.

Unchanged:
- `RenameChange`, `CopyChange`, `ModifyChange.broken`, and `detectRenames(diff)` with its
  `-M` behaviour.
- Scores. `estimateSimilarityFromMaps`, `buildChunkMap` and `isSizeRejected` are unchanged.
- ADR-370: the exact pass is never limited. ADR-893's `-M` exact semantics are unchanged.
- blame's single-follow shape (ADR-895).

### 4.8 `-B` parity: type-change breaking, write back, `should_break` guards (ADR-903)

**Public type** (`src/domain/diff/diff-change.ts`):

```ts
export interface TypeChangeChange {
  readonly type: 'type-change';
  readonly path: FilePath;
  readonly oldId: ObjectId; readonly newId: ObjectId;
  readonly oldMode: FileMode; readonly newMode: FileMode;
  /** Dissimilarity datum when -B broke this type change and its halves rejoined.
   *  git breaks every symlink↔regular type change at MAX_SCORE, so score === MAX_SCORE. */
  readonly broken?: SimilarityScore;
}
```

It mirrors `ModifyChange.broken` (ADR-249: a datum; the caller renders `T100`). It is set
only when `breakRewrites` is on and the pair is a symlink↔regular type change whose add
half stayed unpaired. The value is always `{ score: MAX_SCORE, maxScore: MAX_SCORE }`.
It stays a `SimilarityScore`, not a boolean, for three reasons: git carries a score,
`ModifyChange.broken` has the same shape, and a consumer's `T%03d` / `M%03d` projection is
then one code path.

**Representation.** No new change kind and no public halves:

```
type-change a/p (symlink→regular), -B on
        │ runBreakPass: kindOf(old) ≠ kindOf(new), both ∈ {file, symlink}
        ▼
BrokenRecord { original: TypeChangeChange, del: D a/p (symlink), add: A a/p (regular),
               dissimilarity: MAX_SCORE }          ← no blob read
        │ registerCandidates: del → RenameSource{origin:'broken-delete', seedUses:0}
        │                     add → destination
        ▼ exact / basename(off: broken>0) / matrix — symlink half: exact only (ADR-899)
        ├─ add half paired  → emit the R/C for it; drop del          (N7f, N7g, N7j, N7h)
        └─ add half unpaired → rejoin: { ...original, broken: MAX } ; uses[del.source]++
                                                                      (N7b, N7d, N7e, N7m, N7n)
```

The internal `BrokenRecord.original` widens from `ModifyChange` to
`ModifyChange | TypeChangeChange`. `emitMergedModify` becomes `rejoinBroken(record,
mergeScore)`, which spreads `original` for either kind. The keep-broken rule stays one
rule, `dissimilarity >= mergeScore`: a type change's `MAX_SCORE` passes every merge score
git can express (`parse_rename_score` caps at `MAX_SCORE`).

**Candidate filter** (`attemptBreaks`, `:599`):
- `modify` whose kind is `file` or `symlink`, scored as today. `isGitlink` (`:605`)
  becomes `isBreakableKind(mode) = kindOf(mode) === 'file' || kindOf(mode) === 'symlink'`,
  git's `object_type == OBJ_BLOB`.
- `type-change` whose two kinds are both breakable (that is, file↔symlink): broken
  unconditionally with dissimilarity `MAX_SCORE`, never hydrated. gitlink↔file,
  gitlink↔symlink and directory↔anything stay plain `T` (G3).
- `patchDiffWithBroken` (`:571`) keys on `change.type === 'modify' || 'type-change'`.
- Under `-C`, a broken type change registers once, as its `broken-delete` half. It is not
  also a `modified` copy source (N7c), exactly as a broken modify is not.

**Write back** is the §4.5 rule, and it covers modifies too: S2 fixes a regular-file
divergence that exists today.

**`should_break` guards (D10).** `computeBreakScores` (`:519`) lacks two early returns:
- `max(srcSize, dstSize) < MINIMUM_BREAK_SIZE` (400) → no break (S1);
- `srcSize === 0` → no break (S0).

They are local and need no new read, because both sizes come from bytes that are already
hydrated. Several existing `-B` unit fixtures are below 400 bytes (for example the
150-byte `sharedContent` at `:1339`). Under D10(a) they grow past the gate.

**Consumers of `TypeChangeChange.broken`.**

| Consumer | Handling | Pin |
|---|---|---|
| patch serializer `renderTypeChangeBlock` (`patch-serializer.ts:621`) | ignores `broken`: git's type-change patch is delete + add blocks, byte-identical with or without `-B` | N7b `-p` reconstructPatch vs `git diff -p -M -B` |
| stat pass (`diff-trees.ts` `applyStatPass`, `stat-fields.ts`) | ignores `broken`; `complete_rewrite` is modify-only | N7b `--numstat` `20 1` |
| `withPrefix` (`diff-trees.ts:604`) | spread keeps the field (it runs before `-B` anyway) | — |
| `materialisePatchFiles` (`:268`, `:296`) | reads both sides as today; no field access | — |
| `show` / `log` / `whatchanged` / `range-diff` / `status` / `blame` / merge | never pass `breakRewrites`, so the field never appears | no change |
| interop name-status reconstructions | add a `T%03d` arm when `broken` is set: `rename-similarity-interop.test.ts:86` (today drops `type-change` to `''`), `rename-exact-interop.test.ts:102`, `diff-type-change-interop.test.ts:109` | N7 rows |
| `docs/use/commands/diff.md` Data guarantees | new bullet: a `type-change` may carry `broken`; always `MAX_SCORE`; rendered `T100` | doc |

## 5. Interactions

| Interaction | Rule (git) | Pin |
|---|---|---|
| basename × copies | basename pass off under `-C`; `name_score` still breaks matrix ties | B3c, B1c, B8c |
| basename × `-B` | off only when a pair was actually broken | B3b, B3bb |
| basename × limit | basename pass unlimited; the limit counts the leftovers | B3l, L2 |
| basename × non-regular | counted for uniqueness, never scored | N9, N9d |
| basename × size gate | gated at `min_basename_score`; fingerprints reused by the matrix | §4.2 |
| size gate × copies | gate at `threshold`, the one `minimum_score` of both passes | §4.2, ADR-906 |
| size gate × limit | limit decides before any matrix blob is read | §4.2 |
| non-regular × exact | same-mode exact pairing stays, copies included | N4s, G1, G2 |
| non-regular × `-B` | symlink modifies break; halves pair exactly only | N6, N6b |
| copies × exact × limit | exact copy pairing unlimited; harder degrade hits the matrix only | C16, C18 |
| copies × rename precedence | pass 1 (deleted sources only) runs over the whole matrix before pass 2 | C19, C20 |
| `-B` × labels | a broken-delete source re-merged is one more user → C | K1, K2, N7d, N7m |
| `-B` × write back | broken delete dropped iff its add half paired | S2, N7f, N7g, N7j |
| `-B` type change × basename | a broken type change sets `break_idx`: basename pass off | B3t |
| `-B` type change × non-regular | symlink half exact only; regular half exact or inexact | N7g, N7k, N7e, N7j |
| `-B` type change × copies | registered once, as a broken delete, not as a `modified` source | N7c |
| blame × basename | single-follow still runs the basename pass | BL1 |

## 6. Edge cases

| Case | Behaviour | Pin |
|---|---|---|
| `threshold === MAX_SCORE` | exact pass only; no basename, no matrix, no hydration | derived (§2.1 step 3) |
| empty blobs | `rename_empty` on for diff: exact pairing as today | first design #14 |
| dst basename unique, src not | no basename pair; matrix decides | B5 |
| basename pair below `minBasename` | left to the matrix | B4 |
| 5+ equal-score sources | top-4 by (score, nameScore); ties keep the first slots | B8 |
| deleted source used by exact + inexact | k−1 copies, last in path order is R | C10 |
| retained source only | every use is C | C17, C4 |
| gitlink/symlink retained exact | C100 same mode | G1, N4s |
| blob size > ioBound window × pool | residency bounded by the window, not the pool | §3.1 |
| symlink↔regular type change, same blob | breaks anyway; the halves cannot pair exactly (mode class) → `T100` | N7s |
| broken type change, add half paired, delete half used | both pairings stand; no `T` | N7h, N7k |
| gitlink↔regular type change under `-B` | never broken → `T` | G3 |
| `breakRewrites.merge` > `MAX_SCORE` | outside git's range (`parse_rename_score` caps). tsgit applies the shared `dissimilarity >= merge` rule, so nothing stays broken, type changes included | not pinned (no git counterpart) |
| empty or < 400 B modify under `-B` | never broken (D10) | S0, S1 |
| lazy fetch (partial clone) | size read and blob read keep `withLazyFetchRetry`; no batch prefetch (git's `inexact_prefetch` is a promisor optimisation) | not pinned |

## 7. Performance and bundle

- **Hot path.** `show`/`log` with renames do one exact pass per commit. §3.1 prices the
  size pass at +0.3 to +0.55 ms per small diff, and D3(b) keeps small pools off it. The
  copy-aware exact pass costs the same as today under `-M` (splice path unchanged). Under
  `-C` it scans without splicing, still O(min(k, 100)) per destination.
- **Benchmark (Part 1).**
  - New `test/bench/diff-renames.bench.ts` with three shapes, generated by a new cached
    builder in `test/bench/support/fixture-generator.ts` (build in a temp dir, rename
    into place):
    - `common`: 50 files, 3 renamed+edited (F1);
    - `wide`: 300 moved+edited 4 KB files (F2);
    - `hostile`: 300 × 1 MiB distinct deletes + 1 tiny add (d300).
  - Loose and packed variants of each.
  - A/B with `npm run bench:ab` against `main` before the Part 1 commit (memory note:
    bench after the commit). Gate: `common` median within noise of `main`, and
    `hostile` ≥ 10× faster.
  - A `rename-hydration` workload in `tooling/bench-memory.ts` records peak RSS on
    `hostile`. Target: within 64 MB of the process baseline, against ~665 MB today.
- **Bundle.**
  - Adds: basename pass, size gate, header-only size read, pairing module, labels.
  - Removes: `buildCopySourcesForOn`/`ForHarder` merged into `registerCandidates`,
    `buildCopyTriples` merged into `buildMatrix`, the `sortTriples` kind tie-break,
    `greedySelect`.
  - Net estimate: +0.6 to +1.2 kB gzip, split between `Chunks: domain` and
    `Chunks: primitives`. The browser bundle has ~50 B headroom under 209.25 kB, and
    `Chunks: primitives` ~168 B. Both are expected to be crossed; ADR-904 applies.

## 8. Implementation parts (pre-chewed context)

Order: Part 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Each part is TDD, and each commit is green on
`npm run validate`. That includes `check:dead-code` (knip), so every new export lands in
the part that first consumes it, and `check:doc-typedoc`, so any public-type change
regenerates `reports/api.json` (`npm run docs:json`) in the same commit.

**Faithfulness ordering.** Each part lands the interop rows it fixes, in the suites
ADR-905 names, in the same commit: first the RED unit row, then the interop row. No commit
may turn a §3 row that is ✓ today into ✗. The order is forced by the dependencies below.

| Constraint | Why | Forces |
|---|---|---|
| exact copy pairing before non-regular exclusion | N4s (`C100` symlink→symlink) is ✓ today only because the inexact pass scores symlinks. Excluding them first regresses it until exact copies exist. | Part 3 < Part 4 |
| use-count write back before type-change breaking | without S2's rule and rejoin uses, breaking a type change emits bare halves (`A a/p ; R100 a/p→b/q`) | Part 3 < Part 5 |
| non-regular exclusion before type-change breaking | a symlink half would otherwise inexact-pair with a regular delete (N7n would become `R100 a/d→a/p`) | Part 4 < Part 5 |
| type-change breaking before the basename pass | B3t pairs like git today only because tsgit has no basename pass. A basename pass that does not count a broken type change regresses it to `R080` | Part 5 < Part 6 |
| `copyThreshold` removal first | Parts 1 and 3 then build a one-threshold gate and selection directly | Part 0 first |

### Part 0: one threshold, `copyThreshold` removed (ADR-906)

Commit: `feat(diff)!: gate copies with the rename threshold and remove copyThreshold`.
- `src/domain/diff/rename-detect.ts:13-14`: delete the `copyThreshold?` member and its doc
  comment from `RenameDetectOptions`. `threshold`'s doc (none today) states that it gates
  renames and copies.
- `src/application/primitives/detect-similarity-renames.ts`, every use goes. `threshold`
  replaces the parameter where one remains:
  - `buildCopyTriples(…, copyThreshold)` (`:234`, `:239`, `:249`);
  - `InexactPassOptions.copyThreshold` (`:372`);
  - `buildAllTriples` (`:427`, `:433`, `:446`);
  - `runInexactPass` destructuring (`:457`, `:469`);
  - `DetectOptions.copyThreshold` and its `?? threshold` default (`:780`, `:791`);
  - `detectSimilarityRenames` (`:824`, `:859`).
- Tests:
  - `test/unit/application/primitives/detect-similarity-renames.test.ts:515-556`
    ("copy pair whose score is below copyThreshold") becomes "below threshold". Use a
    `threshold` one point above the copy's measured score, not `MAX_SCORE`: `MAX_SCORE`
    exits before the matrix (§6), so it would not exercise the copy-pass gate.
  - `test/integration/rename-similarity-interop.test.ts:2010-2100` (T3): `renameOptions:
    { copies: 'on', threshold: 24000 | 24600 }` against the unchanged `git -C40%` /
    `-C41%` peer. The row has no delete, so the rename pass is inert. The describe title
    drops `copyThreshold`.
- Docs:
  - `docs/use/commands/diff.md:22-27`: drop the `copyThreshold?` line; `threshold?` reads
    "rename and copy similarity gate (git's `-M<n>` / `-C<n>`)";
  - `docs/use/primitives/diff-trees.md:13`, `:28`: drop `copyThreshold`.
  - `README.md` and `examples/` have no call site (grepped).
- `npm run docs:json` → `reports/api.json` (`:110636`, `:190295` entries go).
- The changelog entry comes from the `!` commit (release tooling). Do not hand-edit
  `CHANGELOG.md`.

### Part 1: bounded hydration (item 1)


- `src/application/primitives/read-object.ts`:
  - `readObjectMetadata(ctx, id): Promise<ObjectMetadata>` (`:281`) gets a header-only
    loose route (D4). `resolveObjectMetadataWithContent` (`:305`) stays for
    `readObjectMetadataWithContent`, which deltify needs with content.
  - The loose file path comes from `looseObjectPath(commonGitDir(ctx), id)`
    (`path-layout.ts`). The existence probe is `probeLooseOid` (`object-resolver.ts`).
  - Reference loop: `readLooseHeader` (`internal/blob-source.ts:455`) accumulates inflate
    chunks until the NUL.
- `src/application/primitives/detect-similarity-renames.ts`:
  - `hydrateAndFingerprint(ctx, allSrcIds, adds)` (`:402`, exported for
    `test/unit/application/primitives/internal/detect-similarity-renames.test.ts`) becomes
    `hydrateFingerprints(ctx, request): Promise<Map<ObjectId, BlobFingerprint>>`.
  - New private `sizeCompatibleIds(sizes, srcIds, dstIds, threshold)` (binary search) and
    `SIZE_GATE_MIN_IDS`. The gate threshold is `threshold` (Part 0 removed the second one).
  - Pool scope at this commit: every id the matrix still scores. Symlinks are still scored
    here (Part 4 removes them), so they are sized and fingerprinted like regular blobs.
    Gitlinks are already out (ADR-405).
  - `hydrateIds` (`:37`) and `buildFingerprintMap` (`:157`) are removed.
  - `scoreModifies` (`:533`) streams per modify.
- Tests:
  - the internal test file above: its concurrency-ceiling proof carries over;
  - new cases: a size-rejected id is never passed to `readBlob`, via a counting fs/ctx
    spy (kills the gate's mutants observably, instead of the "equivalent" survivors at
    `:192`); below `SIZE_GATE_MIN_IDS` the size read is skipped; a loose object whose
    header needs more than the probe prefix falls back correctly.
  - `test/unit/application/primitives/read-object.test.ts`: header-only loose size for a
    large loose blob equals `content.length`.
  - Property sibling `detect-similarity-renames.properties.test.ts`, lens 2:
    `sizeCompatibleIds` equals a brute-force `some(!isSizeRejected)` over small arrays.
    The brute force is not the binary search, and `isSizeRejected` is independently
    tested.
- Bench: §7.

### Part 2: domain pairing module (item 4 exact core)

- New `src/domain/diff/rename-pairing.ts` with `RenameSource`, `SourceOrigin` and
  `pairIdenticalFiles`, which `detectRenames` consumes. `compareCandidates`,
  `selectPairs` and `labelRenameCopy` wait for Part 3, and `uniqueBasenamePairs` for
  Part 6: each lands with its first consumer (knip).
- `hasSameBasename`, `exactKey`, `EXACT_CANDIDATE_CAP` move here from
  `src/domain/diff/rename-detect.ts` (`:25`, `:44`, `:68`). `detectRenames` (`:110`)
  wraps `pairIdenticalFiles(…, 'rename')`.
- Re-export through `src/domain/diff/index.ts` only what the primitive needs. Nothing new
  goes public (`src/public-types.ts`).
- Tests: new `test/unit/domain/diff/rename-pairing.test.ts`, with rows C1, C3, C9, C14,
  C15, G1 at domain level (pairs + use counts), plus a used-source cap-counting row (copy
  mode counts used sources toward 100). `test/unit/domain/diff/rename-detect.test.ts`
  stays green, untouched.
- Properties: new `rename-pairing.properties.test.ts`; generators extend
  `test/unit/domain/diff/arbitraries.ts` (`arbNonDirMode`, small id/path pools).
  - Lens 4: under `'copy'`, every destination with a same-key source is paired.
  - The existing `rename-detect.properties.test.ts` stays (ADR-136).
- No interop row changes: the primitive does not call the copy mode yet.

### Part 3: unified registry, one matrix, two passes, labels, write back (item 4)

- `detect-similarity-renames.ts`:
  - `registerCandidates(workingDiff, broken, copies, preimage, mergeScore)` replaces
    `partitionLeftovers` (`:347`), `resolveCopySources` (`:699`) and
    `buildCopySourcesForOn`/`ForHarder` (`:60`, `:84`). The exact pass now runs
    `pairIdenticalFiles(…, copies ? 'copy' : 'rename')` over all sources.
  - `buildMatrix` replaces `buildRenameTriples` (`:206`) and `buildCopyTriples` (`:234`).
  - `ScoredTriple` (`:96`) loses `kind` and gains `nameScore`.
  - `selectPairs` (new in `rename-pairing.ts`) replaces `greedySelect` (`:313`).
  - `compareCandidates` (new in `rename-pairing.ts`, git's `score_compare`) drives
    `recordIfBetter` (`:125`) and `sortTriples` (`:260`).
  - `labelRenameCopy` (new in `rename-pairing.ts`) labels in output order.
  - `assemblePostPass` (`:799`) emits deletes by final use count.
  - `findPresentHalves` (`:632`) and `remergeOrKeepBroken` (`:659`) become the §4.5 write
    back: a broken delete is dropped iff its add half is paired (S2). Otherwise the halves
    rejoin, and `uses[delete-half source]++`.
  - The limit gate at `:849` uses §4.6 counts.
- Existing tests to rewrite in `detect-similarity-renames.test.ts`. They encode today's
  divergence:
  - `:1334` "delete-half consumed by a rename → add-half remains as an add" becomes K1's
    shape: rejoined `modify` with `broken`, and the other pair is a `copy`. Fixtures at
    ≥ 400 B, so that they survive D10;
  - `:2425` "add-half consumed, delete-half stays as a delete" becomes S2: no delete, only
    the rename;
  - `:2545` both-consumed: re-check against the new rule (the add half is paired → the
    delete is dropped whatever its uses);
  - "copies on with both a rename candidate and a copy candidate" (`:597`) and the kind
    tie-break mutant notes at `:264`/`:266`: the tie-break is gone; C19/C20 replace it;
  - "copies harder with limit exceeded only under harder" (`:755`): the fallback becomes
    `skip_unmodified`, and C18 adds the exact-still-sees-all row;
  - the `recordIfBetter` block (`:1712`, `:3708`) gains nameScore arms.
- Domain properties (`rename-pairing.properties.test.ts`), lens 4:
  - per `deleted` source with k ≥ 1 pairs, the labels are exactly k−1 copies and one
    rename, and the rename is the last in output order;
  - every `retained` source yields only copies.
- Interop rows fixed here:
  - C1–C3, C6, C9, C10, C14–C16, C18–C20, L1, K1, K2, G1, G2, S2;
  - the `name_score` matrix rows B1, B1c, B2, B8, B8c, B9 (no basename pass is needed:
    equal scores, basename tie-break).
  Exact rows go in `rename-exact-interop`, the rest in `rename-similarity-interop`.

### Part 4: non-regular exclusion (item 3; ADR-899)

- `registerCandidates` (Part 3) keeps every mode in the source and destination lists (exact
  pass, counts, uniqueness). Scoring and hydration filter with
  `isRegularFile(mode) = kindOf(mode) === 'file'` (`src/domain/diff/mode-kind.ts`). The
  gitlink carve-out in the old `partitionLeftovers` goes with it.
- Part 1's size and fingerprint pool narrows to regular ids.
- `attemptBreaks` (`:599`): unchanged here (gitlinks out, symlinks in, §2.6). Part 5 widens
  it.
- Tests: `test/unit/application/primitives/detect-similarity-renames.test.ts`. The
  gitlink describes (ADR-405 arms, search `isGitlink`/`160000`) get sibling symlink arms:
  N1, N2, N3, N4, N5, N5r, N6b, plus "symlink blob never read" via a readBlob spy.
- Interop rows fixed here: N1–N5r, N6b, N4s (must stay ✓), gitlink-limit-count row.

### Part 5: `-B` parity: type-change breaking, `should_break` guards (ADR-903, D10)

Commit: `feat(diff): break symlink↔regular type changes under -B and report them broken`.
If D10(a), a separate `fix(diff): never break empty or sub-400-byte files under -B` goes
first.
- `src/domain/diff/diff-change.ts:42`: `TypeChangeChange.broken?: SimilarityScore` with
  the §4.8 doc comment. It is re-exported through `src/public-types.ts` unchanged (the
  interface is already public). `npm run docs:json`.
- `detect-similarity-renames.ts`:
  - `BrokenRecord` (`:485`): `original: ModifyChange | TypeChangeChange`;
  - `attemptBreaks` (`:599`): the §4.8 candidate filter. Type changes produce records
    with `dissimilarity: MAX_SCORE` without entering `scoreModifies`;
  - `patchDiffWithBroken` (`:571`): replace type changes too;
  - `emitMergedModify` (`:652`) → `rejoinBroken`, which spreads either kind;
  - D10(a): `computeBreakScores` (`:519`), or its caller, returns "no break" when
    `maxSize < MINIMUM_BREAK_SIZE` or `srcSize === 0`. Name the constant, and keep the
    existing `srcSize > 0` equivalence note consistent.
- `src/domain/diff/patch-serializer.ts:621` `renderTypeChangeBlock`: no change. Add a
  unit row to `test/unit/domain/diff/patch-serializer.test.ts` (next to "Given a type
  change from regular to symlink", `:600`): a `broken` type change renders byte-identical
  to the plain one.
- Unit rows (`detect-similarity-renames.test.ts`), one describe each:
  - N7b and N7s (no `readBlob` for a type change, spy);
  - N7d, N7e, N7m (rejoin + copy label);
  - N7f, N7j, N7g, N7h, N7k (add half paired → no `T`);
  - N7n (symlink half never inexact);
  - N7c (registered once under `-C`);
  - G3 (gitlink type change never broken);
  - isolated guard rows for each kind pair of the filter (file↔symlink breaks;
    file↔gitlink, symlink↔gitlink, directory↔file do not);
  - D10(a): S0 and S1, each guard isolated, with the boundary at 399 / 400 bytes.
  - Existing `-B` fixtures under 400 bytes (`:1339` `sharedContent`, 150 B, and any
    `tenLines` fixture used with `breakRewrites`) grow past the gate in the D10 commit.
- Interop (`rename-similarity-interop.test.ts`, per ADR-905):
  - `reconstructNameStatus` (`:86`) gains a `type-change` arm: `T` + `%03d` of
    `broken.score` when set. Today it returns `''`, which would hide every T row;
  - `rename-exact-interop.test.ts:102` and `diff-type-change-interop.test.ts:109` get the
    same arm;
  - rows N7b, N7s, N7c, N7d, N7e, N7f, N7g, N7h, N7j, N7k, N7m, N7n, G3, S0, S1, B3t
    (pairing and datum). N7b also pins `reconstructPatch` (`test/integration/
    diff-reconstruct.ts`) against `git diff -p -M -B`, and `withStat` against
    `--numstat`.
- Docs: `docs/use/commands/diff.md` Data guarantees (`:103-106`) gains the §4.8 bullet
  after the `modify` one: "A `type-change` may carry `broken` when `-B` broke a
  symlink↔regular type change and its halves rejoined; `score` is always `MAX_SCORE`
  (git prints `T100`). A broken type change whose new side pairs elsewhere is replaced by
  that rename/copy, as in git." `docs/use/commands/whatchanged.md:70` needs no change
  (no `-B` on that path).

### Part 6: basename pass (item 2)

- `detect-similarity-renames.ts`: new `runBasenamePass(ctx, sources, dests, uses,
  fingerprints, minBasename)` between exact and limit. It is gated on
  `copies === 'off' && broken.length === 0 && threshold < MAX_SCORE`, where `broken`
  includes type-change records (B3t).
- `uniqueBasenamePairs` lands in `rename-pairing.ts` with its lens-2 property
  (it never returns a basename that occurs twice on either side).
- Tests:
  - rows B3, B3l, B3b, B3bb, B3bn, B3t, B4, B7, B10, L2, N9, N9d;
  - isolated guard tests for each gate condition (copies, broken modify, broken type
    change, MAX_SCORE), per CLAUDE.md's "guard clauses need isolated tests";
  - the `minBasename` formula boundary (score = minBasename vs minBasename − 1).
- blame: `test/unit/application/commands/blame.test.ts`, add "Given a rename source
  competing on basename" (BL1), and the BL1 row in `test/integration/blame-interop.test.ts`.

### Part 7: cross-cutting interop pins

The rows no single part owns, per ADR-905:
- the ✓-must-stay rows (C4, C5*, C7, C8, C11–C13, C15n, C17, L3, N3r, N6, N8, B4–B7, K3,
  N7dn/N7fn/N7kn) in `rename-similarity-interop` / `rename-exact-interop`;
- any row a part deferred.

Every row compares against live git through the suite's reconstruction helper. New rows
compare live git directly. They do not copy the existing
`try { expect(golden) } catch { saveGolden }` pattern (for example the `break-b6` row),
which turns a golden mismatch into a silent golden rewrite.

## 9. Test strategy (summary)

Every §3 row that changes becomes a RED unit row first (domain rows for pure pairing,
primitive rows for scoring and hydration), then an interop row against live git.
- Guards get isolated tests: basename gates (including a broken type change on its own),
  the size gate, non-regular scoring, copy vs rename pass skip rules, cap counting in copy
  mode, the `-B` kind filter per kind pair, and each `should_break` guard (D10).
- The type-change break is proven unread by a `readBlob` spy.
- The hydration gate is proven by read-count spies, not by output (output is equal by
  construction).
- Coverage 100%. Mutation target 0 survivors. Stryker disables in touched code
  (`:133`, `:192`, `:264`, `:266`, `:409`, `:411`) are re-triaged, because the
  restructure removes most of them.

## 10. Non-goals and follow-ups

- `-B` without rename detection. git's `diff -B` alone breaks and re-merges without
  pairing (N7b `-B` alone gives `T100`, and a K1 shape gives `M100 m ; A q`). tsgit runs
  `breakRewrites` only inside `detectRenames: true`. That is a pre-existing API shape and
  needs its own option design.
- `--numstat` of a broken **modify** (`complete_rewrite` counts every old and new line).
  Pre-existing and unprobed; a broken type change is unaffected (N7b `--numstat`).
- The goldens-seeding `catch { saveGolden }` pattern in the existing interop rows (Part 7):
  a test-hygiene fix outside this change.
- `breakRewrites.merge` outside `0..MAX_SCORE` has no git counterpart (§6). Input
  validation is a separate change.
- `GIT_BASENAME_FACTOR` (an env knob of git's CLI; tsgit reads no git env vars here).
- `-M0` / threshold 0: git maps `minimum_score == 0` to the default; tsgit keeps 0.
  Unprobed, noted only.
- Promisor batch prefetch (`inexact_prefetch`, `basename_prefetch`).
- Fingerprint representation. A JS `Map` per blob costs more than git's packed spanhash
  table. The size gate removes the hostile case, but a pool of many large, size-compatible
  blobs still holds `Map`s of roughly blob-proportional size. A typed-array fingerprint
  is a separate change.
- git's stderr rename-limit warning (rendering; ADR-249/370).

## 11. Decisions (ratified)

| # | Choice | Outcome | ADR |
|---|---|---|---|
| D1 | ADR form for item 3 | (a) new ADR superseding ADR-898, refining ADR-405: every non-regular mode leaves scoring and hydration, and keeps exact pairing, uniqueness and limit counts | [899](../adr/899-non-regular-files-leave-the-inexact-scoring-pools.md) |
| D2 | Where copy-aware exact pairing and R/C labelling live | (a) pure domain module `rename-pairing.ts`; `detectRenames` is its `-M` wrapper | [900](../adr/900-rename-pairing-is-a-pure-domain-module.md) |
| D3 | How to bound hydration | (b) fingerprint-and-drop always; size pass above `SIZE_GATE_MIN_IDS` | [901](../adr/901-inexact-hydration-fingerprints-and-drops-with-a-size-gate.md) |
| D4 | Loose-object size read | (a) header-only route inside `readObjectMetadata` with full-read fallback | [902](../adr/902-loose-object-size-reads-only-the-header.md) |
| D5 | Scope of `-B` rows | **(b), user-ratified**: every `-B` row follows git, symlink↔regular type changes included (§4.8) | [903](../adr/903-break-detection-covers-type-changes.md) |
| D6 | Public API changes | **(b), user-ratified**: `TypeChangeChange.broken?: SimilarityScore`, mirroring `ModifyChange.broken` | [903](../adr/903-break-detection-covers-type-changes.md) |
| D7 | Bundle-size limits | (a) raise each crossed limit to measured + 0.25 kB in the crossing commit | [904](../adr/904-bundle-limits-follow-git-mandated-growth.md) |
| D8 | Where interop pins live | (a) extend `rename-similarity-interop` / `rename-exact-interop`; blame rows in `blame-interop` | [905](../adr/905-rename-parity-pins-extend-the-existing-interop-suites.md) |
| D9 | `copyThreshold` | **(b), user-ratified**: removed; `threshold` gates both passes (git's single `minimum_score`) | [906](../adr/906-copy-threshold-is-removed.md) |

## 12. New decision candidates

| # | Choice | Options | Recommendation |
|---|---|---|---|
| D10 | `should_break`'s two missing guards, surfaced by this revision (S0: empty source; S1: `max(src, dst) < 400` bytes). Today tsgit breaks both, and the broken halves then pair where git keeps a plain `M` (`D a/d ; M a/s` in git vs `D a/s ; R100 a/d→a/s` in tsgit) | (a) fold them into Part 5 as a separate `fix(diff)` commit under ADR-903 ("every `-B` row follows git"): two early returns plus growing the sub-400-byte `-B` unit fixtures · (b) defer to a follow-up and leave S0/S1 without assertions · (c) fold only the empty-source guard (no fixture churn) | **(a)**: they are `-B` rows in this matrix, and ADR-903 already commits to every one. The code is two guards. The cost is fixture growth in existing `-B` unit tests, which Part 3 rewrites anyway. (b) leaves a known divergence in a pass this change rewrites. (c) splits one git function across two changes |
