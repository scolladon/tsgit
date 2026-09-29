# Design: diff core parity hardening (lying loose sizes, xdiff line counts, fingerprint scoring)

> Brief: design round 3 of the `fix/rename-exact-one-shot-delete` PR. The user folded in three
> existing git divergences that the security and performance reviews found:
> 1. **Lying loose size header.** tsgit fully inflates a loose blob whose header claims 6 bytes
>    and whose body is 200 MB. git refuses it in 0.01 s.
> 2. **Huge-file numstat parity.** On 32 MiB text modifies, `withStat` reports 4194304/4194304
>    where `git diff -B --numstat` reports 3871665/3871665.
> 3. **`-M -B` scoring speed.** 300 × 1 MiB random modifies: tsgit 44.7 s / 862 MB against
>    git 11.2 s / 810 MB.
>
> Status: draft. The decision candidates are in §11. Pinning these items against git turned up
> four more divergences that the brief does not list: L4, L5, S1 and S2 in §3. Each one is in
> scope only if the user takes the matching decision candidate.

## 1. Context

### 1.1 The three items today

| # | Symptom (pinned in §3) | Where |
|---|---|---|
| 1 | The loose arm inflates the whole body before it checks the header claim. A blob that claims 6 bytes passes the rename size gate (ADR-902 reads the claim) and is then inflated in full: 20 × 200 MB takes **8.4 s / 579 MB** in tsgit, while git dies in **0.01 s**. On every buffered read route git refuses a body that runs past the claim. tsgit serves it on every route. | `resolveLooseArm` / `tryLoose` (`object-resolver.ts:173`, `:313`), `assertLooseSizeConsistent` (`git-object.ts:38`) |
| 2 | `diffLines` is a minimal Myers diff that gives up at edit distance 10 000 (ADR-563) and emits a whole-file replace. git's xdiff never gives up. It also has two heuristics that tsgit lacks: it discards multi-match lines (`xdl_cleanup_records`) and it slides change groups (`xdl_change_compact` plus the indent heuristic). As a result tsgit's numstat and patch differ from git's on inputs as small as 12 lines (L4) and 13 lines (L5). | `computeMyersTrace` / `diffPresplitLinesWithBound` (`line-diff.ts:124`, `:383`) |
| 3 | Fingerprints are `Map<number, number>` and scoring does one `Map.get` per source bucket. git keeps a sorted `spanhash` array and merge-scans two of them. Reading `hash_chars` also turned up two output bugs in `buildChunkMap`: S1 (the bucket hash does not wrap to uint32) and S2 (the CR of a CRLF pair is not skipped). | `similarity.ts` (`buildChunkMap`, `countSrcCopied`, `estimateSimilarityFromMaps`), `detect-similarity-renames.ts:79` (`BlobFingerprint`) |

### 1.2 Constraining decisions

| ADR | Constraint |
|---|---|
| 226 | Match git's data and on-disk state byte for byte. Pin every change with a cross-tool interop test. |
| 249 | Structured output. numstat and patch text are rebuilt inside the tests. |
| 366 / 900 | The scorer, the pairing and the line diff are pure domain code with no I/O. |
| **563** | **`MAX_DIFF_EDIT_DISTANCE = 10 000` is a live bail with a whole-file fallback.** The user ratified it. Item 2 cannot match git while it stands, so replacing it is decision candidate H3, not a silent change. |
| 558 | The line-count caps were retired in favour of the digest fold. It is not affected here. |
| **863** | **A size-lying loose blob serves its real bytes on every tsgit read. Commit, tree and tag refuse.** Item 1 revisits the blob half, so this is decision candidate H1. |
| 854 | The `ctx.deltaCache` value stays `{ type, content }`. |
| 901 / 902 | Hydration fingerprints each blob and drops it. The size gate reads the loose header only, so it trusts the claim. That is the gap item 1 exploits. |
| 904 | A crossed bundle limit rises to the measured size + 0.25 kB, **for git-mandated growth**. |
| 134–136 | Parsers, decoders, matchers and serializers get a `*.properties.test.ts` sibling. |

## 2. git 2.55.0, read from source

Sources: `object-file.c`, `odb/source-loose.c`, `odb/streaming.c`, `builtin/cat-file.c`,
`xdiff/xprepare.c`, `xdiff/xdiffi.c`, `xdiff/xutils.c`, `diffcore-delta.c`, `builtin/blame.c`,
`xdiff/xmerge.c`, all at tag `v2.55.0`. The notes below paraphrase the code.

### 2.1 Loose reads have three tiers

- **Header tier** (`cat-file -s`, `--batch-check`, `ls-tree -l`) prints the claim.
- **Streaming tier** (`odb_stream_blob_to_fd`) inflates to `Z_STREAM_END` and ignores the claim.
  `cat-file -p`, `cat-file blob`, `--batch`, `show <blob>` and checkout write blobs this way.
- **Buffered tier** (`unpack_loose_rest`, `object-file.c:202`) serves everything else: diff, rename
  and break scoring, archive, blame, grep, fsck, and every commit, tree or tag parse.
  1. `unpack_loose_header` inflates into `char hdr[32]` (`MAX_HEADER_LEN`).
  2. `unpack_loose_rest` allocates `xmallocz(size)` from the claim and copies in
     `min(total_out − headerLen, size)` body bytes.
  3. It sets `avail_out = size − bytes` and inflates with `Z_FINISH`.
  4. If the stream has not ended when the claim is used up, the result is
     `corrupt loose object '<oid>'`. **git never inflates more than `max(32, headerLen + claim)`
     output bytes.**
  5. If the whole object fits in the 32-byte header window, the stream has already ended, so
     the body is **silently truncated** to the claim.
  6. If the body is shorter than the claim, the buffer is zero-padded.
- **fsck** (`read_loose_object`, `object-file.c:1618`) takes the buffered tier. It then re-hashes
  the buffer at its claimed size, so every size liar fails as either `corrupt loose object` or
  `hash-path mismatch`. Only blobs larger than `core.bigFileThreshold` go through
  `check_stream_oid`.

### 2.2 xdiff's Myers pipeline (`xdl_do_diff`, `xdiffi.c:314`)

git's default diff, blame and merge (`xmerge.c:695–707`) all run this pipeline. `--minimal` sets
`XDF_NEED_MINIMAL`. blame inherits `XDF_INDENT_HEURISTIC` from the diff configuration
(`builtin/blame.c:1036`), and `diff.indentHeuristic` defaults to on (`diff.c:57`).

1. **Classify** (`xdl_prepare_ctx`, `xdl_classify_record`): each line gets an id that is equal
   exactly when the line bytes are equal. The whitespace flags control the comparison through
   `xdl_recmatch`. The hash only picks a bucket, so a collision never merges two lines.
