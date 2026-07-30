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
> Status: **revision 2 — decisions DC-1 … DC-14 all settled** as ADR-548 … ADR-561
> (§Settled decisions). ADR-554 pulled the two pre-existing faithfulness divergences Pin C
> uncovered into this PR as ordered follow-on commits; §Pin E widened the matrix and found
> three more (C6, C7, C8). All five are now in scope.
>
> Two of the five latest decisions went **against** the previous revision's recommendation and
> reshape the design:
> - **ADR-558** replaces per-line buffering with an **incremental O(1) digest fold**. No line
>   is ever held on either arm; `MAX_LINE_BYTES`/`MAX_LINES` stop deciding the verdict and no
>   replacement bound is needed. §D1 is rewritten around it; ADR-551's "bodies move verbatim"
>   clause and three of ADR-552's five proofs lose their subject.
> - **ADR-561** puts the same caps' removal from `isBinary` in scope (C8), which drags
>   `MAX_DIFF_LINES` in behind it. §D9 designs it against a fresh empirical sweep of all five
>   `isBinary` consumers (§Pin F) and a measured Myers cost matrix (§Pin G).
>
> Three new load-bearing choices are open (DC-15 … DC-17). **No blocker**: the incremental
> fold reproduces today's digests bit-identically in every mode (§D1, proof), and the C8
> consumer sweep found a divergence bounded by one constant in one function (§Pin F/§D9).

## Context

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1a | `src/domain/diff/whitespace.ts` → the four digest folders (`digestVerbatim`, `digestDropAllWs`, `digestCollapseRuns`, `digestDropTrailingWs`) + `digestContentEnd` + `commitRun` replaced by **one incremental fold** (ADR-558); `digestNormalizedLine` re-expressed over it (DC-15) | domain |
| P1b | **new** `src/domain/diff/line-digest-scanner.ts` → the synchronous chunk-fed line/digest state machine driving the P1a fold (today's `LineSourceState`, `scanForNul`, `nextLine`, `nextSignificantDigest` lifted out of the application layer; `concatBytes`, `takeLine`, `trackLineCaps` **deleted**) | domain |
| P2 | **new** internal blob-source seam (working name `src/application/primitives/internal/blob-source.ts`) → `openBlobSource(ctx, id, maxBufferedBytes)` returning `{ kind: 'bytes' } \| { kind: 'stream' }`; `src/application/primitives/stream-blob.ts` → `streamBlob` re-expressed over it, public contract unchanged | primitive |
| P3 | `src/application/primitives/internal/whitespace-drop-predicate.ts` → `isWhitespaceOnlyModify(ctx, change: ModifyChange, lineKey: LineKey, ignoreBlankLines: boolean): Promise<boolean>` — two arms (sync buffered / async streamed) over the P1b scanner | primitive |
| P4 | `src/adapters/browser/browser-compressor.ts`, `src/adapters/memory/memory-compressor.ts` → `inflate` (conditional, ADR-555) | adapter |
| P5 | `test/bench/diff-whitespace.bench.ts` (+ a new many-small-modified-pairs fixture) — the current bench does not reach the code being changed (§Pin D-3) | bench |
| P6 | **C4 fix** (§D6, ADR-557) — `src/domain/diff/whitespace.ts` → `normalizeLine` + the fold's terminator rule; `src/domain/diff/patch-serializer.ts` → `trailingNoNewline` | domain |
| P7a | **C5 fix, predicate arm** (§D7, ADR-558) — `line-digest-scanner.ts` → delete the `capsExceeded` observation scaffold; `whitespace-drop-predicate.ts` → stop reading it | domain + primitive |
| P7b | **C5/C7 fix, stat arm** (§D7, ADR-560) — `src/application/primitives/diff-trees.ts` → `applyStatPass`/`materialisedShouldDrop` verdict source moves onto the shared scanner | primitive |
| P8 | **C6 fix** (§D8, ADR-559) — `src/domain/diff/whitespace.ts` → `applyCrRule` + the fold's CR rule | domain |
| P9a | **C8 fix, the caps** (§D9, ADR-561) — `src/domain/diff/line-diff.ts` → `isBinary` becomes NUL-only, `exceedsLineCaps` deleted | domain |
| P9b | **C8 fix, `MAX_DIFF_LINES`** (§D9, DC-16) — `src/domain/diff/line-diff.ts` → `diffLines`/`computeMyersTrace` refusal bound | domain |

P6–P9 are the ADR-554/561 follow-on commits, landing **after** the perf slice. Everything in
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
| **ADR-513** | the drop-pass predicate streams both blobs and folds a per-line rolling digest; the `withStat` path interns lines for Myers; the two verdicts must stay provably consistent | **the consistency clause is honoured harder; the "digest primitives untouched" premise no longer holds.** ADR-558 rewrites the four digest folders into one incremental fold (§D1), with a bit-identity proof (§D1.5) and a property test standing in for "untouched". ADR-560 moves the `withStat` arm's *verdict* onto that same fold, so consistency becomes structural rather than asserted — §Pin E-2's C7 shows the asserted form had already failed on `main` |
| **ADR-249** | structured data, no rendered output | unaffected |
| **ADR-226** | git-faithfulness prime directive | this change must not move any verdict (§Requirements 1); §Pin C records two *pre-existing* divergences it uncovered |

### Settled decisions (were DC-1 … DC-14)

The rows below are constraints on this document, not open questions. **DC-11 and DC-14 were
ratified against the previous revision's recommendation** and are marked ⚑ — they are the two
that reshape the design.

| was | Decision | ADR |
|---|---|---|
| DC-1 | The buffered/streamed choice lives in a shared internal `openBlobSource` seam **below** `streamBlob`; `streamBlob` = `openBlobSource(ctx, id, 0, options)` + a wrap tail, contract byte-for-byte unchanged | [548](../adr/548-blob-source-seam-below-stream-blob.md) |
| DC-2 | The gate is **64 KiB of compressed/on-disk bytes**, uniform on every arm; the amplification residual is explicitly accepted | [549](../adr/549-buffered-blob-gate-compressed-64-kib.md) |
| DC-3 | The predicate **keeps a gated streaming arm**; above the gate both sides still stream | [550](../adr/550-predicate-keeps-a-gated-streaming-arm.md) |
| DC-4 | One **synchronous chunk-fed scanner** in `src/domain/diff/line-digest-scanner.ts`, `push`/`end`/`next` — *refined by ADR-558: the decision stands, the "bodies move verbatim" clause does not* | [551](../adr/551-synchronous-line-digest-scanner-in-domain.md) |
| DC-5 | All five equivalent-mutant proofs are **re-proved against the new structure**, never carried — *refined by ADR-558: a proof whose construct is deleted is deleted, not re-anchored* | [552](../adr/552-equivalent-mutant-proofs-re-proved-not-carried.md) |
| DC-6 | Drop-pass concurrency **unchanged** — `boundedMap(changes, 32)` | [553](../adr/553-drop-pass-concurrency-unchanged.md) |
| DC-7 | **Perf slice first**, reproducing today's verdicts exactly; then C4 and C5 as separate **ordered commits in this same PR**, each with its own ADR and interop case | [554](../adr/554-perf-slice-precedes-the-faithfulness-fixes.md) |
| DC-8 | Browser/memory `inflate` is **reimplemented over `inflateZlibMember`, gated on a large-input bench** against native `DecompressionStream`; if the bench is not clearly better, fall back to accepting a Node-only win | [555](../adr/555-adapter-buffered-inflate-bench-gated.md) |
| DC-9 | Chunk-boundary cases move to **synchronous scanner tests**; the `streamBlob` module spy is deleted | [556](../adr/556-chunk-boundary-tests-move-to-the-scanner.md) |
| DC-10 | The C4 terminator rule lives in `normalizeLine`, mirrored in the digest, plus the `trailingNoNewline` postimage fix | [557](../adr/557-terminator-rule-lives-in-normalize-line.md) |
| DC-11 ⚑ | An **incremental O(1) digest fold** replaces per-line buffering; no line is ever buffered on either arm, the caps stop deciding the verdict, **no replacement bound is needed**. Lands **inside** the scanner part | [558](../adr/558-incremental-o1-digest-fold-replaces-the-line-caps.md) |
| DC-12 | The C6 incomplete-line CR fix is **its own ordered commit** | [559](../adr/559-cr-at-eol-incomplete-line-fix-as-its-own-commit.md) |
| DC-13 | The `withStat` arm's **drop verdict** comes off the shared scanner; C7 retires as a side effect | [560](../adr/560-stat-arm-drop-verdict-off-the-shared-scanner.md) |
| DC-14 ⚑ | **C8 is fixed in this PR**: the line caps leave `isBinary` too. Every consumer is verified against real git, and `MAX_DIFF_LINES` is settled **once, coherently** | [561](../adr/561-line-caps-leave-is-binary-in-this-change.md) |

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
`--ignore-cr-at-eol` alone (an observable wrong drop). §D8, ADR-559.

**C4 is also a numstat divergence, not only a drop-verdict one.** For
`ctx-gain` (`a\nb` → `A\nb\n`) and `ctx-loss` (`a\nb\n` → `A\nb`) — a real change on line 1
plus a terminator change on the common last line — git reports `1 1` under `-w`; tsgit
reports **`2 2`** on both, because the interned last line pair never matches. The
prime directive binds `added`/`deleted` as structured data, so the fix cannot be scoped to
the drop verdict alone without leaving this in place (ADR-557).

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
because its fixtures are two lines long. ADR-560 retires it as a side effect of the C5 fix
(§D7 step 4).

**C8 — the residual, now in scope (ADR-561).** tsgit reports `- -` (binary) on `--numstat` for
`tail-ws`, `rand-1line`, `len-*` and `lines-100000` where git reports real counts —
**under plain diff, with no whitespace flag involved**. That divergence is `isBinary`'s, not
the drop pass's; fixing it means changing `isBinary`, which also feeds `three-way-content`,
`grep`, `patch-id`, `range-diff` and the patch `Binary files … differ` surface, and it
collides with `MAX_DIFF_LINES`. ADR-561 ratified fixing it here. §Pin F sweeps all five
consumers against real git; §Pin G measures what `MAX_DIFF_LINES` actually costs and buys;
§D9 designs the fix.

### Pin F — the C8 consumer sweep (git 2.55.0, pinned 2026-07-30)

ADR-561's binding requirement: *"each [consumer] needs its faithfulness checked against real
git rather than assumed unchanged"*. Pinned in two `mktemp -d` throwaways (isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, `commit.gpgsign=false`, `core.autocrlf=false`,
`merge.conflictStyle=merge`, `.gitattributes` = `* -text`). Two fixtures, both **NUL-free**:

- **`longline.txt`** — one line of 70 000 `a` + LF. Over `MAX_LINE_BYTES = 65 536`; **2 lines
  total** across a modify pair, so far under `MAX_DIFF_LINES`.
- **`manylines.txt`** — 100 001 lines. Over `MAX_LINES = 100 000`; **200 002 lines** across a
  modify pair, so also over `MAX_DIFF_LINES = 50 000`.

That split is the sweep's central finding: the two cap families do **not** behave alike once
`isBinary` stops short-circuiting.

| # | consumer | git 2.55.0, pinned | tsgit today | after `isBinary` = NUL-only, `MAX_DIFF_LINES` **kept** |
|---|---|---|---|---|
| F-1 | `--numstat` (`computeStatFields`) | `1 1` for **both** fixtures | `- -` for both | `longline` **`1 1` ✓** · `manylines` `100001 100001` ✗ (`wholeFileFallback`) |
| F-2 | patch body (`patch-serializer`, `materialise-patch-files`) | full text hunks; `@@ -1 +1 @@` with the whole 70 000-byte line for `longline`, `@@ -3,7 +3,7 @@` for `manylines`. **`Binary files` appears zero times** in the whole diff | ` Binary files … differ` for both | `longline` **✓** · `manylines` one whole-file replace hunk where git emits 7 lines ✗ |
| F-3 | `grep` | greps both as text — `longline.txt:1:aaa…`, `manylines.txt:100001:L100000`. Control: a NUL blob still yields `Binary file nul.bin matches` | `binaryMatch: true`, no hits | **both ✓ — `grep` never touches `diffLines`, so it is complete at P9a** |
| F-4 | `three-way-content` merge | **merges textually.** `manylines` with non-overlapping edits: `Auto-merging` + `Merge made by the 'ort' strategy`, `1 insertion(+), 1 deletion(-)`, **zero conflict markers**. `longline` with two edits on its single line: `CONFLICT (content)` with real `<<<<<<< HEAD` / `>>>>>>> theirs` markers around the 70 000-byte sides — a **text** conflict, never a binary refusal | `{ status:'conflict', conflictType:'binary' }` for both | `longline` **✓** (textual conflict) · `manylines` → `degraded` ⇒ one whole-file conflict region where git auto-merges **clean** ✗ |
| F-5 | `patch-id` | a real id over the full text hunks for both (`d1ae4836…` for `longline`, `e5774c26…` for `manylines`). Control: for a NUL file git still emits an id, hashed over the `diff --git`/`index` header lines alone, since the body is `Binary files … differ` | file lands in the `binaryKey` oid list, body is ` Binary files … differ` | `longline` **✓** · `manylines` id computed over a whole-file replace hunk git would never emit ✗ |
| F-6 | `range-diff` (`range-diff/patch-text.ts`) | full text hunks inside the `## file ##` block, **zero `Binary files` lines** (pinned with `--creation-factor=999` so the pair actually matches; at the default factor a 70 000-byte patch is simply *unpaired*, a similarity heuristic, not a binary decision) | ` Binary files … differ` | `longline` **✓** · `manylines` whole-file hunk ✗ |

