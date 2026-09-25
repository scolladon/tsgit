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
> Status: draft, decision candidates open (§11)

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
| 893–897 | `-M` exact pass = `find_identical_files` (cap 100, basename, mode class); blame single-follow; interop + property pins. |
| 898 | Superseded by this design (D1). |

## 2. git's algorithm, read from source

Source: git **v2.55.0** `diffcore-rename.c`, `diffcore-break.c`, `diff.c`. Behaviour pinned
against `git version 2.55.0` (§3). The blocks below paraphrase the source; they are not
verbatim.

### 2.1 Pipeline order (`diffcore_rename_extended`, `diffcore-rename.c:1380`)

```
1. register        adds → rename_dst (single_follow: only that path)
                   deletes → rename_src, rename_used = 0
                     broken delete half with score 0 (it will re-merge) → rename_used = 1
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
8. write back      delete kept iff rename_used == 0 (broken delete: iff its add half unpaired)
   merge_broken    re-joined halves: rename_used++ on the source   (diffcore-break.c:262)
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

### 2.6 `-B` (`diffcore-break.c:175`, `should_break` `:13`)

- Candidates are pairs whose two sides both have `object_type == OBJ_BLOB`. Gitlinks are
  excluded. **Symlinks are not excluded.**
- `S_ISREG(src) != S_ISREG(dst)` (a symlink↔regular type change) → always broken, merge
  score `MAX_SCORE`. The pair stays broken as `T100`, and its halves feed exact pairing
  (N7b–N7f).
- Otherwise a symlink→symlink modify is scored like a regular file (MINIMUM_BREAK_SIZE
  400, spanhash). Its halves can then only pair exactly, because `estimate_similarity`
  returns 0 for them (N6, N6b).

## 3. Pinned matrices (real git 2.55.0 vs tsgit on this branch)

Environment: every `GIT_*` unset, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
isolated `HOME`, signing off, one `mktemp -d` repo per row.
- git column: `git diff --name-status <flags> HEAD~1 HEAD`.
- tsgit column: `diff(ctx, { from:'HEAD~1', to:'HEAD', detectRenames:true, recursive:true,
  renameOptions })` via `createNodeContext`, run from a scratch copy of this branch's `src/`
  (`HEAD 99c7125a`) against the **same** repo. Name-status is rebuilt from the structured
  fields. The runner does not render the `broken` datum (`M100`/`T100`); where that is the
  only difference, the row says so.
- Flag mapping: `-C` → `copies:'on'`, `-C -C` → `'harder'`, `-lN` → `limit:N`,
  `-B` → `breakRewrites:{score:30000, merge:36000}`, `-M90%` → `threshold:54000`.
- Content: `body` = 20 lines `body line i`; `edit k` = `body` with the first k lines
  replaced; `gen p n` = n lines `p line i`.

Probe scripts and runner (`lib.sh`, `run.mts`, `*.sh`) are in the session scratchpad
(`p2/`). The interop suites (§8 Part 7) are the durable copy.

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
Part 7 pins it live.

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
| N7d | `-M -B`: regular→symlink `a/p`; add `b/q` = old regular content | `T100 a/p ; C100 a/p→b/q` | `T ; A b/q` ✗ |
| N7e | N7d with `b/q` = old content + 1 line | `T100 ; C098 a/p→b/q` | `T ; A` ✗ |
| N7f | `-M -B`: symlink→regular `a/p`; deleted `a/old` = new `a/p` content | `R100 a/old→a/p` (the T vanishes) | `D a/old ; T a/p` ✗ |
| N7dn/N7fn | N7d / N7f with `-M` only | `T ; A` / `D ; T` | ✓ |
| N8 | `-C`: regular→symlink type change used as a copy source | `T ; C100 a/p→b/q` | ✓ |
| G1 | `-C`: modified gitlink `a/sub` (X→Y); added gitlink `b/sub2` = X | `M a/sub ; C100 sub→sub2` | `M ; A` ✗ |
| G2 | `-C -C`: unchanged gitlink = X; added gitlink = X | `C100 ; M k` | `A ; M k` ✗ |

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

## 4. Design

### 4.1 Target pipeline (transcribes §2.1)

```
detectSimilarityRenames(ctx, diff, options?, preimage?)
  1 runBreakPass                      streaming scores per modify (§4.2)
  2 registerCandidates                ordered RenameSource[] + destinations          (primitive)
  3 pairIdenticalFiles                copy-aware exact pass                          (domain, §4.5)
  4 cull ─┬─ copies | broken>0 : keep every source
          └─ else              : drop used → basename pass (§4.3) → drop used
  5 limit gate on the leftovers       counts every mode, each source once (§4.6)
  6 hydrate                           size-first, fingerprint-and-drop (§4.2)
  7 buildMatrix                       one top-4 matrix per destination, name_score (§4.3)
  8 selectPairs                       stable sort; rename pass; copy pass            (domain, §4.5)
  9 writeBack + remergeOrKeepBroken   re-merge counts one extra use (§4.5)
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
  - `broken-delete` → 1 when its dissimilarity < mergeScore (git's `score = 0`), else 0;
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
3. Gate threshold: the lowest threshold any later phase will apply,
   `min(threshold, copies ? copyThreshold : threshold)`. The basename pass needs pairs at
   `min_basename_score`, which is ≥ that, so its candidates are a subset of the needed ids.

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
residency bound.

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
`broken.length === 0` and `threshold < MAX_SCORE`:

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
- Only pairs at or above the gate threshold (`min(threshold, copyThreshold)`, §4.2) are
  recorded. This drops git's below-minimum
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
| `-B` break candidates | symlink modifies eligible (gitlinks excluded, as today) | N6, N6b |

† git counts `rename_src_nr` / `rename_dst_nr` over every registered pair. tsgit's
`partitionLeftovers` removes gitlinks before counting today. Part 7 pins a gitlink-count
row.

Consequence for ADR-405: its predicate `isGitlink` becomes `kindOf(mode) !== 'file'` for
**scoring and hydration only**. The exact pass and the counts keep gitlinks. D1 covers the
ADR form.

`-B` type-change breaking (N7b, N7d–N7f) is related but separate. git breaks every
symlink↔regular type change and keeps it as a `T` with a dissimilarity datum. tsgit's
`TypeChangeChange` has no `broken` field, so fixing it changes the public type. That is D5.

### 4.5 Item 4: copy-aware exact pass, two-pass selection, use-count labels (D2, D10)

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

**Selection: `selectPairs(sortedMatrix, uses, { copies, threshold, copyThreshold })`**
(domain, pure):
- Pass 1: skip a paired destination, skip a source with `uses > 0`, stop at the first
  `score < threshold`.
- Pass 2 (copies only): skip a paired destination, stop at `score < copyThreshold`.
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

**Write back.** A delete is emitted iff its source's final `uses` is 0 (a `broken-delete`
follows the existing present-halves logic). This replaces `consumedDeletes`.