2. **`xdl_trim_ends`** drops the common prefix and suffix.
3. **`xdl_cleanup_records`** runs unless `need_min`:
   - `mlim = min(xdl_bogosqrt(nrec), XDL_MAX_EQLIMIT = 1024)`, where
     `bogosqrt(n)` is: `for (i = 1; n > 0; n >>= 2) i <<= 1`.
   - A line with no match on the other side is `DISCARD`. A line with fewer than `mlim` matches
     is `KEEP`. Anything else is `INVESTIGATE`.
   - An `INVESTIGATE` line is discarded when `xdl_clean_mmatch` sees it sitting in a run of
     discards:
     - scan at most `XDL_SIMSCAN_WINDOW = 100` lines on each side;
     - both sides must hold at least one `DISCARD`;
     - the line goes when `rpdis * XDL_KPDIS_RUN(4) < rpdis + rdis`.
   - Discarded lines are marked changed. Only the kept lines take part in the Myers search.
4. **`xdl_recs_cmp` / `xdl_split`** is a linear-space, divide-and-conquer bidirectional Myers.
   Unless `need_min`, it has two cut-offs:
   - **Snake heuristic.** Once `ec > XDL_HEUR_MIN_COST (256)` and a snake longer than
     `XDL_SNAKE_CNT (20)` has been seen, it splits at the best diagonal with
     `v > XDL_K_HEUR(4) * ec`.
   - **Cost cap.** At `ec >= mxcost`, with `mxcost = max(bogosqrt(ndiags), 256)`, it takes the
     furthest-reaching forward or backward diagonal.

   Either cut-off returns a **valid but non-minimal** script. It never degrades to a whole-file
   replace.
5. **`xdl_change_compact`** (`:793`) runs once per side:
   - slide every change group up as far as it goes, then down, merging with neighbouring groups;
   - if the group can end next to a change in the other file, align it there;
   - otherwise, with `XDF_INDENT_HEURISTIC`, score every shift in
     `[max(earliest_end, end − groupsize − 1, end − 100), end]` using `measure_split` and
     `score_add_split`, and keep the lowest score, preferring the later shift on a tie
     (`score_cmp <= 0`). The constants are `MAX_INDENT 200`, `MAX_BLANKS 20` and the eleven
     penalty weights at `:534–571`.
6. Build the script and emit it. numstat (`builtin_diffstat`) and the patch come from the same
   script, which makes numstat independent of step 5.

### 2.3 `diffcore-delta.c` (`hash_chars`, `diffcore_count_changes`)

- Chunks end at an LF or after 64 bytes.
- **`if (is_text && c == '\r' && sz && *buf == '\n') continue;`**: in a text blob
  (`!diff_filespec_is_binary`) the CR of a CRLF pair is neither hashed nor counted.
- The accumulators are `unsigned int`. The bucket is
  **`hashval = (accum1 + accum2 * 0x61) % HASHBASE`, computed in uint32**, so the sum wraps
  mod 2^32 before the modulo is taken.
- Buckets live in an open-addressing `spanhash_top` of at most 2^18 slots, `QSORT`ed by
  `hashval` once.
- `diffcore_count_changes` merge-scans the two sorted arrays: `sc += min(src_cnt, dst_cnt)`, and
  `la` collects the destination excess.
- `estimate_similarity` passes the cached `cnt_data` of both sides. `should_break`
  (`diffcore-break.c`) passes `NULL`, so it re-hashes.

## 3. Pinned matrices (git 2.55.0 against tsgit `HEAD ce68b824`)

**Environment.**
- Every `GIT_*` variable is unset. `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME`
  is isolated, signing is off, and each repo is its own `mktemp -d` throwaway.
- The git column comes from `git <cmd> --no-ext-diff`.
- The tsgit column comes from a scratch copy of `src/` (`git archive HEAD src`), bundled with
  esbuild and driven through `openRepository`.
- Probe scripts are in the session scratchpad (`r3.*/`: `make-lying-blob.py`, `probe-lie.sh`,
  `loose-route-probe.ts`, `hunks.ts`, `search.py`, `score-probe.ts`, `hash-compare.mjs`, `fingerprint-bench.ts`). The
  interop rows that each §8 part lands are the durable copy.

### 3.1 Item 1: size-lying loose blob

**Repo shape.** `make-lying-blob.py <repo> <claim> <bodyLen>` writes a loose blob `f` whose stored bytes
are `blob <claim>\0` + `<bodyLen>` digits. The oid is the SHA-1 of those stored bytes, so the
file sits at its **own** hash. `HEAD~1` holds `f`; `HEAD` replaces it with `other\n`.

- **Overrun:** claim < body.
- **Under-run:** claim > body.
- **Window:** `headerLen + body ≤ 32`.

| Row | Route (git command → tsgit call) | A1 overrun, window (6/10, 6/25) | A2 overrun (6/26, 6/40, 6/1 MiB) | A3 under-run (20/10, 2 MiB/1 MiB) | tsgit today (every column) |
|---|---|---|---|---|---|
| A-s | `cat-file -s`, `--batch-check`, `ls-tree -l` → `catFile` `size` | claim | claim | claim | claim ✓ |
| A-p | `cat-file -p` / `blob` / `--batch` body → `catFile` content | real bytes | real bytes | real bytes | real bytes ✓ |
| A-show | `show <blob>`, `show HEAD~1:f` → `show` | real bytes | real bytes | real bytes | real bytes ✓ |
| A-co | `checkout HEAD~1 -- f` → `checkout { paths, source }` | real bytes | real bytes | real bytes | real bytes ✓ |
| A-diff | `diff`, `diff --numstat` → `diff { withStat }` | **truncated to claim** (numstat `1 1`) | **exit 128 `corrupt loose object '<oid>'`** | zero-padded (20/10: `- -` binary; 2 MiB: `1 1`) | real bytes ✗ (A1, A2) |
| A-M | `diff -M` / `-B` / `-M -B` → `diff { detectRenames, breakRewrites }` | truncated | **exit 128 corrupt** | zero-padded | real bytes ✗. 20 × 200 MB: **8.4 s / 579 MB** against git **0.01 s** |
| A-ar | `archive`, `grep`, `blame` → `archive`, `grep`, `blame` | truncated | **exit 128 corrupt** | zero-padded | real bytes ✗ (A1, A2) |
| A-fsck | `fsck` → `fsck()` | exit 3 `hash-path mismatch` | exit 3 `corrupt loose object` | exit 3 `hash-path mismatch` | exit 0, no finding ✗ |
| A-vh | none → `readObject/readBlob/streamBlob { verifyHash }` | n/a | n/a | n/a | passes: the stored bytes hash to the path |

The boundary is pinned (claim 6, header `blob 6\0` = 7 bytes):

| Body | `diff --numstat` |
|---|---|
| 24 | `1 1` |
| 25 | `1 1` |
| 26 | `corrupt loose object` |