**And git's own heuristic, pinned exactly.** A NUL at byte offset **7 999** ⇒ `- -`; at **8 000**
and **8 001** ⇒ `1 1`. So git's window is `[0, 8 000)`, byte-for-byte what
`hasNulInWindow` already implements (`end = min(len, BINARY_DETECTION_BYTES); i < end`).
**No change is needed to the NUL rule itself** — it is already faithful.

**What the sweep settles.** Removing the caps from `isBinary` moves every one of the six
surfaces *towards* git; not one consumer wants the cap. But it **completes only for the
`MAX_LINE_BYTES` family**. For the `MAX_LINES` family it converts "wrongly binary" into
"wrongly degraded" on five of the six — and on merge that is arguably a *worse* output (a
whole-file conflict where today's binary conflict at least takes ours wholesale, and where git
merges cleanly). `MAX_DIFF_LINES` is the single shared choke point, and every over-`MAX_LINES`
file is necessarily over `MAX_DIFF_LINES` (100 000 > 50 000), so the two cannot be separated.
**This is not a divergence materially larger than the rest of the PR** — it is one constant in
one function, with the measured cost model in §Pin G — so it is designed (§D9), not escalated.

### Pin G — what `MAX_DIFF_LINES` costs and what it buys (measured)

Measured on this host against the branch's built `dist/esm`, `node --expose-gc
--max-old-space-size=6144`, `diffLines` called directly, heap deltas from
`process.memoryUsage().heapUsed` around a `gc()`:

| # | input | time | `degraded` | heap growth |
|---|---|---|---|---|
| G-1 | 10 000 × 2 lines (M+N = 20 000), **1-line edit** | 5.4 ms | false | 2.7 MB |
| G-2 | 20 000 × 2 lines (M+N = 40 000), 1-line edit | 6.4 ms | false | 4.5 MB |
| G-3 | 24 999 × 2 lines (**M+N = 49 998**, just under the cap), 1-line edit | **3.6 ms** | false | 7.8 MB |
| G-4 | 25 001 × 2 lines (M+N = 50 002, just **over**), 1-line edit | 1.4 ms | **true** | 6.3 MB |
| G-5 | 24 999 × 2 lines **fully different** (M+N = 49 998, *under* the cap) | **958 ms** | **true** | **769 MB** |
| G-6 | one 70 000-byte line vs another, ws-only change | **0.2 ms** | false | ~0 MB |
| G-7 | `new Array(2 × 200 002 + 1).fill(0)` — the `v` array Myers would allocate for the `manylines` pair | 0.3 ms | — | ~3 MB |

Three conclusions, each load-bearing for §D9:

1. **The input-size cliff buys nothing in the common case.** G-3 (a 50 000-line pair with a
   one-line edit) costs **3.6 ms** and 7.8 MB. G-4, two lines larger, refuses outright. The
   cliff is not protecting against that shape at all.
2. **`MAX_LINE_BYTES` buys nothing on the diff path, full stop.** G-6: a 70 000-byte line goes
   through `diffLines` in **0.2 ms**, because it is *two lines*. The `MAX_LINE_BYTES` half of
   `isBinary` protects nothing that `MAX_DIFF_LINES` does not already protect better.
3. **`MAX_DIFF_LINES` *is* doing real work — but the wrong kind.** G-5 shows the true worst
   case, **reachable today, under the cap**: 958 ms and **769 MB**. The mechanism:
   `computeMyersTrace`'s `iterationBudget = (M+N) × MAX_DIFF_ITERATION_FACTOR`, and iterations
   to reach edit distance `d` are ≈ `d²/2`, so the budget bails at `d ≈ √(2·(M+N)·1000)` and
   trace memory is `Σ(2d+1) ≈ (d+1)²` cells. At the cap that is `d ≈ 10 000` ⇒ ~1.0 × 10⁸ cells
   ⇒ the measured 769 MB (7.7 B/cell, consistent). Because the budget is *proportional to*
   `M+N`, worst-case trace memory is **linear in `M+N`**: at the `manylines` pair's
   M+N = 200 002 it extrapolates to `d ≈ 20 000` ⇒ ~4.0 × 10⁸ cells ⇒ **~3.1 GB and ~4 s**.
   So simply deleting the pre-check is a genuine memory DoS; raising it is the same DoS scaled.
   The bound that is actually needed is on **edit distance**, not on input size — and
   `MAX_DIFF_EDIT_DISTANCE = 10 000` is already exported, already documented as subsumed, and
   currently **inert**, and today's measured bail at the cap is `d ≈ 10 000`. DC-16.

**One hard constraint the pinning surfaced.** `reports/api.json` records these constants by
**literal value and literal type**:
`{"name":"MAX_DIFF_LINES","kind":32,"flags":{"isConst":true},"type":{"type":"literal","value":50000},"defaultValue":"50_000"}`.
So *re-valuing* any of `MAX_LINE_BYTES`, `MAX_LINES`, `MAX_DIFF_LINES` or
`MAX_DIFF_ITERATION_FACTOR` is a **public type change with `api.json` churn**, and removing one
is a breaking export removal. Every option below is scored against that.

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
   divergence in §Pin C and §Pin E exactly as it is today — C4, C5, C6, C7, C8 included. The
   perf commit's own diff must show **zero** verdict movement; P6–P9 then move them, one
   family per commit. Because ADR-558's fold has no caps at all, the perf slice carries them
   as a **named one-commit observation scaffold** (`capsExceeded`, §D1) that P7a deletes —
   this is the only mechanism by which a capless scanner can honour ADR-554 (DC-17).

   **1a — digest identity, the property everything else rests on.** The incremental fold
   produces **bit-identical `LineDigest` values** — `length`, `terminated` **and** `hash` — to
   the whole-line fold, for all four modes, with `ignoreCrAtEol` on and off, terminated and
   unterminated, over **every** chunk partition of the input. Proved structurally in §D1.5 and
   pinned as a property test (§Test strategy, property 1). A failure here is a blocker, not a
   bug to design around; §D1.5 records the proof rather than asserting the claim. **No mode
   was found where the fold cannot reproduce today's digest.**

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
   forward unexamined, and a proof whose construct is **deleted** is deleted, not re-anchored
   (ADR-552 as refined by ADR-558; §D4).
7. **Measured, not asserted.** A bench that actually reaches the predicate (Pin D-3),
   before(`main`)/after(branch), absolute wall-clock, on one host, ≥2 runs, in the PR body;
   the nightly `bench.yml` artifact is the published authority.
8. **Cross-adapter pinned.** The whitespace drop path gains a parity scenario
   (§Test strategy) — today no `test/parity` scenario exercises `ignoreWhitespace` at all.
9. **The two arms agree, always.** For every fixture in §Pin E, `repo.diff({…})` and
   `repo.diff({…, withStat: true})` return the same survivor set, and both equal live git's.
   This is ADR-513's consistency invariant made executable over inputs that actually reach
   the disagreeing code (C7), not over two-line fixtures.
10. **Each fix commit flips only its own assertions.** P6, P7, P8 and P9 each turn exactly one
    family of §Pin E / §Pin F rows from "documented divergence" into "agrees with git", and
    touch no other expectation. §Test strategy names the mechanism (a per-row
    `tsgitDivergence` override that the fix commit deletes) and §Part sequence names the rows.
11. **No new public surface, and no `reports/api.json` churn unless a decision says so.**
    `MAX_LINE_BYTES`, `MAX_LINES`, `MAX_DIFF_LINES`, `MAX_DIFF_EDIT_DISTANCE`,
    `MAX_DIFF_ITERATION_FACTOR`, `BINARY_DETECTION_BYTES` and `isBinary` are **public exports**
    (`src/public-types.ts`, `src/domain/diff/index.ts`, `reports/api.json`), and §Pin G shows
    `api.json` records each constant's **literal value as its type** — so re-valuing one is a
    public type change and removing one is breaking. No part removes, renames or re-values any
    of them; `normalizeLine`, `linesEqualUnder` and `isBinary` keep their signatures. Two
    deliberate **behaviour** changes with no signature or value change: §D6 changes what
    `normalizeLine` returns under an active key, and §D9 changes what `isBinary` returns for
    over-cap NUL-free content. Both are documented in their ADRs. `MAX_LINES` becomes
    export-only (no internal consumer) — kept at 100 000 with its doc rewritten, not removed.
    `digestNormalizedLine`, `digestsEqual`, `digestIsBlank` and `LineDigest` are **internal**
    (verified: not in `src/domain/diff/index.ts` nor `src/public-types.ts`), so ADR-558 may
    restructure them freely.
12. **Every `isBinary` consumer verified, not assumed** (ADR-561). `three-way-content`'s merge
    refusal, `grep`'s binary skip, `patch-id`, `range-diff` and the patch
    `Binary files … differ` surface each have their post-fix behaviour pinned against live git
    (§Pin F) and an interop case in the suite that already owns them.

## Design

### D1 — the incremental O(1) digest fold, and the scanner that drives it

ADR-558 replaces the previous revision's design. The scanner still exists, is still
synchronous, still lives in `src/domain/diff/`, and still drives both arms (ADR-551 stands).
What changes is that **no line is ever buffered**: bytes are folded into a digest as they
arrive, and the only per-side state is a fixed number of scalars.

#### D1.1 — why a naive incremental fold does not work, and what the tentative pair is for

`digestNormalizedLine(line, key)` today needs the **whole** line before it can fold anything,
because two decisions look backwards from the end:

1. `lfIndex(bytes)` finds the terminator, which is `bytes.length - 1` or nothing.
2. `digestContentEnd` drops a **CR** that sits immediately before the terminator.
3. `digestCollapseRuns` / `digestDropTrailingWs` drop a whitespace run **only if it touches
   the content boundary** — `digestCollapseRuns` calls it `pendingSpace`, `digestDropTrailingWs`
   defers the run's bytes to `commitRun`.

Points 2 and 3 are the hard case: seeing a space, you cannot know whether it is *trailing*
until you see what follows it. The fix is not to buffer the run — it is to fold it **twice
over**, once optimistically and once not:

> Maintain two fold states.
> **`committed = (hash, length)`** is the fold over everything that is *definitely* part of the
> normalized line. **`tentative = (hash, length)`** is `committed` **plus the pending droppable
> tail, folded exactly as it would be folded if that tail turned out to be internal.**
> Every input byte is classified **hard** (cannot be part of a droppable tail) or **soft**
> (could be). A hard byte first *promotes* the pending tail (`committed := tentative`, after
> closing the run), then folds itself into both. A soft byte folds into `tentative` only.
> At the end of the line the answer is `committed` — the pending tail is discarded — except
> for the one case where the tail turns out to be significant (C6, §D1.4), where it is
> `tentative`.

That is the whole mechanism. Neither state is ever more than two numbers, so **the memory cost
of "not knowing yet" is 16 bytes, not the run's length.**

#### D1.2 — the tail grammar, derived from the current code

The droppable tail is not "any suffix of soft bytes" — deriving it loosely is how this would
silently break. Read it off the actual composition — `digestNormalizedLine` computes the CR-
adjusted boundary with `digestContentEnd` **first**, then runs the mode folder up to it, and
`normalizeLine` applies `applyCrRule` **first**, then the mode transform. In that order the tail
is exactly:

```
TAIL := WS*  CR?          -- the CR, if present, is the LAST content byte;
                          -- the WS run, if present, is immediately before it
