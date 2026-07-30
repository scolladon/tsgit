# Design — whitespace drop-pass fast path

> Brief: the residual `ignoreWhitespace` slowness is **many small modified pairs**, and
> the cost is **not** scanning — it is the per-blob WHATWG stream + `createInflate`
> pipeline the drop-pass predicate builds twice per pair. Reproduced locally
> (2,500 pairs of ~56-byte Java classes): **258–271 ms warm** against a **6.4–7.1 ms**
> plain recursive diff of the same trees and **111–113 ms** for the same 5,000 blobs
> read buffered through `readBlob`. A CPU profile attributes only **~2.8 %** to tsgit's
> own scanning frames; **16.4 %** is web-streams machinery, **6.2 %** `node:zlib`
> instance/async churn, and **4.4 %** is `NodeError` construction — all of which the
> profile traces to a single line. Replace the streaming pipeline with a buffered
> read + a synchronous line-digest scan below a size gate; keep streaming above it.
> Status: **decisions settled** — DC-1 … DC-9 are ratified as ADR-548 … ADR-556 (§Settled
> decisions). ADR-554 pulled the two pre-existing faithfulness divergences Pin C uncovered
> into this PR as ordered follow-on commits; §D6 and §D7 design them, against a fresh
> empirical matrix (§Pin E) that also uncovered **three more** divergences of the same
> families (C6, C7, C8). Five new load-bearing choices those fix designs raise are open
> (DC-10 … DC-14).