A1 therefore covers exactly `headerLen + body ≤ 32`.

**ADR-863's rationale, restated.** ADR-863 chose to serve the real bytes on every tsgit read for
two reasons. The first was to remove tsgit's own `streamBlob`/`readObject` disagreement. The
second was that transcribing git's buffered tier means *allocating from the claim*, and the
claim is attacker-chosen: a 12-byte blob claiming 100 MB made `git repack` write a 100 MB
object. That argument holds for the **under-run** (zero-pad) branch only.

For an **overrun**, git's buffered tier allocates `min(claim, …)` and stops inflating at the
claim. Serving the real bytes is what lets an attacker force an **unbounded** inflate
(200 MB behind a 6-byte claim). So ADR-863's choice creates the amplification that item 1
reports. Its threat model argues for the opposite choice on the overrun branch.

### 3.2 Item 2: line counts and hunks

`git diff --no-index --numstat a b`, the same command with `--minimal`, and tsgit's
`diffLines(a, b)`, where tsgit's added/deleted counts sum the `theirs-only` / `ours-only` hunks.
Patch rows compare git's hunk body with `computeHunks(a, b, 3)`.

| Row | Input | git | git `--minimal` | tsgit | Cause |
|---|---|---|---|---|---|
| L1 | brief: 4 × 32 MiB text rewrites (`gen.py`, text-modify kind, `BYTES=33554432`) under `-B --numstat` | **3871665 / 3871665** per file, 2.8 s | n/a | **4194304 / 4194304** (degraded), 11.8 s, 1.8 GB peak RSS | cap |
| L2 | smallest cap hit: 5001 unique lines + `common` on each side | 5001 / 5001 | 5001 / 5001 | **5002 / 5002** degraded | cap: d = 10 002 > 10 000 |
| L2' | smallest cap hit in lines: 10 001 unique + `common` against `common` | 0 / 10001 | same | **1 / 10002** degraded | cap: d = 10 001 |
| L2'' | 5000 + `common` each side (d = 10 000) | 5000 / 5000 | same | 5000 / 5000 ✓ | at the cap, no bail |
| L3 | `mt{n}`: `j*7` against `j*13+1`, n = 500…4000 / 8000 / 16000 / 65536 | 461…3692 / 7384 / 14769 / 60494 | equal to git | ✓ up to 4000, then **n / n** degraded | cap |
| **L4** | **smallest non-minimal row:** `a` = `f`×4; `b` = `u1 u2 u3 u4 f u5 u6 u7` | **8 / 4** | 7 / 3 | **7 / 3** | `xdl_cleanup_records`: in `b`, `f` has 4 matches ≥ `mlim = bogosqrt(8) = 4`, so it is `INVESTIGATE`. With 7 discards around it, `2·4 < 2 + 7`, so it is discarded. With 3 `f`s (below `mlim`) or 6 discards, git is minimal again. |
| L4' | random mixes (`search.py`, seeds 1, 2, 3, 5, 6, 7, 10; 300–6000 lines) | e.g. 752, 2757, 3296 | 748, 2735, 3259 | equals `--minimal` | cleanup and split heuristics |
| **L5** | **smallest patch row:** `a` = `a b c d e`, `b` = `a b c X d c d e` | `+X +d +c` then context `d` | same | `+X`, context `d`, `+c +d` | `xdl_change_compact`: the `{c,d}` group slides up and merges with `{X}` |
| L5' | inserted C function block (`int b() {…}` between `a()` and `c()`) | hunk body equal | n/a | ✓ body. The `@@` func-name suffix is display text (ADR-249) | none |

**Root cause of L1.** tsgit's `computeMyersTrace` stops at `d > MAX_DIFF_EDIT_DISTANCE`
(ADR-563) and returns `wholeFileFallback`, so every line counts as changed. git never stops.
Its `xdl_split` cost cap (`mxcost = max(bogosqrt(ndiags), 256)`) and snake heuristic turn an
expensive search into a valid but non-minimal split, found in linear space. On these inputs
git's non-minimal script still keeps 322 639 lines per file in common, and the whole-file
fallback drops all of them.

Below the cap there are two more independent causes. L4: tsgit has no `xdl_cleanup_records`,
so its counts are *lower* than git's. L5: tsgit has no `xdl_change_compact` or indent
heuristic, so its hunk placement differs while the counts stay equal.

**Match git on every row: transcribe all three xdiff stages.** Lifting the cap alone fixes L1
to L3. It leaves L4 and L5 wrong, and L4 is a numstat row.

### 3.3 Item 3: fingerprint scoring

| Row | Input | git | tsgit | Cause |
|---|---|---|---|---|
| S0 | brief: 300 × 1 MiB random modifies, `-M -B` (defaults `30000/36000`) | 247 × `M086`, 53 × `M087`; **11.2 s**, 810 MB max RSS | 300 modify (broken datum not rendered); **44.7 s**, 862 MB peak RSS | Map lookups; see §7 |
| **S1** | 12 binary pairs (4 KiB / 64 KiB / 256 KiB random, 45–55 % shared prefix) at an exact threshold: `-M47250` (raw 28350) on `o1→n1` | **`R047 o1→n1`** (raw ≥ 28350, recomputed 28435) | **`D o1` + `A n1`** (raw 28318) | `(accum1 + Math.imul(accum2, 0x61)) % HASHBASE`: `Math.imul` is signed and the `+` does not wrap. Six of the 12 pairs score differently. With `-M49950` (raw 29970), git pairs `o2→n2` (29993) and tsgit does not (29769). Around the default 30000 this flips pairings on binary files. |
| **S2** | `old.txt` = 20 CRLF lines; `new.txt` = the same with 6 lines edited; `-M` | **`R065`** | **`R071`** (42666) | CR not skipped in text blobs (§2.3) |

Percent output alone does not show S1 (`R044…R055` agree for all 12 pairs). Raw-threshold
probes are needed: `-M<digits>` is a decimal fraction of `MAX_SCORE`.

## 4. Design

### 4.1 Item 1: git's buffered tier with bounded inflate (H1 (a), H2 (a))

The loose arm takes one of two **read modes**, named by a string union rather than a boolean:
`LooseReadMode = 'buffered' | 'streamed'`.