```

with `WS` droppable only when `mode !== 'none'` and `CR` droppable only when the CR rule
applies. Four worked cases pin the shape (all verified by hand against the current code):

| input (content, mode `at-eol`) | `digestContentEnd` | folder | result | tail |
|---|---|---|---|---|
| `a  \r` | `3` (CR dropped) | `dropTrailingWs("a  ")` | `a` | `"  \r"` |
| `a \r ` | `4` (last byte is SP, not CR) | `dropTrailingWs("a \r ")` | `a \r` | `" "` |
| `a\r\r` | `2` (only **one** CR dropped) | `dropTrailingWs("a\r")` | `a\r` | the **last** `\r` |
| `a  \r  ` | `6` | `dropTrailingWs("a  \r  ")` | `a  \r` | the second `"  "` |

Note row 3: a CR run does **not** collapse — only the final CR is droppable, so a second CR
*promotes* the first. And row 1: a CR does **not** promote the whitespace run before it, because
if the CR is dropped the run becomes trailing too. Those two asymmetries are the entire
subtlety, and they fall straight out of the classifier below.

#### D1.3 — the classifier and the transitions

State (all scalars, all `O(1)`, all carried across `push` boundaries):

```ts
interface FoldState {
  committedHash: number; committedLength: number;   // definitely in the line
  tentHash: number;      tentLength: number;        // committed + the pending tail
  pendingWs: boolean;                               // a droppable WS run is open
  pendingCr: boolean;                               // the last folded byte was a droppable CR
  sawLf: boolean;                                   // an LF was consumed for this line
  lineHasBytes: boolean;                            // distinguishes EOF from an empty final line
}
```

Four numbers and four booleans, reset per line. That is the **entire** per-side state; nothing
in it scales with line length, line count, chunk size or chunk count.

Classification, given `key`:

- a byte is **soft-WS** iff `isWs(b)` and `key.mode !== 'none'`;
- a byte is **soft-CR** iff `b === CR` and the CR rule applies (§D1.4);
- every other content byte is **hard**. Under `mode: 'none'` whitespace is hard; without the
  CR rule a CR is hard.

Transitions — `fold(pair, b)` is one `fnvMix` plus `length++`; `closeRun(pair)` is the
mode-specific closure of an open WS run:

| mode | during a WS run | `closeRun` |
|---|---|---|
| `'all'` | fold nothing (WS is dropped everywhere) | nothing |
| `'change'` | fold nothing | fold **one `SPACE`** (mirrors `pendingSpace` in `digestCollapseRuns`) |
| `'at-eol'` | fold **each WS byte verbatim** into `tentative` (mirrors `commitRun`) | nothing (already folded) |
| `'none'` | *unreachable* — WS is hard | — |

```
onHard(b):        if (pendingWs) tent = closeRun(tent)
                  pendingWs = pendingCr = false
                  tent = fold(tent, b);  committed = tent

onSoftWs(b):      if (pendingCr) { committed = tent; pendingCr = false }   // the CR is now internal
                  if (mode === 'at-eol') tent = fold(tent, b)
                  pendingWs = true

onSoftCr():       if (pendingCr)      committed = tent          // the PREVIOUS CR is now internal
                  else if (pendingWs) tent = closeRun(tent)      // fold the run as internal, do NOT promote
                  pendingWs = false
                  tent = fold(tent, CR);  pendingCr = true
```

`onSoftWs`'s promotion on `pendingCr` is what makes row 2 and row 4 of §D1.2 come out right;
`onSoftCr`'s *non*-promotion of `pendingWs` is what makes row 1 come out right. Every branch
above is reachable and therefore killable — none of them needs an equivalence proof.

**A chunk boundary that falls inside a whitespace run is a non-event.** The run's entire effect
is already inside `tentative` (folded verbatim under `at-eol`, owed as one `SPACE` under
`change`, nothing under `all`) and the only thing carried is the `pendingWs` bit. `push` sets
`chunk`/`cursor`; the fold resumes at the cursor with the identical state it stopped with. There
is no buffer to re-concatenate, nothing to re-scan, and no boundary-sensitive branch anywhere in
the three transitions above.

#### D1.4 — the terminator and the CR rule, in a fold that never holds the line

This is the C4/C6 obligation (ADR-557, ADR-559) expressed against a fold whose problem is that
the terminator arrives **last**, after the hash is already committed.

**The terminator (C4).** Under an **active** key (`lineKeyIsActive(key)`, i.e.
`mode !== 'none' || ignoreCrAtEol`) ADR-557 makes the terminator insignificant: the emitted
digest carries `terminated: false` **and the LF is never folded into the hash**. So under an
active key the fold simply *never sees* the LF as content — it is the line delimiter and nothing
else. Under an **inactive** key the LF is folded on sight, at the moment it arrives, and
`terminated: true` is emitted. Folding a byte that arrives last is a pure suffix operation and
needs no lookahead, so **the terminator was never the hard part** — the tail grammar was.
Equivalently: the LF is a *hard* byte under an inactive key and a *non-byte* under an active one.

**The CR rule (C6).** ADR-559: `crApplies = key.mode !== 'none' || (key.ignoreCrAtEol &&
terminated)`. Under `mode: 'none' + ignoreCrAtEol` the trailing CR is droppable **only if the
line is terminated** — and termination, again, is known only at the end. The tentative pair
answers this for free: the CR is classified soft on sight, and the *choice of which pair to emit*
is deferred to the end of the line. Under `mode !== 'none'` the CR is droppable unconditionally
(§Pin E-1 `cr-no-eol` under `-w`/`-b`/`at-eol`: both tools drop), so `committed` always wins
there. Under `mode: 'none' + !ignoreCrAtEol` the key is inactive, `pendingCr` is never set and
the branch is dead. So C6 is **one boolean read at line end**, not a second pass.

**The whole emit step, in order.** The CR rule chooses *which* pair; the terminator rule then
decides whether the LF is mixed into it. The two are independent and cannot both fire
(`useTentative` requires `!sawLf`; the LF fold requires `sawLf`):

```
// 1. C6 — which pair survives the tail?
useTentative = pendingCr && key.mode === 'none' && !sawLf   // an incomplete line's CR is content
pair         = useTentative ? tentative : committed

// 2. C4 — is the terminator part of the line's identity?
terminated   = sawLf && !lineKeyIsActive(key)
hash         = terminated ? fnvMix(pair.hash, LF) : pair.hash

digest       = { length: pair.length, terminated, hash }
```

`length` is always the chosen pair's length: the LF folds into the **hash** but never into the
**length**, exactly as `digestVerbatim` does today (`length: contentEnd`, then
`if (terminated) hash = fnvMix(hash, LF)`).

Before P8 lands, step 1's condition keeps today's unconditional shape (a soft CR is always
dropped when `key.ignoreCrAtEol || key.mode !== 'none'`, so `useTentative` is constant `false`);
P8 adds the `&& !sawLf` conjunct at exactly this one site plus its `applyCrRule` twin. That is
the whole of §D8 restated in fold terms.

#### D1.5 — the proof that the fold is bit-identical

**Claim.** For every line `L` (content bytes plus an optional final LF), every `LineKey k`, and
every partition of `L` into chunks, the fold emits a `LineDigest` byte-identical to
`digestNormalizedLine(L, k)` as that function exists in the same commit.

**Proof, in three steps.**

1. **Chunk-partition independence.** The transitions in §D1.3 read only `(b, key, state)` and
   write only `state`; no branch reads `chunk`, `cursor`, `chunk.length`, or any position. The
   fold is therefore a left-fold of a per-byte state transformer over the byte sequence, and a
   left-fold is associative over any partition by construction. `push` only re-seats the cursor.
   *This is the step where the previous revision needed two hand proofs about `buffer.length`;
   with no buffer there is nothing left to prove.* The one remaining chunk-sensitive component,
   `scanForNul`, is untouched and its own invariant is restated in §D4/M2.
2. **Per-mode agreement on a whole line.** With the partition eliminated, it suffices to compare
   the fold over `L` against `digestNormalizedLine(L, k)`. Both reduce to: *fold the FNV hash
   over the normalized content bytes, in order, then optionally the LF*. The two differ only in
   **when** the normalized content is determined, so the obligation is exactly "the fold's
   `committed` at line end equals the byte sequence the mode folder would have folded":
   - `'none'` — every content byte is hard, `committed` advances on each, so `committed` is the
     verbatim prefix up to the first soft-CR that survives to the end. `digestContentEnd` cuts
     at precisely that CR. Identical.
   - `'all'` — WS folds nothing whether soft or promoted, so `committed` at line end is the
     non-WS content bytes up to `contentEnd`. `digestDropAllWs` folds exactly those. Identical.
   - `'change'` — a WS run contributes one `SPACE` iff `closeRun` fires, i.e. iff a hard byte or
     a soft-CR follows it inside the content; a run that reaches the tail never fires. That is
     verbatim `digestCollapseRuns`' `pendingSpace` semantics (including a **leading** run, which
     both forms render as one `SPACE`). Identical.
   - `'at-eol'` — a WS run's bytes are folded verbatim into `tentative` and promoted iff a hard
     byte or a soft-CR follows, dropped otherwise. That is verbatim `commitRun`'s condition
     (`runStart !== -1` flushed on the next non-WS byte, left pending at loop end). Identical.
   The four tail cases of §D1.2 are the case analysis that closes this step, and they are
   asserted as example tests, not left as prose.
3. **Terminator and CR.** §D1.4 shows both are determined at line end from `sawLf` and
   `pendingCr`, and both branches of the choice reproduce `lfIndex` / `digestContentEnd`'s cut
   points exactly. `length` and `terminated` follow from the same two scalars.

**Where the claim is *not* self-evident, and what pins it.** Step 2 is a hand argument over four
folders; this repository has shipped a falsified hand argument before. So it is backed by a
property test whose oracle is **`normalizeLine` + a plain FNV over its output** — i.e.
`whitespace.test.ts`'s existing `expectedDigest` helper, which is a genuinely independent
implementation (it allocates the normalized array and hashes it) and not a copy of the SUT.
See §Test strategy, property 1. **No mode was found where the fold cannot reproduce today's
digest; there is no blocker here.**

#### D1.6 — the scanner, and what survives of `LineSourceState`

```ts
export interface LineDigestScanner {
  /** Feed the next chunk. Legal before the first `next()` or after a `needs-input` step —
   *  at most one chunk is ever in flight. Runs the NUL-window scan, then re-seats the fold
   *  cursor. The scanner holds a *reference* to `chunk` until it is consumed; it never
   *  copies, concatenates or accumulates. */
  push(chunk: Uint8Array): void;
  /** No more chunks will arrive. */
  end(): void;
  /** Next significant digest, or why not. Never throws. */
  next(): ScanStep;
  /** NUL in the first BINARY_DETECTION_BYTES — the ONLY binary rule. Once set, `next()`
   *  answers `exhausted`, exactly as `nextSignificantDigest` returns `undefined` today. */
  readonly binary: boolean;
  /** ADR-554 scaffold, deleted in P7a (§D1.7, DC-17). Deliberately does NOT stop `next()`:
   *  the predicate reads it before comparing digests, which §D1.7 proves is equivalent. */
  readonly capsExceeded: boolean;
}

type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' }   // only reachable before end()
  | { readonly kind: 'exhausted' };    // EOF *or* binary — the caller reads `.binary`
                                       // to tell them apart, exactly as the verdict
                                       // ladder does today