## Context

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | **new** `src/domain/diff/line-digest-scanner.ts` → the synchronous chunk-fed line/digest state machine (today's `LineSourceState`, `concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`, `nextLine`, `nextSignificantDigest` lifted out of the application layer) | domain |
| P2 | **new** internal blob-source seam (working name `src/application/primitives/internal/blob-source.ts`) → `openBlobSource(ctx, id, maxBufferedBytes)` returning `{ kind: 'bytes' } \| { kind: 'stream' }`; `src/application/primitives/stream-blob.ts` → `streamBlob` re-expressed over it, public contract unchanged | primitive |
| P3 | `src/application/primitives/internal/whitespace-drop-predicate.ts` → `isWhitespaceOnlyModify(ctx, change: ModifyChange, lineKey: LineKey, ignoreBlankLines: boolean): Promise<boolean>` — two arms (sync buffered / async streamed) over the P1 scanner | primitive |
| P4 | `src/adapters/browser/browser-compressor.ts`, `src/adapters/memory/memory-compressor.ts` → `inflate` (conditional, ADR-555) | adapter |
| P5 | `test/bench/diff-whitespace.bench.ts` (+ a new many-small-modified-pairs fixture) — the current bench does not reach the code being changed (§Pin D-3) | bench |
| P6 | **C4 fix** (§D6) — `src/domain/diff/whitespace.ts` → `normalizeLine`/`digestNormalizedLine`; `src/domain/diff/patch-serializer.ts` → `trailingNoNewline` | domain |
| P7 | **C5 fix** (§D7) — `src/domain/diff/line-digest-scanner.ts` (the P1 module) → cap disposition; `src/application/primitives/diff-trees.ts` → `applyStatPass`/`materialisedShouldDrop` verdict source | domain + primitive |
| P8 | **C6 fix** (§D8, conditional on DC-12) — `src/domain/diff/whitespace.ts` → `applyCrRule`/`digestContentEnd` | domain |

P6–P8 are the ADR-554 follow-on commits, landing **after** the perf slice. Everything in
P1–P5 is a **read path**. `diff-trees.ts` needs no change for batching: the
drop pass is *already* `boundedMap(diff.changes, MAX_CONCURRENT_OBJECT_LOADS = 32, …)`
(§Pin D-1).

### Prior decisions that constrain this design

| ADR | What it binds | How this design stands to it |
|---|---|---|
| **ADR-383** | `streamBlob` is a sibling of `readBlob`; size-tiered auto-escalation *inside `readBlob`* was rejected | respected — `readBlob` untouched |
| **ADR-385** | "`streamBlob` always streams. No streaming decision is ever keyed off … any size threshold." Its closing note: *"If escalation is ever wanted, it lives inside `streamBlob`, not in `readBlob`."* | **was the load-bearing tension.** ADR-548 keeps the decision text literally true: the seam sits *below* `streamBlob`, whose contract is byte-for-byte unchanged, and the Neutral note is honoured by the shared implementation |
| **ADR-386** | a deltified blob is reconstructed **in full** then streamed, `materialised: true` | exploited — that arm is already a buffer; the gate is a no-op there |
| **ADR-387** | streaming inflate reuses `Compressor.createInflateStream` as-is; no port change | respected — and the profile shows this is the exact cost centre for small blobs |
| **ADR-388** | the loose arm reads the **whole compressed file** (`ctx.fs.read`) before inflating | exploited — on the loose arm the compressed length is known *for free*, so the gate costs no extra I/O |
| **ADR-392** | no full-blob **working-tree materialisation** is left buffered | not in scope: this is a read-and-scan, not a worktree write. The memory posture for genuinely large blobs is preserved by the gate (ADR-550) |
| **ADR-513** | the drop-pass predicate streams both blobs and folds a per-line rolling digest; the `withStat` path interns lines for Myers; the two verdicts must stay provably consistent | preserved — the digest primitives are untouched; only the *transport* changes |
| **ADR-249** | structured data, no rendered output | unaffected |
| **ADR-226** | git-faithfulness prime directive | this change must not move any verdict (§Requirements 1); §Pin C records two *pre-existing* divergences it uncovered |

### Settled decisions (were DC-1 … DC-9)

Every candidate was ratified with the design's recommendation. The rows below are now
constraints on this document, not open questions.

| was | Decision | ADR |
|---|---|---|
| DC-1 | The buffered/streamed choice lives in a shared internal `openBlobSource` seam **below** `streamBlob`; `streamBlob` = `openBlobSource(ctx, id, 0, options)` + a wrap tail, contract byte-for-byte unchanged | [548](../adr/548-blob-source-seam-below-stream-blob.md) |
| DC-2 | The gate is **64 KiB of compressed/on-disk bytes**, uniform on every arm; the amplification residual is explicitly accepted | [549](../adr/549-buffered-blob-gate-compressed-64-kib.md) |
| DC-3 | The predicate **keeps a gated streaming arm**; above the gate both sides still stream | [550](../adr/550-predicate-keeps-a-gated-streaming-arm.md) |
| DC-4 | One **synchronous chunk-fed scanner** in `src/domain/diff/line-digest-scanner.ts`, `push`/`end`/`next` | [551](../adr/551-synchronous-line-digest-scanner-in-domain.md) |
| DC-5 | All five equivalent-mutant proofs are **re-proved against the new structure**, never carried | [552](../adr/552-equivalent-mutant-proofs-re-proved-not-carried.md) |
| DC-6 | Drop-pass concurrency **unchanged** — `boundedMap(changes, 32)` | [553](../adr/553-drop-pass-concurrency-unchanged.md) |
| DC-7 | **Perf slice first**, reproducing today's verdicts exactly; then C4 and C5 as separate **ordered commits in this same PR**, each with its own ADR and interop case | [554](../adr/554-perf-slice-precedes-the-faithfulness-fixes.md) |
| DC-8 | Browser/memory `inflate` is **reimplemented over `inflateZlibMember`, gated on a large-input bench** against native `DecompressionStream`; if the bench is not clearly better, fall back to accepting a Node-only win | [555](../adr/555-adapter-buffered-inflate-bench-gated.md) |
| DC-9 | Chunk-boundary cases move to **synchronous scanner tests**; the `streamBlob` module spy is deleted | [556](../adr/556-chunk-boundary-tests-move-to-the-scanner.md) |

`docs/design/raw-tree-cursor-diff.md` §Out of scope already names this work: *"The
whitespace-mode per-modify-pair stream setup. A separate lever; re-profile after this
lands."* This is that re-profile.

### Current code shape (the tax being removed)

Per **modify** change, `changeShouldDrop` → `isWhitespaceOnlyModify` builds two
independent pipelines:

```
streamBlob(ctx, id)
  └─ looseCompressedBytes → ctx.fs.read(whole compressed file)      [ADR-388]
     └─ inflateOneShot: new ReadableStream (1 enqueue + close)
        └─ .pipeThrough(ctx.compressor.createInflateStream())        [ADR-387]
           └─ NodeCompressor: new createInflate()  → Zlib instance
              → 'data' → controller.enqueue         (async processChunk)
              → 'end'  → controller.terminate()     ← the NodeError site
        └─ readableStreamToAsyncIterable(readable)  → getReader()
     └─ yieldAndVerifyChunks (async generator, hash verify, stripHeader)
```

and drives them through `nextSignificantDigest` with a **`Promise.all` per line pair**.
For a ~56-byte blob the scaffolding above dwarfs the ~3 lines of content.

`streamBlob` also **never consults `ctx.deltaCache`** — `resolveObjectBytes` checks it
first, `streamBlob` goes straight to the loose probe. On a packed repo that costs the
predicate a full pack re-resolve on every call (§Pin B).

## Empirically pinned matrices

All measurements on this host (darwin 25.5.0, Node v22.22.3, git 2.55.0), against a
scratch repo of **2,500 files** of the shape `package a;\npublic class C<i> {\n  int f<i> = <i>;\n}\n`
(**~56 bytes** each — 278 340 bytes over 5 000 blobs, measured) in 50 directories,
committed twice — the second commit a **whitespace-only** rewrite.
Repro scripts under the session scratchpad; the fixture builder is reproduced verbatim
in §Test strategy as the new bench fixture.

### Pin A — where the time goes (`node --cpu-prof` over `dist-profile/`, 5 iterations, 1 458.7 ms sampled)

| share | self-time | frame |
|---|---|---|
| 6.90 % + 6.54 % + 2.93 % | 100.6 + 95.4 + 42.7 ms | Node's three web-streams implementation modules (`ReadableStream`, `WritableStream`, `TransformStream`) — **16.4 % web-streams machinery** |
| 6.18 % | 90.2 ms | `node:zlib` (`processChunk` 3.40 %, `Zlib` ctor 0.95 %, `Inflate` 0.60 %, `processChunkSync` 0.43 %) |
| **4.39 %** | **64.1 ms** | **`NodeError`** |
| 3.73 % | 54.4 ms | `runMicrotasks` |
| 3.22 % | 47.0 ms | garbage collector |
| 2.76 % + 1.21 % + 0.88 % | 40.2 + 17.6 + 12.8 ms | `realpath` (native) + `realpath@promises` + `isContainedInAnyRoot` — the loose-read containment gate, paid by **both** designs |
| **2.83 %** | **41.3 ms** | **the actual scan**: `isWhitespaceOnlyModify` 1.13 % + `nextLine` 0.67 % + `nextSignificantDigest` 0.52 % + `takeLine` 0.51 % |

**Every one of the 64.1 ms of `NodeError` self-time has a single call chain:**

```
NodeError ← transformStreamDefaultControllerTerminate ← terminate
          ← <NodeCompressor.createInflateStream 'end' handler>
          ← emit ← endReadableNT ← processTicksAndRejections
```

That is `controller?.terminate()` inside `inflate.on('end', …)` — the **normal, successful
completion** of every inflate stream. WHATWG `terminate()` constructs an `ERR_INVALID_STATE`
`TypeError` to error the writable side (`transformStreamErrorWritableAndUnblockWrite`), and
each construction captures a stack. A secondary ~10 ms comes from
`writableStreamDefaultWriterEnsureReadyPromiseRejected` / `…EnsureClosedPromiseRejected`
via `writableStreamDefaultWriterRelease ← finalize` — also the normal pipe-completion path.

### Pin B — the ceiling the buffered path already reaches

| repo shape | today's `diff -w` (warm) | plain recursive diff | `readBlob` × 5 000 | native `git diff-tree -r -w` |
|---|---|---|---|---|
| **loose** (as committed) | 258 / 271 ms *(cold 365)* | 6.4–7.1 ms | 111–113 ms → **22.3–22.6 µs/blob** | 160 ms *(incl. process start)* |
| **packed** (`git repack -ad`) | 165 / 176 ms *(cold 272)* | 2.9–3.2 ms | 87.6 ms cold → **6.9–7.0 ms warm (1.4 µs/blob)** | 77 ms |

The packed warm number is `ctx.deltaCache`: `resolvePackChain` caches the reconstructed
loose-format buffer, so the *second* pass over the same 5,000 ids costs 1.4 µs each. The
streaming predicate cannot reach that cache at all.

**Projection** (reads + the untouched tree walk + a synchronous scan over 278 kB total):
loose ≈ **120 ms** (from 258 ms, native 160 ms); packed ≈ **91 ms cold / ~10 ms warm**
(from 165 ms, native 77 ms). It is anchored on Pin B's measured read cost, **not** on
subtracting Pin A's shares — those shares are computed over a sampled total that also
carries `(program)`, `(idle)` and module compilation, so they are a lower bound on the
removable fraction and the two estimates are not meant to reconcile arithmetically.
Labelled a projection, not a result — §Test strategy names the go/no-go measurement.

### Pin C — git 2.55.0 whitespace-drop edge matrix, and the first two live tsgit divergences

Pinned in a `mktemp -d` throwaway (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
scrubbed, `commit.gpgsign=false`), tree-to-tree via
`git diff-tree --no-ext-diff -r <flag> --name-only HEAD~1 HEAD`; tsgit via
`repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true, … })` on the same repo
(`3.1.2`, node adapter). **Shown = survives the diff.**

| # | file | change | git plain | git `-w` | tsgit `'all'` | git `--ignore-space-at-eol` | tsgit `'at-eol'` |
|---|---|---|---|---|---|---|---|
| C1 | `no-newline.txt` | ws-only, **last line unterminated** (`a b\nc d` → `a   b\nc    d`) | shown | dropped | **dropped** ✓ | shown | shown ✓ |
| C2 | `binary.txt` | ws-only inside a **NUL-bearing** file | shown | shown (`-  -` numstat) | **shown** ✓ | shown | shown ✓ |
| C3 | `blank.txt` | blank-line-only insertion | shown | shown (`2 0`) | **shown** ✓ | shown | shown ✓ |
| C4 | `eof-newline.txt` | **gains a trailing LF only** (`x y` → `x y\n`) | shown | **dropped** | **shown** ✗ | **dropped** | **shown** ✗ |
| C5 | `long-line.txt` | ws-only on a **70 000-byte line** | shown | **dropped** | **shown** ✗ | **dropped** | **shown** ✗ |

`--ignore-blank-lines --name-only` keeps all five on both tools (the existing "BL1"
finding in `diff-whitespace-modes-interop.test.ts`).

**C1–C3 agree. C4 and C5 are pre-existing prime-directive divergences this pinning
exercise uncovered — neither is caused by, nor fixed by, the perf work.**

- **C4** — `LineDigest.terminated` is compared by `digestsEqual`, so gaining a trailing LF
  is a significant change for tsgit. git treats it as whitespace at end-of-line under both
  `-w` and `--ignore-space-at-eol`. Affects the `withStat` path identically
  (`normalizeLine` preserves the LF, `bytesEqual` sees it).
- **C5** — tsgit's `MAX_LINE_BYTES = 65 536` marks the side binary, and a binary side is
  never dropped. git's text/binary heuristic is NUL-in-the-first-8000-bytes only; it has
  no line-length cap here.

ADR-554 settled what happens to them: the perf slice reproduces both verdicts exactly, then
ordered fix commits in this PR correct them. §Pin E is the matrix those fixes are designed
against — a wider re-pin that confirms C4 and C5 and adds C6, C7 and C8.

**Reading C5's `--ignore-space-at-eol` column against §Pin E-2.** This row's `long-line.txt`
carries a **trailing**-whitespace change, which is why git drops it under `at-eol` as well as
under `-w`. §Pin E-2's `rand-1line` and `long-line-txt` carry an **internal** whitespace change,
which git legitimately keeps under `at-eol`. The two matrices agree; the fixtures differ, and
§Pin E-2 keeps both shapes so the fix cannot be validated on only one.

### Pin E — the C4/C5 fix matrix (git 2.55.0 vs tsgit 3.1.2, pinned 2026-07-30)

Pin C pinned C4 and C5 on one fixture each. Designing the fixes needs the *rule*,
not the instance: which flags it holds under, whether it is symmetric, where the cliff is,
and what the `withStat` twin does. Pinned in three `mktemp -d` throwaways (isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, `commit.gpgsign=false`, `core.autocrlf=false`,
`.gitattributes` = `* -text`) via `git diff-tree --no-ext-diff -r <flag> --name-only HEAD~1 HEAD`;
tsgit via `repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true, … })` on the **same** repo,
run **twice** — once predicate-only and once `withStat: true` — because the two arms turn out
not to agree. **Shown = survives.** `k` = kept, `d` = dropped.

#### E-1 — the C4 family (trailing LF), and the C6 discovery

| fixture | before → after | plain | `-w` | `-b` | `--ignore-space-at-eol` | `--ignore-cr-at-eol` | `--ignore-blank-lines` |
|---|---|---|---|---|---|---|---|
| `lf-gain` | `x y` → `x y\n` | k k | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | k k |
| `lf-loss` | `x y\n` → `x y` | k k | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | k k |
| `lf-gain-multi` | `a\nb\nc` → `a\nb\nc\n` | k k | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | k k |
| `sp-no-eol` | `' '` → `'\n'` | k k | **d** / k ✗ | **d** / k ✗ | d d | k k | k k |
| `tab-no-eol` | `a\t` → `a\n` | k k | **d** / k ✗ | **d** / k ✗ | **d** / k ✗ | k k | k k |
| `cr-then-lf` | `x y\r\n` → `x y\n` | k k | d d | d d | d d | d d | k k |
| **`cr-no-eol`** | `x y\r` → `x y` | k k | d d | d d | d d | **k** / d ✗ | k k |
| `lf-gain-plus-ws` | `x y` → `x  y\n` | k k | **d** / k ✗ | **d** / k ✗ | k k | k k | k k |
| `lf-gain-plus-txt` | `x y` → `x z\n` | k k | k k | k k | k k | k k | k k |
| `lf-gain-empty` | `''` → `'\n'` | k k | k k | k k | k k | k k | k k |

*(cell = `git` / `tsgit`; ✗ marks a divergence. `lf-gain-empty` is dropped by **both** under
`-w --ignore-blank-lines` — the added line is blank, so the blank-skip covers it.)*

**C4 rule, as pinned.** git ignores a difference in the final line's terminator under
**every** flag that sets `diff_from_contents` — `-w`, `-b`, `--ignore-space-at-eol` **and
`--ignore-cr-at-eol`** — and it is **symmetric** (LF gained and LF lost behave identically).
`--ignore-blank-lines` alone never drops anything (the existing BL1 finding: git does not set
`diff_from_contents` for it), and under plain diff the terminator is significant on both tools.
So the answer to "which modes must suppress the terminator" is: **exactly those where
`lineKeyIsActive(key)` is true**, i.e. `mode !== 'none' || ignoreCrAtEol` — which is precisely
the condition that gates the drop pass into existence (`diff-trees.ts:96`). It is *not*
"every mode but `'none'`": `ignoreCrAtEol` with `mode: 'none'` is an active key and does
suppress it. It is also not unconditional: under an inactive key the terminator stays
significant, matching plain git.

**C6 — a new divergence, same family, opposite direction.** `cr-no-eol` (`x y\r` → `x y`) is
**kept** by git under `--ignore-cr-at-eol` and **dropped** by tsgit. git's `--ignore-cr-at-eol`
ignores a CR only immediately before a real newline — a CR ending an *incomplete* final line
is significant. Under `-w`/`-b`/`--ignore-space-at-eol` the same CR *is* dropped, because
there it is ordinary trailing whitespace, and both tools agree. tsgit's `applyCrRule` /
`digestContentEnd` strip a trailing CR regardless of termination, so tsgit is stricter than
git under the three whitespace modes (no observable difference) and **looser** under
`--ignore-cr-at-eol` alone (an observable wrong drop). §D8, DC-12.

**C4 is also a numstat divergence, not only a drop-verdict one.** For
`ctx-gain` (`a\nb` → `A\nb\n`) and `ctx-loss` (`a\nb\n` → `A\nb`) — a real change on line 1
plus a terminator change on the common last line — git reports `1 1` under `-w`; tsgit
reports **`2 2`** on both, because the interned last line pair never matches. The
prime directive binds `added`/`deleted` as structured data, so the fix cannot be scoped to
the drop verdict alone without leaving this in place (DC-10).

**And a patch-bytes rule the fix must satisfy.** Once the last line pair becomes *common*,
the `\ No newline at end of file` marker has to follow git. Pinned from `git diff-tree -r -w -p`:

```
ctx-gain (a\nb -> A\nb\n):   @@ -1,2 +1,2 @@ / -a / +A / " b"           ← NO marker
ctx-loss (a\nb\n -> A\nb):   @@ -1,2 +1,2 @@ / -a / +A / " b" / "\ No newline at end of file"
```

git renders a context line from the **postimage** and emits the marker from the
**postimage's** termination alone. tsgit's `patch-serializer.ts::trailingNoNewline` uses
`(isLastOld && !oldHasTrailingNewline) || (isLastNew && !newHasTrailingNewline)` for a
context edit — which would emit a marker for `ctx-gain`, where git emits none. That OR is
unreachable-divergent **today** (a context match currently forces equal termination) and
becomes reachable the moment C4 lands. §D6 step 3.

#### E-2 — the C5 family (the line caps), and the C7 discovery

All fixtures are whitespace-only changes. `tsgit` cells are `predicate / withStat`.

| fixture | shape | disk (compressed) | arm under ADR-549 | git `-w` | tsgit `-w` |
|---|---|---|---|---|---|
| `len-65535` | one line, 65 535 B → 65 536 B incl. LF | 100 B | buffered | **d** | k / k ✗ |
| `len-65536` | one line, 65 536 B → 65 537 B | 100 B | buffered | **d** | k / k ✗ |
| `tail-ws` | one 70 000 B line, trailing-ws change | **345 B** | **buffered** | **d** | k / k ✗ |
| `rand-1line` | one 80 003 B incompressible line | **80 045 B** | **streaming** | **d** | k / k ✗ |
| `lines-99999` | 99 999 lines | 2 709 B | buffered | **d** | **d** / **k** ✗✗ |
| `lines-100000` | 100 000 lines | 2 708 B | buffered | **d** | k / k ✗ |
| `long-line-txt` | 70 000 B line, **real content** change | 70 046 B | streaming | k | k / k ✓ |

**C5 rule, as pinned.** git has **no line-length cap and no line-count cap**. A 70 000-byte
line and a 100 001-line file are plain text to it: `git diff-tree -r -p` renders
`@@ -1 +1 @@` with the full 70 000-byte line, and `--numstat` reports `1 1` / `100001 100001`,
never `- -`. Its only text/binary heuristic on this path is NUL-in-the-first-8000-bytes,
exactly as Pin C recorded. tsgit's cliffs are at **65 536 bytes** for one line (`>= MAX_LINE_BYTES`,
counted **including** the LF, on **either** side — `len-65535`'s *modified* side is 65 536 B,
which is why it already trips) and at **100 000 lines** (`>= MAX_LINES`).