- **`'buffered'`** is the default. It is used by `readObject`, `readBlob`, `readObjectMetadata`'s
  full-read fallback, diff, stat, rename and break hydration, archive, blame, grep and merge. It
  transcribes `unpack_loose_header` + `unpack_loose_rest` with no claim-sized allocation beyond
  the body.

  ```
  head = inflateHead(compressed, LOOSE_HEADER_WINDOW + 1)      // 33 bytes, git's hdr[32] + 1
  { type, claim, headerLen } = parseHeader(head)                   // today's refusals unchanged
  if head.length <= LOOSE_HEADER_WINDOW:                        // stream ended inside git's window
      body = head[headerLen:]
  else:
      body = inflate(compressed, headerLen + claim)[headerLen:]       // cap fires ⇒ overrun
               on cap-exceeded → refuse INVALID_OBJECT_HEADER "content exceeds declared size <claim>"
  classify(type, claim, body):
      equal                         → honest; cache as today
      blob, body > claim (window)   → truncate to claim (git A1); do not cache
      blob, body < claim            → serve body (ADR-863 residual: git zero-pads); do not cache
      commit/tree/tag, any mismatch → refuse (unchanged)
  ```

- **`'streamed'`** is today's behaviour: a full inflate under the compressor cap and `maxBytes`.
  It is used by git's streaming-tier routes: `catFileBatch` content (A-p), `show`'s blob target
  (A-show), and `streamBlob`, which checkout already uses through `apply-changeset`.
  `streamBlob` has its own loose path (`openBlobSource`) and does not change.

**Port.** `Compressor` gains two things. Both follow `streamInflate`'s existing contract: a caller
can narrow the cap but never widen it, and a cap hit is `DECOMPRESS_FAILED` with
`INFLATE_CAP_EXCEEDED_REASON`.
- `inflate(data, maxOutputBytes?)`: the optional cap on the one-shot inflate. Node already
  passes `maxOutputLength` to `inflateSync`. Memory and browser already call
  `inflateZlibMember(…, cap)`.
- `inflateHead(data, maxOutputBytes): Promise<Uint8Array>`: returns at most `maxOutputBytes`
  bytes and **does not throw at the cap**. It truncates, and it throws only on corrupt input.
  - Node: `inflateSync(data.subarray(0, n), { finishFlush: Z_SYNC_FLUSH })`, with the input
    prefix growing ×4 from 32 until either the output reaches the cap or the input runs out.
  - Memory and browser: an early-stop flag on `inflateZlibMember`.

**Cost (§7).** Node pays about +1.3 µs per loose read, the fixed cost of a second sync zlib
call. A 200 MB overrun is refused in **0.77 ms instead of 31 ms** of inflate per blob, and with
no 200 MB buffer.

**Consequences.**
- Rows A-diff, A-M and A-ar match git for A1 and A2.
- A-s, A-p, A-show and A-co keep matching.
- A3 keeps ADR-863's recorded residual.
- A-fsck stays divergent (follow-up F1, §10).
- ADR-863 is **superseded in part**: its blob-serving list shrinks to the streaming tier. Its
  DC-A2 (`catFile` reports the claim), its commit, tree and tag refusal, and its no-claim-sized
  allocation invariant all stay.

### 4.2 Item 2: transcribe xdiff's Myers pipeline (H3 (a), H4 (a))

A new pure domain module, `src/domain/diff/xdiff/`, in kebab-case files. It has no outward
imports.

| File | Transcribes | Output |
|---|---|---|
| `xdl-classify.ts` | `xdl_prepare_ctx` / `xdl_classify_record` / `xdl_hash_record` | `Int32Array` class ids for both sides. Equality is exact bytes, or the interned `lineKey` when a whitespace mode is on, which reuses `whitespace.ts` `normalizeLine`. Collisions are resolved by byte comparison, never by the hash alone. |
| `xdl-prepare.ts` | `xdl_trim_ends`, `xdl_cleanup_records`, `xdl_clean_mmatch`, `xdl_bogosqrt` | `changed: Uint8Array` per side, pre-marked with the discards, plus `referenceIndex: Int32Array` for the kept lines |
| `xdl-split.ts` | `xdl_recs_cmp`, `xdl_split` (heuristic + cost cap), `xdl_do_diff` setup (`ndiags`, `mxcost`, `snake_cnt`, `heur_min`) | fills `changed`. Its `kvdf`/`kvdb` buffers are one `Int32Array(2·ndiags + 2)`, which makes memory **O(M + N)** |
| `xdl-compact.ts` | `group_*`, `xdl_change_compact`, `measure_split`, `score_add_split`, `score_cmp`, `get_indent` and the constants | slides `changed` in place, one side at a time, against the other side's groups |
| `index.ts` | `xdl_build_script` to `LineHunk[]` | same `LineDiff` shape as today |

`diffPresplitLinesWithBound`'s Myers core is replaced. `diffLines`, `diffPresplitLines` and
`LineDiff` keep their signatures. `degraded` stays on the public type and is always `false`. Its
one consumer branch, `three-way-content.ts:79`, becomes dead and is deleted (no dead code).

`MAX_DIFF_EDIT_DISTANCE` stays exported with a `DEPRECATED, no consumer, NOT a bound` comment,
like its three siblings, so `reports/api.json` does not move on its account. `diffLinesWithBound`
and `diffPresplitLinesWithBound` (test-only seams for the cap) are deleted along with their tests.

**Minimal mode.** `need_min` is `false` on every production route, as in git's default. The
flag stays inside the module (`XdiffFlags`), so the property oracle can run with `need_min`
and compare against the minimal edit distance.

**Worst case replaces ADR-563's bound.** Memory is linear: class ids plus `changed` plus
`kvd`, about 17 bytes per line per side. CPU is bounded by `mxcost` per split, just as in git.
L1 (4.2 M lines per side) is the calibration row: its target is ≤ 3× git's wall time, with RSS
below today's 1.8 GB. Part B2 measures it. A fully different pair stops being a "whole-file
replace at d = 10 000" and becomes git's trimmed and discarded fast path: cleanup marks every
line changed, and `xdl_recs_cmp` returns on `off1 == lim1`.

### 4.3 Item 3: faithful hash, typed fingerprints, merge scan (H5 (a), H6 (a))

1. **Hash (S1).** `hashval = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE`, applied at
   both sites in `buildChunkMap`.
2. **CRLF (S2).** `buildChunkMap(data, isText)`: when `isText && c === 0x0d && next === 0x0a`,
   skip the byte (no accumulate, no `n++`). `isText` is `!isBinary(content)` (`line-diff.ts:76`),
   the same 8000-byte NUL window as git's `buffer_is_binary`. It is computed where the bytes are
   hydrated, in `hydrateFingerprints` and `computeBreakScores`. A caller-supplied type, not a
   boolean argument, carries it: `FingerprintInput = { bytes, text: boolean }`.
3. **Representation.**

   ```ts
   export interface SpanFingerprint {
     readonly hashes: Uint32Array; // ascending, distinct, each < HASHBASE
     readonly counts: Uint32Array; // counts[i] = bytes hashed into hashes[i]
   }
   ```

   `BlobFingerprint` becomes `{ fingerprint: SpanFingerprint; size }`.