```

`createLineDigestScanner(key: LineKey, ignoreBlankLines: boolean): LineDigestScanner`.
There is **no `overflow` step** — the previous revision's fourth `ScanStep` kind, the
materialised-comparison escalation it triggered and the entire second code route die with
ADR-558. `next()` advances the fold from `cursor` until it consumes an LF (⇒ `digest`,
terminated), exhausts the chunk (⇒ `needs-input`, or after `end()` a final unterminated
`digest` when `lineHasBytes`), or finds nothing left (⇒ `exhausted`). Blank skipping
(`digestIsBlank`, unchanged) loops inside `next()` exactly as `nextSignificantDigest` does today.

Field-by-field disposition of today's `LineSourceState`:

| field | fate | why |
|---|---|---|
| `iterator` | **gone** | ADR-551: the scanner is push-fed, not pull-fed |
| `buffer` | **gone** — replaced by `chunk: Uint8Array` + `cursor: number` | nothing is ever accumulated; the scanner borrows the caller's chunk and walks it |
| `exhausted` | **stays** (set by `end()`) | still distinguishes `needs-input` from `exhausted` |
| `nulScanOffset` | **stays** | NUL detection is unchanged and is now the *whole* binary rule |
| `lfScanFrom` | **gone** | its only job was "never rescan bytes a previous chunk already cleared, or a long line degrades to O(n²)". The fold visits every byte exactly once, so the O(n²) it defended against cannot arise. `buffer.indexOf(LF, …)` goes with it — the LF is recognised inside the fold's own per-byte loop |
| `currentLineBytes` | **scaffold only** — feeds `capsExceeded` through P3, deleted in P7a | it existed solely for `MAX_LINE_BYTES` |
| `lineCount` | **scaffold only** — same | it existed solely for `MAX_LINES` |
| `binary` | **stays**, set by `scanForNul` alone | |

And the functions: **`concatBytes` loses its only caller and is deleted** — the scanner never
joins two byte ranges, so the empty-`a` shortcut it existed for has nothing to shortcut.
**`takeLine` is deleted** (nothing is taken; the digest is already built). **`trackLineCaps` is
deleted** in P7a with the scaffold. `scanForNul` survives verbatim, now invoked from `push`
rather than lazily from `nextLine` — once per chunk either way.

> **Does `MAX_LINE_BYTES` have *any* remaining role in the scanner?** **No — none.** After P7a
> the scanner's entire binary-detection story is the NUL window, byte-for-byte git's own rule
> (§Pin F: NUL at 7 999 ⇒ binary, at 8 000 ⇒ text). Its whole per-side state is five numbers and
> three booleans plus a borrowed chunk reference, so there is nothing left for a length cap to
> bound. `MAX_LINE_BYTES` keeps exactly one live consumer in `src/` — `grep`'s
> binary-presence-probe bound (`grep.ts:147`), which is about a *RegExp* over a NUL blob, not
> about buffering — and `MAX_LINES` keeps none (§Requirements 11).

**One cost this design must measure, not assert.** Today's `nextLine` finds the terminator with
`Uint8Array.prototype.indexOf` — a native scan — and then `digestNormalizedLine` walks the line
again in JS. The fold does **one** JS pass that also tests for LF. That removes a pass and every
per-line allocation (`subarray` ×2, `concatBytes`, the `LineDigest` object stays), but it trades
a native scan for a JS comparison per byte. The expectation is a win; it is listed as an explicit
go/no-go micro-measurement in §Measurement protocol rather than claimed here.

#### D1.7 — the `capsExceeded` scaffold, and why it exists for exactly one commit

ADR-554 requires the perf commit to show **zero** verdict movement, and blind-spot 9 makes that
a mechanical check. ADR-558 requires the scanner to have no caps. Those collide: a capless
scanner wired into the predicate would *silently fix C5* inside the perf commit.

The resolution keeps both, at the cost of a named 6-line scaffold. The scanner carries two
counters (`currentLineBytes`, `lineCount`) and derives `capsExceeded` from them with today's
exact rule; the **predicate** — not the scanner — applies it:

```ts
// P3 only. Deleted in P7a, together with the two counters and capsExceeded.
if (old.binary || old.capsExceeded || next.binary || next.capsExceeded) return false;
```

`binary` therefore means "NUL in the window" from day one and never changes meaning, and P7a's
diff is a deletion of two counters, one derived boolean and two operands — the smallest possible
visible statement of "the caps stopped deciding the verdict".

**Why this is verdict-identical to today, despite firing later.** Today the cap can fire *early*,
from `nextLine`'s pending-bytes short-circuit, before the over-long line is ever emitted; the
scaffold can only fire when the line is emitted. That difference is unobservable:

- A `binary`/`capsExceeded` side always yields `return false` (kept). It never yields `true`.
- The predicate's loop checks binary-ness **before** comparing digests, so an emitted-then-flagged
  line cannot change the branch taken.
- `return true` is only reachable when *both* sides exhaust, which is strictly after every line
  has been emitted — so a line that trips the cap always trips it before any `true`.
- `MAX_LINES` already fired at line completion today, so it is unchanged by construction.

Verified against all six over-cap shapes in §Pin E-2 — `len-65535`, `len-65536`, `tail-ws`,
`rand-1line`, `lines-99999`, `lines-100000` — every one of which keeps today's verdict under
the scaffold (`lines-99999` is *under* `MAX_LINES` and is dropped by the predicate today; the
scaffold does not change that, which is why C7 stays a P7b fix and not a P3 accident). **This is
the only mechanism found that satisfies ADR-554 and ADR-558 simultaneously without
reintroducing buffering; DC-17 records the alternative.**

Home: `src/domain/diff/`, beside `line-diff.ts` whose `hasNulInWindow` / `splitLines` this
scanner mirrors, and beside `whitespace.ts` whose fold it drives. Zero platform dependency, so
it belongs in domain (ADR-551).

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

### D4 — the equivalent-mutant proof dispositions, re-derived against the incremental fold

The previous revision's table was written against a structure that ADR-558 deleted. Re-derived
here from scratch. **A proof whose construct no longer exists is deleted, not re-anchored**
(ADR-552 as refined by ADR-558) — and re-derivation means arguing against the *new* structure's
distinguishing path, never re-reading the old argument. This repository has already shipped one
proof falsified exactly that way.

| # | today's location | the proof's load-bearing premise | disposition under the fold |
|---|---|---|---|
| M1 | `concatBytes` — `if (a.length === 0) return b` (ConditionalExpression `false` variant) | `out.set(a, 0)` is a no-op when `a` is empty | **DELETED with its construct.** The fold never joins two byte ranges — it borrows the caller's chunk and walks it (§D1.6) — so `concatBytes` has no caller and is removed. There is no mutant left to prove equivalent. ADR-552 option 2's stated objection to deleting it (*"`concatBytes(EMPTY, wholeBlob)` would copy the whole blob on every buffered read"*) is **moot**: no copy happens at all. |
| M2 | `scanForNul` — `nulScanOffset < BINARY_DETECTION_BYTES` (`true` variant, `<=` variant) | once `nulScanOffset ≥ 8 000`, `end ≤ 0`, so the scan loop never runs | **SURVIVES — re-derived, not re-read.** The distinguishing path in the *new* structure: `scanForNul` moves from `nextLine` (called lazily, on the chunk that a stalled line needed) to `push` (called eagerly, once per chunk). The premise never mentioned *when* it is called, only the accumulated offset, and `nulScanOffset += chunk.length` is unchanged — so the arithmetic is untouched. The adversarial input that would distinguish the mutant is *"a chunk arriving after 8 000 bytes have been seen and containing a NUL"*, and under both original and mutant `end = min(chunk.length, ≤0) ≤ 0` still skips the loop. Stays **unannotated** for the original reason: the opposite-direction variants (`false`, `>=`) are real killed mutants on the same line, and a `next-line` disable binds by `(mutator, line)`. |
| M3 | `trackLineCaps` — `if (terminated) currentLineBytes = 0` (`true` variant) | this is the last `trackLineCaps` call for the line; `currentLineBytes` is never read again | **DELETED with its construct**, in P7a. During P3 the reset lives on in the `capsExceeded` scaffold (§D1.7) — but there its premise is **false**: the scaffold's counter resets on *every* terminated line and is read again on the next one, so `true`-forcing it lets short lines accumulate and is a **real, killable mutant**. No proof, no directive; a multi-short-line fixture kills it. Then P7a deletes the counter outright. |
| M4 | `nextLine` — the pending-bytes cap, `Stryker disable next-line ArithmeticOperator,BlockStatement` | `buffer.length` only grows until the line completes, so the short-circuit only fires the cap early | **DELETED with its construct.** There is no `buffer`, so there is no pending-bytes short-circuit and no directive. ADR-552 singled this one out as *"the one re-verified by hand"* and required an executable test that many short lines in one whole-blob push do not trip `MAX_LINE_BYTES`; ADR-558 dissolves the question — a whole-blob push allocates nothing, so there is nothing that could trip. The executable test is still worth keeping in a *different* form (§Test strategy: peak-state assertion), because it is the memory claim, not the mutant, that the reviewer should be able to check. |
| M5 | `nextLine` exhausted branch — `terminated: false`, `Stryker disable next-line BooleanLiteral` | the argument only feeds `trackLineCaps`' reset branch; that call is always the last line returned, so `currentLineBytes` is never read again | **DELETED — and the mutant becomes LIVE.** This is the row that a re-read would have got wrong. With `trackLineCaps` gone, `terminated` is no longer an argument to an unobserved side effect: it is the fold's `sawLf`, which decides (a) whether the LF is folded into the hash under an inactive key and (b) under `mode:'none' + ignoreCrAtEol`, whether the trailing CR is content (§D1.4, C6). Both are observable through `digestsEqual`. Forcing it to `true` is therefore a **real defect**, and P1b must ship a kill test — **and the obvious test does not work.** Under any *active* key ADR-557 pins `terminated` to `false` regardless, so an `ignoreWhitespace:'all'` fixture leaves the mutant alive; and before P8 lands, the `mode:'none' + ignoreCrAtEol` C6 shape does not distinguish either (the CR is dropped unconditionally on both sides). Two tests are needed: **(i) from P1b**, construct the scanner with `NONE_KEY` — its API takes any `LineKey`, even though the drop pass only ever passes active ones — over `"a\nb"` vs `"a\nb\n"`, where the unterminated final line must digest differently; **(ii) from P8**, the C6 shape `"x y\r"` vs `"x y\r\n"` under `{ mode:'none', ignoreCrAtEol:true }`, which kills it on the *active*-key path the predicate actually uses. Shipping only (ii) leaves a window; shipping only (i) leaves the active path unproven. |

**New proof obligations the fold creates: none claimed.** Every branch in §D1.3's three
transitions is reachable and distinguishable by one of the §D1.2 tail cases, so the design takes
on **zero** new equivalence arguments. If mutation triage later finds a survivor there, the
standing rule applies: kill it with a fixture, and only claim equivalence with a hand proof
anchored on the **expression** line (a multi-line proof comment between directive and expression
silently unbinds the directive — a known trap in this repository).

**Elsewhere in the touched files.** `whitespace.ts` carries seven further proofs on `lfIndex`,
`collapseRuns`, `dropTrailingWs` (×3), `dropTrailingCr` (×2) and `digestContentEnd`. The first
six belong to `normalizeLine`'s allocating helpers, which ADR-558 does **not** touch and whose
internal behaviour ADR-557 does not change (the terminator strip is applied *after* the mode
switch, §D6) — they survive, unexamined-but-unaffected, and the plan states that explicitly
rather than silently. `digestContentEnd`'s NOTE **dies with the function** under DC-15→A/C.
`patch-serializer.ts::trailingNoNewline`'s two directives die in P6 (§D6 step 3, blind-spot 10).
`diff-trees.ts::statOptionsFor`'s two inline `equivalent-mutant:` notes are untouched by any part.

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

The rule can only ever bite the **last** line pair: `splitLines` emits a terminated line for
every non-final line by construction, and so does the scanner (`sawLf` is false only on the step
that also sees `end()`), so `terminated` can differ on no other index. That bounds the blast
radius of the change to the final line of a file and is the argument that no mid-file alignment
moves.

**Where it lands — three sites, one commit** (ADR-557, adopted as recommended): the rule lives
in `normalizeLine` and is mirrored in the digest, so both consumers inherit it.

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
2. **`src/domain/diff/whitespace.ts` → the incremental fold's emit step** (the allocation-free
   twin, the predicate arm — §D1.4). The terminator must be suppressed **at construction**, not
   at comparison: the fold mixes the LF byte into the FNV hash when the line is terminated, so
   leaving `terminated` in place and merely ignoring it in `digestsEqual` would still yield
   different hashes (`sp-no-eol` in §Pin E-1 is the fixture that proves this: both sides
   normalize to zero content bytes, and only the folded LF distinguishes them). Concretely, the
   emit step's guard becomes `!lineKeyIsActive(key) && sawLf` — under an active key the LF is
   neither folded nor reported, which is *cheaper* than today, not merely equivalent.
   `digestsEqual` is **unchanged** — deliberately, because `whitespace.test.ts`'s
   hand-built-digest case ("terminated differs, length and hash match → false") is what keeps
   the `a.terminated === b.terminated` conjunct a killable mutant once the predicate can no
   longer produce a `terminated: true` digest. Under DC-15→A the single site is the fold, and
   `digestNormalizedLine` inherits it by being expressed over the fold; under DC-15→B it is two
   sites that must not drift.
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

### D7 — the C5 fix: there is nothing left for the caps to protect

**The threat argument, restated under ADR-558.** The previous revision's answer to "what do the
caps protect?" was *"`MAX_LINE_BYTES` bounds the per-line buffer on the streaming arm"* — and it
was correct **about a design that no longer exists**. `state.buffer` is gone (§D1.6): the fold
consumes each byte into a fixed set of scalars and never accumulates. So:

| cap | what it protected in the previous design | what it protects under the fold |
|---|---|---|
| `MAX_LINES = 100 000` | nothing in the predicate — `lineCount` was a counter, no allocation scaled with it | **nothing**, unchanged |
| `MAX_LINE_BYTES = 65 536` | the per-line accumulation in `state.buffer`; 32 pairs × 2 sides × line size | **nothing.** Peak per side is `sizeof(FoldState)` + a borrowed chunk reference. A 500 MB single-line minified bundle costs the streaming arm **one chunk**, whatever the transport hands over |

So the fix is not "delete the caps and accept a risk", and it is not "keep a bound where it still
buys something". It is: **the caps stop deciding the verdict, and there is no replacement bound
because there is nothing left to bound** (ADR-558). What the previous revision proposed as an
`overflow` `ScanStep`, a materialised-comparison escalation, an extra `readBlob` per pathological
pair and a second code route — **all of it is deleted, unbuilt.**

**The design (ADR-558 + ADR-560).**

1. **Both caps leave the drop path entirely, in P7a.** The `capsExceeded` scaffold (§D1.7) — two
   counters and one derived boolean, carried through P3 solely so the perf commit shows zero
   verdict movement — is deleted, along with the predicate's two reads of it. `binary` already
   meant NUL-only from P1b, so nothing changes meaning; something stops being consulted. This
   retires `len-65535`, `len-65536`, `tail-ws`, `rand-1line` and `lines-100000` on the predicate
   arm in one diff.
2. **Both ADR-549 arms are covered by construction**, not by per-arm configuration. There is no
   "bound armed / bound disarmed" distinction any more: the same capless scanner runs on the
   buffered arm (one `push` of the whole content) and the streaming arm (one `push` per inflate
   chunk), and §D1.5 step 1 proves those are the same computation. `tail-ws` (345 B on disk →
   buffered) and `rand-1line` (80 045 B on disk → streaming) still both go in the interop suite —
   not because the arms could diverge, but because that claim is the one worth having an
   executable witness for.
3. **The memory claim gets an executable witness, not a prose one.** ADR-552 asked for a test
   proving many short lines in one whole-blob push do not trip `MAX_LINE_BYTES`; that question
   dissolves, but the *underlying* claim — the scanner's footprint is independent of line length
   and line count — is now the load-bearing one. §Test strategy pins it directly: feed a
   single-line blob far over `MAX_LINE_BYTES` in many chunks and assert the scanner retains no
   reference beyond the current chunk.
4. **The `withStat` twin — the stat arm's verdict source (ADR-560).** `applyStatPass`
   and `materialisedShouldDrop` derive the drop verdict from `computeStatFields`, whose
   `binary` flag is `isBinary(old) || isBinary(next)` — line caps included — and whose
   `added`/`deleted` come from `diffLines`, which independently refuses `M + N > MAX_DIFF_LINES`.
   Both make the stat arm answer differently from the predicate arm (C5 via the caps, **C7** via
   `MAX_DIFF_LINES`). The fix routes the stat arm's *verdict* through the same scanner:
   ```
   dropVerdict(file, lineKey, ignoreBlankLines) =
     file.numstatBinaryOverride === 'binary' ? false
     : hasNulInWindow(old) || hasNulInWindow(next) ? false
     : scanEqual(old, next, lineKey, ignoreBlankLines)   // the P1b scanner, one push per side
   ```
   `stats` keeps being computed exactly as today and keeps populating the `withStat` surface;
   only the *keep/drop* decision moves off it. Consistency then holds **by construction** —
   the same statement ADR-551 makes about the perf slice's two arms, extended to the third —
   and the stat arm inherits ADR-558's O(1) fold for free (ADR-560's own consequence note).
   The `.gitattributes` overrides keep their meaning (`-diff` ⇒ forced binary ⇒ never dropped),
   which `diff-whitespace-modes-interop.test.ts`'s attribute suite already pins.
   **`hasNulInWindow` must be exported from `line-diff.ts`** for this call site (it is currently
   module-private); it stays out of `src/domain/diff/index.ts`, so no public surface moves.
5. **`line-diff.ts`'s own use of the caps is no longer "deliberately divergent" — ADR-561
   settles it in the same PR.** The previous revision argued the drop path and the diff path
   could legitimately diverge (*"the drop decision asks 'does any significant line differ',
   which is O(bytes); the diff asks 'produce an alignment', which is O((M+N)·D)"*). The argument
   about *cost* still holds and is what §D9 designs around — but it does not license a *binary
   verdict* divergence, and §Pin F shows none of `isBinary`'s five consumers wants the cap. C8
   is therefore §D9's, in P9, not left standing.

**Interaction with ADR-549's compressed gate — both arms, one code path.** A 70 000-byte
line of repeated bytes is 345 B on disk (§Pin E-2) and takes the **buffered** arm; an
80 003-byte incompressible line is 80 045 B on disk and takes the **streaming** arm. Under
ADR-558 the arms differ only in how many times `push` is called, and §D1.5 step 1 proves that is
not observable. Both fixtures still land in the interop suite — the previous revision needed
them because a compressible-only fixture set would have left an *escalation path* unproven;
there is no escalation path now, so they are there as witnesses to the chunk-invariance claim
rather than as coverage of a second route.

**Which assertions the fix commit flips.** `test/unit/application/primitives/diff-trees.test.ts:1728-1749`
— *"Given a single unterminated line longer than the line cap, whitespace-only change … Then the
file is kept (binary via the incremental cap, never buffered whole)"* — inverts to **dropped**,
and its comment about the pending-bytes bail is deleted rather than rewritten (there is no bail).
The scanner's cap tests written in P1b as *scaffold* tests (`capsExceeded` fires at
`MAX_LINE_BYTES` / `MAX_LINES`) are **deleted** in P7a; the *memory* claim they were coupled to
lives on as its own `it` (§D7 step 3) and does not move.
`test/integration/diff-whitespace-modes-interop.test.ts` C5 and C7 rows.
No `whitespace.test.ts` case flips.

**Size, honestly.** P7a is a **deletion**: two counters, one derived boolean, two predicate
operands, one scaffold test block. P7b is real surgery on `applyStatPass` plus a
`hasNulInWindow` export — ~35 lines of `src`. Keeping them as separate commits is what makes
P7a's diff read as "the caps stopped deciding" and P7b's as "the second arm joined"; collapsing
them does not violate ADR-554 (still one verdict family, still after P6).

### D8 — the C6 fix (ADR-559)

`--ignore-cr-at-eol` ignores a CR **only immediately before a real newline**. tsgit's
`applyCrRule` (`whitespace.ts:100`) and its allocation-free twin `digestContentEnd`
(`whitespace.ts:173`) strip a trailing CR without asking whether the line is terminated.
Under `all`/`change`/`at-eol` that is harmless — a trailing CR is ordinary trailing whitespace
there and git drops it too (§Pin E-1, `cr-no-eol` under `-w`/`-b`/`at-eol`: both drop). Under
`ignoreCrAtEol` with `mode: 'none'` it is an observable wrong drop.

The fix is one condition, applied on both sides of the rule:

```ts
const crApplies = key.mode !== 'none' || (key.ignoreCrAtEol && terminated);
```

`applyCrRule` currently does not know `terminated`; it is `lfIndex(bytes) < bytes.length`,
already computed by `lfIndex` inside `dropTrailingCr`. On the digest side, §D1.4 already shows
where it goes: `useTentative = pendingCr && key.mode === 'none' && !sawLf` — a single boolean
read at the line's emit step, no second pass, no lookahead. ADR-559 sequences this as its own
commit, immediately after P6, because it touches functions P6 just changed and rebases cheapest
there; it carries **no** dependency on the cap work and could be swapped with P7 at the cost of
rebase noise only. `test/unit/domain/diff/whitespace.test.ts:698` ("Given ignoreCrAtEol true
with mode none, When digesting a CR-terminated line") stays green (that line *is* terminated);
the flipping cases are the unterminated-CR rows at lines 312–325. ~4 lines of `src`.

**This commit is also where M5's killed proof pays off** (§D4). The `sawLf` bit that ADR-559
makes load-bearing is exactly the argument the deleted `Stryker disable next-line BooleanLiteral`
used to claim was unobservable. P8's own fixture — `"x y\r"` vs `"x y\r\n"` under
`{ mode: 'none', ignoreCrAtEol: true }` — is the kill test M5 now requires, so the obligation and
its discharge land in the same suite even though the directive dies in P1.

### D9 — the C8 fix: git's NUL window is the whole binary rule

ADR-561 put `isBinary`'s line caps in scope, with the blast radius stated: five consumers, and
a fix that *"does not complete on its own"*. §Pin F swept all five against live git; §Pin G
measured the second half. This section is the design that follows from those two matrices.

#### D9.1 — the honest end state, stated plainly

> **Yes: after this change, NUL in the first 8 000 bytes is the entire text/binary rule for
> tsgit, exactly as it is for git.**
>
> ```ts
> export function isBinary(bytes: Uint8Array): boolean {
>   return hasNulInWindow(bytes);
> }
> ```
>
> `exceedsLineCaps` is deleted (it has no other caller). `MAX_LINE_BYTES` keeps one live
> consumer — `grep`'s binary-presence-probe bound — and `MAX_LINES` keeps none; both remain
> **exported at today's values** with their documentation rewritten to say what they are and
> are not (§Requirements 11). §Pin F pinned git's window to `[0, 8 000)` byte-for-byte, and
> `hasNulInWindow` already implements exactly that, so **the surviving rule needs no change at
> all** — only the disjunct beside it goes.

**The memory and performance consequences, on the diff path** (ADR-561 confines the question
there; §D1 already removed the predicate's dependence on the caps):

- **`MAX_LINE_BYTES`: zero cost, measured.** §Pin G-6 — a 70 000-byte line through `diffLines`
  is **0.2 ms** and no measurable heap, because it is *two lines*. Line **length** never drove
  `diffLines`' cost; line **count** does. `splitLines` already produces `subarray` views, not
  copies, so a long line costs one view. Removing this cap has no downside anywhere.
- **`MAX_LINES`: real cost, and it is `MAX_DIFF_LINES`'s, not `isBinary`'s.** Every file over
  `MAX_LINES = 100 000` is necessarily over `MAX_DIFF_LINES = 50 000` on a modify pair, so
  removing the cap from `isBinary` alone changes *which wrong answer* five of the six surfaces
  give (§Pin F: "wrongly binary" → "wrongly degraded"), and on **merge** it is arguably a
  regression: git auto-merges the 100 001-line pair **cleanly**, tsgit today refuses it as
  binary and keeps ours, and post-P9a-only it would emit a **whole-file conflict region** — a
  bigger, noisier wrong answer. **P9a alone is not shippable; P9b is not optional.**
- **`grep` is the one consumer complete at P9a**, because it never touches `diffLines`. Its new
  exposure is real and is git's own: a 500 MB single-line minified blob is now *text*, so the
  caller's `RegExp` is run against a 500 MB latin1 line. `grep.ts:143-148` already names this
  hazard and bounds the *binary-probe* path to `MAX_LINE_BYTES`; the **text** path has no bound
  and never had one for any file under the caps. This is git's posture (`git grep` scans text
  files of any size) and the prime directive binds it, but it is the single most attackable
  claim in this section — blind-spot 15.

#### D9.2 — `MAX_DIFF_LINES`, settled once

ADR-561 requires one coherent answer, because the constant has two independent reasons to move:
ADR-560 retires it as C7's cause, and §D9.1 needs it re-examined for faithful counts. §Pin G
supplies the facts:

- The **input-size** pre-check buys nothing for the shape that matters — a 50 000-line pair with
  a one-line edit is **3.6 ms / 7.8 MB** (G-3) and two lines later is refused outright (G-4).
- The pre-check *is* load-bearing, but for a different shape: `iterationBudget = (M+N) × 1 000`
  means worst-case trace memory is **linear in M+N**, and at the cap it is a measured
  **769 MB / 958 ms** (G-5) — *reachable today*. Deleting the pre-check with nothing in its place
  extrapolates to **~3.1 GB / ~4 s** on the `manylines` pair. That is a genuine memory DoS and
  the design refuses it.
- So the bound that is actually needed is on **edit distance**, not input size. And
  `MAX_DIFF_EDIT_DISTANCE = 10 000` is already exported, already documented as *"subsumed …
  remains exported for documentation"*, currently **inert** — and today's measured bail at the
  cap is `d ≈ 10 000`. Activating it reproduces today's worst case **exactly** while making it
  input-size-independent.

DC-16 carries the three options and the recommendation; the design does not choose. What the
design *does* fix, under every option, is the shape of the answer:

- whatever the bound becomes, `wholeFileFallback`/`degraded: true` stays as the refusal
  mechanism — no new failure mode, no new error, no new option;
- `MAX_DIFF_LINES` is **not removed and not re-valued** (§Requirements 11 / §Pin G's `api.json`
  finding) — under DC-16→B it becomes export-only, like `MAX_LINES`;
- the four surfaces that consume `diffLines` (`computeStatFields`, `patch-serializer`,
  `three-way-content`, `range-diff/patch-text`) inherit the answer without any change of their
  own. Not one of them needs a code edit in P9b.

#### D9.3 — per-consumer disposition and the interop case that pins it

| consumer | code change in P9 | pinned expectation after P9a+P9b | interop suite that owns it |
|---|---|---|---|
| `computeStatFields` → `--numstat` | none (inherits `isBinary`) | `1 1` for both fixtures (§Pin F-1) | `diff-whitespace-interop.test.ts` (numstat matrix) + a new plain-path row |
| `patch-serializer` / `materialise-patch-files` | none (inherits `sideIsBinary`) | full text hunks; **zero** `Binary files` lines (§Pin F-2) | `diff-attr-binary-interop.test.ts` (already owns the `-diff`/`diff` overrides, which must **not** move) |
| `grep` | none (inherits `isBinary`); the `MAX_LINE_BYTES` probe bound **stays** | text hits with real line numbers; NUL blobs still `Binary file … matches` (§Pin F-3) | `grep-interop.test.ts` |
| `three-way-content` | none (inherits `isBinary`) | textual merge: clean auto-merge on `manylines`, `<<<<<<<` markers on `longline` (§Pin F-4) | `merge-interop.test.ts` + `merge-conflict-interop.test.ts` |
| `patch-id` | none (inherits `isBinary`, which also drops the file out of the `binaryKey` oid list) | a stable id over the full text hunks (§Pin F-5) | no interop suite exists; covered by the unit suite + the equality-relation assertions it already carries |
| `range-diff/patch-text` | none (inherits `isBinary`) | full hunks inside `## file ##`; **zero** `Binary files` lines (§Pin F-6) | `range-diff-interop.test.ts` (pin with `--creation-factor=999`, per §Pin F) |