`tail-ws` (345 B on disk) and `rand-1line` (80 045 B on disk) straddle ADR-549's 64 KiB
compressed gate: after the perf slice the first case takes the **buffered** arm and the
second the **streaming** arm. Both must be fixed, and each is the interop fixture that
proves its arm.

**C7 — the two tsgit arms already disagree with each other.** `lines-99999` is **dropped by
the predicate arm** (which agrees with git) and **kept by the `withStat` arm**. The cause is
not the caps: 99 999 lines is under `MAX_LINES`, so `isBinary` is false, but
`diffLines` refuses `M + N > MAX_DIFF_LINES = 50 000` and returns `wholeFileFallback`
(`degraded: true`) with `added = deleted = 99 999`, so `shouldDrop`'s `added === 0` test
fails. This reproduces on `main` today under `-w`, `-b` and `-w --ignore-blank-lines`, for
any whitespace-only change to a file whose two sides total more than 50 000 lines. It is a
live violation of ADR-513's "the two verdicts must stay provably consistent" and of the
invariant `diff-whitespace-modes-interop.test.ts` exists to assert — the suite is green only
because its fixtures are two lines long. DC-13 option A retires it as a side effect of the
C5 fix; the other options leave it standing.

**C8 — the residual, and the scope line.** tsgit reports `- -` (binary) on `--numstat` for
`tail-ws`, `rand-1line`, `len-*` and `lines-100000` where git reports real counts —
**under plain diff, with no whitespace flag involved**. That divergence is `isBinary`'s, not
the drop pass's; fixing it means changing `isBinary`, which also feeds `three-way-content`,
`grep`, `patch-id`, `range-diff` and the patch `Binary files … differ` surface, and it
collides with `MAX_DIFF_LINES` (a 100 001-line file would then reach `diffLines` and degrade
to `wholeFileFallback` anyway). §Out of scope names it; DC-14 asks whether it rides along.

### Pin D — premises of the brief checked against the code

| # | brief premise | verdict |
|---|---|---|
| D-1 | *"the drop-pass over N modified pairs is … sequential awaiting; run it through the existing `BoundedReader`"* | **FALSE.** `applyDropPredicate` already runs `boundedMap(diff.changes, MAX_CONCURRENT_OBJECT_LOADS = 32, …)`; within a pair both `streamBlob` calls and both per-line digests are already `Promise.all`. `createBoundedReader` (`internal/bounded-reader.ts`) is a *per-id-deduped* semaphore used by commit walks — it is not the drop pass's mechanism and dedup is worthless here (every id appears once). |
| D-2 | *"the early-exit/teardown path (stream abort / premature-close) … manufactures NodeErrors"* | **FALSE.** There is no abort/destroy anywhere on this path; the predicate abandons its iterators silently. Measured: a content-change workload (predicate exits after the *first* line pair, both streams abandoned) costs **259–268 ms** — indistinguishable from the fully-drained whitespace-only workload (258–271 ms). Pin A traces 100 % of `NodeError` self-time to `controller.terminate()` on the **success** path. "Early exit without exceptions" is a **no-op fix**. A `return()`-on-the-iterator hygiene fix is still worth landing (it releases the reader and the `createInflate` instance instead of leaking them until GC) — as *resource* hygiene, not as a perf lever. |
| D-3 | implicit: `test/bench/diff-whitespace.bench.ts` measures this | **FALSE.** `MEDIUM_FIXTURE` uses the `multi` strategy — every commit writes 4 *new* paths (`d{i/512}/f{i}.dat`). `HEAD~1..HEAD` recursive therefore yields 4 **add** changes, and `changeShouldDrop` returns at `change.type !== 'modify'` **before** `isWhitespaceOnlyModify` is ever called. The existing bench never executes the code this design changes. |
| D-4 | *"whether the `Compressor` port can express a sync inflate at all"* | **No port change is forced.** The port already has `inflate(data): Promise<Uint8Array>`, and `NodeCompressor.inflate` **is** `inflateSync` — the Promise is pre-resolved, no thread-pool hop, no `Zlib` instance churn. The cost the brief attributes to zlib comes entirely from the *other* verb, `createInflateStream()` → `createInflate()`. The fast path simply stops calling it. |
| D-5 | implicit: the win is adapter-neutral | **FALSE.** `BrowserCompressor.inflate` builds `Blob → DecompressionStream → Response`; `MemoryCompressor.inflate` builds a `DecompressionStream` per call. On those adapters buffered inflate is **not** cheaper than streaming inflate, so the fast path is (at best) a wash there. Both, however, already ship a **synchronous zero-dependency whole-member decoder** — `inflateZlibMember` in `src/adapters/inflate.ts`, used by their `streamInflate`. ADR-555 takes that route, gated on a large-input bench. |
| D-6 | *"already materialized in the delta cache"* | **Correct, and stronger than stated.** `streamBlob` never reads `ctx.deltaCache`; `resolveObjectBytes` checks it first. Routing through the buffered path both *hits* and *populates* it (Pin B: 87.6 ms → 6.9 ms). |

## Requirements

1. **Verdict identity.** For every `(oldBytes, newBytes, lineKey, ignoreBlankLines)`,
   the buffered arm and the streaming arm return the **same** boolean as today's
   implementation — including the binary rules (NUL in the first `BINARY_DETECTION_BYTES`
   of the *concatenated* stream, `MAX_LINE_BYTES`, `MAX_LINES`), the unterminated-final-line
   case, and `ignoreBlankLines` skipping. Per ADR-554 the perf slice reproduces **every**
   divergence in §Pin C and §Pin E exactly as it is today — C4, C5, C6, C7 included. The
   perf commit's own diff must show **zero** verdict movement; P6/P7/P8 then move them, one
   family per commit.
2. **Error identity.** A missing object, a non-blob oid, a hash mismatch and an aborted
   `ctx.signal` raise the *same* structured error (`OBJECT_NOT_FOUND`,
   `UNEXPECTED_OBJECT_TYPE`, `OBJECT_HASH_MISMATCH`, `OPERATION_ABORTED`) from **both**
   arms, with the same `.data`.
3. **Bounded peak memory above the gate — stated honestly.** A blob whose *gated* size
   exceeds the threshold is still streamed (ADR-550). Under ADR-549 the gated quantity is the
   **compressed** size, so a sub-threshold object that inflates large *is* newly
   materialised where today it would have streamed; that residual is bounded only by the
   adapter's `MAX_INFLATED_OBJECT_BYTES` (2 GiB), which is exactly `readBlob`'s existing
   posture for every loose object in the library. ADR-549 accepted that trade explicitly and
   §Blind-spot 1 is the review hook; the pack-delta arm is excepted outright (ADR-386 already
   materialises it).
4. **No public API change.** `streamBlob`, `BlobStream`, `readBlob`, `DiffChange`,
   `TreeDiff`, `DiffOptions`, `repo.primitives.*` and `reports/api.json` are untouched.
5. **One state machine, not two.** The buffered and streamed arms drive the *same* scanner
   code; the "identical semantics" property holds by construction, and the differential
   test is a check on that, not the only guarantee.
6. **Every equivalent-mutant proof is re-argued against the new structure** — none carried
   forward unexamined (§Design D5).
7. **Measured, not asserted.** A bench that actually reaches the predicate (Pin D-3),
   before(`main`)/after(branch), absolute wall-clock, on one host, ≥2 runs, in the PR body;
   the nightly `bench.yml` artifact is the published authority.
8. **Cross-adapter pinned.** The whitespace drop path gains a parity scenario
   (§Test strategy) — today no `test/parity` scenario exercises `ignoreWhitespace` at all.
9. **The two arms agree, always.** For every fixture in §Pin E, `repo.diff({…})` and
   `repo.diff({…, withStat: true})` return the same survivor set, and both equal live git's.
   This is ADR-513's consistency invariant made executable over inputs that actually reach
   the disagreeing code (C7), not over two-line fixtures.
10. **Each fix commit flips only its own assertions.** P6, P7 and P8 each turn exactly one
    family of §Pin E rows from "documented divergence" into "agrees with git", and touch no
    other expectation. §Test strategy names the mechanism (a per-row `tsgitDivergence`
    override that the fix commit deletes) and §Part sequence names the rows.
11. **No new public surface.** `MAX_LINE_BYTES`, `MAX_LINES` and `BINARY_DETECTION_BYTES` are
    **public exports** (`src/public-types.ts`, `src/domain/diff/index.ts`, `reports/api.json`).
    Neither fix removes, renames or re-values them; `normalizeLine`, `linesEqualUnder`,
    `digestNormalizedLine`, `digestsEqual` and `LineDigest` keep their signatures. §D6 changes
    what `normalizeLine` *returns* under an active key — a behaviour change, documented in its
    ADR, with no `reports/api.json` churn.

## Design

### D1 — one synchronous chunk-fed scanner (`domain/diff/line-digest-scanner.ts`)

The predicate's per-side state machine is lifted out of the application layer, made
**synchronous**, and given a push API. It owns exactly what it owns today — buffering,
LF scanning with a resume cursor, the NUL window, the line caps, digesting, blank skipping —
and nothing about *where bytes come from*.

```ts
export interface LineDigestScanner {
  /** Feed the next chunk. Runs the incremental NUL-window scan. */
  push(chunk: Uint8Array): void;
  /** No more chunks will arrive. */
  end(): void;
  /** Next significant digest, or why not. Never throws. */
  next(): ScanStep;
  readonly binary: boolean;
}

type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' }   // only reachable before end()
  | { readonly kind: 'exhausted' };    // EOF *or* binary — the caller reads `.binary`
                                       // to tell them apart, exactly as the verdict
                                       // ladder does today
```

`createLineDigestScanner(key: LineKey, ignoreBlankLines: boolean): LineDigestScanner`.