4. **Build (H6 (a)).**
   - Below `HASHBASE` bytes: pack each chunk as `bucket * 128 + n` (bucket < 2^17 and
     n ≤ 64 < 2^7, so it fits in 24 bits) into a `Uint32Array(chunks)`, native-`sort()` it, then
     run-length fold it into `hashes`/`counts`.
   - At or above `HASHBASE` bytes: a dense `Uint32Array(HASHBASE)` accumulator plus a touched
     list, then sort the touched list.

   Both paths give identical output, pinned by a property. Transient memory is ≤ 4 × size below
   the switch and a fixed 2 × 431 kB above it.
5. **Scan.** `countCopied(src, dst)` is a two-pointer merge summing `min(counts)`. It is
   `diffcore_count_changes` without the `la` accumulator, which callers derive as
   `dstSize − srcCopied`. `estimateSimilarityFromMaps` becomes
   `estimateSimilarityFromFingerprints`, with the same guards.
6. **Break pass reuse.** `computeBreakScores` today builds two maps and throws them away.
   `runBreakPass` now fingerprints each modify's halves once and seeds `hydrateFingerprints`'
   `known` map with them, so a broken half is never re-read or re-hashed for the rename matrix.
   The output is identical: git re-hashes, but the hash is a pure function of the bytes.
7. `buildChunkMap` / `estimateSimilarityFromMaps` are not public (`domain/diff/index.ts:70-77`
   re-exports only `estimateSimilarity`, the constants and `toSimilarityPercent`). They are
   renamed with no API change. `estimateSimilarity` keeps its signature and delegates.

## 5. Interactions

- **Items 1 and 3.** Rename and break hydration call `readBlob`, so they take the `'buffered'`
  mode. A size liar is refused before it is fingerprinted, and the refusal propagates out of
  `diff` the way git's `fatal: unable to read` does. There is no silent drop, matching git's
  exit 128.
- **Items 2 and 3.** These are independent. Item 3 scores bytes with spanhash. Item 2 only
  affects line counts and hunks.
- **Item 2 and merge / blame / range-diff / patch-id.** Every `diffLines` consumer moves to git's
  engine. Three-way merge: `xmerge.c` runs `xdl_do_diff` + `xdl_change_compact` on both sides,
  so conflict regions move toward git's. Blame: `diff_hunks` is xdiff with the indent heuristic
  inherited. **Neither is pinned in §3**, because the probes covered diff only. Part B1 and Part
  B2 each add one merge row and one blame row on the L4/L5 inputs before they claim parity (§9).
- **Item 2 and whitespace modes.** Classification folds the `lineKey`. `ignoreBlankLines`'
  `suppressBlankGroups` keeps running on the script, as git's `xdl_mark_ignorable_lines` does
  after compaction.

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Loose object ≤ 32 bytes in total | One `inflateHead` call and no second inflate: faster than today |
| Honest loose object | `inflate(…, headerLen + claim)` never hits the cap and the bytes are unchanged |
| Header with no NUL in 33 bytes | `parseHeader`'s existing refusal. git: `header … too long, exceeds 32 bytes` |
| Overrun blob through `catFile` | Real bytes and the claim size (A-p). Unchanged |
| `readObject { verifyHash }` on an honest blob | Unchanged. On an overrun blob it now refuses before hashing |
| xdiff on an empty side, or both sides empty | `xdl_trim_ends` / `recs_cmp` early exits. The `M === 0 && N === 0` guard stays |
| Lines longer than 64 KiB | No cap (ADR-558). Classification hashes them in full |
| CR alone, or CR at end of buffer | git's `sz && *buf == '\n'` guard: a lone CR or a trailing CR is hashed |
| Blob with NUL in the first 8000 bytes | Binary: CRs kept, as in git |
| 32-bit count overflow in `counts` | Impossible: a blob is capped at 2 GiB by the compressor |

## 7. Performance, memory, bundle

**Item 1** (`inflate-bench*.mjs`, node 22.22, 20 000 objects):

| Object body | One-shot | Head probe + capped |
|---|---|---|
| 20 B | 1.2 µs | 2.4 µs |
| 2 KB | 1.5 µs | 3.0 µs |
| 64 KB | 14–19 µs | 16–17 µs (probe alone 1.4–2.6 µs) |

The rejected no-port alternative, a streaming header probe through `createInflateStream`,
costs **55 µs** per object against 2 µs (H2 (b)). Loose-read benches gate the change:
`loose-read.bench.ts`, `cat-file.bench.ts` and `diff-renames` `common`.

**Item 3** (`fingerprint-bench.ts`, 1 MiB blobs; the typed output is identical to the fixed-hash `Map`
oracle):

| Shape | Build per 200 blobs (today's `buildChunkMap` → typed) | Fingerprint memory | Matrix (K×K pairs) |
|---|---|---|---|
| K = 300 random | 0.65 s → 0.56 s (dense) / 0.46 s (packed) | **551 → 82 MB** | **46.4 s → 12.1 s** |
| K = 100 text | 2.43 s → 1.15 s (dense) / 1.34 s (packed) | **734 → 120 MB** | **19.7 s → 3.0 s** |
| 5000 × 1 KB | 50 → 17 ms (packed) / 45 ms (dense) | n/a | n/a |

The matrix and memory columns compare against a `Map` oracle with the S1 fix applied, which
has today's shape and cost.

The expected S0 total is about 15 s against git's 11 s, down from 44.7 s. The target is ≤ 1.5×
git.

**Bundle.**
- Item 1 adds `inflateHead` to three adapters plus the early-stop flag in `inflateZlibMember`
  (browser bundle).
- Item 2 adds about 450 lines of transcribed C to `line-diff`'s module graph (every bundle that
  holds `diff`, `merge` or `blame`).
- Item 3 replaces the `Map` code with typed code of similar size.

The browser bundle has about 0.2 kB of headroom. Items 1 and 2 are git-mandated, so ADR-904's
bump rule applies in the crossing commit. Item 3's hash and CRLF fixes are git-mandated. Its
typed rewrite is **not** git-mandated, which is decision candidate H7. Every part runs
`npm run size` and records the measured figure in the commit.

**Bench plan (item 3).**
- New shape `rewrite` in `test/bench/support/fixture-generator.ts` (`RenameFixtureShape`): 100
  paths × 256 KiB random bytes, rewritten in full in `HEAD`, loose and packed.
- New scenario in `test/bench/diff-renames.bench.ts`: `breakRewrites: { score: 30000,
  merge: 36000 }, detectRenames: true`, given as "Given a rewrite repo (100 × 256 KiB files
  rewritten in full)".
- The shape lands in its own `chore(bench)` commit **before** C3, so that
  `npm run bench:ab -- <C0 sha> <C3 sha>` compares two committed refs that both carry it.
- `npm run bench:memory` is recorded for `rewrite` before and after.

## 8. Implementation parts (pre-chewed context)