**Every consumer inherits; not one is edited.** That is the strongest available evidence that
the caps were never a per-consumer policy — they were one function's disjunct leaking into six
surfaces. It is also why the blast radius, though wide, is **shallow**: the diff of P9a is two
lines of `isBinary` plus a deleted helper.

**Two behaviours that deliberately do *not* change.** (i) `patch-id`'s `binaryKey` mechanism
(appending `oidsOf` for binary files) differs from git's — git hashes a binary file's header
lines because its body is `Binary files … differ`. Both are stable identities; the caps change
only moves *which* files take that branch, and reconciling the two mechanisms is a separate
question this PR does not open. (ii) `.gitattributes` `-diff` / `diff` overrides keep exact
priority over the content sniff on every surface — `numstatBinaryOverride` /
`patchBinaryOverride` are consulted before `isBinary` and are untouched.

#### D9.4 — which assertions P9 flips

- `test/unit/domain/diff/line-diff.test.ts:148-176` — four `isBinary` rows invert from `true` to
  `false`: `MAX_LINE_BYTES` bytes on one line; `MAX_LINES` lines; `MAX_LINES` via a trailing
  incomplete line; and the two `-1` rows stay `false` **for a different reason** (they were never
  binary), which the test titles must stop implying. The NUL rows and the
  `BINARY_DETECTION_BYTES` boundary pair (offset 7 999 ⇒ `true`, offset 8 000 ⇒ `false`) are the
  **controls that must not move** — and §Pin F pinned both against live git, so they gain an
  interop witness for the first time.