The bodies of `concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`, `nextLine` and
`nextSignificantDigest` move **verbatim** apart from `await`/`Promise` removal and the
`needs-input` return that replaces `await state.iterator.next()`. `LineSourceState` loses
its `iterator` field and becomes the scanner's private state.

Why this shape settles §Requirements 1 and 5:

- **`scanForNul` is chunk-count-invariant.** `nulScanOffset` accumulates across pushes and
  `end = min(chunk.length, BINARY_DETECTION_BYTES - nulScanOffset)`, so N chunks and one
  concatenated chunk both scan exactly the first 8 000 bytes of the stream.
- **The pending-bytes cap is chunk-count-invariant.** The
  `currentLineBytes + buffer.length >= MAX_LINE_BYTES` check is only *reached* when
  `buffer.indexOf(LF, lfScanFrom) === -1`, i.e. when the buffer holds no terminator — so
  `buffer.length` is always the pending *unterminated* byte count, whether the buffer was
  filled by one push or fifty. A whole-blob push does **not** let a short-line file trip
  the cap.
- **`trackLineCaps`/`takeLine` are unchanged**; the terminated/unterminated split still
  comes from "was an LF found" vs "the exhausted branch", which both drivers reach the
  same way.

Home: `src/domain/diff/`, beside `line-diff.ts` whose `hasNulInWindow` / `exceedsLineCaps` /
`splitLines` this scanner mirrors, and beside `whitespace.ts` whose digest primitives it
consumes. Zero platform dependency, so it belongs in domain (ADR-551).

### D2 — the blob-source seam and the size gate

The gate cannot live in the predicate: from outside, a blob's size is unknowable without
reading it. It **can** live where the source is resolved, because there the size — or a
free proxy for it — is already in hand:

| storage form | what the resolution already knows, before inflating | cost of learning it |
|---|---|---|
| `ctx.deltaCache` hit | the full loose-format buffer | zero — it *is* the buffer |
| loose | `compressed.length`, from the `ctx.fs.read` **both** designs must perform (ADR-388) | zero |
| pack **base** entry | `header.size` (declared inflated size) **and** `nextOffset - offset` (exact compressed slice), from `readEntryHeaderWithChunk`, which `streamBlob` already calls | zero |
| pack **delta** entry | nothing pre-inflate — but ADR-386 already reconstructs it in full | n/a: always the buffered arm |

So a size gate placed in the source resolution **costs no I/O at all**. The brief's
objection ("a gate that costs a full read to decide not to read is not a gate") does not
apply: on the loose arm the read is mandatory for both designs, and on the pack arm the
entry header is parsed for both designs.

```ts
type BlobSource =
  // content already split from its header; `type` is the object's real type
  | { readonly kind: 'bytes';  readonly type: ObjectType; readonly content: Uint8Array }
  | { readonly kind: 'stream'; readonly stream: AsyncIterable<Uint8Array>;
      readonly materialised: boolean };

openBlobSource(ctx, id, maxBufferedBytes, options?): Promise<BlobSource>
```

The `bytes` arm carries **split** `{ type, content }`, not loose-format bytes, because the
four sources do not agree on framing: the delta-cache, loose and pack-delta arms hold
`<type> <size>\0<content>` (split with the existing `splitObject`), while a pack **base**
entry's inflated output is raw content with **no** header — its type comes from
`PackEntryHeader.type` and its canonical header (`blob <declaredSize>\0`) is synthesised
for hashing exactly as `yieldAndVerifyPackedBaseChunks` does today. Normalising to
loose-format instead would mean an extra whole-blob copy on the hottest arm.

Resolution order, gated:

0. **`ctx.deltaCache.get(id)` is consulted only when `maxBufferedBytes > 0`.** This is
   load-bearing for ADR-548: `streamBlob` passes `0`, so it keeps today's exact
   loose-first-then-pack precedence and never turns a cache hit into a `materialised: true`
   stream where it returns `materialised: false` today. A cache hit *above* the threshold
   is still returned as `bytes` — the buffer is already resident, so streaming it would
   save nothing.
1. loose: `looseCompressedBytes` → if `compressed.length <= maxBufferedBytes`,
   `ctx.compressor.inflate(compressed)` → `bytes`; else today's
   `createInflateStream` pipeline → `stream`.
2. pack base: if the gate passes, `ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`
   → `bytes`; else today's pipeline → `stream`.
3. pack delta: `resolvePackChain` → `bytes` (and the delta cache is populated as today).