Every commit is green on `npm run validate` (knip dead-code check, typedoc, size-limit). Each
part lands its RED unit row, then its interop row, in the same commit. **No §3 row that is ✓
today may turn ✗.**

| Constraint | Forces |
|---|---|
| The port must exist before the resolver uses it | A1 < A2 |
| Compaction over today's Myers output fixes L5 without touching counts. Switching the engine without compaction would move today's ✓ patch rows | B1 (compact) < B2 (engine) |
| Fix the hash and CRLF before the typed rewrite, so the oracle is the faithful Map | C1 < C2 < C3 |
| The bench shape must be in the base ref of `bench:ab` | C0 < C3 |

### Part A1: `Compressor.inflateHead` and the capped `inflate` (H2)

Commit: `feat(ports): bound one-shot inflate and add a truncating head inflate`.
- `src/ports/compressor.ts:24`: `inflate: (data: Uint8Array, maxOutputBytes?: number) =>
  Promise<Uint8Array>`. Add `inflateHead: (data: Uint8Array, maxOutputBytes: number) =>
  Promise<Uint8Array>`, documented like `streamInflate`'s cap paragraph (`:32-40`).
- `src/adapters/node/node-compressor.ts:184` (`inflate`): `maxOutputLength:
  this.effectiveCap(maxOutputBytes)` (`:129`). Map `ERR_BUFFER_TOO_LARGE` to
  `decompressFailed(INFLATE_CAP_EXCEEDED_REASON)`. `inflateHead`: `inflateSync(prefix,
  { finishFlush: constants.Z_SYNC_FLUSH })` with the growing-prefix loop, a named constant
  `HEAD_PROBE_INPUT_BYTES = 32`, and `.subarray(0, max)`.
- `src/adapters/inflate.ts:888` (`inflateZlibMember`): add a `stopAtCap` mode through an options
  object, not a boolean. `src/adapters/memory/memory-compressor.ts:34` and
  `src/adapters/browser/browser-compressor.ts:37` implement both members.
- Tests:
  - `test/unit/adapters/{node,memory,browser}/*compressor*.test.ts`: cap hit →
    `DECOMPRESS_FAILED` with the cap reason, asserted on the data; head on a short stream → the
    full output; head on a long stream → exactly `max` bytes.
  - `test/unit/adapters/inflate.test.ts` / `inflate.properties.test.ts`: property:
    `inflateHead(d, k)` equals `inflate(d).subarray(0, k)`.
  - `test/bench/node-compressor.bench.ts`: add the head case.

### Part A2: the loose arm transcribes git's buffered tier (H1)