- `test/unit/domain/diff/line-diff.test.ts:380-420` — the three `MAX_DIFF_LINES` describes move
  from input-size fixtures to edit-distance fixtures under DC-16→B, or stay put under A/C.
- `test/unit/application/primitives/diff-trees.test.ts:1728-1749` — already flipped by P7a; P9
  does not touch it again.
- **Verified not to flip:** `stat-fields.test.ts`, `patch-serializer.test.ts`,
  `patch-serializer.properties.test.ts`, `materialise-patch-files.test.ts` and
  `grep.test.ts:400` build every binary fixture out of **NUL bytes**, never out of length
  (checked across all five files). `grep.test.ts:400` in particular sets `blob[0] = 0x00`
  explicitly, so its `MAX_LINE_BYTES` probe-bound assertion is unaffected.

## Decision candidates

**All decision candidates are settled.** DC-1 … DC-14 are recorded in §Settled decisions and
ADRs 548–561. The three below were raised by ADR-558's rewrite of §D1 and ADR-561's
`MAX_DIFF_LINES` requirement, and are now settled too — each **as recommended**:

| # | outcome | record |
|---|---|---|
| DC-15 | **A** — the fold lives in `whitespace.ts`; `digestNormalizedLine` re-expressed as a thin whole-line driver, signature unchanged | ADR-562 |
| DC-16 | **B** — delete the input-size pre-check; activate `MAX_DIFF_EDIT_DISTANCE` at its existing 10 000; `MAX_DIFF_LINES` stays exported, export-only | ADR-563 |
| DC-17 | **A** — the `capsExceeded` observation scaffold, deleted by the cap-fix commit | ADR-564 |

The table below is retained as the reasoning behind those three outcomes.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-15 | Where the incremental fold lives, and what happens to `digestNormalizedLine` | **A** the fold lives in `whitespace.ts` as `createLineDigestFold(key)` (push-byte / end-line); `digestNormalizedLine(bytes, key)` is re-expressed as a thin whole-line driver of it, keeping its signature; the scanner drives the same fold directly · **B** the fold lives in `line-digest-scanner.ts`; `whitespace.ts` keeps today's four whole-line folders as the reference implementation · **C** the fold lives in `line-digest-scanner.ts` and `digestNormalizedLine` + the four folders + `digestContentEnd` are **deleted** (their only consumer is the drop predicate) | **A** | **A is one rule with one implementation**, which is ADR-551's whole argument applied one layer down, and it keeps the test oracle genuinely independent for free: `whitespace.test.ts`'s `expectedDigest` derives the expected digest from **`normalizeLine`'s output** (allocate the normalized array, FNV over it) — a separate implementation, not a copy of the SUT — so §Requirements 1a's bit-identity property has a real oracle without anyone writing one. A also keeps all ~40 existing `digestNormalizedLine` rows passing **unchanged**, which is the regression net for the rewrite. Verified precondition: `digestNormalizedLine`, `digestsEqual`, `digestIsBlank` and `LineDigest` are **internal** — absent from both `src/domain/diff/index.ts` and `src/public-types.ts` — so none of the three options touches public surface. **B is the two-implementations option**: the whole-line folders and the incremental fold encode the same rule and can drift, caught only by the property test; that is precisely the failure mode ADR-551 exists to prevent, and ADR-557/559 would then have to be applied twice, in two commits' worth of sites. **C is the smallest end state** — one fold, no wrapper — but it relocates ~40 pinned digest rows out of `whitespace.test.ts` in the same commit that rewrites the thing they pin, which is the worst possible moment to move a regression net, and it spreads the domain's digest rule across two files. **USER DECISION** — this is the "exact tentative/committed shape" question ADR-558 left open; A and C differ in whether a public-adjacent internal function survives. |
| DC-16 | `MAX_DIFF_LINES`'s fate — settled **once**, for both its reasons (ADR-560 retires it as C7's cause; ADR-561 needs it faithful) | **A** keep the `M + N > MAX_DIFF_LINES` input-size pre-check at 50 000, unchanged · **B** delete the input-size pre-check and activate the already-exported, currently-inert `MAX_DIFF_EDIT_DISTANCE = 10 000` as a live **edit-distance** bail in `computeMyersTrace`, re-basing `iterationBudget` on an absolute constant instead of `(M+N) × MAX_DIFF_ITERATION_FACTOR`; `MAX_DIFF_LINES` stays exported at 50 000, export-only · **C** raise `MAX_DIFF_LINES` to a large constant (e.g. 1 000 000), keeping the pre-check's shape | **B** | **A leaves C8 half-fixed and merge arguably worse.** §Pin F: every over-`MAX_LINES` file is over `MAX_DIFF_LINES` too, so P9a alone converts "wrongly binary" into "wrongly degraded" on five of six surfaces, and on merge that means a whole-file conflict region where git auto-merges **clean** (§Pin F-4). **B is faithful where it matters and worst-case-neutral where it does not.** §Pin G-3: a 50 000-line pair with a one-line edit already costs **3.6 ms / 7.8 MB**, so the input-size cliff protects nothing for the common shape; §Pin G-5: the real worst case is `d`-driven, **769 MB / 958 ms**, and *reachable today under the cap*; today's bail at the cap is `d ≈ 10 000`, so activating `MAX_DIFF_EDIT_DISTANCE` at its existing value **reproduces today's ceiling exactly** while removing its dependence on input size. Cost of B: `internLines` and the `2(M+N)+1` `v` array are now paid on arbitrarily large inputs — both O(M+N), the same order `splitLines` already pays, measured at 0.3 ms / ~3 MB for the 200 002-line pair (§Pin G-7). **C is B's memory profile without B's safety**: it re-values a public constant whose *literal value is its type* (§Pin G — `api.json` churn plus a public type change), moves the cliff instead of removing it, and because the iteration budget is proportional to `M+N` it multiplies worst-case trace memory ~20× (→ ~15 GB extrapolated). **USER DECISION** — B's 769 MB worst case is inherited, not introduced, but it is inherited *deliberately*; a reviewer may want that constant tightened, which is a pure behaviour change (more pairs degrade) and belongs in this decision, not after it. |
| DC-17 | How the perf commit keeps ADR-554's **zero verdict movement** now that ADR-558's scanner has no caps | **A** the `capsExceeded` observation scaffold (§D1.7): the scanner carries two counters and one derived boolean through P3; the **predicate** applies today's cap rule; P7a deletes all of it · **B** relax ADR-554 for the cap family — let P3 land the perf change and the C5 verdict change together, and drop blind-spot 9's mechanical check for those rows · **C** fix C5 first, on today's async predicate, before building the scanner — then P3 is verdict-neutral against an already-fixed baseline | **A** | ADR-554 is settled and blind-spot 9 makes "P3's diff touches no `tsgitDivergence` entry" a mechanical check; A is the only mechanism found that honours it **and** ADR-558 without reintroducing buffering. Its cost is ~6 lines of scaffold that exist for exactly one commit and are deleted by a diff that reads as *"the caps stopped deciding"* — arguably the clearest possible statement of the change. §D1.7 proves the scaffold is verdict-identical despite firing at line-emit rather than at the pending-bytes short-circuit, against all six §Pin E-2 shapes. **B is honest and cheaper** but forfeits the property that made the perf slice safe to review at all — "the oracle did not move" — on exactly the family where the oracle is most contested. **C is the worst of the three**: fixing C5 on today's buffering predicate means deleting the pending-bytes bail while `state.buffer` still exists, i.e. committing a known unbounded-buffering window, even if only for the span of one in-branch commit. **USER DECISION** — B trades a settled ADR's guarantee for ~6 lines. |

## Test strategy

- **P1a fold (unit, `test/unit/domain/diff/whitespace.test.ts` — extended, not replaced).**
  Under DC-15→A the fold *is* `digestNormalizedLine`'s implementation, so **all ~40 existing
  digest rows must pass unchanged** — that is the rewrite's regression net and it is the reason
  the fold does not get its own new example file. What is *added* is the tail grammar of §D1.2,
  which today's rows do not cover exhaustively: for each of the 8 `LineKey` shapes ×
  {terminated, unterminated}, the four worked cases `a  \r`, `a \r `, `a\r\r`, `a  \r  ` plus
  the leading-run cases `"  a"` / `"\ta"` (which `change` renders as one SPACE and `at-eol`
  keeps verbatim) and the all-tail cases `"   "`, `"\r"`, `""`, `"\n"`. Each asserted against
  `expectedDigest` (the `normalizeLine`-derived oracle), never against a hand-written hash.