**Cull (step 4).** With copies on, or any broken pair, used sources **stay in the matrix**
(git's `remove_unneeded_paths_from_src` returns early). Pass 1 still skips them, but they
occupy top-4 slots. This is a derived consequence (no probe isolates it), and Part 7 pins
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

### 4.7 What does not change

- Public types and options. `RenameDetectOptions`, `RenameChange`, `CopyChange`,
  `ModifyChange.broken` and `detectRenames(diff)` keep their shapes and their `-M`
  behaviour, unless D5(b) is chosen.
- Scores. `estimateSimilarityFromMaps`, `buildChunkMap` and `isSizeRejected` are unchanged.
- ADR-370: the exact pass is never limited. ADR-893's `-M` exact semantics are unchanged.
- blame's single-follow shape (ADR-895).

## 5. Interactions

| Interaction | Rule (git) | Pin |
|---|---|---|
| basename × copies | basename pass off under `-C`; `name_score` still breaks matrix ties | B3c, B1c, B8c |
| basename × `-B` | off only when a pair was actually broken | B3b, B3bb |
| basename × limit | basename pass unlimited; the limit counts the leftovers | B3l, L2 |
| basename × non-regular | counted for uniqueness, never scored | N9, N9d |
| basename × size gate | gated at `min_basename_score`; fingerprints reused by the matrix | §4.2 |
| size gate × copies | gate at `min(threshold, copyThreshold)`; one matrix | §4.2 |
| size gate × limit | limit decides before any matrix blob is read | §4.2 |
| non-regular × exact | same-mode exact pairing stays, copies included | N4s, G1, G2 |
| non-regular × `-B` | symlink modifies break; halves pair exactly only | N6, N6b |
| copies × exact × limit | exact copy pairing unlimited; harder degrade hits the matrix only | C16, C18 |
| copies × rename precedence | pass 1 (deleted sources only) runs over the whole matrix before pass 2 | C19, C20 |
| `-B` × labels | a broken-delete source re-merged is one more user → C | K1, K2 |
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
    `Chunks: primitives` ~168 B. Both are expected to be crossed. D7.

## 8. Implementation parts (pre-chewed context)

Order: Part 1 → 2 → 3 → 4 → 5 → 6 → 7. Each part is TDD, and each commit is green on
`npm run validate`.

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
    `SIZE_GATE_MIN_IDS`.
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

### Part 2: non-regular exclusion (item 3; supersedes ADR-898)

- `partitionLeftovers` (`:347`): stop moving gitlinks to `other`. Keep them in
  adds/deletes for counts and uniqueness, and filter at scoring and hydration with
  `isRegularFile(mode)` = `kindOf(mode) === 'file'` (`src/domain/diff/mode-kind.ts`).
- `buildCopySourcesForOn` (`:60`) / `ForHarder` (`:84`): keep non-regular for exact
  pairing. They are superseded by Part 4's registry, so land the filter there if Part 4
  goes first.
- `attemptBreaks` (`:599`): unchanged filter (gitlinks out, symlinks in). This matches
  §2.6.
- Tests: `test/unit/application/primitives/detect-similarity-renames.test.ts`. The
  gitlink describes (ADR-405 arms, search `isGitlink`/`160000`) get sibling symlink arms:
  N1, N2, N3, N4, N5, N6b, plus "symlink blob never read" via a readBlob spy.

### Part 3: domain pairing module (item 4 exact core)

- New `src/domain/diff/rename-pairing.ts` exports `RenameSource`, `SourceOrigin`,
  `pairIdenticalFiles`, `uniqueBasenamePairs`, `selectPairs`, `labelRenameCopy`, and a
  shared `compareCandidates`.
- `hasSameBasename`, `exactKey`, `EXACT_CANDIDATE_CAP` move here from
  `src/domain/diff/rename-detect.ts` (`:25`, `:44`, `:68`). `detectRenames` (`:110`)
  wraps `pairIdenticalFiles(…, 'rename')`.
- Re-export through `src/domain/diff/index.ts` only what the primitive needs. Nothing new
  goes public (`src/public-types.ts`).
- Tests: new `test/unit/domain/diff/rename-pairing.test.ts`, with rows C1, C3, C9, C14,
  C15, G1 at domain level plus a used-source cap-counting row (copy mode counts used
  sources toward 100). `test/unit/domain/diff/rename-detect.test.ts` stays green,
  untouched.
- Properties: new `rename-pairing.properties.test.ts`; generators extend
  `test/unit/domain/diff/arbitraries.ts` (`arbNonDirMode`, small id/path pools).
  - Lens 4: under `'copy'`, every destination with a same-key source is paired.
  - Lens 4: per `deleted` source with k ≥ 1 pairs, the labels are exactly k−1 copies and
    one rename, and the rename is the last in output order.
  - Lens 4: every `retained` source yields only copies.
  - Lens 2: `uniqueBasenamePairs` never returns a basename that occurs twice on either side.
  - The existing `rename-detect.properties.test.ts` stays (ADR-136).

### Part 4: unified registry, one matrix, two passes, labels (item 4)

- `detect-similarity-renames.ts`:
  - `registerCandidates(workingDiff, broken, copies, preimage, mergeScore)` replaces
    `partitionLeftovers` + `resolveCopySources` (`:699`) + `buildCopySourcesFor*`.
  - `buildMatrix` replaces `buildRenameTriples` (`:206`) and `buildCopyTriples` (`:234`).
  - `ScoredTriple` loses `kind` and gains `nameScore`.
  - `selectPairs` replaces `greedySelect` (`:313`).
  - `assemblePostPass` (`:799`) emits deletes by final use count.
  - `remergeOrKeepBroken` (`:659`) increments the re-merged source's uses.
  - The limit gate at `:849` uses §4.6 counts.
- Existing tests to revisit in `detect-similarity-renames.test.ts`:
  - "copies on with both a rename candidate and a copy candidate" (`:597`) and the kind
    tie-break mutant notes at `:264`/`:266`: the tie-break is gone, and C19/C20 replace
    it;
  - "copies harder with limit exceeded only under harder" (`:755`): the fallback becomes
    `skip_unmodified`, and C18 adds the exact-still-sees-all row;
  - the `recordIfBetter` block (`:1712`, `:3708`) gains nameScore arms.
- New rows: C6, C10, C16, C19, C20, L1, K1, K2.

### Part 5: basename pass (item 2)

- `detect-similarity-renames.ts`: new `runBasenamePass(ctx, sources, dests, uses,
  fingerprints, minBasename)` between exact and limit. Gate it on
  `copies === 'off' && broken.length === 0 && threshold < MAX_SCORE`.
- Tests:
  - rows B1, B2, B3, B3l, B3b, B3bb, B7, B8, B9, B10, L2, N9, N9d;
  - isolated guard tests for each gate condition (copies, broken, MAX_SCORE), per
    CLAUDE.md's "guard clauses need isolated tests";
  - the `minBasename` formula boundary (score = minBasename vs minBasename − 1).
- blame: `test/unit/application/commands/blame.test.ts`, add "Given a rename source
  competing on basename" (BL1).

### Part 6: `-B` rows

Scope per D5. Under the recommendation, K1/K2 land in Part 4 and N6b in Part 2. Nothing
else.

### Part 7: interop pins

Per D8: extend `test/integration/rename-similarity-interop.test.ts` (B-, N-, C-inexact,
K-, L-rows) and `test/integration/rename-exact-interop.test.ts` (C1–C3, C9, C14–C18, G1,
G2, N4s, gitlink-limit-count row). Add BL1 to `test/integration/blame-interop.test.ts`.
Each uses the existing `nameStatusFrom` reconstruction. Add the broken-datum rendering
(`M100`) to the reconstruction, so K1/K2/N6b compare the full line. Rows not fixed under
the chosen D5 scope are not asserted.

## 9. Test strategy (summary)

Every §3 row that changes becomes a RED unit row first (domain rows for pure pairing,
primitive rows for scoring and hydration), then an interop row against live git.
- Guards get isolated tests: basename gates, the size gate, non-regular scoring, copy vs
  rename pass skip rules, cap counting in copy mode.
- The hydration gate is proven by read-count spies, not by output (output is equal by
  construction).
- Coverage 100%. Mutation target 0 survivors. Stryker disables in touched code
  (`:133`, `:192`, `:264`, `:266`, `:409`, `:411`) are re-triaged, because the
  restructure removes most of them.

## 10. Non-goals and follow-ups

- `-B` type-change breaking and a `broken` datum on `TypeChangeChange` (N7b, N7d–N7f),
  unless D5(b) is chosen.
- `GIT_BASENAME_FACTOR` (an env knob of git's CLI; tsgit reads no git env vars here).
- `-M0` / threshold 0: git maps `minimum_score == 0` to the default; tsgit keeps 0.
  Unprobed, noted only.
- Promisor batch prefetch (`inexact_prefetch`, `basename_prefetch`).
- Fingerprint representation. A JS `Map` per blob costs more than git's packed spanhash
  table. The size gate removes the hostile case, but a pool of many large, size-compatible
  blobs still holds `Map`s of roughly blob-proportional size. A typed-array fingerprint
  is a separate change.
- git's stderr rename-limit warning (rendering; ADR-249/370).

## 11. Decision candidates

| # | Choice | Options | Recommendation |
|---|---|---|---|
| D1 | ADR form for item 3 | (a) new ADR that **supersedes ADR-898** and **refines ADR-405**: exclusion widened to every non-regular mode, scoped to scoring/hydration; exact pass, uniqueness and limit counts keep them · (b) amend ADR-405 in place, mark 898 superseded · (c) amend 898 into a decision | **(a)**: 898 stays readable as the deferral it was; 405's gitlink-hydration rationale stays true and is narrowed, not replaced |
| D2 | Where copy-aware exact pairing and R/C labelling live | (a) new pure domain module `rename-pairing.ts`; `detectRenames` becomes its `-M` wrapper; primitive keeps I/O and matrix scoring · (b) primitive-only; domain `detectRenames` stays `-M`-only and the primitive re-implements `find_identical_files` for copies · (c) public `detectRenames(diff, { copies })` | **(a)**: one transcription of `find_identical_files` (no duplicate), byte-free (ADR-366), public surface unchanged; (c) exposes a copy mode without the retained-source inputs it needs |
| D3 | How to bound hydration | (a) size pass always + fingerprint-and-drop · (b) fingerprint-and-drop always + size pass only above `SIZE_GATE_MIN_IDS` unique regular ids (e.g. 2× the default ioBound limit) · (c) fingerprint-and-drop only | **(b)**: residency bounded in every case; hostile case 1.03 s → ~36 ms; the +0.3 to +0.55 ms small-diff cost measured for (a) stays off the hot path. (c) bounds memory but keeps the O(total bytes) CPU (~1 s) |
| D4 | Loose-object size read | (a) header-only route inside `readObjectMetadata` (prefix `readSlice` + streaming inflate to the NUL, full-read fallback), which also benefits `ref-store`'s tag peel · (b) private helper in the rename primitive · (c) keep the full inflate | **(a)**: one size primitive; measured 305 → 122 MB and 118 → 36 ms on the hostile repo vs (c) |
| D5 | Scope of `-B`-adjacent rows | (a) include K1/K2 (fall out of use counts) and N6b (falls out of non-regular exclusion); defer type-change breaking N7b–N7f · (b) include all, adding `broken?: SimilarityScore` to `TypeChangeChange` (public type change) · (c) exclude all `-B` rows | **(a)**: no public type change; the deferred rows need a new structured field and their own matrix |
| D6 | Public API changes | (a) none: `RenameDetectOptions`, change types and `detectRenames(diff)` unchanged; only internal exports (`hydrateAndFingerprint`, `ScoredTriple`, `recordIfBetter`) change · (b) (a) plus `TypeChangeChange.broken` (only with D5(b)) · (c) (a) plus a `basenameFactor` option mirroring `GIT_BASENAME_FACTOR` | **(a)**: every item is reachable through existing options |
| D7 | Bundle-size limits | (a) bump `Browser bundle (no-build)` and the crossed chunk limits to measured + 0.25 kB in the commit that crosses them, justified in the commit · (b) offset by trimming unrelated code in this PR · (c) move rename parity into a separately loaded chunk | **(a)**: the growth is git-mandated behaviour; (b) is unbounded scope, (c) changes the loading model |
| D8 | Where interop pins live | (a) extend `rename-similarity-interop` and `rename-exact-interop`, BL1 in `blame-interop` · (b) new `rename-parity-interop.test.ts` for all four items | **(a)**: rows sit next to the pass they pin; ADR-896's suite already owns exact rows |
| D9 | `copyThreshold` in the single matrix | (a) pass 1 stops at `threshold`, pass 2 at `copyThreshold`, size gate at their minimum (defaults equal git's single `minimum_score`) · (b) deprecate `copyThreshold` and use one threshold like git · (c) separate matrices per threshold | **(a)**: faithful at defaults, no API break; (c) is today's divergent model |