Commit: `fix(objects)!: refuse loose blobs whose body overruns the header claim like git's buffered read`.
- `src/domain/objects/git-object.ts`:
  - `LOOSE_HEADER_WINDOW = 32` (git's `MAX_HEADER_LEN`).
  - `classifyLooseBody(split): 'honest' | 'truncate' | 'underrun'`, pure. It replaces
    `assertLooseSizeConsistent` (`:38`) for the loose arm, and the commit/tree/tag refusal stays
    `sizeMismatch` (`:21`).
  - `contentExceedsClaim(claim)` error: `INVALID_OBJECT_HEADER`, reason
    `content exceeds declared size <claim>`.
- `src/application/primitives/object-resolver.ts`:
  - `tryLoose` (`:313`) and `resolveLooseArm` (`:173`) take `mode: LooseReadMode`. `'buffered'`
    runs §4.1. `'streamed'` is today's `ctx.compressor.inflate(compressed)`.
  - `enforceLooseCap` (`:264`) still measures the bytes actually produced.
  - Cache only `'honest'` (`:187`).
  - Thread `mode` through `resolveObjectContentWithDepth` (`:83`) and
    `resolveObjectWithSize` (`:245`), defaulting to `'buffered'`.
- `src/application/primitives/cat-file-batch.ts:44` (`readObjectWithSize`) and
  `src/application/commands/show.ts:125`, `:163` (blob targets only): pass `'streamed'` through an
  internal read option, never a public one.
- `src/application/primitives/read-object.ts:217-244`: default `'buffered'`. The public options
  do not change.
- Tests:
  - `test/unit/domain/objects/git-object.test.ts`: `classifyLooseBody` rows at 24 / 25 / 26 body
    bytes, plus under-run and commit.
  - `test/unit/application/primitives/object-resolver.test.ts`: overrun refuses **without**
    inflating past the cap, asserted through a spy compressor's `inflate` `maxOutputBytes`
    argument; window truncation; `'streamed'` serves.
  - **Interop:** extend `test/integration/loose-header-size-interop.test.ts` with rows A-diff,
    A-M and A-ar for A1 and A2 against `git diff --numstat`, `git diff -M --name-status` and
    `git archive` (exit code and stderr `corrupt loose object '<oid>'` against tsgit's
    `INVALID_OBJECT_HEADER`). Its existing A-p, A-co and A-s rows stay green unchanged.
- Docs: the errors page row for `INVALID_OBJECT_HEADER`, and `docs/use/primitives/read-object.md`
  (overrun refuses; `catFile`/`streamBlob` serve).
- ADR: supersede ADR-863 in part (H1).

### Part B1: `xdl_change_compact` and the indent heuristic over the current script (H4)

Commit: `fix(diff): slide change groups like git's xdl_change_compact with the indent heuristic`.
- New `src/domain/diff/xdiff/xdl-compact.ts`: `compactChanges(changed: Uint8Array, other:
  Uint8Array, ids: Int32Array, lines: ReadonlyArray<Uint8Array>): void`. This is an internal
  typed-array mutation and the one documented exception to the immutability rule; the reason
  is the hot path, which a *why* comment records. It holds the constants from `xdiffi.c:397-576`
  and a `get_indent` transcription (tabs to the next multiple of 8, `MAX_INDENT`,
  whitespace-only lines → −1).
- New `src/domain/diff/xdiff/xdl-classify.ts`, moved here from B2 because compaction compares
  lines by class id (`recs_match`): `classifyLines(ours, theirs, lineKey?)`. It absorbs
  `internLines` / `internOne` / `buildLineEquality` (`line-diff.ts:~280-338`), so the Myers
  core's `eq` becomes an id comparison on both paths.
- `src/domain/diff/line-diff.ts`: turn `reconstructEdits` (the `:383` caller) into `changed`
  arrays, compact both sides, then `buildHunks`.
- Tests:
  - `test/unit/domain/diff/xdiff/xdl-compact.test.ts`: L5, the C-function block, blank-line
    preference, the end-of-file penalty.
  - `xdl-compact.properties.test.ts`: compaction preserves the added and deleted counts and the
    multiset of changed lines.
  - **Interop:** add L5 / L5' rows to `test/integration/diff-patch-git-parity.test.ts`, plus one
    `blame-interop` row and one `merge-interop` row on L5-shaped input. Pin the git side first.
    If blame or merge differs, stop and escalate.

### Part B2: the xdiff Myers engine replaces the bounded Myers (H3)

Commit: `fix(diff)!: diff lines with git's xdiff heuristics instead of bailing at edit distance 10000`.
- New `src/domain/diff/xdiff/xdl-prepare.ts`, `xdl-split.ts`, `index.ts` (§4.2), reusing B1's
  `xdl-classify.ts`.
- `src/domain/diff/line-diff.ts`:
  - delete `computeMyersTrace` (`:124`), `chooseDown`, `advanceSnake`, `reconstructEdits`,
    `wholeFileFallback`, `buildLineEquality` / `internLines`, which move into classify;
  - delete `diffLinesWithBound` (`:356`) and `diffPresplitLinesWithBound` (`:383`);
  - `diffPresplitLines` calls the engine;
  - `MAX_DIFF_EDIT_DISTANCE` (`:37`) gets the deprecated comment.
- `src/domain/merge/three-way-content.ts:79`: delete the `degraded` branch and its tests.
- Tests:
  - `test/unit/domain/diff/line-diff.test.ts` (955 lines): delete the cap and seam blocks. The
    L2/L2'/L2''/L3/L4 rows become examples.
  - New `xdiff/*.test.ts` for `bogosqrt`, `clean_mmatch` windows and `mlim` rows.
  - `xdiff/xdl-split.properties.test.ts`: the script is always a valid edit (applying it to
    `a` yields `b`). With `need_min`, the count equals an LCS oracle on ≤ 12-line inputs.
    Without it, the count is ≥ the minimal count.
  - `test/unit/domain/blame/split-blame.test.ts` and `three-way-content.test.ts`: rows whose
    expectations came from the old engine are re-derived from git, never edited to fit.
  - **Interop:** add L1 (shrunk to 2 × 1 MiB text rewrites for runtime), L2, L2', L3 (n = 8000) and
    L4 numstat rows to `diff-patch-git-parity.test.ts`, plus an L4 row in `blame-interop` and one
    in `merge-interop`.
- Bench: `diff.bench.ts`, `diff-whitespace.bench.ts` and `blame.bench.ts` through `bench:ab`.
  The L1 wall time and RSS go in the commit message.
- ADR: supersede ADR-563 (H3).
- Docs: `docs/use/commands/diff.md`: drop the "degrades above …" statement if present; grep
  `docs/` for `10 000` / `MAX_DIFF_EDIT_DISTANCE`.

### Part C0: `rewrite` bench shape (§7)

Commit: `chore(bench): add a full-rewrite -M -B rename shape`.
- `test/bench/support/fixture-generator.ts:986`: extend `RenameFixtureShape`. Add a stream
  builder next to `streamHostileRenameFastImport` (`:1109-1146`) and an entry in
  `RENAME_FIXTURE_STREAMS`.
- `test/bench/diff-renames.bench.ts`: `SHAPE_GIVEN.rewrite`, and scenario options with
  `breakRewrites`.

### Part C1: the bucket hash wraps to uint32 (H5)

Commit: `fix(diff): wrap the spanhash bucket sum to 32 bits like git`.
- `src/domain/diff/similarity.ts`, `buildChunkMap` (both `hashval` sites): add `>>> 0` before
  `% HASHBASE`. Name the expression `bucketOf(accum1, accum2)`.
- Tests:
  - `test/unit/domain/diff/similarity.test.ts`: a chunk whose `Math.imul` is negative (search a
    short byte string once and pin it as a literal) now lands in bucket `x`.
  - `similarity.properties.test.ts`: every bucket is in `[0, HASHBASE)`.
  - **Interop:** add the S1 row to `rename-similarity-interop.test.ts`: generated `o1/n1` bytes
    from a seeded PRNG, `threshold: 28350` against `git -M47250`.

### Part C2: the CR of CRLF is skipped in text blobs (H5)

Commit: `fix(diff): skip the CR of CRLF when fingerprinting text like git`.
- `similarity.ts`: add `buildChunkMap(data, kind: 'text' | 'binary')`.
  `countSpanhashChanges`/`estimateSimilarity` derive `kind` from `isBinary` (import from
  `line-diff.ts`, domain to domain).
- `detect-similarity-renames.ts:453` (`hydrateFingerprints`) and `:606` (`computeBreakScores`)
  pass the kind.
- **Check in the part:** does the rename pass see the `diff`/`binary` attribute today
  (`docs/design/diff-attr-binary-override.md`)? If it does not, record that as residual F3 and
  keep the content sniff.
- Tests: CR-before-LF, lone CR, trailing CR and binary-with-CRLF rows. **Interop:** the S2 row
  (`R065`) in `rename-similarity-interop`, plus one `-B` CRLF row.

### Part C3: typed fingerprints and merge scan (H6)

Commit: `perf(diff): fingerprint blobs into sorted typed arrays and merge-scan them like git`.
- `similarity.ts`:
  - `SpanFingerprint`, `buildFingerprint(data, kind)`, which dispatches on size to
    `packFingerprint` or `denseFingerprint`, each under 20 lines;
  - `countCopied`, `estimateSimilarityFromFingerprints`;
  - delete `buildChunkMap`, `countSrcCopied` and `estimateSimilarityFromMaps`.
- `detect-similarity-renames.ts`:
  - `BlobFingerprint` (`:79`) becomes `{ fingerprint, size }`;
  - `estimatePairSimilarity` (`:103`) and the basename pass (`:1160`) switch over;
  - `runBreakPass` / `scoreModifies` seed `known` (§4.3.6).
- Tests: `similarity.properties.test.ts` gets the **oracle property**. For arbitrary byte
  pairs, including CRLF-heavy text and 64-byte runs, the typed score equals the C2 `Map`
  implementation, kept as a test-only helper in `test/unit/domain/diff/support/`. A second
  property pins `packFingerprint ≡ denseFingerprint`. All existing
  `detect-similarity-renames.test.ts` rows stay green unchanged.
- Bench: `bench:ab <C0> <C3>` on `diff-renames` `common` / `wide` / `hostile` / `rewrite`.
  `bench:memory` for `rewrite`. `npm run size`, with H7 applied.

## 9. Test strategy (summary)

- Interop rows are the only proof of faithfulness (§3 → §8). Each row reconstructs git's text
  from structured fields (ADR-249).
- Properties:
  - `inflateHead` ≡ a prefix of `inflate`;
  - the xdiff script is valid, count ≥ minimal, and `need_min` gives exactly the minimal count;
  - compaction preserves counts;
  - typed ≡ Map oracle;
  - pack ≡ dense.
- Mutation: every new domain module is Stryker-scoped per `.claude/workflow/mutation.md`. The
  indent-heuristic weight constants are killed by the L5 and C-block examples plus one example
  per penalty.
- Blame and merge parity for item 2 is **not yet pinned**. B1 and B2 pin it before claiming it.

## 10. Non-goals and follow-ups

- **F1:** `fsck` does not report size liars (A-fsck). git reports `hash-path mismatch` or
  `corrupt loose object`. tsgit's fsck has no loose-content re-hash at the claimed size. This is
  a separate change to fsck's findings model.
- **F2:** A3 under-run blobs are served instead of zero-padded (ADR-863 residual, kept). An
  under-running commit still refuses where `git log` accepts it.
- **F3:** the `diff`/`binary` attribute for the CRLF `is_text` decision, if C2 finds it is not
  plumbed through.
- **F4:** `diff.indentHeuristic=false`, `--minimal`, and `diff.algorithm=patience|histogram` as
  config and options (H4).
- Not in scope: git's `--no-index` surface, and function-name `@@` suffixes (display, ADR-249).

## 11. Decision candidates

| # | Choice | Options | Recommendation |
|---|---|---|---|
| **H1** | What a loose read does with a blob whose body does not match its header claim (item 1 scope; revisits ADR-863) | **(a)** Transcribe git's tiers. Buffered reads (`readObject`, `readBlob`, diff, rename/break, archive, blame, grep, merge) inflate at most `headerLen + claim`: overrun beyond the 32-byte window refuses, overrun inside it truncates to the claim. Streaming-tier routes (`catFile` content, `show` blob, `streamBlob`, checkout) keep serving the real bytes. Under-run keeps ADR-863's residual (serve the body). Supersede ADR-863 in part. · **(b)** Bound and refuse every overrun on every route, `catFile`/`show`/`streamBlob`/checkout included: one rule. · **(c)** Bound only rename/break hydration and leave ADR-863 elsewhere. | **(a).** It matches every pinned A1/A2 row except fsck (F1) and removes the amplification on every buffered route. ADR-863's own threat model (no allocation from the claim) holds, because an overrun allocates at most the claim. (b) diverges on A-p, A-show and A-co, git's most common blob reads, which tsgit matches today. (c) leaves A-diff and A-ar divergent, and leaves the same unbounded inflate reachable through `diff` without `-M`. |
| **H2** | How the loose arm learns the claim before inflating | **(a)** Port change: `inflate(data, maxOutputBytes?)` plus a truncating `inflateHead(data, max)`. A 33-byte head, then a capped one-shot. Measured +1.3 µs per loose read on node. · **(b)** No port change: read the header through `createInflateStream` (as `readLooseHeader` does), then `streamInflate(…, headerLen + claim)`. Measured 55 µs against 2 µs per object. · **(c)** Bound only where the claim is already known (hydration after the ADR-902 header read). | **(a).** It is the only option that bounds every buffered route without a 25× regression on the loose hot path. (b) is simpler but is measured as a hot-path regression. (c) cannot deliver H1 (a). |
| **H3** | Line-diff engine; supersedes ADR-563's `MAX_DIFF_EDIT_DISTANCE` bail | **(a)** Transcribe xdiff's Myers pipeline (classify, `trim_ends`, `cleanup_records`, `recs_cmp`/`split` with both heuristics) as the single engine behind every `diffLines` consumer (numstat, patch, blame, merge, range-diff, patch-id). Supersede ADR-563: linear memory and git's `mxcost` bound replace the bail. · **(b)** Same engine, but only for the diff stat and patch surfaces. Blame, merge and range-diff keep the bounded minimal Myers. · **(c)** Only lift the cap: a linear-space minimal Myers with no bail. | **(a).** Only (a) fixes L1–L5 on every surface. git runs one engine for diff, blame and merge, so (b) creates two tsgit engines that disagree with each other and leaves blame and merge divergent on L4-class input. (c) fixes L1–L3 but leaves L4 (numstat) and L5 (patch) wrong, and a minimal diff on L1 costs git's `--minimal` time, which git itself avoids by default. Risk: blame and merge rows are unpinned (§5); B1/B2 pin them first. |
| **H4** | Indent heuristic and its configuration | **(a)** Always on (git's default). `diff.indentHeuristic`, `--minimal` and the algorithm options become follow-up F4. · **(b)** Honour `diff.indentHeuristic` now: a config read on diff, blame and merge, and a new option. · **(c)** Compaction without the indent heuristic. | **(a).** Default-config parity is what the interop suite pins. (b) widens the public surface and the config plumbing of three commands in a PR that is already large. (c) diverges from git's default on L5' and similar inputs. |
| **H5** | The two `hash_chars` bugs found while designing item 3 (S1 bucket hash not wrapped to uint32; S2 CR of CRLF not skipped) | **(a)** Fold both in as `fix(diff)` commits C1 and C2 before the typed rewrite, so the rewrite's oracle is the faithful Map. · **(b)** Fold in S1 only and defer S2, which needs `isText` plumbing and possibly attributes. · **(c)** Defer both, keeping C3 output-identical to today. | **(a).** Both are pinned rename and break divergences in the function C3 rewrites. Folding them in first costs one property oracle. Deferring them means the rewrite freezes known-wrong output behind a property test. |
| **H6** | Fingerprint build strategy | **(a)** Hybrid: packed-sort below `HASHBASE` bytes, dense `Uint32Array(HASHBASE)` bucket accumulator above. Fastest on both ends; transient memory bounded (≤ 4 × size, or a fixed 862 kB). · **(b)** Packed-sort only: smallest code, but transient memory is up to 4 × blob size (128 MiB for a 32 MiB all-LF blob). · **(c)** Transcribe git's open-addressing `spanhash_top` then sort: bounded at 2 MiB, but builds 1.8× slower than packed (822 ms against 462 ms for 100 × 1 MiB). | **(a).** Measured best on small (17 ms against a 45 ms dense-only build) and large inputs, with bounded memory. (b) trades a hostile-input memory spike for a few hundred bytes. (c) is faithful in shape only; the output is identical under every option. |
| **H7** | Bundle growth from item 3's typed rewrite (not git-mandated; the browser bundle has about 0.2 kB of headroom) | **(a)** C3 must be size-neutral on every size-limit entry. If it is over, trim (for example, share the fold loop between pack and dense). Only git-mandated commits (A1, A2, B1, B2, C1, C2) bump under ADR-904. · **(b)** A new ADR extends ADR-904 to measured performance growth, bumping at measured + 0.25 kB with the `bench:ab` figure in the commit. · **(c)** Take H6 (b) to minimise code and accept its memory profile. | **(a).** It keeps ADR-904's rule intact. The typed code replaces Map code of similar size, so neutrality is plausible and is measured in C3. If C3 cannot reach it, escalate with the measured delta instead of pre-authorizing growth (b). |