- **P1a bit-identity (property, `test/unit/domain/diff/whitespace.properties.test.ts`).**
  This is §Requirements 1a made executable and it is the property the whole design rests on.
  CLAUDE.md lens **2** (compositional aggregator — the fold reduces a byte sequence to a
  digest, and the invariants are "empty ⇒ identity digest", "a hard byte always advances the
  committed pair", "a tail-only suffix never does"). Lens **3** (totality over a grammar) also
  fits and is property 4. Lens 1 does **not** fit — there is no inverse — and saying so is part
  of the four-lens discipline.
  1. **bit-identity vs the allocating reference**, `numRuns: 200` — for an arbitrary line
     (arbitrary bytes over `{a,b,SP,TAB,CR}` plus an optional trailing LF) and an arbitrary
     `LineKey`, the fold's `LineDigest` equals `expectedDigest(line, key)` **field by field**
     (`length`, `terminated`, `hash`), not merely `digestsEqual`. The oracle is
     `normalizeLine` + a plain FNV over its output — an independently-tested sibling that
     allocates the normalized array, **not** a re-implementation of the fold. *This is the
     property; everything else is scaffolding around it.*
  2. **chunk-split invariance**, `numRuns: 200` — for arbitrary bytes and an arbitrary
     partition into chunks, the emitted digest sequence and the final `binary` flag are
     identical to pushing the whole input as one chunk. Not a tautology: the oracle is the same
     scanner fed differently, which is exactly §D1.5 step 1's claim.
  3. **agreement with `linesEqualUnder`**, `numRuns: 100` — for arbitrary line pairs,
     `digestsEqual(fold(a,k), fold(b,k))` agrees with `linesEqualUnder(a, b, k)`.
  4. **totality**, `numRuns: 100` — over the safe subset (arbitrary bytes, no NUL) the fold
     never throws and always terminates. There are no caps to stay under any more, so the
     "safe subset" is now just "no NUL", which is itself the finding.
  Generators live in a shared `test/unit/domain/diff/arbitraries.ts`; no seed committed.
- **P1b scanner (unit, `test/unit/domain/diff/line-digest-scanner.test.ts`).** Every case
  today's `whitespace-drop-predicate.test.ts` drives through `chunkedStream` moves here and
  becomes synchronous (ADR-556): LF at a chunk boundary; a line split across three pushes; a
  chunk boundary **inside a whitespace run**, **between a CR and its LF**, and **between the
  last content byte and the LF** (the three positions §D1.3 identifies as the only ones where a
  boundary could have mattered); NUL in the first 8 000 bytes vs at byte 8 000 vs straddling a
  push boundary; unterminated final line; `ignoreBlankLines` skipping a spaces-only line under
  a whitespace mode but not under `'none'`; empty blob; blob that is a single LF; `push` after
  `end()` and `next()` after `exhausted` (the API legality contract §D1.6 states).
  Error data asserted via try/catch on `.data`, never bare `toThrow(Class)`.
  Two blocks are written **knowing they have different lifetimes** (§D7 step 3):
  - the `capsExceeded` **scaffold** block (fires at `MAX_LINE_BYTES` on one long line, at
    `MAX_LINES` on many short ones, isolated per operand) — **deleted wholesale in P7a**;
  - the **memory** block — feed a single line far over `MAX_LINE_BYTES` in many chunks and
    assert the scanner holds no reference beyond the current chunk and no accumulated buffer
    (e.g. by pushing detached views and asserting retained state is scalar-only). This is
    ADR-552's M4 obligation in the form that survives ADR-558, and **it does not move in P7a**.
- **M5's kill tests — two of them, and the obvious one is not enough (§D4/M5).** The deleted
  `Stryker disable next-line BooleanLiteral` becomes a **live** mutant on the scanner's `sawLf`.
  **(i) P1b:** construct the scanner with `NONE_KEY` (an inactive key — the API accepts one even
  though the drop pass never passes one) over `"a\nb"` vs `"a\nb\n"`; the unterminated final
  line must digest differently. **(ii) P8:** `{ mode: 'none', ignoreCrAtEol: true }` over
  `"x y\r"` vs `"x y\r\n"`, which kills it on the active-key path the predicate actually uses.
  Neither alone suffices: under an active key ADR-557 pins `terminated` to `false`, so a
  whitespace-mode fixture cannot see the bit at all, and before P8 the C6 shape drops the CR on
  both sides. Write (i) in P1b and (ii) in P8, and say so in both commits.
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
  - **C5 (P7a):** `tail-ws` (345 B on disk → **buffered** arm) and `rand-1line` (80 045 B on
    disk → **streaming** arm), plus `len-65536` and `lines-100000`; `long-line-txt` as the
    control that must keep surviving. Both arms stay mandatory — under ADR-558 they are one
    code path, so these rows are the executable witness to that claim rather than coverage of a
    second route.
  - **C7 (P7b, via ADR-560):** `lines-99999`, the one row whose divergence is *arm-specific*
    (predicate drops, stat keeps). It is what makes §Requirements 9 executable.
  - **C6 (P8, ADR-559):** `cr-no-eol` under `--ignore-cr-at-eol`, with its
    `-w`/`-b`/`--ignore-space-at-eol` rows as controls that must not move.
  - **C8 (P9):** `longline` and `manylines` (§Pin F) on the **plain** path — no whitespace flag
    — asserting `--numstat` counts and reconstructed patch bytes against git. The NUL-boundary
    pair (offset 7 999 ⇒ binary, 8 000 ⇒ text) joins as a permanent control that git's own rule
    is matched exactly; it has never had an interop witness before.
  Setup cost: the 100 000-line and 80 KB fixtures make the shared `beforeAll` heavier. It
  already carries an explicit `beforeAll(fn, 60_000)` — keep it and re-check the margin, since
  git-spawning setup hooks on this repo have timed out before.
- **P9's consumer sweep (integration).** One case per §Pin F row, each in the suite that already
  owns the consumer, each pinned against live git in the same run (not against a frozen
  constant): `grep-interop.test.ts` (text hits on both fixtures; a NUL blob still
  `binaryMatch`), `merge-interop.test.ts` (clean auto-merge of the 100 001-line pair with
  non-overlapping edits) + `merge-conflict-interop.test.ts` (textual `<<<<<<<` markers on the
  70 000-byte single-line pair, **not** `conflictType: 'binary'`),
  `range-diff-interop.test.ts` (full hunks, zero `Binary files` lines, peer pinned with
  `--creation-factor=999`), `diff-attr-binary-interop.test.ts` (the `-diff`/`diff` overrides
  keep exact priority over the content sniff — the control that must **not** move). `patch-id`
  has no interop suite; it is covered by its unit suite's equality-relation assertions plus one
  new case asserting an over-cap file no longer lands in the `binaryKey` oid list.
- **The fixes' unit coverage.** P6: `normalizeLine` + the fold over the four active key shapes ×
  {terminated, unterminated} × {blank, non-blank}, with the **inactive** key asserted unchanged
  (that gate is the whole fix); `trailingNoNewline` context edits for a gained and a lost
  terminator; `linesEqualUnder` and `isBlankLine` regression cases. P7a: the scaffold block
  deleted, the memory block untouched (above). P7b: the stat arm's `dropVerdict` for a NUL side,
  a `-diff`-override side, and an over-`MAX_DIFF_LINES` pair. P8: the CR rule ×
  {terminated, unterminated} × the four key shapes. P9a: `line-diff.test.ts`'s four inverting
  `isBinary` rows plus the NUL controls. P9b: whichever of DC-16's options lands, with the
  edit-distance bail (under B) tested at `d = MAX_DIFF_EDIT_DISTANCE` and `d = … - 1` as
  isolated boundary cases, and a large-input/small-edit case asserting `degraded: false` —
  the shape §Pin G-3/G-4 shows is the one that matters.
- **Cross-adapter (parity).** No `test/parity` scenario touches `ignoreWhitespace` today
  (§Requirements 8). Extend `test/parity/scenarios/diff-pipeline.scenario.ts` with a
  whitespace-only modified pair and assert the surviving paths — this is what catches an
  adapter whose `Compressor.inflate` behaves differently (and it is the suite that catches
  the workerd `return`-without-`await` class of failure; `test:parity:workers|deno|bun` are
  **not** in `npm run validate` and must be run explicitly, since P4/ADR-555 touch adapters).
- **Mutation.** The gate comparison (`<=` vs `<`), the arm-selection branch, and the fold's
  three transitions are mutation-dense; each boundary gets an explicit test rather than a
  documented equivalence. §D4's dispositions are re-derived, not carried: **four of the five
  proofs are deleted with their constructs (M1, M3, M4, M5) and one survives re-derived (M2)**;
  M5's mutant becomes **live** and gets a kill test. The design claims **zero** new
  equivalences in the fold. Two further proofs die in P6:
  `patch-serializer.ts::trailingNoNewline`'s pair of `Stryker disable` directives rest on *"a
  byte-identical context match forces equal trailing-newline state"*, which C4 falsifies — they
  are **deleted with the OR they guarded**, not re-anchored (§D6 step 3). One dies in P9a:
  `line-diff.ts::exceedsLineCaps` goes, taking its mutants with it. After P6, `digestsEqual`'s
  `a.terminated === b.terminated` conjunct is unreachable-by-the-predicate but stays killable
  through `whitespace.test.ts`'s hand-built digest case; if that case were ever deleted the
  conjunct would become a survivor, so it is load-bearing and must be labelled as such. Any
  survivor found in the fold is killed with a fixture; if an equivalence is ever genuinely
  needed, the directive must sit **immediately above the expression line** — a multi-line proof
  comment in between silently unbinds it, producing a survivor rather than an ignore.

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
2a. **New — the fold's own micro-measurement (P1a go/no-go).** ADR-558 replaces
   `indexOf(LF)` (a native scan) + a JS fold pass with a single JS pass that also tests for LF,
   and removes every per-line allocation (`subarray` ×2, `concatBytes`). §D1.6 **expects** a win
   and deliberately does not assert one. Measure `digestNormalizedLine` before/after over the
   four modes × {short lines, one long line} at the `whitespace.bench` level, before P1b is
   wired. A regression here is a design signal, not a tuning task: it would mean the native
   terminator scan was carrying more than the extra pass costs, and the fold would want a
   `indexOf`-assisted fast path for the `'none'`-inactive case. Record the number either way.
2b. **New — `diffLines` before/after under DC-16.** §Pin G is the baseline. Re-run G-3, G-5,
   G-6 plus the 100 001-line pair on the branch and record them; G-5 (**769 MB / 958 ms**) is
   the number that must **not** grow, and the 100 001-line/1-line-edit case is the number that
   must become finite and fast. Both belong in the PR body next to the drop-pass numbers.
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
| 1 | **P1a** | `src/domain/diff/whitespace.ts` — the incremental fold (§D1.1–D1.4), `digestNormalizedLine` re-expressed over it (DC-15). Existing digest rows pass **unchanged**; new tail-grammar rows; `whitespace.properties.test.ts` **extended** with the four §Requirements-1a properties (that file and `test/unit/domain/diff/arbitraries.ts` already exist — extend, do not replace). **Digest-identical by construction — no verdict moves.** | — |
| 1 | **P2** | `src/application/primitives/internal/blob-source.ts` — `openBlobSource`; `stream-blob.ts` re-expressed over it. `stream-blob.test.ts` passes **unmodified** (ADR-548). | — |
| 1 | **P5a** | `test/bench/diff-whitespace.bench.ts` — the many-small-modified-pairs fixture, loose + packed variants; existing add-shaped scenario relabelled (Pin D-3). Runnable on `main` to capture the before-number. | — |
| 1 | **P4a** | ADR-555's bench only: `inflateZlibMember` vs native `DecompressionStream` on large inputs, browser + memory. Produces the **recorded decision**, changes no adapter. | — |
| 2 | **P1b** | `src/domain/diff/line-digest-scanner.ts` — the sync `push`/`end`/`next` scanner over the P1a fold, plus the `capsExceeded` scaffold (§D1.7, DC-17). `concatBytes`/`takeLine` never written. §D4's dispositions land here: four proofs deleted, M2 re-derived, M5's kill test added. **No caller yet.** | ⇢ P1a |
| 2 | **P1m** | The P1a fold micro-measurement (§Measurement protocol 2a). Number in the PR body; a regression is a design signal, not a tuning task. | ⇢ P1a |
| 3 | **P3** | `whitespace-drop-predicate.ts` — the two arms, `compareBuffered` / `compareStreamed`, `iterator.return?.()` hygiene, the two `capsExceeded` reads. **This is the commit whose diff must show zero verdict movement** (ADR-554, blind-spot 9). | ⇢ P1b, P2 |
| 4 | **P5b** | Go/no-go: before(`main`)/after(branch), both variants, ≥2 runs, PR body. Re-profile. | ⇢ P3, P5a |
| 4 | **P3t** | Interop threshold-forced second pass (both arms pinned against git); the `tsgitDivergence` ledger seeded with every §Pin C/§Pin E/§Pin F row **at today's verdicts**; parity scenario for `ignoreWhitespace`. | ⇢ P3 |
| 4 | **P4b** | ADR-555's conditional branch: reimplement browser/memory `inflate`, or record "bench said no, option A taken". If taken, run `test:parity:workers\|deno\|bun` explicitly — they are not in `npm run validate`. | ⇢ P4a |
| 5 | **P6** | **C4 fix** (§D6, ADR-557). Deletes the C4 `tsgitDivergence` entries and `trailingNoNewline`'s two falsified directives. | ⇢ P3t |
| 6 | **P8** | **C6 fix** (§D8, ADR-559). Slotted here because it touches the sites P6 just changed, so it rebases cheapest immediately after; it carries no dependency on the cap work. | ⇢ P6 |
| 7 | **P7a** | **C5 fix, predicate arm** (§D7 steps 1–3, ADR-558): the `capsExceeded` scaffold and its two predicate reads **deleted**; the scaffold test block deleted, the memory block untouched. Deletes the C5 ledger entries for the predicate arm. | ⇢ P6 |
| 8 | **P7b** | **C5/C7 fix, stat arm** (§D7 step 4, ADR-560): `dropVerdict` off `computeStatFields`; `hasNulInWindow` exported from `line-diff.ts` (module-internal only). Deletes the remaining C5 entries **and** the C7 entry. | ⇢ P7a |
| 9 | **P9a** | **C8 fix, the caps** (§D9.1, ADR-561): `isBinary` becomes `hasNulInWindow` alone; `exceedsLineCaps` deleted; `MAX_LINE_BYTES`/`MAX_LINES` kept exported at today's values with rewritten docs. Flips `line-diff.test.ts`'s four cap rows; adds the six §Pin F consumer interop cases. | ⇢ P7b |
| 10 | **P9b** | **C8 fix, `MAX_DIFF_LINES`** (§D9.2, DC-16) + ADR. Deletes the C8 ledger entries for the `manylines` family. **Not optional** — P9a alone leaves five of six surfaces wrongly degraded and merge arguably worse. | ⇢ P9a |

Notes the planner needs:

- **Wave 1 is fully parallel** — P1a, P2, P5a and P4a never import each other. Waves 2–4 narrow:
  P1b is the only consumer of P1a, and P3 is the only thing that joins P1b and P2. Everything
  from wave 5 on is **one part per wave**, so "wave" there means commit order, not parallelism.
- **P1 is split at the fold/scanner seam, and the seam is load-bearing.** P1a is a pure
  restructure with a *provable* no-op on every digest (§D1.5) and can be reviewed as such; P1b
  is new machinery with a new API. Reviewing them as one commit would hide the one claim that
  the entire design rests on inside a file of new code. **This split is not optional.**
- **P6 must precede P7** (ADR-554 names that order) and both must follow the whole perf slice
  including P3t — the ledger has to exist before a commit can delete rows from it.
- **P8 and P7a are independent** of each other (different sites, same predecessor P6); the order
  shown is the cheapest rebase, and swapping them costs only rebase noise (ADR-559 says so
  explicitly). **P7a/P7b may collapse** into one commit; it stays a split because P7a is a pure
  deletion and P7b is surgery on `applyStatPass`. Collapsing violates no ADR.
- **P9a and P9b must not be reordered or separated.** §D9.1: P9a alone converts "wrongly binary"
  into "wrongly degraded" on five surfaces and makes merge output *worse*. If the PR has to be
  cut short, the cut is before P9a, never between them.
- **DC-16 changes P9b's content but not the part list.** DC-15 changes *which file* P1a edits
  (option C moves the fold into `line-digest-scanner.ts` and collapses P1a into P1b). DC-17→B
  deletes the `capsExceeded` scaffold from P1b/P3 and merges P7a into P3 — the only option that
  changes the part count.
- **Repo gates.** No part adds a public export, so `reports/api.json` should not move — the one
  place it *could* is DC-16→C, which re-values a literal-typed constant (§Pin G); if it moves
  under any other option, something leaked into `src/public-types.ts`.
  `line-digest-scanner.ts` is internal to `domain/diff/` and must **not** be added to
  `src/domain/diff/index.ts`'s public re-exports; the same goes for `hasNulInWindow` (P7b) and
  `createLineDigestFold` (P1a). `MAX_LINES` becomes an exported constant with no internal
  consumer in P9a — confirm `check:dead-code` (knip) tolerates it as public API before the
  commit, not after. `check:test-pyramid`, `check:doc-typedoc` and `cspell` run on the whole
  diff, not per part.

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
5. **Chunk-count invariance, and the fold's tail grammar.** §D1.5 step 1 is now the load-bearing
   claim, and it is *stronger* than the previous revision's two proofs (no branch reads a
   position, so a left-fold is partition-associative). Attack it where the argument could still
   be wrong: does any transition in §D1.3 read `cursor`, `chunk.length`, or "is this the last
   byte"? Then attack the **tail grammar** (§D1.2) directly — it is a hand derivation from four
   worked cases, and a fifth case it missed would be a silent wrong digest. Specifically try
   `"a\r \r"`, `"  \r  \r"`, `"\r"` alone, and a CR as the very first content byte, under all
   four modes × `ignoreCrAtEol`. And keep the old attack for `scanForNul`: a NUL at byte 7 999
   vs 8 000, straddling a push boundary, on both arms.
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
12. **C5's threat argument, restated.** The previous revision claimed `MAX_LINE_BYTES` bounded
    the streaming arm's per-line buffer; ADR-558 answers by deleting the buffer. **Verify that
    claim rather than accepting it**: walk §D1.6's field table and confirm nothing in the
    scanner retains a reference across a `push` except the current chunk, and that
    `compareStreamed` does not keep the chunks it fed. The memory test (§D7 step 3) is the
    executable form; a reviewer who can construct a retained-chunk path has found a real bug.