The seam reports `type`; the blob-specific `UNEXPECTED_OBJECT_TYPE` refusal stays with the
callers (`streamBlob`'s wrapper and the predicate), so a future non-blob consumer is not
foreclosed. **Refusal *timing* is preserved per arm**, because today's differs: pack base
and pack delta refuse eagerly (`isBase`/`PACK_ENTRY_TYPE.BLOB`, `parseHeader` in
`streamFromBuffer`), while the streamed loose arm refuses lazily, on first drain, inside
`stripHeader`. The *buffered* loose arm necessarily refuses eagerly — it has the header in
hand — which is reachable only for sub-threshold objects and only from the predicate, which
awaits the verdict anyway, so no caller can observe the difference. `streamBlob` (gate `0`)
never reaches it. Hash verification is `ctx.hash.hashHex(<header ++ content>)` raising the
same `OBJECT_HASH_MISMATCH`; `checkAborted` fires at the same points.

**The seam does *not* adopt `resolveObjectBytes`'s virtual empty-tree short-circuit.**
`resolveObjectBytes` answers the empty-tree oid from `EMPTY_TREE_BYTES` without touching
disk; `streamBlob` today misses loose, misses the pack and raises `OBJECT_NOT_FOUND`.
Adopting the short-circuit would silently change that refusal to `UNEXPECTED_OBJECT_TYPE`.

`streamBlob(ctx, id, options?)` becomes `openBlobSource(ctx, id, 0, options)` plus a
"wrap a `bytes` arm as a one-chunk iterable" tail — with the cache probe gated off at
`0`, the only `bytes` arm it can reach is the pack-delta one, which is exactly where it
reports `materialised: true` today. Its observable contract is byte-for-byte unchanged,
and `test/unit/application/primitives/stream-blob.test.ts` must pass **unmodified**.

**Note on partial clones.** `readRawObject`/`readObject` carry a promisor lazy-fetch retry;
`streamBlob` does not. `openBlobSource` deliberately does **not** acquire one — adding it
would change refusal behaviour on the streamed arm too, and asymmetric lazy-fetch (small
blobs fetched, large ones not) would be worse than either. Reviewers should check this
(§Blind-spot 6).

### D3 — the predicate's two arms

```
isWhitespaceOnlyModify(ctx, change, lineKey, ignoreBlankLines):
  [oldSrc, newSrc] = await Promise.all([openBlobSource(ctx, change.oldId, T),
                                        openBlobSource(ctx, change.newId, T)])
  if both are 'bytes':  return compareBuffered(oldSrc.content, newSrc.content, …)  // 0 awaits
  else:                 return await compareStreamed(oldSrc, newSrc, …)           // today's loop
```

`compareBuffered` is fully synchronous: push each content slice into its scanner, `end()`,
then drain both with the existing verdict ladder (binary → both exhausted → one exhausted →
digest mismatch). Zero promises, zero microtasks, zero stream objects — which is what
removes the 16.4 % + 6.2 % + 4.4 % + 3.7 % of Pin A. `isWhitespaceOnlyModify` stays
`async` (the seam is async), so this arm is `return compareBuffered(…)` returning a plain
boolean; the streamed arm is `return await compareStreamed(…)` — never a bare
`return <promise>`, which is this repo's recurring workerd unhandled-rejection class.

`compareStreamed` keeps today's structure and its **concurrency**: both sides still advance
under one `Promise.all` per step, so a two-large-blob diff keeps overlapping its I/O.
What changes is that "advance one side to its next significant digest" now consults the
sync scanner first and only awaits when it answers `needs-input` — so the mixed case (one
sub-threshold buffered side, one huge streamed side) stops allocating and awaiting a
resolved promise for the buffered side on every line.

**Early-exit hygiene (brief item 2, demoted to non-perf).** `compareStreamed` calls
`iterator.return?.()` on both sides before returning early. `readableStreamToAsyncIterable`
already implements `return` as `reader.cancel()`, so this releases the reader and lets the
`createInflate` instance be collected instead of leaking until GC. Pin D-2 shows this is
worth **0 ms**; it is landed as resource hygiene and is *not* the fix.

### D4 — what happens to each hand-proven equivalent-mutant NOTE

| # | today's location | the proof's load-bearing premise | disposition |
|---|---|---|---|
| M1 | `concatBytes` — `if (a.length === 0) return b` (ConditionalExpression `false` variant) | `out.set(a, 0)` is a no-op when `a` is empty | **holds verbatim** under both drivers; the note moves with the function. The `true` variant stays a real killed mutant — the multi-push scanner tests keep killing it. |
| M2 | `scanForNul` — `nulScanOffset < BINARY_DETECTION_BYTES` (`true` variant, `<=` variant) | once `nulScanOffset ≥ 8 000`, `end ≤ 0` so the loop never runs | **holds verbatim**; independent of chunking. |
| M3 | `trackLineCaps` — `if (terminated) currentLineBytes = 0` (`true` variant) | this is the last `trackLineCaps` call for the line; the unterminated tail is the last line ever returned | **holds**, but the premise now cites the scanner's `exhausted` branch rather than `nextLine`'s. Note text updated to name the new structure. |
| M4 | `nextLine` — the pending-bytes cap, `Stryker disable next-line ArithmeticOperator,BlockStatement` | `buffer.length` only grows until the line completes | **holds, and is the one to re-verify by hand** against a *single whole-blob push* (see D1: the check is only reached when the buffer contains no LF). The plan must reproduce the proof against the buffered driver explicitly, not carry it. |
| M5 | `nextLine` exhausted branch — `terminated: false`, `Stryker disable next-line BooleanLiteral` | that call is always the last line returned; `currentLineBytes` is never read again | **holds verbatim**. |

The repo's known past defect is a proof silently falsified by a structure change
(sorted-array → heap). Every row above is re-derived against the sync scanner in the plan,
and each surviving `Stryker disable` keeps its `(mutator, line)` anchoring on the
**expression** line. ADR-552 settled this route and rejected both deleting the constructs and
carrying the notes forward. **P7 re-opens M4 specifically**: once the pending-bytes check stops
producing a `binary` verdict and starts producing `overflow` (§D7), its proof's conclusion
("the final verdict is unchanged") is about a different verdict and must be re-derived a second
time, in that commit — the perf slice's re-derivation does not cover it.

### D5 — layering

```
application/primitives/stream-blob.ts          application/primitives/internal/
  (public primitive, contract unchanged)         whitespace-drop-predicate.ts
                 │                                    │            │
                 └──────────────┬─────────────────────┘            │
                                ▼                                  ▼
        application/primitives/internal/          domain/diff/line-digest-scanner.ts
                  blob-source.ts                        (pure; no ports)
                                │                                  │
                                ▼                                  ▼
   object-resolver.ts · pack-registry.ts · ports/compressor   domain/diff/whitespace.ts
                                                              domain/diff/line-diff.ts
```

No new port, no new adapter method, no new public export, no `reports/api.json` churn. The
dependency rule (`repository → commands → primitives → domain`) is respected; the change
*removes* a domain-shaped state machine from the application layer.

### D6 — the C4 fix: a terminator difference is whitespace when the key is active

**The rule.** §Pin E-1: under every flag that makes git compare content at all — `-w`, `-b`,
`--ignore-space-at-eol`, `--ignore-cr-at-eol` — a difference in the **final line's terminator**
is ignorable, symmetrically (gained or lost). Under plain diff and under `--ignore-blank-lines`
alone it is significant. That maps onto exactly one predicate tsgit already has:
`lineKeyIsActive(key)` (`mode !== 'none' || ignoreCrAtEol`). So:

> **A line's trailing LF is part of its identity iff the line key is inactive.**

The rule can only ever bite the **last** line pair: `splitLines` and the scanner's `takeLine`
both produce a terminated line for every non-final line by construction, so `terminated` can
differ on no other index. That bounds the blast radius of the change to the final line of a
file and is the argument that no mid-file alignment moves.

**Where it lands — three sites, one commit.** The recommendation is DC-10 option A: put the
rule in `normalizeLine` and mirror it in `digestNormalizedLine`, so both consumers inherit it.

1. **`src/domain/diff/whitespace.ts` → `normalizeLine`** (the allocating form, the `withStat`
   twin). Today each mode branch re-appends the LF (`if (end < bytes.length) out.push(LF)`).
   Under an active key it must not: the normalized form of `a\n` and of `a` become the same
   bytes. The change is one guard threaded into the four `drop*`/`collapse*` helpers, or —
   smaller and provably uniform — one terminator strip applied to the switch's result:
   ```ts
   export function normalizeLine(bytes: Uint8Array, key: LineKey): Uint8Array {
     const normalized = normalizeUnderMode(applyCrRule(bytes, key), key);   // today's body
     return lineKeyIsActive(key) ? stripTerminator(normalized) : normalized;
   }
   ```
   This is what makes the **`withStat` twin** correct, and it is the site the review finding
   this repo keeps re-discovering would otherwise miss: `internOne`
   (`line-diff.ts:290`) interns `binaryStringOf(normalizeLine(line, key))`, so the last-line
   pair now interns to one id and Myers marks it *common*. For a file whose **only** difference
   is the terminator (`lf-gain`), `computeStatFields` then returns `added = deleted = 0` and
   `shouldDrop` fires — the stat arm reaches the predicate arm's verdict **through its own code
   path**, which is what ADR-513 requires. For a file that also carries a real change
   (`ctx-gain`), the counts fall from `2 2` to `1 1`, correcting the numstat divergence
   §Pin E-1 pinned; the file still survives on both tools.
2. **`src/domain/diff/whitespace.ts` → `digestNormalizedLine`** (the allocation-free twin, the
   predicate arm). The terminator must be suppressed **at construction**, not at comparison:
   `digestVerbatim`/`digestDropAllWs`/`digestCollapseRuns`/`digestDropTrailingWs` all fold the
   LF byte into the FNV hash when `terminated`, so leaving `terminated` in place and merely
   ignoring it in `digestsEqual` would still yield different hashes (`sp-no-eol` in §Pin E-1 is
   the fixture that proves this: both sides normalize to zero content bytes, and only the
   folded LF distinguishes them). Concretely: pass `terminated && !lineKeyIsActive(key)` as the
   `terminated` argument. `digestsEqual` is **unchanged** — which is deliberate, because
   `whitespace.test.ts`'s hand-built-digest case ("terminated differs, length and hash match →
   false") is what keeps the `a.terminated === b.terminated` conjunct a killable mutant once
   the predicate can no longer produce a `terminated: true` digest.
3. **`src/domain/diff/patch-serializer.ts` → `trailingNoNewline`** (the rendering twin). Once
   the last pair can be *common* with differing termination, the `context` branch's
   `(isLastOld && !oldHasTrailingNewline) || (isLastNew && !newHasTrailingNewline)` emits a
   `\ No newline at end of file` marker that git does not (§Pin E-1, `ctx-gain`). git's rule is
   **postimage only** — context text already comes from `newLines` (`patch-serializer.ts:208`),
   and the marker must too:
   ```ts
   if (edit.kind === 'context') return isLastNew && !ctx.newHasTrailingNewline;
   ```
   **Two `Stryker disable` directives on those exact lines are falsified by this commit.** Both
   proofs rest on the premise *"a byte-identical context match forces equal trailing-newline
   state"*, which is exactly what C4 stops being true. They must be **deleted**, not re-anchored:
   after the change the OR is gone, so there is nothing left to prove equivalent. This is the
   same failure mode ADR-552 guards against inside the perf slice, recurring in a file the perf
   slice does not touch — §Blind-spot 10.

**What else consumes the pair.** `LineDigest.terminated` has **no** reader outside
`digestsEqual`, and `digestNormalizedLine`/`digestIsBlank`/`digestsEqual` have no consumer
outside the drop predicate (verified across `src/`). `normalizeLine` has exactly three internal
consumers — `linesEqualUnder`, `isBlankLine`, `internOne` — plus its public export:
- `linesEqualUnder(a, b, key)` **inherits the rule** and thereby starts agreeing with git's
  `xdl_recmatch` under an active key. It has zero internal callers; this is a public
  behaviour change with no internal blast radius.
- `isBlankLine(line, key)` is `lfIndex(normalizeLine(line, key)) === 0` and is **unaffected**:
  a blank terminated line normalizes to empty under both old and new rules (`lfIndex('') === 0`),
  and a non-blank line's content length is unchanged. Verified against both call sites
  (`stat-fields.ts:39/44`, `patch-serializer.ts:225`).
- `internOne` is site 1's mechanism, above.

**Which assertions the fix commit flips.** `test/unit/domain/diff/whitespace.test.ts`: the
`normalizeLine` rows whose `expected` ends in `\n` — 8 of the 25 rows in that section, all of
them under an active key (the file's `{ mode: 'none', ignoreCrAtEol: false }` blocks at lines
264 and 459 are inactive and **must not move**, while the `{ mode: 'none', ignoreCrAtEol: true }`
block at line 290 **is** active and does) — plus the `expectedDigest` oracle helper
(lines 40–44), which derives `terminated` from
`normalizeLine`'s own output and therefore needs the same guard to stay an *independent*
oracle. The case at line 683 (`{ mode: 'none', ignoreCrAtEol: false }` — an inactive key)
**must not flip**, and the `digestsEqual` hand-built case at line 851 **must not flip**;
both are the regression net for the gating. `test/unit/domain/diff/patch-serializer.test.ts`:
the context-edit no-newline cases. `test/integration/diff-whitespace-modes-interop.test.ts`:
the C4 rows (§Part sequence). No `diff-trees.test.ts` case flips.

**Size.** ~15 lines of `src` across three files, two deleted Stryker directives, ~12 test rows.
Larger than "flip an assertion", but a single coherent commit. It is **not** a blocker.

### D7 — the C5 fix: the line caps are a memory bound, not a binary verdict

**The threat argument, stated first.** `MAX_LINE_BYTES` and `MAX_LINES` are not decoration,
and removing either without saying what it protected would be a security regression. What each
one actually buys, in the drop predicate:

| cap | what it protects | still needed once the drop verdict ignores it? |
|---|---|---|
| `MAX_LINES = 100 000` | **nothing, in the predicate.** Lines are consumed one at a time and `lineCount` is a counter; no allocation scales with it. It exists here only to mirror `line-diff.ts`'s `exceedsLineCaps`, where it *does* bound `splitLines`' array and the intern table. | **No.** Excluding it from the drop decision costs zero protection. |
| `MAX_LINE_BYTES = 65 536` | **a real memory bound.** The scanner accumulates an unterminated line in `state.buffer` until it finds an LF; `nextLine`'s pending-bytes short-circuit is the only thing stopping a 500 MB single-line blob (minified bundle, one-line JSON — the case its own comment names) from being buffered whole. Under ADR-553's `boundedMap(…, 32)` the exposure is 32 pairs × 2 sides × line size. | **Yes on the streaming arm. No on the buffered arm** — below ADR-549's gate both sides are *already* fully resident, so skipping the cap there adds exactly zero bytes to peak memory. |

So the fix is **not** "delete the caps". It is: **the caps stop deciding the verdict; the
memory bound survives where it is the only thing bounding memory.**

**The design (DC-11 option A).**

1. **`MAX_LINES` leaves the drop path entirely.** `trackLineCaps` stops setting `binary` on the
   line count. Zero threat delta (row 1 above), and it retires the `lines-100000` divergence on
   both arms.
2. **`MAX_LINE_BYTES` stops setting `binary` and starts signalling *overflow*.** The scanner's
   `ScanStep` gains a fourth kind:
   ```ts
   type ScanStep =
     | { readonly kind: 'digest'; readonly digest: LineDigest }
     | { readonly kind: 'needs-input' }
     | { readonly kind: 'overflow' }      // pending unterminated bytes hit the buffer bound
     | { readonly kind: 'exhausted' };
   ```
   `overflow` is **not** `binary` — `binary` still means exactly what git means by it
   (NUL in the first `BINARY_DETECTION_BYTES`), and a `binary` side is still never dropped.
   On the **buffered** arm the bound is not armed at all (the bytes are already resident, so
   the scanner is constructed with the bound disabled) and `overflow` is unreachable — this is
   what makes `tail-ws`, `len-*` and `lines-*` simply work. On the **streaming** arm the bound
   stays at `MAX_LINE_BYTES` and `overflow` means "I cannot answer this cheaply".
3. **`overflow` escalates; it does not answer.** `compareStreamed` abandons both scanners and
   falls back to a materialised comparison of the two blobs — `readBlob` both sides, run the
   same scanner over them with the bound disabled. Peak memory in that case equals **git's own
   posture** (git's `xdiff` has no streaming mode; it holds both blobs in memory to diff them
   at all), so the worst case is not novel exposure — it is the exposure any faithful answer to
   this question implies. It is reached only for a blob that is both over 64 KiB compressed
   *and* contains a >64 KiB line, it costs one extra full read **per pair** (not per line), and
   that read is `readBlob`, so it inherits the adapter's existing `MAX_INFLATED_OBJECT_BYTES`
   (2 GiB) refusal rather than inventing a new bound. `rand-1line` (§Pin E-2, 80 045 B on disk)
   is exactly that fixture. The escalation is also where `ctx.signal` is re-checked, so abort
   granularity on the pathological path is no worse than `readBlob`'s (§Blind-spot 7).
4. **The `withStat` twin — the stat arm's verdict source (DC-13 option A).** `applyStatPass`
   and `materialisedShouldDrop` derive the drop verdict from `computeStatFields`, whose
   `binary` flag is `isBinary(old) || isBinary(next)` — line caps included — and whose
   `added`/`deleted` come from `diffLines`, which independently refuses `M + N > MAX_DIFF_LINES`.
   Both make the stat arm answer differently from the predicate arm (C5 via the caps, **C7** via
   `MAX_DIFF_LINES`). The fix routes the stat arm's *verdict* through the same scanner:
   ```
   dropVerdict(file, lineKey, ignoreBlankLines) =
     file.numstatBinaryOverride === 'binary' ? false
     : hasNulInWindow(old) || hasNulInWindow(next) ? false
     : scanEqual(old, next, lineKey, ignoreBlankLines)   // the P1 scanner, bound disabled
   ```
   `stats` keeps being computed exactly as today and keeps populating the `withStat` surface;
   only the *keep/drop* decision moves off it. Consistency then holds **by construction** —
   the same statement ADR-551 makes about the perf slice's two arms, extended to the third.
   The `.gitattributes` overrides keep their meaning (`-diff` ⇒ forced binary ⇒ never dropped),
   which `diff-whitespace-modes-interop.test.ts`'s attribute suite already pins.
5. **`line-diff.ts`'s own use of the caps stays unchanged — deliberately.** `exceedsLineCaps`,
   `hasNulInWindow` and `isBinary` keep today's values and today's meaning for
   `computeStatFields`' `binary` field, `materialise-patch-files`, `patch-id`, `grep`,
   `three-way-content`, `range-diff` and the patch `Binary files … differ` surface. **The two
   uses legitimately diverge**, and this is the design saying so explicitly: the drop decision
   asks "does any significant line differ", which is O(bytes) and needs no cap; the diff asks
   "produce an alignment", which is O((M+N)·D) and does. Keeping `isBinary` as-is leaves the
   C8 residual (`- -` numstat on over-cap files, a **plain-path** divergence with no whitespace
   flag involved) exactly where it is today — see DC-14 and §Out of scope.

**Interaction with ADR-549's compressed gate — both arms, proved by fixture.** A 70 000-byte
line of repeated bytes is 345 B on disk (§Pin E-2) and takes the **buffered** arm; an
80 003-byte incompressible line is 80 045 B on disk and takes the **streaming** arm. The fix
works on both because the cap disposition is per-arm by construction (bound disabled where the
bytes are resident, escalation where they are not), and both fixtures land in the interop suite
so neither arm can regress silently. A fixture that only exercises the compressible case would
leave the escalation path untested — which is the specific way this fix could ship half-done.

**Which assertions the fix commit flips.** `test/unit/application/primitives/diff-trees.test.ts:1728-1749`
— *"Given a single unterminated line longer than the line cap, whitespace-only change … Then the
file is kept (binary via the incremental cap, never buffered whole)"* — inverts to **dropped**,
and its comment's claim about the pending-bytes bail becomes a claim about escalation. The
scanner's own cap tests (P1, moved there by ADR-556) split into two groups: the *memory* bound
(still asserted, on a bound-armed scanner) and the *verdict* (asserted to be unaffected by line
length or line count). `test/integration/diff-whitespace-modes-interop.test.ts` C5 and C7 rows.
No `whitespace.test.ts` case flips.

**Size, honestly.** ~40 lines of `src` across the scanner, the predicate and `diff-trees.ts`,
plus the escalation path and its tests. Step 4 is real surgery on `applyStatPass` and is the
part that could argue for splitting P7 into **P7a** (predicate arm: caps out of the verdict,
overflow escalation) and **P7b** (stat arm: verdict source). Both orderings keep ADR-554's
"perf slice first, verdict changes after" property. It is at the upper edge of one commit but
**not** a blocker; §Part sequence carries the split as the default and notes it can collapse.

### D8 — the C6 fix (conditional on DC-12)

`--ignore-cr-at-eol` ignores a CR **only immediately before a real newline**. tsgit's
`applyCrRule` (`whitespace.ts:100`) and its allocation-free twin `digestContentEnd`
(`whitespace.ts:173`) strip a trailing CR without asking whether the line is terminated.
Under `all`/`change`/`at-eol` that is harmless — a trailing CR is ordinary trailing whitespace
there and git drops it too (§Pin E-1, `cr-no-eol` under `-w`/`-b`/`at-eol`: both drop). Under
`ignoreCrAtEol` with `mode: 'none'` it is an observable wrong drop.

The fix is one condition, applied to both twins:

```ts
const crApplies = key.mode !== 'none' || (key.ignoreCrAtEol && terminated);
```

`applyCrRule` currently does not know `terminated`; it is `lfIndex(bytes) < bytes.length`,
already computed by `lfIndex` inside `dropTrailingCr`, and already computed as `end` in
`digestNormalizedLine`. Same two functions as D6 — which is why DC-12 asks whether this rides
in the C4 commit or its own. `test/unit/domain/diff/whitespace.test.ts:698` ("Given
ignoreCrAtEol true with mode none, When digesting a CR-terminated line") stays green (that line
*is* terminated); the flipping cases are the unterminated-CR rows at lines 312–325.
~4 lines of `src`.

## Decision candidates

DC-1 … DC-9 are **settled** — see §Settled decisions and ADRs 548–556. The five below are
raised by §D6/§D7/§D8 and by §Pin E's three new findings, and are the user's to settle.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-10 | Where the C4 terminator rule lives, and how far the fix reaches | **A** in `normalizeLine`, mirrored in `digestNormalizedLine` — one rule, `internOne`/`linesEqualUnder` inherit it; plus the `trailingNoNewline` postimage fix · **B** leave `normalizeLine` byte-stable; apply the rule at the two comparison sites only (`digestNormalizedLine`, and a terminator strip inside `internOne`), plus `trailingNoNewline` · **C** drop-verdict only — fix `digestNormalizedLine` and let DC-13's stat-arm reroute carry the other arm; `normalizeLine`, interning, numstat and patch bytes untouched | **A** | A is the DRY answer and the faithful one: `linesEqualUnder` starts agreeing with git's `xdl_recmatch` under an active key, and the `expectedDigest` test oracle (which derives `terminated` from `normalizeLine`'s own output) stays an *independent* oracle instead of needing a second rule bolted on. Measured churn is small — 8 of 25 `normalizeLine` rows. Its cost is a **public behaviour change**: `normalizeLine`/`linesEqualUnder` return different bytes under an active key (no signature or `reports/api.json` change; §Requirements 11). B avoids that at the price of two rules that must never drift — the exact failure mode ADR-551 was written to prevent, one layer down. **C is the minimal option and is not faithful enough**: §Pin E-1 pins tsgit reporting `2 2` where git reports `1 1` under `-w`, and `added`/`deleted` are structured data the prime directive binds. **USER DECISION** — A moves a public function's observable output. |
| DC-11 | What happens to `MAX_LINE_BYTES` in the drop predicate (the DoS-cap trade) | **A** the caps stop deciding the verdict; the per-line buffer bound survives **only on the streaming arm**, where tripping it signals `overflow` and escalates to a materialised comparison · **B** delete the cap from the predicate outright — simplest diff, unbounded per-line buffering on the streaming arm · **C** make the in-line digest fold incremental (tentative/committed hash pair) so no line is ever buffered — O(1) memory, no cap needed on either arm | **A** | The cap is a real bound on the streaming arm and none at all on the buffered arm (below ADR-549's gate the bytes are already resident), so A pays for protection exactly where it buys something. Its worst case — one extra full read of a pair that is both >64 KiB compressed *and* holds a >64 KiB line — lands on **git's own memory posture**, since `xdiff` has no streaming mode and holds both blobs to diff them at all; that is the floor for any faithful answer to this question. **B is a genuine security regression**: 32 concurrent pairs × 2 sides × an unbounded line (a minified bundle is the ordinary case here, not the adversarial one) with nothing between it and the heap. **C is the best end state and the biggest change** — it rewrites the four digest folders ADR-551 just moved verbatim and deletes `takeLine`, re-opening that decision one commit after taking it; if C is chosen it should displace part of P1, not follow it. **USER DECISION** — A and B differ in security posture; C re-opens ADR-551. |
| DC-12 | C6 (`--ignore-cr-at-eol` ignores a CR ending an *incomplete* line, where git does not) — a **new** divergence §Pin E-1 uncovered | **A** fix it in this PR as its own ordered commit (P8) with its own ADR and interop row · **B** fold it into the C4 commit — same two functions (`applyCrRule`, `digestContentEnd`), same eol-boundary family · **C** file it; this PR ships C4 and C5 only | **A** | The standing default is no follow-ups, and this is ~4 lines of `src` with its fixture already pinned, so C is hard to justify. A over B because ADR-554's whole argument is that each verdict change must be its own visibly-flipping diff — folding a second rule into C4's commit is exactly the merge that argument rejects, and the two rules are independent (one is about the terminator, one about a CR before it). B is defensible purely on locality. **USER DECISION** — C6 was not in scope when ADR-554 was taken. |
| DC-13 | Where the `withStat` arm's **drop verdict** comes from | **A** the shared P1 scanner over the materialised buffers — `stats` still computed as today for the `withStat` surface, only keep/drop moves · **B** give `computeStatFields` a `binaryDetection: 'nul-only'` option used solely for the drop decision · **C** leave it on `computeStatFields` and accept the arm disagreement | **A** | A makes the two arms consistent **by construction** — ADR-513's requirement, and ADR-551's own argument applied to the third code path — and it retires **C7** (a live `main` disagreement: `lines-99999` is dropped by the predicate arm and kept by the stat arm under `-w`) as a side effect. B fixes the cap half but leaves `MAX_DIFF_LINES`, so C7 survives B. C leaves a pinned inconsistency standing and is listed only because it is the do-nothing option. Cost of A: `applyStatPass`'s comment "the stat and drop predicate share one `computeStatFields` call so drop and counts are mutually consistent" stops being the mechanism and must be rewritten. **USER DECISION** — A changes how a second surface computes its verdict. |
| DC-14 | C8 — `--numstat` reports `- -` for over-cap files where git reports real counts, **on the plain path, with no whitespace flag involved** | **A** leave it; §Out of scope names it, no ticket · **B** fix it here by taking the line caps out of `isBinary` too · **C** file a backlog item | **C** | This is the warn-and-ask the standing "no follow-ups" default reserves for work that really should not ride along. B changes `isBinary`, which also decides `three-way-content`'s merge refusal, `grep`'s binary skip, `patch-id`, `range-diff` and the `Binary files … differ` patch surface — a blast radius several times this PR's — and it would not even finish the job: a 100 001-line file would then reach `diffLines`, exceed `MAX_DIFF_LINES` and degrade to `wholeFileFallback`, so faithful counts need that cap re-examined too. A leaves a pinned divergence with no owner, which this repo's history argues against. **USER DECISION** — C deviates from the no-follow-ups default; B deviates from bounded scope. |

## Test strategy

- **P1 scanner (unit, `test/unit/domain/diff/line-digest-scanner.test.ts`).** Every case
  today's `whitespace-drop-predicate.test.ts` drives through `chunkedStream` moves here and
  becomes synchronous: LF at a chunk boundary; a line split across three pushes; NUL in the
  first 8 000 bytes vs at byte 8 001 vs straddling a push boundary; `MAX_LINE_BYTES`
  reached by one long line, by a pending unterminated tail, and *not* reached by many short
  lines in one whole-blob push (the M4 re-proof, as an executable test); `MAX_LINES`;
  unterminated final line; `ignoreBlankLines` skipping a spaces-only line under a whitespace
  mode but not under `'none'`; empty blob; blob that is a single LF. Guard clauses get
  **isolated** tests per operand (`currentLineBytes >= MAX` and `lineCount >= MAX`
  separately). Error data asserted via try/catch on `.data`, never bare `toThrow(Class)`.
  **Write the cap cases knowing P7 will re-partition them** (§D7): today one assertion couples
  "the buffer stopped growing" to "the verdict is binary". Keeping those two claims in separate
  `it`s from the start means P7 edits the verdict half and leaves the memory half untouched,
  instead of rewriting the block.
- **Differential oracle (unit, `line-digest-scanner.properties.test.ts`).** CLAUDE.md lens
  **2** (compositional matcher/aggregator) and lens **4** (idempotence/counting invariant)
  both fit; lens 1 (round-trip) and lens 3 (totality over a grammar) fit the scanner too.
  Properties, `numRuns: 100` (the chunk-split one at 200):
  1. *chunk-split invariance* — for an arbitrary byte string `b` and an arbitrary partition
     of `b` into chunks, the digest sequence and final `binary` flag are identical to
     pushing `b` whole. **This is the requirement-1 guarantee expressed as a property**, and
     it is not a tautology: the oracle is the same scanner fed differently, which is exactly
     the invariant that matters.
  2. *agreement with the allocating reference* — for arbitrary lines and an arbitrary
     `LineKey`, `digestsEqual(scan(a), scan(b))` agrees with
     `linesEqualUnder(a, b, key)` (the independently-tested `normalizeLine` + `bytesEqual`
     pair — a genuinely separate implementation, not a copy of the SUT).
  3. *totality* — over the safe subset (bytes without NUL, under the caps) the scanner
     never throws and always terminates.
  Generators live in a shared `test/unit/domain/diff/arbitraries.ts`; no seed committed.
- **P3 predicate (unit).** Arm selection: a sub-threshold pair takes the buffered arm and
  builds **no** stream; an over-threshold side takes the streamed arm; a mixed pair takes
  the streamed arm. Content edges on both arms: one side empty, both sides empty, a side
  that is a single LF, a side with no trailing LF. Error identity: missing oid, tree oid,
  the empty-tree oid, corrupted loose object, aborted signal — asserted on **both** arms
  with the same `.data` (§Requirements 2). Verdict identity: the whole of today's predicate
  suite re-run once per arm by varying only the threshold constant — a sub-threshold blob
  forced onto the streaming arm must return the identical boolean.
- **P2 seam (unit).** `openBlobSource` on: delta-cache hit **with the gate open and with it
  at 0** (the probe must be skipped at 0 — §D2 step 0, the property that keeps
  `streamBlob` unchanged), loose under/over the gate, pack base under/over the gate, pack
  delta (always `bytes`), missing oid, non-blob oid, empty-tree oid, `verifyHash` on/off,
  aborted signal. Header framing per arm: the pack-base arm's `bytes` must be raw content
  with the synthetic `blob <size>\0` used only for hashing; the other three split with
  `splitObject`. `streamBlob`'s existing suite
  (`test/unit/application/primitives/stream-blob.test.ts`, 40+ cases) is the regression net
  proving the public contract did not move — **it must pass unchanged**.
- **Faithfulness (integration).** The two existing interop suites are the authority and
  must stay byte-identical: `test/integration/diff-whitespace-interop.test.ts` (the full
  W/B/EOL/CR/BL/M/D/C matrix, name-status + numstat + quiet + reconstructed patch bytes vs
  live `git diff --no-ext-diff --no-color <mode>` and frozen goldens) and
  `test/integration/diff-whitespace-modes-interop.test.ts` (predicate path *and*
  `withStat` path agreeing with each other and with git across all five flags). **They
  cover the fast path automatically** — their blobs are all far under any sensible
  threshold, so today they exercise the streaming arm and after this change they exercise
  the buffered arm. To keep *both* arms pinned against git, the suites gain a
  threshold-forced second pass (same fixtures, gate set to 0) — otherwise the streaming arm
  loses its only cross-tool coverage.
- **Faithfulness — the divergence ledger (integration).** `diff-whitespace-modes-interop.test.ts`
  is scenario-driven (`SCENARIOS` × one `mode-only.txt` + one `real.txt`, asserting
  predicate-survivors === stat-survivors === live-git-survivors). Pin C's and Pin E's fixtures
  cannot be added as plain rows during the perf slice: the suite compares tsgit to git, and on
  them tsgit is wrong today. The perf slice therefore extends `Scenario` with a per-fixture
  **`tsgitDivergence`** field — the survivor set tsgit is *known* to return, asserted alongside
  git's, so the suite stays green while pinning the divergence as a fact rather than hiding it.
  **Each fix commit deletes exactly its own `tsgitDivergence` entries**, which is the visible
  statement of what it changed (§Requirements 10). Fixtures, all from §Pin E, all with their
  git verdict already pinned:
  - **C4 (P6):** `lf-gain`, `lf-loss`, `lf-gain-multi`, `sp-no-eol`, `tab-no-eol` across `-w`,
    `-b`, `--ignore-space-at-eol` and `--ignore-cr-at-eol`; `lf-gain-empty` and
    `lf-gain-plus-txt` as **controls that must not move**; `ctx-gain`/`ctx-loss` asserted on
    `withStat` counts (`1 1`, not `2 2`) **and** on reconstructed patch bytes (marker present
    for `ctx-loss`, absent for `ctx-gain` — §Pin E-1).
  - **C5 (P7):** `tail-ws` (345 B on disk → **buffered** arm) and `rand-1line` (80 045 B on
    disk → **streaming** arm, exercising the `overflow` escalation), plus `len-65536` and
    `lines-100000`; `long-line-txt` as the control that must keep surviving. Both arms are
    mandatory — a compressible-only fixture set leaves the escalation path unproven, which is
    the specific way this fix could ship half-done.
  - **C7 (P7, via DC-13):** `lines-99999`, the one row whose divergence is *arm-specific*
    (predicate drops, stat keeps). It is what makes §Requirements 9 executable.
  - **C6 (P8, conditional on DC-12):** `cr-no-eol` under `--ignore-cr-at-eol`, with its
    `-w`/`-b`/`--ignore-space-at-eol` rows as controls that must not move.
  Setup cost: the 100 000-line and 80 KB fixtures make the shared `beforeAll` heavier. It
  already carries an explicit `beforeAll(fn, 60_000)` — keep it and re-check the margin, since
  git-spawning setup hooks on this repo have timed out before.
- **The fixes' unit coverage.** P6: `normalizeLine`/`digestNormalizedLine` over the four active
  key shapes × {terminated, unterminated} × {blank, non-blank}, with the **inactive** key
  asserted unchanged (that gate is the whole fix); `trailingNoNewline` context edits for a
  gained and a lost terminator; `linesEqualUnder` and `isBlankLine` regression cases. P7: the
  scanner's cap behaviour split into *memory* (bound armed ⇒ `overflow` at the bound, buffer
  never exceeds it) and *verdict* (bound disarmed ⇒ neither line length nor line count ever
  yields `binary`), isolated per-operand; the stat arm's `dropVerdict` for a NUL side, a
  `-diff`-override side, and an over-`MAX_DIFF_LINES` pair. P8: the CR rule ×
  {terminated, unterminated} × the four key shapes.
- **Cross-adapter (parity).** No `test/parity` scenario touches `ignoreWhitespace` today
  (§Requirements 8). Extend `test/parity/scenarios/diff-pipeline.scenario.ts` with a
  whitespace-only modified pair and assert the surviving paths — this is what catches an
  adapter whose `Compressor.inflate` behaves differently (and it is the suite that catches
  the workerd `return`-without-`await` class of failure; `test:parity:workers|deno|bun` are
  **not** in `npm run validate` and must be run explicitly, since P4/ADR-555 touch adapters).
- **Mutation.** The gate comparison (`<=` vs `<`), the arm-selection branch, and the
  scanner's index arithmetic are mutation-dense; each boundary gets an explicit test rather
  than a documented equivalence. §D4's five proofs are re-derived, not carried. Two more
  proofs die in P6: `patch-serializer.ts::trailingNoNewline`'s pair of `Stryker disable`
  directives rest on *"a byte-identical context match forces equal trailing-newline state"*,
  which C4 falsifies — they are **deleted with the OR they guarded**, not re-anchored
  (§D6 step 3). After P6, `digestsEqual`'s `a.terminated === b.terminated` conjunct is
  unreachable-by-the-predicate but stays killable through `whitespace.test.ts`'s hand-built
  digest case; if that case were ever deleted the conjunct would become a survivor, so it is
  load-bearing and must be labelled as such.

### Measurement protocol (requirement 7)

1. **New bench** — `test/bench/diff-whitespace.bench.ts` gains a
   *many-small-modified-pairs* scenario, because the existing one never reaches the
   predicate (Pin D-3). Shape: a **scratch** repo built through the library's own API in
   `test/bench/support/write-scratch.ts` style — N files × ~56 bytes across N/50
   directories, committed, then rewritten whitespace-only and committed — **not** a
   mutation of the shared `~/.cache/tsgit-bench` fixture (`buildWideModifyTreeId`'s
   deterministic-write trick would add 20 000 loose objects to a cache every other bench
   shares). Two variants: loose (as committed) and packed (`git repack -ad`), because Pin B
   shows they exercise different resolution arms and the packed one is the realistic
   megarepo. Built **once** at module scope and reused across iterations (the 2 500-file
   build measured a few seconds); torn down in `afterAll`. Keep the existing add-shaped
   scenario as a non-regression watch, relabelled so its "measures the whitespace path"
   claim is no longer implied (Pin D-3).
2. **Go/no-go, in-PR** — before(`main`) vs after(branch), same host, ≥2 runs, absolute
   wall-clock, both variants, recorded in the PR body. Target: loose ≤ 130 ms, packed
   ≤ 100 ms cold (from 258 / 165 ms), no regression on `diff.bench.ts`,
   `diff-recursive.bench.ts`, `pack-read.bench.ts`, `loose-read.bench.ts`.
3. **Re-profile** — `npm run profile` after landing; the `NodeError` /
   `NodeError` and the three web-streams-module frames should leave the digest
   entirely for this workload. Published numbers come from the **nightly `bench.yml`
   artifact**, never a loaded local session.
4. **Non-goal** — beating native git. On the packed variant native is 77 ms and the
   projection is ~91 ms cold; the residual is the loose/pack read itself plus the
   containment gate (Pin A, ~4.9 %), not this design's business.

## Part sequence

One PR, one branch, ordered commits. `⇢` = strictly depends on; parts on the same wave carry
no dependency on one another and can be implemented in parallel.

| wave | part | what lands | depends on |
|---|---|---|---|
| 1 | **P1** | `src/domain/diff/line-digest-scanner.ts` — the sync scanner, its example tests, its property tests, `arbitraries.ts`. The five §D4 proofs re-derived here (ADR-552). No caller yet. | — |
| 1 | **P2** | `src/application/primitives/internal/blob-source.ts` — `openBlobSource`; `stream-blob.ts` re-expressed over it. `stream-blob.test.ts` passes **unmodified** (ADR-548). | — |
| 1 | **P5a** | `test/bench/diff-whitespace.bench.ts` — the many-small-modified-pairs fixture, loose + packed variants; existing add-shaped scenario relabelled (Pin D-3). Runnable on `main` to capture the before-number. | — |
| 1 | **P4a** | ADR-555's bench only: `inflateZlibMember` vs native `DecompressionStream` on large inputs, browser + memory. Produces the **recorded decision**, changes no adapter. | — |
| 2 | **P3** | `whitespace-drop-predicate.ts` — the two arms, `compareBuffered` / `compareStreamed`, `iterator.return?.()` hygiene. **This is the commit whose diff must show zero verdict movement** (ADR-554). | ⇢ P1, P2 |
| 3 | **P5b** | Go/no-go: before(`main`)/after(branch), both variants, ≥2 runs, PR body. Re-profile. | ⇢ P3, P5a |
| 3 | **P3t** | Interop threshold-forced second pass (both arms pinned against git); the `tsgitDivergence` ledger seeded with every §Pin C/§Pin E row **at today's verdicts**; parity scenario for `ignoreWhitespace`. | ⇢ P3 |
| 3 | **P4b** | ADR-555's conditional branch: reimplement browser/memory `inflate`, or record "bench said no, option A taken". If taken, run `test:parity:workers\|deno\|bun` explicitly — they are not in `npm run validate`. | ⇢ P4a |
| 4 | **P6** | **C4 fix** (§D6) + ADR. Deletes the C4 `tsgitDivergence` entries. | ⇢ P3t |
| 5 | **P8** | **C6 fix** (§D8) + ADR — *conditional on DC-12→A*; slotted here because it touches the two functions P6 just changed, so it rebases cheapest immediately after. Under DC-12→B it disappears into P6; under DC-12→C it leaves the PR. | ⇢ P6 |
| 6 | **P7a** | **C5 fix, predicate arm** (§D7 steps 1–3) + ADR: caps out of the verdict, `overflow` escalation. Deletes the C5 `tsgitDivergence` entries for the predicate arm. | ⇢ P6 |
| 7 | **P7b** | **C5 fix, stat arm** (§D7 step 4, DC-13): `dropVerdict` off `computeStatFields`. Deletes the remaining C5 entries **and** the C7 entry. | ⇢ P7a |

Notes the planner needs:

- **Wave 1 is fully parallel** and is where the bulk of the new code is. P1 and P2 never import
  each other; P3 is the only thing that joins them.
- **P6 must precede P7** (ADR-554 names that order) and both must follow the whole perf slice
  including P3t — the ledger has to exist before a commit can delete rows from it.
- **P7a/P7b may collapse into one commit** if the reviewer prefers; the split exists because
  step 4 is surgery on `applyStatPass` while steps 1–3 are contained to the scanner and the
  predicate. Collapsing does not violate ADR-554 (still one verdict family, still after P6).
- **Waves 4–7 are one part each**, so "wave" there means commit order on the branch, not
  parallelism. P8 and P7a are in fact *independent* of each other (different functions, same
  predecessor P6); P8 is sequenced first only because it lands in the two functions P6 just
  touched and rebases cheapest there. Swapping them costs nothing but rebase noise.
- **P8 is the only part gated on an unsettled decision that changes the part list itself.**
  P7's shape depends on DC-11 and DC-13, but it exists under every option.
- **If DC-11→C is chosen**, the incremental-fold rewrite belongs **inside P1**, not in P7 —
  it changes the scanner ADR-551 describes, and building it twice would be waste.
- **Repo gates.** No part adds a public export, so `reports/api.json` should not move; if it
  does, something leaked into `src/public-types.ts`. `line-digest-scanner.ts` is internal to
  `domain/diff/` and must **not** be added to `src/domain/diff/index.ts`'s public re-exports.
  `check:test-pyramid`, `check:doc-typedoc` and `cspell` run on the whole diff, not per part.

## Blind-spot checklist — what a reviewer should attack

1. **Zip-bomb amplification through the gate (ADR-549).** A 64 KiB compressed loose object can
   inflate to gigabytes; the fast path materialises it where the streaming path would not.
   Attack: is the "every other read path already does this" argument actually true for the
   *concurrent* case (32 pairs × 2 sides in flight)? Peak is now 64 × inflated-size, not
   1 × inflated-size.
2. **Hash verification silently weakened.** Confirm the buffered arm verifies with the same
   default (`verifyHash` true) and raises `OBJECT_HASH_MISMATCH` with the same `.data`.
   A buffered read that skips verification "because it's small" is a supply-chain hole.
3. **Type-confusion parity.** `streamBlob` refuses a non-blob oid in *three* different
   places (loose `stripHeader`, pack `isBase` + `PACK_ENTRY_TYPE.BLOB`, delta
   `streamFromBuffer`/`parseHeader`). Check every arm of `openBlobSource` refuses
   identically — a tree oid reaching the scanner as "content" would be a silent wrong answer,
   not a crash. Specifically check the **empty-tree oid**: `resolveObjectBytes` answers it
   virtually from `EMPTY_TREE_BYTES`; the seam must not inherit that, or today's
   `OBJECT_NOT_FOUND` silently becomes `UNEXPECTED_OBJECT_TYPE` (§D2).
4. **Loose-first precedence.** `streamBlob` probes loose *first*; `openBlobSource` probes
   the delta cache first (mirroring `resolveObjectBytes`). Confirm that cannot serve a
   stale object after an external `git gc` + rewrite — and that the fanout-cache
   invalidation caveat (a `Context` built before a foreign `git` write sees a stale loose
   set) is unchanged.
5. **Chunk-count invariance.** The two proofs in §D1 (`scanForNul`, the pending-bytes cap)
   are the load-bearing correctness claims. Attack them with a file whose total length
   exceeds `MAX_LINE_BYTES` but whose every line is short, and with a NUL at byte 8 000 vs
   8 001, on both arms.
6. **Partial clones.** The buffered arm is one call away from `readRawObject`'s promisor
   lazy-fetch retry; if it acquires one, small blobs get lazy-fetched and large ones do not.
   Confirm the seam does *not* retry (§D2).
7. **Abort responsiveness.** Today a long blob is abandoned mid-stream on
   `ctx.signal.aborted`; the buffered arm checks only at the resolution boundary. Confirm
   the gate keeps abort granularity acceptable — the sub-threshold case is bounded by the
   threshold, so this is only a question above it.
8. **Workerd / Deno / Bun.** P4 and ADR-555 touch adapters, and the parity suites are **not**
   in `npm run validate`. The recurring failure class on this repo is `return <promise>`
   without `await` in an `async` function → a workerd unhandled rejection while every test
   passes. Concrete site here: `isWhitespaceOnlyModify`'s streamed arm
   (`return await compareStreamed(…)`, §D3) and every arm of `openBlobSource` that tails
   into an inner async call.
9. **ADR-554 ordering.** Verify the perf commit (P3) shows *zero* verdict change on its own —
   the whole safety argument for the perf slice is "the oracle did not move". The mechanical
   check: P3's diff touches no `tsgitDivergence` entry.
10. **P6's falsified proofs.** `patch-serializer.ts::trailingNoNewline` carries two
    `Stryker disable` directives whose shared premise ("a byte-identical context match forces
    equal trailing-newline state") C4 destroys. Confirm they are **deleted**, not moved — a
    re-anchored directive on the new line would suppress a live mutant. This is the same
    structure-falsifies-a-carried-proof failure this repo has already shipped once, in a file
    the perf slice does not otherwise touch.
11. **C4's write-path twin, concretely.** The read-path fix (`digestNormalizedLine`) and the
    twin (`normalizeLine` → `internOne` → the `withStat` arm) must be in the **same commit**.
    The executable check is `diff-whitespace-modes-interop.test.ts`'s
    `survivorPaths(predicateResult) === survivorPaths(statResult)` on the C4 rows: a
    read-path-only fix turns that assertion red rather than passing quietly.
12. **C5's threat argument.** Attack §D7's table directly. Is `MAX_LINE_BYTES` really the only
    thing bounding the streaming arm's per-line buffer? Is `overflow`'s escalation path
    genuinely bounded (one extra `readBlob` per pair, not per line)? Under DC-11→B, compute
    32 × 2 × the largest line in a realistic minified bundle and decide whether that number is
    acceptable — it is the whole content of the option.
13. **`overflow` is not `binary`.** Confirm the new `ScanStep` kind never reaches the verdict
    ladder as "binary" and never causes a **drop** by itself. A file that overflows must be
    answered by the escalation, not by a default — a default in either direction is a silent
    wrong answer on exactly the inputs the cap was hiding.
14. **The stat arm's counts after DC-13→A.** `stats` is still computed by `computeStatFields`
    and still populates `withStat`. Confirm a change that is *dropped* by the new `dropVerdict`
    can never surface counts (it is filtered out), and that a change that survives carries
    exactly today's counts — the fix moves the verdict, not the numbers.

## Out of scope

- **The loose-read containment gate** (`realpath` + `isContainedInAnyRoot`, ~4.9 % of Pin A).
  Paid identically by both designs, already investigated and partly reverted in 26.4, and
  absent entirely on packed repos.
- **The `.gitattributes` per-path resolution in `changeShouldDrop`.** `loadDir` caches per
  directory, so it is O(distinct directories), not O(changes); it did not surface in Pin A.
- **`core.bigFileThreshold`.** ADR-385 established tsgit does not honour it anywhere; this
  design's threshold is an internal memory bound, deliberately not that knob, and not
  user-configurable (adding an option would be a public-surface change — §Requirements 4).
- **The `withStat` / `materialisePatchFiles` path, *for performance*.** Untouched by the perf
  slice: it already materialises both sides by construction and intern-Myers is a different
  cost profile (ADR-513). P6 and P7b do change its **verdict** — that is the point of the
  write-path twin, not a scope creep.
- **C8 — `isBinary`'s line caps on the numstat/patch surface** (DC-14). tsgit reports `- -`
  where git reports real counts for any file over `MAX_LINE_BYTES` or `MAX_LINES`, **on the
  plain path with no whitespace flag involved** (§Pin E-2). Fixing it means changing
  `isBinary`, which also decides `three-way-content`'s merge refusal, `grep`'s binary skip,
  `patch-id`, `range-diff` and the `Binary files … differ` patch surface, and it collides with
  `MAX_DIFF_LINES`. Named here rather than silently dropped; DC-14 decides its owner.
- **`MAX_DIFF_LINES` and the Myers iteration budget.** `diffLines` degrades to
  `wholeFileFallback` above 50 000 total lines. After DC-13→A that no longer leaks into the
  drop verdict (C7), but it still shapes the *counts* of a surviving large file. Rebalancing
  those algorithmic bounds is its own investigation.
- **`streamInflate` and `fetch-pack`.** Different verb, different contract
  (`bytesConsumed`), untouched.
- **Raising `MAX_CONCURRENT_OBJECT_LOADS`** (ADR-553) — a measurement to run *after* the arm
  cost changes, not a design decision to take now.