13. **The `capsExceeded` scaffold is verdict-identical, not merely similar.** §D1.7 argues that
    firing the cap at line-emit instead of at the pending-bytes short-circuit is unobservable,
    from four premises (binary ⇒ `false`; the binary check precedes the digest comparison;
    `true` needs both sides exhausted; `MAX_LINES` already fired at completion). Attack each.
    And confirm it really is deleted in P7a — a scaffold that survives its commit is worse than
    one that was never written.
14. **The stat arm's counts after ADR-560.** `stats` is still computed by `computeStatFields`
    and still populates `withStat`. Confirm a change that is *dropped* by the new `dropVerdict`
    can never surface counts (it is filtered out), and that a change that survives carries
    exactly today's counts — the fix moves the verdict, not the numbers.
15. **`grep`'s new unbounded text path (C8).** After P9a a 500 MB single-line minified blob is
    **text**, so the caller's `RegExp` runs against a 500 MB latin1 line on the *text* branch,
    which has no bound (the `MAX_LINE_BYTES` probe bound is on the **binary** branch only, and
    `grep.ts:143-148` names the hazard explicitly). §Pin F-3 shows this is git's own posture and
    the prime directive binds it — but this is the single most attackable claim in §D9. Decide
    whether "git does it too" is sufficient here, or whether a catastrophic-backtracking guard
    belongs in the same commit.
16. **P9's inherit-don't-edit claim.** §D9.3 asserts all six consumers inherit `isBinary` with
    **zero** code edits. That is a strong claim about a wide surface; check each call site for a
    second, independent cap assumption (e.g. an array pre-size, a `slice`, a loop bound) that
    the caps were quietly making safe. `materialise-patch-files.ts` has **six** `isBinary` call
    sites — check all six, not the two the design names.
17. **`MAX_DIFF_LINES` under DC-16→B: what did the input-size pre-check silently protect?**
    Its comment says it skips interning *"when the trace computation would refuse the input
    anyway"*. Under B, `internLines` (a Map with one entry per distinct normalized line) and
    `new Array(2(M+N)+1)` are paid before the edit-distance bail can fire. §Pin G-7 measures
    that at 200 002 lines (0.3 ms / ~3 MB), but the shape that is *not* measured is a 20 M-line
    input. Decide whether an input-size **guard** (as opposed to a refusal) is still wanted, and
    if so, that it is a memory guard with its own number, not a resurrection of the cliff.

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
- ~~C8 and `MAX_DIFF_LINES`~~ — **both are now in scope** (ADR-561, §D9, DC-16). Left listed
  here struck through so the scope change is visible in the diff rather than silent.
- **`patch-id`'s `binaryKey` mechanism.** tsgit appends `oidsOf` for binary files; git hashes a
  binary file's `diff --git`/`index` header lines instead (§Pin F-5 control). Both are stable
  identities, and §D9 only changes *which* files take that branch. Reconciling the two
  mechanisms is a separate question.
- **`MAX_DIFF_ITERATION_FACTOR`'s value.** DC-16→B re-bases the iteration budget off an absolute
  constant instead of `(M+N) ×` this factor; choosing a *different* ceiling than today's
  measured 769 MB (§Pin G-5) is a behaviour change with its own trade-off and belongs to DC-16,
  not to a later sweep — but re-tuning the Myers algorithm itself (a bogosqrt-style
  cost-limited heuristic like git's `xdiff`, which never degrades to a whole-file fallback at
  all) is genuinely out of scope here.
- **`streamInflate` and `fetch-pack`.** Different verb, different contract
  (`bytesConsumed`), untouched.
- **Raising `MAX_CONCURRENT_OBJECT_LOADS`** (ADR-553) — a measurement to run *after* the arm
  cost changes, not a design decision to take now.

## Results (measured)

Local go/no-go numbers from this host only (darwin 25.5.0, Node v22.22.3, arm64) — **not**
the published authority. The published authority is the nightly `bench.yml` artifact
(§Measurement protocol 3); this section exists so Part 14's after-numbers have a same-host
before-number to sit next to.

### Whitespace drop-pass diff, before (`main`)

Fixture: `buildWhitespacePairsScratch()` — 2,500 files (~50/directory) committed once, then
every space doubled and committed again (whitespace-only), built through the library's own
API into a fresh `mkdtemp` scratch repo, never touching the shared `~/.cache/tsgit-bench`
fixture. `sut = repo.diff({ from: 'HEAD~1', to: 'HEAD', recursive: true, ignoreWhitespace:
'all' })`. Two runs, 10 samples each.

| variant | run | min | mean | max |
|---|---|---|---|---|
| loose (as committed) | 1 | 257.92 ms | 261.18 ms | 268.74 ms |
| loose (as committed) | 2 | 256.76 ms | 263.88 ms | 276.35 ms |
| packed (`git repack -ad`) | 1 | 168.60 ms | 171.27 ms | 172.98 ms |
| packed (`git repack -ad`) | 2 | 166.62 ms | 169.27 ms | 171.98 ms |

Matches §Pin B's reference numbers (loose 258–271 ms warm, packed 165–176 ms warm) within
this host's run-to-run spread. Target for Part 14: loose ≤ 130 ms, packed ≤ 100 ms cold.

**After (branch tip): TBD — Part 14.**

### The existing `MEDIUM_FIXTURE` scenario — confirmed non-regression watch, not a predicate measurement

Mean 0.475 ms / 0.476 ms per iteration across two runs (1,000+ samples each) — two orders of
magnitude below the whitespace-pairs scenario, consistent with never entering
`isWhitespaceOnlyModify`. Confirmed directly, not just inferred from the timing gap: a
`vi.spyOn` on `isWhitespaceOnlyModify`, wrapped around this scenario's fixture resolution and
`sut` call, recorded **zero invocations** across a full run (temporary instrumentation, not
committed — see the TDD steps above). `changeShouldDrop` returns at `change.type !==
'modify'` before the predicate is ever reached, because `MEDIUM_FIXTURE`'s `multi` build
strategy writes 4 brand-new paths on every commit, so `HEAD~1..HEAD` is entirely `add`
changes.

### The fold micro-bench (`digestNormalizedLine`), before (`main`) — go/no-go for the incremental-fold part

Mean ms/call, two runs, no fixture, no `git`:

| mode | 5,000 short lines (run 1 / run 2) | one 70,000-byte line (run 1 / run 2) |
|---|---|---|
| `all` | 0.0959 / 0.0965 | 0.0553 / 0.0529 |
| `change` | 0.1172 / 0.1187 | 0.0701 / 0.0737 |
| `at-eol` | 0.1463 / 0.1465 | 0.1136 / 0.1128 |
| `none` | 0.0899 / 0.0886 | 0.0700 / 0.0702 |

**After (branch tip, once the fold lands): TBD — Part 14.** §Measurement protocol 2a expects
a win from replacing the native `indexOf(LF)` pass plus a JS fold pass with a single JS pass
that also finds the terminator, and from removing every per-line allocation; a regression
here is a design signal, not a tuning task to code around.
