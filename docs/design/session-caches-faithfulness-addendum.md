# Design — session-caches faithfulness addendum (31.2, eleven folded items)

> Brief: fold eleven items into the 31.2 PR on `feat/session-caches-per-command-floor` — six
> pre-existing git-faithfulness gaps pinned against git 2.55.0 (A size-lying loose header, B
> lightweight `tag.create` target, C `updateRef` target verification, D `gc.reflogExpire*`
> config, E single-ref `reflog expire` on a gone ref, F symlinked `HEAD` with a format-invalid
> link text), one sizing fix (H FlatTree default at sha256), two structural items (I structural
> `isObjectNotFound`, K `runExpire` length) and three LOW review findings (M HEAD-slot epoch, N
> repo-settings verdict double compute, O parsed-memo accounting).
> Status: draft → self-reviewed ×3 → decisions ratified (2026-09-14)

---

## Context

### Where this comes from

`docs/design/session-caches-per-command-floor.md` (the 31.2 design, including its
**Post-review corrections** block, which is authoritative where its body disagrees) was
implemented, reviewed to convergence, refactored and documented (worktree head `b80d85f9`). The
user folded eleven more items into the same PR. This addendum designs them; it amends nothing
in the parent design except where an item names the ADR it re-opens (H → ADR-851, O →
ADR-851/852, M → ADR-855, D/E → ADR-857's out-of-scope paragraph).

Environment for every number below: Apple M3 Pro, macOS, Node 22.22.3, `git version 2.55.0`.
Every git probe ran in a `mktemp -d` throwaway with `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`,
every `GIT_*` scrubbed, signing off, `merge.conflictStyle=merge`. "tsgit today" rows marked
**live** were run against the worktree source (esbuild bundle of `src/index.node.ts` on the same
throwaway repositories); unmarked rows are code-derived with the anchor given. Heap numbers are
`process.memoryUsage().heapUsed` deltas after six forced GCs (`node --expose-gc`), each
configuration run twice with identical results. Git source quotes are from the `v2.55.0` tag
(`object-file.c`, `odb/source-loose.c`, `odb/streaming.c`, `object.c`, `refs.c`,
`refs/files-backend.c`, `builtin/{tag,reflog,cat-file}.c`, `reflog.{c,h}`).

### What exists today (the seams touched)

| Item | Seam (anchors on `b80d85f9`) | Today |
|---|---|---|
| A | `domain/objects/git-object.ts:21` `splitObject` (size check `:29-33`); `object-resolver.ts:91-99` loose arm, `:146` `enforceLooseCap`, `:254` `verifyObjectContent`, `:691` `cacheEntry`; `internal/blob-source.ts:141` `toBytesSource`, `:154` `verifyBufferedBytes`, `:175` `resolveLoose`, `:310` `stripHeader`; `cat-file-batch.ts:21` `buildOkEntry` (`size: payloadByteLength`) | **live:** `catFile`, `readObject`, `readObject {verifyHash}` refuse `INVALID_OBJECT_HEADER` `size mismatch: header says N, actual content is M`; `streamBlob` (`NEVER_BUFFER` → stream arm, `parseHeader` only) serves the real bytes; `streamBlob {verifyHash}` refuses `OBJECT_HASH_MISMATCH` (it hashes the stored header). Two tsgit read paths already disagree on the same object |
| B | `commands/tag.ts:85` `tagCreate`, `:192` `updateTagRef` (exists = the CAS), `:186` `resolveObjectType` (annotated only) | **live:** lightweight `tag.create` to a tree → written (git agrees); to a nonexistent full oid → written (git refuses) |
| C | `primitives/update-ref.ts:17` `updateRef`; `commands/clone.ts:321` `writeRef`, `:353` `applyRemoteHead` (direct `applyRefUpdates` with remote-sourced ids) | **live:** `updateRef('refs/heads/u', <tree>)` and `updateRef('refs/tags/nx', <nonexistent>)` both written |
| D | `commands/reflog.ts:69-70` `DEFAULT_EXPIRE = '90.days.ago'`, `DEFAULT_EXPIRE_UNREACHABLE = '30.days.ago'`; `:164` `runExpire` resolves one cutoff pair for every target | `gc.reflogExpire*` read nowhere; `refs/stash` expires on the constants |
| E | `reflog.ts:201` `resolveExpireTargets` (`hasReflog` file probe on the verbatim name), `:267` `expireKindFor` (`peelRefToCommit`, not gentle), `:79` `reflog` (class check before `runExpire`) | **live:** `expire refs/heads/gone` (log kept, ref deleted) → rewrites the log; `expire refs/heads/dangling` (oid of a missing object, `never`/`now`) → throws `OBJECT_NOT_FOUND`; `expire side` → `REFLOG_NOT_FOUND`; `expire` with no ref → expires `HEAD` |
| F | `ref-store.ts:417` `resolveHeadDirect` symlink arm → `validateRefName(linkText)`; `internal/head-file.ts` slot; `internal/repo-state.ts:130` `hasUsableHead` (`isRefsLinkText`) | **live:** link `refs/heads/a..b` → a file holding an oid: `resolveRef('HEAD')` and `status` throw `INVALID_REF` `ref name must not contain ..` |
| H | `internal/object-caches.ts:109` `FLAT_TREE_DEFAULT_SHARE = 0.5`, `:124` `budgetsFor`; `:70` `memoByteValve`, `:80` `PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512`, `:91` `memoMaxEntries`; `read-head-tree.ts:86/:94/:104` sizer | FlatTree valve 8 MiB at every width; 50 000 files size to 8 200 048 B at sha1, 9 400 048 B at sha256 (44 620 fit). The memo has the same width blind spot (below) |
| I | `domain/objects/error.ts:79` `isObjectNotFound` (`instanceof TsgitError`); `primitives/internal/error-data-code.ts:14` `errorDataCode` (15 consumers) | ten production call sites classify by class identity |
| K | `reflog.ts:164-194` `runExpire`, 31 lines | guideline is < 20 |
| M | `head-file.ts:128` `validateHead` sets `trusted = true` on every gate; cleared only by `invalidateHeadSlot` (a HEAD write) or an `lstat` failure | **live (memory adapter):** gated command → raw `HEAD` rewrite → primitive `resolveRef('HEAD')` returns the pre-rewrite target on every read until the next gate |
| N | `config-read.ts:399` `memoizeSessionVerdict`, `:362` `reconcileAbsentKey`; `read-object.ts:64` `getPackRegistry`; `pack-registry.ts:633` `createPackRegistry` | **live:** primitive-only first `readObject` = `stat, readUtf8, stat` of `.git/config` — see correction 9 |
| O | `object-caches.ts:165` `PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256`, `:182` `parsedObjectByteSize` | sizer charges 256 B + message + signature + extra headers + parents × hexLength |

### Constraints this design lives under

- **ADR-226** git-faithfulness binds data, on-disk state, refusal conditions and message formats;
  **ADR-249** structured data only — every refusal below carries fields the caller composes git's
  lines from; nothing returns a rendered string.
- **ADR-850** config epoch (gate-armed; primitive-only sessions keep per-read stats) — N and M
  are measured against its wording. **ADR-851** entry-first cache bounds, valve-ordering pinned
  by test — H and O amend its numbers, never its principle. **ADR-852** delta-base cache sized
  from `core.deltaBaseCacheLimit`, family total 136 MiB — O re-opens the total. **ADR-854**
  `{ type, content }` cache value — A must not reintroduce a header-prefixed buffer. **ADR-855**
  "shared only within the command" — M. **ADR-857** git's expire model; its Consequences name D
  and E as open. **ADR-859/862** the repo-settings class tier — E moves where `reflog expire`
  reaches it. **ADR-860/861** `branch.create` start-point typing and the
  `UNEXPECTED_OBJECT_TYPE` reuse — the precedent B and C follow. **ADR-637** (carried forward)
  local-only `readConfig` scope — D inherits it.
- **Hot-path rule** (Post-review correction 8): no extracted `async` tier on a per-object read.
  A touches `resolveObjectContentWithDepth` and adds no `await`.
- **Surface gates** (`.claude/workflow/surface-gates.md`): `reports/api.json` regenerated in the
  commit that changes a public shape; `docs/use/errors.md` row per new thrower; the tarball cap
  in `tooling/verify-tarball.sh` is **928 KiB (950 272 B) against a measured 949 335 B — 937 B of
  headroom**; the house convention raises it in the part that crosses it, with attribution in
  the script comment.

### Brief corrections

Claims in the brief that the pins or measurements did not bear out:

1. **(A) "`git cat-file -p` prints the real bytes, and only `git fsck` catches it."** True only
   for **blobs**, and only on git's streaming tier. Commits and trees go through git's buffered
   reader (`unpack_loose_rest`, `object-file.c:202`), which allocates the *claimed* size: a body
   longer than the claim dies `error: corrupt loose object '<oid>'` on `cat-file -p`, `log`,
   `status`, `rev-parse`, `commit`; a body shorter than the claim is zero-padded and then refused
   `error: hash mismatch <oid>` by every `parse_object` caller. Blobs read through the buffered
   tier (`diff`, `archive`, `grep`, `repack`) are truncated, zero-padded, or refused depending on
   which side of the zlib header buffer the body ends. Matrix A1–A4.
2. **(A) the size check "may be protecting an allocation".** It is not, in tsgit: the loose arm
   allocates what zlib emits (`ctx.compressor.inflate`, 2 GiB port cap) and `enforceLooseCap`
   already measures the *actual* content. Git is the one that allocates from the header
   (a zero-filled buffer of the claimed `size`); pinned: a 12-byte blob claiming 104 857 600 made `git repack -ad` write a
   104 857 600-byte object into the pack.
3. **(B) "Git types it."** For a lightweight tag git checks **existence only**: `tag l <tree>`,
   `<blob>`, `<tag-object>` all succeed; only a nonexistent object is refused, by the generic
   ref transaction (`refs.c:1425-1445`), with `fatal: trying to write ref 'refs/tags/l-nx' with
   nonexistent object <oid>`. Commit typing applies to `HEAD` and `refs/heads/*` only.
4. **(C)** git's check is in `ref_transaction_update` for every writer, and `is_branch`
   (`refs.c:1072`) includes `HEAD` (`update-ref --no-deref HEAD <tree>` refuses). The check runs
   `parse_object`, so a hash-mismatching object is reported as *nonexistent*, and it precedes the
   old-value CAS.
5. **(D)** git 2.55's **effective defaults are total = 30 days, unreachable = 90 days** —
   `reflog.h:25-28` swapped them when expire moved into `reflog.c` in v2.50.0 (v2.49.0 still
   has 90/30; `master` still has 30/90). Pinned D0/D1. Also pinned: a `gc.<pattern>` entry's
   unset slot is **never**, not the global default (long-standing, pre-2.50); `refs/stash` never
   expires unless a pattern or an explicit flag says otherwise; an invalid value dies on **any**
   line (not last-wins), even on a non-matching pattern and even with both flags given.
6. **(E)** confirmed, and the same function (`repo_dwim_log`, `refs.c:840`) carries four more
   behaviours tsgit lacks: short-name DWIM, a symref whose own log is absent expiring its
   **target's** log, an unborn `HEAD` refusing, and the class being reached only **after** the
   target resolves. Adjacent: `expire` with no ref and no `--all` is a **no-op** in git
   (tsgit expires `HEAD`), and `lookup_commit_reference_gently` on a missing tip object is
   `UE_ALWAYS` (tsgit throws).
7. **(I)** `errorDataCode` lives in `src/application/primitives/internal/error-data-code.ts`
   (`midx-source.ts` is one of its 15 consumers), a layer `domain/objects/error.ts` cannot import.
   `isObjectNotFound` has **ten** production call sites, not nine (serena
   `find_referencing_symbols` + `rg`).
8. **(K)** confirmed at 31 lines. It runs once per `reflog expire` command and its loop body
   awaits file and commit reads; it is not a per-object hot path.
9. **(N) not reproduced.** The verdict is computed **once**. With `deltaBaseCacheMaxBytes`
   supplied (ADR-858: the budget reads no config) the primitive-only first `readObject` issues
   exactly `stat, readUtf8`; without it the second `stat` belongs to `deltaBaseCacheBudgetFor`'s
   own `readConfig`, which pays the primitive-only per-read stat ADR-850 documents. The
   `.then` that reconciles the absent sentinel is registered on the verdict promise before the
   caller's `await`, so it runs first and `createPackRegistry`'s check joins the settled entry.
   Same result for `writeObject`, concurrent reads, and an absent config file.
10. **(O)** the real per-entry heap of a memoised commit is **≈ 947 B of fixed overhead** (sha1,
    one parent, LRU node included), not 500–700 B: the sizer under-states typical commits 2.34×
    and short-message commits 3.3×. The FlatTree sizer is much closer: 1.26–1.32× measured over
    real `flattenTree` output.
11. **(H) the memo has the same width defect.** A typical commit (216-char message, one parent)
    sizes to 512 B at sha1 but 536 B at sha256; `32 768 × 536 = 17 563 648 > 16 777 216`, so at
    sha256 the byte valve binds at 31 300 entries — the ordering ADR-851's invariant test pins at
    sha1 only.

---

## Requirements

| # | Requirement | Oracle |
|---|---|---|
| R-A | A loose **blob** whose header size differs from its body is served with its inflated bytes by every tsgit read (`readObject`, `readBlob`, `catFile`, `streamBlob`, checkout) — git's streaming tier; a loose **commit/tree/tag** with the same defect is refused `INVALID_OBJECT_HEADER`; `verifyHash: true` refuses both with `OBJECT_HASH_MISMATCH` (git hashes the stored header); a size-lying object is never admitted to `ctx.deltaCache`; no allocation is sized from a header claim; `catFile`'s entry `size` is the header claim for such a blob (git `--batch`, `-s`) — per DC-A1/DC-A2 as ratified | new `loose-header-size-interop.test.ts` (A1–A4); unit on `object-resolver`, `blob-source`, `cat-file-batch`, `git-object` |
| R-B | Lightweight `tag.create` refuses a target object that does not exist; any existing type is accepted; an existing tag name is refused `TAG_EXISTS` before the target is verified | `ref-write-verification-interop.test.ts` (B1–B6); `tag.test.ts` |
| R-C | `updateRef` (and the ref writers ratified in DC-C2) refuses a nonexistent new object `OBJECT_NOT_FOUND`, an object whose stored bytes do not hash to its id `OBJECT_HASH_MISMATCH`, and a non-commit written to `HEAD` or `refs/heads/*` `UNEXPECTED_OBJECT_TYPE { expected: 'commit' }` (after the hash), all before the CAS; the hash is computed on every such update (no cache answers for it) and a blob body above the buffer gate is hashed without being materialised; deletes, null ids and symbolic writes are unverified — per DC-C1 (a) as ratified | same interop file (C1–C9); `update-ref.test.ts`, `clone.test.ts` |
| R-D | `reflog expire` resolves per-target cutoffs from `gc.reflogExpire`, `gc.reflogExpireUnreachable` and `gc.<pattern>.*` exactly as matrix D pins (explicit flags per slot, first matching pattern, unset pattern slot = never, `refs/stash` never, defaults per DC-D1); an invalid value refuses on any line before the flags, the target and the class | `reflog-expire-config-interop.test.ts` (D0–D23); pure unit on the policy module |
| R-E | A single-ref `expire` resolves its target as `repo_dwim_log` does and refuses `REFLOG_NOT_FOUND` when no candidate both resolves and has a log (own or symref target's); a tip that does not resolve to an existing commit expires by clock; no-ref-no-`all` behaves per DC-E2; the repo-settings class is reached after the target resolves | `reflog-interop.test.ts` extended (E1–E16, O-a…O-f) |
| R-F | A symlinked `HEAD` whose link text is `refs/`-prefixed **and** a valid refname resolves symbolic (unchanged); any other link text falls through to the file the link points to (missing or a directory ⇒ `missing`); the followed content is never held in the HEAD slot | `head-symlink-interop.test.ts` extended (F1–F8); `ref-store.test.ts` |
| R-H | The FlatTree and parsed-memo default valves admit their reference workload (50 000 tracked files; 32 768 typical commits per 16 MiB of dial) at **both** hash widths, derived from `ctx.hashConfig.hexLength`, identical to today at sha1; the invariant tests measure through the real sizers at both widths | `read-head-tree.test.ts`, `object-caches.test.ts` |
| R-I | `isObjectNotFound` classifies on `data.code` through one structural helper shared with every `errorDataCode` consumer | `error.test.ts` (foreign-shaped error → `true`) + one call-site test per consumer class |
| R-K | `runExpire` and every function extracted from it are < 20 lines; one `applyRefUpdates` per run; an update per target even when nothing prunes; the log-existence guard before any rewrite; reachability state built per ref; targets processed sequentially | existing `reflog.test.ts` + interop green with no assertion change in the K commit |
| R-M | The HEAD slot's freshness contract is stated where it is enforced and matches the code (DC-M1) | `head-file.test.ts` pins the ratified epoch |
| R-N | A primitive-only first object read computes the repo-settings verdict exactly once — pinned so the non-defect cannot regress into one | `read-object.test.ts` / `pack-registry.test.ts` finder-spy count |
| R-O | The parsed-memo accounting is either honest or documented as a proxy with its measured ratio (DC-O1) | `object-caches.test.ts`; `internals.md`, `performance.md` |
| R-all | `npm run validate` green; `reports/api.json` regenerated where a public shape moves; docs per [Docs consequences](#docs-consequences); the tarball cap raised with attribution in the part that crosses it | bare gate runs into files |

---

## Design

### X0 — Shape

| Item | Behaviour change? | Part |
|---|---|---|
| I structural `isObjectNotFound` | **Narrow behaviour change** — foreign-graph and duck-typed errors now classify as missing at ten sites; feature-scoped review of those sites | P13 |
| A size-lying loose header | **Behaviour change** (refusals removed for blobs, a size value changes) | P14 |
| H width-derived valves | **Tuning fix** — no git-observable change; amends ADR-851's defaults at sha256 | P15 |
| O memo accounting | per DC-O1: **tuning change** (a) or **docs-only** (c) | P15 |
| F symlink fall-through | **Behaviour change** (refusal removed; resolution moves toward git) | P16 |
| M HEAD-slot epoch | per DC-M1: **docs-only** (a) or **behaviour change** (b) | P16 |
| C `updateRef` verification | **Behaviour change** (new refusals) | P17 |
| B lightweight `tag.create` | **Behaviour change** (new refusal, refusal order) | P17 |
| K `runExpire` | **Pure refactor** | P18 |
| E single-ref expire resolution | **Behaviour change** | P18 |
| D `gc.reflogExpire*` | **Behaviour change** (config honoured, defaults, new refusals) | P18 |
| N verdict double compute | **Test pin + doc correction** (no runtime change under DC-N1 (a)) | P19 |

---

### A — size-lying loose object header

#### Pins (git 2.55.0)

Fixture: one commit holding `small.txt` (12 B, `hello world\n`) and `medium.txt` (1 880 B, 40
lines); each object's loose file re-deflated with a lying header by a Python zlib script, the
body byte-identical, the file kept at its original oid path.

**A1 — blobs.** Cells are exit code and the observable (stdout length or the refusal).

| Command | small, claim 5 | small, claim 20 | small, claim 104 857 600 | medium, claim 500 | medium, claim 4 000 |
|---|---|---|---|---|---|
| `cat-file -t` / `-e` | `blob` / 0 | same | same | same | same |
| `cat-file -s`, `--batch-check`, `ls-tree -l` | **5** | **20** | **104857600** | **500** | **4000** |
| `cat-file -p`, `cat-file blob`, `show <oid>` | 0, **12 B** (real) | 0, 12 B | 0, 12 B | 0, **1 880 B** | 0, 1 880 B |
| `cat-file --batch` / `--batch --buffer` | header `blob 5`, body 12 B | `blob 20`, 12 B | `blob 104857600`, 12 B | `blob 500`, 1 880 B | `blob 4000`, 1 880 B |
| `checkout -- <path>` (file size written) | 12 | 12 | 12 | 1 880 | 1 880 |
| `diff --stat <empty-tree> HEAD` | `1 +` (5 B read) | `Bin 0 -> 20 bytes` | `Bin 0 -> 104857600 bytes` | **128** `error: corrupt loose object '<oid>'` / `fatal: unable to read <oid>` | `Bin 0 -> 4000 bytes` |
| `archive` (member size) | 5 | 20 | 104 857 600 | **128** `fatal: loose object <oid> (stored in …) is corrupt` | 4 000 |
| `grep -c o HEAD -- <path>` | 1 | 1 | 1 | **128** corrupt | 40 |
| `fsck --full` | **3** `hash-path mismatch` | 3 same | 3 same | **3** `corrupt loose object` + `unable to unpack contents` | 3 `hash-path mismatch` |
| `repack -adq`, then `cat-file -p \| wc -c` | 0, pack holds **5** B | 0, pack holds **20** B (zero-padded) | 0, pack holds **104 857 600** B | **128** corrupt | 0, pack holds 4 000 B |
| `status --porcelain` | 0, clean | 0 | 0 | 0 | 0 |

**A2 — commit** (117 B body) and **tree** (37 B body).

| Command | commit, claim 50 | commit, claim 400 | tree, claim 10 | tree, claim 200 |
|---|---|---|---|---|
| `cat-file -s` | 50 | 400 | 10 | 200 |
| `cat-file -p` | **128** corrupt | 0, **400 B** (117 + 283 NUL) | 128 corrupt | **128** `error: hash mismatch <oid>` / `fatal: not a tree object` |
| `cat-file --batch` | header line printed, then 128 corrupt | 0, 400 B | — | — |
| `log --format=%H %s` / `show -s` | 128 corrupt | **0** | — | — |
| `rev-parse HEAD^{tree}` | 128 corrupt | **128** `error: hash mismatch` (×2) + `ambiguous argument` | — | — |
| `status` | 128 corrupt | 0 | 128 corrupt | 128 `hash mismatch` / `bad tree object HEAD` |
| `ls-tree HEAD` | — | — | 128 corrupt | 128 `hash mismatch` / `not a tree object` |
| `fsck --full` | 128 corrupt | **3** `hash mismatch` + `invalid sha1 pointer` | 128 corrupt | **11** `hash-path mismatch` |
| `commit --allow-empty` (child) | 128 corrupt | 0 | — | — |

**A3 — header range (header-only and stream tiers).** Claim `9007199254740993` and
`18446744073709551615`: `cat-file -s` prints the claim verbatim, `cat-file -p` streams 12 B.
Claim `18446744073709551616`: both `fatal: size_t overflow: 18446744073709551610 + 6`, 128.

**A4 — source.** Header-only callers (`oid_object_info` asked for type/size only) never inflate past
the header. The stream reader (`read_istream_loose`, `odb/source-loose.c:292`) inflates until
`Z_STREAM_END` and ignores the claim. The buffered reader (`unpack_loose_rest`) allocates
a zero-filled buffer of the claimed `size`, copies at most `size` bytes of whatever the first 32-byte header inflate
already produced, then inflates into the remaining `size - bytes` window: a body that ends inside
the first chunk is silently truncated to the claim, a longer body runs out of window
(`corrupt loose object`), a shorter body leaves the tail zero. `parse_object` (`object.c:378`)
hashes `type + claimed size + buffer` and refuses `hash mismatch`; for blobs it streams the hash
(`stream_object_signature`). `cat-file -p` and `--batch` route blobs to the stream reader and
every other type to the buffered one (`builtin/cat-file.c:199-230, :430`).

#### What the pins mean

Git has no single rule. The coherent, type-independent facts are: the header-only tier reports
the claim; the streaming tier — which git uses for every user-facing blob read (`cat-file -p`,
`show`, `checkout`, `--batch`) — emits the real bytes; every commit/tree/tag read refuses
(`corrupt` or `hash mismatch`) except `log`/`show -s`/`status`/`commit` on an under-running
commit body, which accept zero-padded content; `fsck` and any hash-verifying read refuse. The
incoherent facts — truncation to a claim that happens to land inside the first zlib chunk,
zero-padding, `repack` persisting either into a pack — are artefacts of a buffer sized by the
header, and reproducing them requires allocating the attacker-chosen size.

#### Change (as recommended in DC-A1 (b) and DC-A2 (a))

```ts
// domain/objects/git-object.ts — beside splitObject (which keeps its strict check: parseObject is public)
/** The loose-object split with the header's size claim kept as data, never enforced. */
export function splitLooseObject(rawBytes: Uint8Array): ObjectContent & { readonly declaredSize: number } {
  const { type, size, contentOffset } = parseHeader(rawBytes);   // grammar refusals unchanged (V1: "blob 07" etc.)
  return { type, content: rawBytes.subarray(contentOffset), declaredSize: size };
}
/** git's buffered tier refuses a size-lying commit/tree/tag on every parse; blobs take the streaming contract. */
export function assertLooseSizeConsistent(split: ObjectContent & { readonly declaredSize: number }): void {
  if (split.type === 'blob' || split.declaredSize === split.content.byteLength) return;
  throw invalidObjectHeader(`size mismatch: header says ${split.declaredSize}, actual content is ${split.content.byteLength}`);
}
```

`object-resolver.ts` loose arm (`:91-99`), no new `await`, no new function on the hot path:

```ts
const split = splitLooseObject(loose);
assertLooseSizeConsistent(split);                          // commits/trees/tags: today's refusal, verbatim reason
enforceLooseCap(id, split.content, maxBytes);              // unchanged: the cap measures ACTUAL bytes, never the claim
if (split.declaredSize === split.content.byteLength) {
  cacheEntry(ctx.deltaCache, id, { type: split.type, content: split.content });   // a lying blob is never cached; one value shape
}
await verifyObjectContent(ctx, id, split.type, split.content, verifyHash, split.declaredSize);
return { type: split.type, content: split.content, chainDepth: 0, declaredSize: split.declaredSize };
```

- `resolveObjectContentWithDepth`'s return gains `declaredSize: number` on **every** arm
  (empty tree and cache hit: `content.byteLength`; pack: `content.byteLength` — the pack arm's
  own size agreement is unchanged). One more slot on the same literal shape in every arm: no
  polymorphism, no microtask.
- `verifyObjectContent(ctx, id, type, content, verifyHash, declaredSize = content.byteLength)`
  hashes `serializeHeader(type, declaredSize)` then `content`. `parseHeader` already refuses any
  non-canonical header text, so `serializeHeader(type, declaredSize)` reproduces the stored header
  bytes exactly: a lying blob under `verifyHash` refuses `OBJECT_HASH_MISMATCH { expected: id,
  actual }`, matching `streamBlob`'s existing answer and git's `hash-path mismatch`.
- Not caching the lying object keeps a later `verifyHash: true` read honest (a cache hit would
  otherwise re-derive the canonical header from `content.byteLength` and pass).
- `blob-source.ts:141` `toBytesSource` → `splitLooseObject` + `assertLooseSizeConsistent`; the
  buffered arm's `verifyBufferedBytes` already hashes the stored bytes; the stream arm is
  unchanged (it is git's streaming tier already).
- `catFile` size (DC-A2 (a)): `read-object.ts` gains an internal `readObjectWithSize(ctx, id,
  options): Promise<{ readonly object: GitObject; readonly size: number }>` sharing
  `withLazyFetchRetry` and the parsed memo exactly as `readObject` does; `cat-file-batch.ts`
  `readOne` calls it and `buildOkEntry` takes `size` from it — `declaredSize` for every type, i.e.
  the stored body length git's `--batch` prints. It equals today's `payloadByteLength` for every
  blob, and for every commit/tree/tag whose re-serialisation is byte-exact; where tsgit's parser
  accepts a stored form it re-serialises to a different length, `size` now reports the stored
  length, as git does. `payloadByteLength` stays public (`reports/api.json`) for its other
  consumers. `readObjectMetadata` stays content-derived (its documented contract, and the value
  `deltify` budgets on).
- `readObject`'s public shape is unchanged; `payloadByteLength` stays for `show`/others.

**Residuals recorded (ADR).** No truncation or zero-padding on tsgit's buffered consumers
(`diff`, `archive`, `grep`, `pack-objects`): they see the real blob bytes, so a tsgit `gc` over a
size-lying loose blob writes the canonical object into the pack where `git repack` writes the
truncated/padded bytes (or dies). An under-running commit body refuses in tsgit where git's
`log`/`show -s`/`status`/`commit` accept its padded buffer. Claims in `(2^53, 2^64)` refuse
`invalid size` in `parseHeader` (not representable as a `number`) where git's header tier prints
them. `INVALID_OBJECT_HEADER` carries no `id`; git's `corrupt loose object '<oid>'` line is
composed by the caller from the id it asked for (ADR-249).

**Threat model.** The header claim is attacker-controlled (a planted `.git`, a crafted loose
file). After this change no tsgit code sizes an allocation from it: the loose arm allocates what
zlib emits under the compressor port's 2 GiB cap; `enforceLooseCap` and `enforceCachedCap` bound
the actual byte count; the claim is surfaced only as a number on `catFile`'s entry and is never
fed to `readObjectMetadata`, `deltify`, the pack writer or any buffer constructor. What the old
equality check protected was header integrity alone, and that is hash-covered for every caller
that asks (`verifyHash`, `fsck`). Git's own buffered tier is the one that allocates from the
claim (pinned, 104 MiB from a 12-byte body) — the design must not transcribe that.

---

### B — lightweight `tag.create` target

#### Pins (git 2.55.0; one-commit repo, `tag-to-tree`/`tag-to-commit`/`tag-to-blob` annotated)

| # | Command | Result |
|---|---|---|
| B1 | `tag l-commit <commit>` / `l-tree <tree>` / `l-blob <blob>` / `l-tagobj <tag-object>` | 0 — every existing type accepted; `for-each-ref` lists `blob`/`commit`/`tag`/`tree` |
| B2 | `tag l-nx <nonexistent full oid>` | 128 `fatal: trying to write ref 'refs/tags/l-nx' with nonexistent object <oid>` |
| B3 | `tag l-nx7 0123456` / `tag l-nope nope` | 128 `fatal: Failed to resolve '<arg>' as a valid ref.` (resolution, before verification) |
| B4 | `tag l-commit <nonexistent>` (name exists) | 128 `fatal: tag 'l-commit' already exists` — exists check **before** verification |
| B5 | `tag -f t <nonexistent>` | 128 `trying to write ref … with nonexistent object` |
| B6 | `tag bad..name <nonexistent>` | 128 `'bad..name' is not a valid tag name.` |
| B7 | `tag -a -m x a-tree <tree>` → 0; `tag -a -m x a-nx <nonexistent>` → 128 `fatal: bad object type.` | annotated path unchanged in tsgit (`resolveObjectType` → `OBJECT_NOT_FOUND`) |
| B8 | reftable backend: `tag l-tree <tree>` 0, `tag l-nx <nonexistent>` 128 same message | backend-independent |

Source: `builtin/tag.c:658-694` — resolve target → validate name → `already exists` → create
the tag object (annotated) → `ref_transaction_update` (verification, `refs.c:1425`).

#### Change

B is C's mechanism: `tagCreate`'s lightweight path already writes through `updateRef`, so once
`updateRef` verifies its target (C) the B2/B5 refusal is structural. What B adds is the order
B4 pins: tsgit's exists check is the CAS inside `updateRef`, which would now run **after**
verification. `tagCreate` gains the explicit pre-check `branch.create` already has, placed before
`createAnnotatedTag` so the annotated path also reports `TAG_EXISTS` first:

```ts
// tag.ts — tagCreate, after the target resolves and the class check (unchanged, O3)
if (input.force !== true && (await refExists(ctx, name))) throw tagExists(name);   // B4; the CAS stays as the race guard
const id = wantsAnnotatedTag(input) ? await createAnnotatedTag(ctx, input, targetId) : targetId;
await updateTagRef(ctx, name, id, input.force === true, `tag: ${input.name}`);       // updateRef verifies (C)
```

Refusal: `OBJECT_NOT_FOUND { id }` — the existing code; git's line needs the ref name, which the
caller holds (ADR-249, ADR-861's reasoning). No new code, no `api.json` change.

---

### C — `updateRef` target verification

#### Pins (git 2.55.0; `C` commit, `T` tree, `B` blob, `AT` annotated tag → tree, `NX` nonexistent)

| # | Command | Result |
|---|---|---|
| C1 | `update-ref refs/heads/u {C, T, B, AT, NX}` | C: 0. T/B/AT: 128 `fatal: update_ref failed for ref 'refs/heads/u': trying to write non-commit object <oid> to branch 'refs/heads/u'` (a tag object is **not** peeled). NX: 128 `… trying to write ref 'refs/heads/u' with nonexistent object <oid>` |
| C2 | `update-ref {refs/tags/u, refs/remotes/o/u, refs/notes/u, refs/u, refs/stash} {C,T,B,AT}` | 0 for every type |
| C3 | same five refs with NX | 128 `nonexistent object` |
| C4 | `update-ref HEAD T` (symref → main); `update-ref --no-deref HEAD T` | both 128 `non-commit object … to branch 'HEAD'` — `HEAD` is a branch (`is_branch`) |
| C5 | `update-ref --no-deref HEAD NX` → 128 nonexistent; `update-ref ORIG_HEAD T` → **0**; `FOO_HEAD NX` → 128 nonexistent | only `HEAD` and `refs/heads/*` are typed |
| C6 | `--stdin` `create refs/heads/s T` / `update refs/heads/main T` | 128 same non-commit message (no `update_ref failed` prefix) |
| C7 | `update-ref refs/tags/t NX <wrong-old>`; `update-ref refs/heads/main T <wrong-old>` | verification reported, **not** the CAS — verification precedes the old-value check |
| C8 | `update-ref refs/tags/cb <hash-mismatching blob>`; `refs/heads/cc <hash-mismatching commit>` | 128 `error: hash mismatch <oid>` + `nonexistent object` — `parse_object` verifies the hash |
| C9 | `update-ref -d refs/tags/t <wrong-old NX>` → 1 CAS error; `update-ref refs/tags/t 0000…` → 0 (delete); `symbolic-ref refs/heads/s refs/heads/nope` → 0; `update-ref refs/heads/s T` (s → nope) → 128 typed by the **given** name; reftable: C1/C3 identical | deletes, null ids and symbolic writes are unverified |

Source: `refs.c:1425-1445` — `(flags & REF_HAVE_NEW) && !new_target && !is_null_oid(new_oid) &&
!(flags & REF_SKIP_OID_VERIFICATION) && !(flags & REF_LOG_ONLY)` ⇒ `parse_object`; `!o` ⇒
nonexistent; `o->type != OBJ_COMMIT && is_branch(refname)` ⇒ non-commit. The only
`REF_SKIP_OID_VERIFICATION` user in v2.55.0 is ref-storage migration (`refs.c:3200`); `fetch`,
`clone`, `receive-pack`, `stash`, `notes`, `sequencer` all verify.

#### Change (DC-C1 (a) full `parse_object` parity and DC-C2 (c), as ratified)

DC-C1 was ratified as **(a)**, not the (b) this design recommended: every verified ref update
checks its target the way `parse_object` does. The rule is: the object exists **and** its stored
bytes hash to the id; `HEAD` and `refs/heads/*` additionally require type `commit`, with an
annotated tag object refused rather than peeled (C1). The C8 residual (b) carried is gone. (a) as
tabled read every target through `readObject { verifyHash: true }`, which materialises every body;
the shape below keeps the rule and does not materialise a large body.

**git's shape** (`object.c` `parse_object_with_flags`, v2.55.0). An object already parsed in the
running process is returned without hashing (`lookup_object` … `obj->parsed`). Otherwise a
header-only `odb_read_object_info` that answers `OBJ_BLOB` sends the object to
`stream_object_signature`; every other type is read whole (`odb_read_object`) and hashed by
`check_object_signature`. Any failure returns `NULL`, which `ref_transaction_update` reports as
nonexistent; the type test runs only on a parsed object (C8: `hash mismatch` precedes
`nonexistent object`).

**Which existing read the check builds on** (anchors on `b80d85f9`):

| Read | Hashes on every arm under `verifyHash`? | Large body materialised? | Type known at open? |
|---|---|---|---|
| `readObjectMetadata` (`read-object.ts:263`) | never hashes | loose: yes (`:295` → `readRawObject`) | packed: header walk, zero inflate |
| `readObject` / `readRawObject` → `resolveObjectContentWithDepth` (`object-resolver.ts:68`) | yes: cache hit `:88`, loose `:97`, pack `:109`; the virtual empty tree `:82` returns without a hash | yes, every arm | after the body |
| `openBlobSource(…, NEVER_BUFFER, …)` (`streamBlob`) | yes, while the stream drains | loose and packed base: no; packed delta: yes (`resolvePackDelta:243`) | packed: yes; loose: no, and a non-blob refuses at the header (`stripHeader:320`) |
| `openBlobSource(…, MAX_BUFFERED_BLOB_BYTES, …)` | yes: cache hit `resolveFromCache:171`, buffered loose `verifyBufferedBytes:183` (the stored bytes, stored header included), packed base `:223` or its stream tail `:400`, packed delta `:251` | only below the 64 KiB compressed gate, and packed deltas | cache hit, buffered arms, packed: yes; loose above the gate: no, and a non-blob refuses at the header |

The last row already has the property the rule needs — buffered below the gate, hashed as it
inflates above it, on every storage form — and lacks only the loose stream arm's type. The check
is built on it:

```ts
// src/application/primitives/internal/blob-source.ts — beside openBlobSource
/** git's parse_object hash check, without its parse: `id` exists and its stored bytes hash to it;
 *  the stored type is returned. Every arm hashes; a body above the buffer gate is hashed as it
 *  inflates and never retained. */
export async function verifyStoredObject(ctx: Context, id: ObjectId): Promise<ObjectType> {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () => hashStoredObject(ctx, id));
}
async function hashStoredObject(ctx: Context, id: ObjectId): Promise<ObjectType> {
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
  if (source.kind === 'stream') await drain(source.stream);   // the arm's hasher refuses OBJECT_HASH_MISMATCH at the end
  return source.type;                                         // known on every arm once (1) below lands
}

// src/application/primitives/internal/ref-target.ts (new)
/** git's `is_branch` (refs.c:1072). */
const isBranchRef = (name: RefName): boolean => name === 'HEAD' || name.startsWith(HEADS_PREFIX);

/** git's ref_transaction_update verification (refs.c:1425-1445): parse_object must succeed, then a
 *  branch needs a commit. */
export const assertRefTargetValid = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  if (id === zeroOid(ctx.hashConfig)) return;                                   // git: !is_null_oid
  const type = await verifyStoredObject(ctx, id);                               // OBJECT_NOT_FOUND, OBJECT_HASH_MISMATCH
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);   // after the hash (C8 order)
};
```

`drain` iterates the stream to its end and discards the chunks; the hash lives in the arm's own
tail (`yieldAndVerifyChunks`, `yieldAndVerifyPackedBaseChunks`), which is why the type is returned
only after the drain.

Two supporting changes, both in P17 commit 1:

1. **The loose stream arm parses its header at open.** `stripHeader` returns `{ type, headerBytes,
   content }` and stops refusing; `resolveLoose`'s stream arm pulls inflate chunks up to the NUL
   before it returns and reports that `type`; the tail hashes `headerBytes` and the remainder
   exactly as today. `BlobSource`'s stream arm narrows `type` to `ObjectType`, the module
   docstring's one exception is deleted, and the `source.type !== undefined` half of the two
   consumers' refusals (`stream-blob.ts:21`, `whitespace-drop-predicate.ts:46`) becomes dead and is
   removed — their existing open-time blob test now covers the loose arm too. Observable in tsgit
   only: `streamBlob` on a loose non-blob raises the same `UNEXPECTED_OBJECT_TYPE { expected:
   'blob', actual, id }` at its `await` instead of at the first chunk; `release()` cancels through
   the iterator that read the header. Preferred over a verifier-private loose tail because both
   callers then share one storage order (cache, loose, pack, behind `assertLoadable`) and an
   asymmetry is removed rather than a mode added.
2. **`withLazyFetchRetry` (`read-object.ts:173`) is exported for internal use,** so a promised
   object is fetched before it is refused — the lazy-fetch (b)'s `readObjectMetadata` sketch
   carried. `verifyStoredObject` lives in `blob-source.ts` because that module already imports
   `read-object.ts`; the reverse placement would cycle.

**Guarantee — the hash is always computed.**

- Every arm of `openBlobSource` hashes under `verifyHash: true` (table above); stream arms hash
  only when drained, and `hashStoredObject` drains before it returns.
- A `ctx.deltaCache` hit is hashed, not trusted (`resolveFromCache:171` →
  `verifyObjectContent:254`). The cache is written only with bytes read from the store for that id
  (loose arm `object-resolver.ts:96`, pack chain `:554`; `writeObject` does not write it), and
  after A no size-lying loose object is admitted, so `serializeHeader(type, content.byteLength)`
  reproduces the stored header for every cached entry.
- The parsed-object memo is not on this path: its only reader is `resolveObject`
  (`object-resolver.ts:128-130`), and even there it is consulted after
  `resolveObjectContentWithDepth` has run the hash.
- Stricter than git inside one process: git skips the hash for an object the process already
  parsed. tsgit's caches outlive a command and are filled by unverified reads, so they cannot
  stand in for git's object table; tsgit hashes on every verified update. For a fresh git
  process — what every pin measures — the verdicts agree.

**Guarantee — a large blob is not materialised.** A loose object whose compressed file exceeds the
gate, and a packed base entry whose payload or declared size exceeds it, are hashed as they
inflate; no chunk is retained. What memory still holds: the compressed loose file
(`looseCompressedBytes` reads it whole) or the compressed pack entry slice, and one inflate chunk.
The gate counts compressed bytes: a buffered packed base is also held to its declared size
(`resolvePackBase:218-221`), a buffered loose body is not, so a loose file under 64 KiB can still
inflate to deflate's ratio limit (≈ 64 MiB) — the bound `openBlobSource`'s existing callers already
accept, under the compressor port's 2 GiB cap. A packed **delta** is reconstructed in memory, bounded by the compressor port's 2 GiB cap, as every
tsgit read of a deltified object is — tsgit has no streaming delta path; recorded, not changed.

**Guarantee — branch typing.** The type comes from the stored header on every arm and is tested
only after the hash passed, so a hash-mismatching commit on `refs/heads/*` reports the hash (C8)
and an annotated tag object on a branch is `tag`, refused (C1).

**Placement.**

- `updateRef` (`update-ref.ts:17`): after `validateRefName`, **before** `resolveDirect`/CAS
  (C7), skipped on `options.delete === true` (C9).
- `clone.ts` `writeRef` (`:321`) and `applyRemoteHead`'s detached `set` (`:370-380`): call it
  before `applyRefUpdates` — the two direct store writers whose ids arrive from a remote
  advertisement. Internal writers of ids the same command just produced (`commit`, `stash`,
  `rebase`, `checkout`, `worktree`, `submodule`) are not touched (DC-C2).

**Refusal data** — all existing codes; no error-union, `api.json` or exhaustiveness change.

- Absent: `OBJECT_NOT_FOUND { id }`.
- Hash mismatch: `OBJECT_HASH_MISMATCH { expected: id, actual }`. git's `error: hash mismatch
  <oid>` and `fatal: trying to write ref '<ref>' with nonexistent object <oid>` both compose from
  `expected` plus the ref name the caller passed.
- Non-commit on a branch: `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }` (ADR-861).
- A size-lying loose object (A) of any type refuses `OBJECT_HASH_MISMATCH`: the buffered arm hashes
  the stored bytes before it splits them, the stream arm hashes the stored header. That git refuses
  such a target follows from `parse_object`; its exact lines for a size-lying target are not among
  C1–C9 and are not claimed here.

**Pin to add in P17.** `openBlobSource` has no virtual empty-tree arm, `resolveObjectContentWithDepth`
has one (`:82`). C1–C9 do not probe the empty-tree id as a target in a repository that does not
store it; P17's interop file adds that row, and `hashStoredObject` takes a virtual arm only if git
accepts the write.

**Cost.** Every verified ref update now reads and hashes one object, where (b) read one pack
header for a branch and probed presence for every other ref. `updateRef`'s callers are `commit`,
`reset`, `merge`, `cherry-pick`, `revert`, `rebase`, `abort-merge`, the sequencer abort, `fetch`,
`push`, `notes`, `remote`, `branch`, `tag` and the facade.

- Commit-sized target: one loose read, one inflate and one hash of the stored bytes; or one pack
  entry slice read, one inflate (a delta chain reconstruction for a deltified entry) and one hash.
  A `ctx.deltaCache` hit removes the read and the inflate, never the hash. `commit` writes its
  commit loose and then updates the branch: one extra read, inflate and hash of that commit per
  commit. `branch.create`'s `requireCommit` reads the start point through `readObject` first, so
  its update is normally a cache hit plus one hash.
- Blob target (tags, notes, remote-tracking refs; a branch update to a blob, which then refuses on
  type): a hash over the whole body, streamed above the gate.
- A `clone` or `fetch` writing N refs hashes N targets, as git's transaction does.
- `commit.bench` and the parent design's `branch.create` floor (R2) are re-measured main-vs-branch
  in P17's part gate and recorded in the PR; no figure is claimed here.

**Residuals recorded (ADR).** `parse_object_buffer` (`object.c`) also returns `NULL` when
`parse_commit_buffer`, `parse_tag_buffer` or `parse_tree_buffer` fails on a hash-valid object; the
check hashes without parsing, so a hash-valid object git's parsers refuse is accepted. Not probed.
Writers outside DC-C2's set remain unverified.

**Threat model.** `newId` is caller- or network-controlled (a Tier-2 caller, a fetch/clone
advertisement). The check hashes the target's stored bytes, so what an advertisement can plant
narrows to objects that are both present and intact: a ref to a missing object, a ref to an
object whose bytes do not hash to its name, and a `refs/heads/*` or detached `HEAD` pointing at a
non-commit are all refused, as git refuses them. Memory: no allocation is sized from the target
beyond what every tsgit read already allows — a blob body above the gate is hashed chunk by chunk,
a commit-sized body is inflated once under the compressor port's 2 GiB cap, and a packed delta is
reconstructed under that same cap. CPU: an attacker who can name a large existing blob as a ref
target makes the check hash that blob once per update, which is also what git does.

---

### D — `gc.reflogExpire` / `gc.reflogExpireUnreachable` / `gc.<pattern>.*`

#### Pins (git 2.55.0)

Fixture: `main` at C; commits A(200 d ago) → B(100 d) → C(60 d); U(60 d, child of B) and
U2(10 d, child of C) dangling. `logs/refs/heads/main` rewritten before every row with seven
entries: e1 `0→A` 200 d, e2 `A→B` 100 d, e3 `B→U` 60 d, e4 `U→B` 60 d, e5 `B→C` 60 d, e6
`C→U2` 10 d, e7 `U2→C` 10 d (e3/e4/e6/e7 unreachable from the tip; ages relative to the real
clock at probe time). Cells list the entries **kept**.

| # | Config / flags (`reflog expire … refs/heads/main` unless stated) | Kept | Reading |
|---|---|---|---|
| D0 | none | e6 e7 | e5 (60 d, reachable) expired ⇒ default total is **30 d**, not 90 |
| D0′ | none, argument `main` | e6 e7 | DWIM (see E) |
| D0″ | none, **no ref argument** | all 7 (and `HEAD`'s log untouched, E10) | no-op |
| D1 | `gc.reflogExpire = never` | all 7 | e3/e4 (60 d, unreachable) kept ⇒ default unreachable is **90 d**, not 30 |
| D2 | `gc.reflogExpireUnreachable = never` | e6 e7 | unreachable 0 ≤ total ⇒ `UE_ALWAYS`, total 30 d |
| D3 | `45.days.ago` / `15.days.ago` | e6 e7 | |
| D3b | `120.days.ago` / `45.days.ago` | e2 e5 e6 e7 | the rule with honest cutoffs |
| D4 | D3b + `--expire=now` | none | explicit total, config unreachable |
| D4b | D3b + `--expire=never` | e1 e2 e5 e6 e7 | |
| D5 | D3b + `--expire-unreachable=never` | e2 e3 e4 e5 e6 e7 | explicit unreachable, config total |
| D5b | D3b + both flags (`150.days.ago` / `5.days.ago`) | e2 e5 | both explicit ⇒ config ignored |
| D6 | `[gc "refs/heads/*"] reflogExpire = 120.days.ago` only | e2…e7 | the pattern's **unset** unreachable slot is **0 (never)** ⇒ `UE_ALWAYS` at 120 d |
| D6b | pattern `reflogExpireUnreachable = 45.days.ago` only | e1 e2 e5 e6 e7 | unset total slot = never |
| D6c | pattern both 120 d / 45 d | e2 e5 e6 e7 | |
| D6d / D6e | global 120/45 plus pattern `reflogExpire = never` (either section order) | all 7 | a matching pattern ignores the global keys entirely |
| D7 | non-matching `[gc "refs/tags/*"]` never/never | e6 e7 | defaults |
| D8 / D8b | `heads/*` never/never then `heads/m*` total now; and the reverse order | all 7 / none | **first** matching pattern in config order wins |
| D8c | `[gc "refs/heads/*"] reflogExpire=120.days.ago`, a second `[gc "refs/heads/*"]` section with `reflogExpireUnreachable=45.days.ago` | e2 e5 e6 e7 | same pattern text merges into one entry |
| D8d / D8e | pattern `refs/heads/main` / pattern `main` | all 7 / e6 e7 | matched against the full refname |
| D8f / D8g | pattern `refs/*` / `refs/**` | all 7 / all 7 | `wildmatch(…, 0)`: `*` crosses `/` |
| D9 / D9b / D9c | `false`/`false`; total `now`; unreachable `all` | all 7 / none / none | `parse_expiry_date` keyword layer (tsgit's `resolveExpiryCutoff`) |
| D9d | `150 days ago` / `2 weeks ago` | e2 e5 e6 e7 | approxidate |
| D9e | `@<50 d ago>` / `@<5 d ago>` | none | |
| D10 | `reflogExpire = bogus` | all 7, **128** `error: 'bogus' for 'gc.reflogExpire' is not a valid timestamp` / `fatal: bad config variable 'gc.reflogExpire' in file '.git/config' at line 9` (git prints the key lowercased in every such message; canonical case is used throughout this doc, as in the parent design) | nothing rewritten |
| D10b / D10c | valueless / empty | 128 `error: missing value for 'gc.reflogExpire'` + same fatal / `'' for … is not a valid timestamp` + same fatal | |
| D10d / D10e | `bogus` then `never`; `never` then `bogus` | 128 at line 9 / 128 at line 10 | **not** last-wins: any invalid line dies |
| D10f | `[gc "refs/tags/*"] reflogExpire = bogus` (non-matching) | 128 `'bogus' for 'gc.refs/tags/*.reflogExpire' …` (subsection verbatim) | patterns validated whether or not they match |
| D10g | `bogus` + both flags explicit | 128 | config parsed before options |
| D10h / D10i | `NEVER` / `120.days.ago` then `never` | all 7 / all 7 | valid duplicates are last-wins |
| D11 / D11c / D11d | lowercase keys; `-c gc.reflogExpire=never -c …Unreachable=never`; `~/.gitconfig` never/never | all 7 each | all scopes honoured (tsgit: local only — ADR-637 residual) |
| D12 / D12b | `refs/stash` log, no config; global 45/15 | all 7 / all 7 | stash never expires unless configured **by pattern** |
| D12c / D12d | `[gc "refs/stash"] reflogExpire = 45.days.ago`; `--expire=45.days.ago` | e6 e7 / e6 e7 | |
| D13 / D13b | `HEAD` log, defaults; `[gc "HEAD"]` never/never | e6 e7 / all 7 | pattern matched against `HEAD` |
| D14 / D15 | `bogus` + `expire refs/heads/nope`; `bogus` + `--expire=bogus2 HEAD` | 128 config refusal both | config before target resolution and before flag parsing |
| D16–D19 | `bogus` + `reflog show HEAD` / `reflog delete HEAD@{0}` / `reflog exists HEAD` / `status` | 0 each | only `reflog expire` (and `gc`/`maintenance`'s reflog task) read these keys |
| D20 / D21 | `bogus` + malformed `core.deltaBaseCacheLimit`, either line order | config refusal both | before the repo-settings class |
| D22 | `--expire=bogus HEAD`, clean config | 128 `fatal: invalid timestamp 'bogus' given to '--expire'` | tsgit: `REVPARSE_UNRESOLVED` (unchanged) |
| D23 | `--all --expire=now HEAD` | 0 | `--all` and refs combine |

Source: `reflog.c:35-80` `reflog_expire_config` (`parse_config_key(var, "gc", &pattern, …)`;
`git_config_expiry_date` → `error` → callback `-1` → `bad config variable`), `:17-33`
`find_cfg_ent` (`FLEX_ALLOC_MEM`, zeroed slots, appended in first-seen order), `:98-133`
`reflog_expire_options_set_refname`, `reflog.h:25-28` `REFLOG_EXPIRE_OPTIONS_INIT`,
`builtin/reflog.c:216` (config) then `:221` (options). v2.49.0's `builtin/reflog.c:311-312`
initialised `default_reflog_expire_unreachable = now - 30 d; default_reflog_expire = now - 90 d`.

#### Change

Three layers, pure core:

```ts
// src/domain/reflog/expire-policy.ts (new, pure) — the entry type lives in domain so config-read.ts
// (application) imports it, never the reverse
export interface ReflogExpiryConfigEntry {
  readonly pattern: string | undefined;          // subsection verbatim; undefined for [gc]
  readonly slot: 'total' | 'unreachable';
  readonly value: string | null;                 // null = valueless
  readonly key: string;                          // lowercased section + key, subsection verbatim: 'gc.<pattern>.<key>'
  readonly source: string;
  readonly line: number;                         // 1-based
}
export interface ExpiryCuts { readonly expireCut: number; readonly unreachableCut: number }
export interface ReflogExpiryPolicy { cutoffsFor(ref: RefName | 'HEAD'): ExpiryCuts }
/** reflog_expire_config + reflog_expire_options_set_refname. Every entry is parsed in file order and the
 *  first invalid one throws (D10–D10g); `explicit` slots come from the caller's flags. */
export const buildExpiryPolicy = (input: {
  readonly entries: ReadonlyArray<ReflogExpiryConfigEntry>;
  readonly explicit: { readonly total?: number; readonly unreachable?: number };
  readonly defaults: ExpiryCuts;                                  // DC-D1
  readonly parse: (raw: string) => number | undefined;            // resolveExpiryCutoff bound to `now`
}): ReflogExpiryPolicy => { … };

// config-read.ts — token walk beside findFirstValuelessInSection (:699); no value parsing here
export const readReflogExpiryConfig = async (ctx: Context): Promise<ReadonlyArray<ReflogExpiryConfigEntry>> => { … };
```

`cutoffsFor(ref)`, per slot, in git's order: an explicit flag wins; else the **first** pattern
entry (by first appearance, same text merged — D8c) whose `wildmatch(pattern, ref, 0)` matches
supplies the slot, an unset slot being `-Infinity` (never — D6, D6b); else `ref ===
'refs/stash'` ⇒ `-Infinity` (D12); else the last valid `[gc]` value, else `defaults`.
Matching uses the shared ref glob (DC-D3). Refusals: valueless ⇒ `CONFIG_MISSING_VALUE { key,
source, line }` (existing code, D10b); unparseable ⇒ per DC-D2.

In `reflog.ts` the expire verb reorders to git's sequence (D14, D15, D20/D21, O-a…O-f):

```ts
export const reflog = async (ctx, opts = {}) => {
  await assertOperationalRepository(ctx);
  if (opts.action === 'exists') return runExists(ctx, opts.ref);
  if (opts.action === 'expire') return runExpire(ctx, opts);   // reaches the class itself, after its target resolves
  await assertRepoSettingsValid(ctx);
  …
};
```

`runExpire`'s shape is K's (below); D fills `resolveExpiryPolicy(ctx, opts)`: reads the entries,
resolves the flags with `resolveCutoff` (config refusals first, then `REVPARSE_UNRESOLVED` —
D15), builds the policy. `expireTargets` calls `policy.cutoffsFor(ref)` per target with the
**resolved** refname (E) — `reflog_expire_options_set_refname(&cb.opts, ref)` receives the
`dwim_log` result.

**Residuals recorded.** Local-only scope (D11c/D11d, ADR-637's recorded divergence). The eager
gate still reports a malformed streaming `[core]` class before a malformed `gc.reflogExpire`
regardless of line order, where git's `reflog_expire_config` falls back to
`git_default_config` in file order — the same shape as ADR-859's ordering residual. tsgit's `gc`
does not run a reflog expire (git's does); unchanged.

---

### E — single-ref `reflog expire` target resolution

#### Pins (git 2.55.0)

| # | Case | git |
|---|---|---|
| E1 | `refs/heads/gone` deleted, `logs/refs/heads/gone` kept: `expire --expire=now refs/heads/gone` | **255** `error: reflog could not be found: 'refs/heads/gone'`; log untouched. Short name `gone`: same message with `'gone'` |
| E1c–e | same log: `reflog exists` → 0; `reflog delete refs/heads/gone@{0}` → 255 `error: no reflog for 'refs/heads/gone@{0}'`; `reflog show` → 128 `ambiguous argument` | (other verbs, out of scope — recorded) |
| E2 | packed-only ref with a log | 0, expired |
| E3 | ref exists, no log | 255 could not be found (tsgit agrees today) |
| E4 | `expire side` (short name) | 0 — `refs/heads/side`'s log expired (DWIM) |
| E5 | dangling symref `refs/heads/sym → refs/heads/nope` with its own log | 255 could not be found |
| E6 | symref `sym2 → main` with its own log | 0, **sym2's** log expired, main's untouched |
| E6b | symref `sym2 → main`, **no** own log | 0, **main's** log expired |
| E7 | `expire HEAD`, `logs/HEAD` absent, main's log present | 0, **main's** log expired |
| E8 | unborn `HEAD` (→ `refs/heads/unborn`), `logs/HEAD` present | 255 could not be found; log untouched |
| E9 | `expire refs/heads/gone refs/heads/main` | 255 for gone, **main still expired** (tsgit takes one ref) |
| E10 | `expire --expire=now` (no ref, no `--all`) | 0, `HEAD` and `main` logs untouched |
| E11 | `--all --expire=never --expire-unreachable=never` over gone's log | 0, kept (R6′: fully expired under `--expire-unreachable=now`) |
| E12 | `refs/heads/bad..name`; `HEAD@{0}` | 255 could not be found (not an invalid-name refusal) |
| E13 | loose ref with unparseable content, log present | 255 could not be found |
| E14 | ref holding the oid of a missing object, `--expire=now` | 0, expired (resolution does not touch the object) |
| E15 | same ref, `--expire=never --expire-unreachable=now` | 0, **every entry expired** — `lookup_commit_reference_gently` NULL ⇒ `UE_ALWAYS` |
| E16 | `refs/tags/tree-tag` → tree with a log, `never`/`now` | 0, all expired (`UE_ALWAYS`; tsgit agrees today) |
| O-a / O-b | malformed `core.deltaBaseCacheLimit` + `expire refs/heads/nope` / `refs/heads/gone` | **255 could not be found** — target resolution precedes the class |
| O-c | malformed class + `--expire=bogus HEAD` | 128 invalid timestamp — flags precede the class |
| O-d | malformed class + `expire --expire=now` (no ref) | **0** |
| O-e / O-f | malformed class + `--all`; + `never`/`never HEAD` | 128 class |

Source: `builtin/reflog.c:282-297` — per argument `repo_dwim_log(argv[i], …, &ref)` else
`status |= error("reflog could not be found: '%s'")`; `refs.c:840-879` `repo_dwim_log` —
for each `ref_rev_parse_rules` candidate: `refs_resolve_ref_unsafe(…, RESOLVE_REF_READING)`
must succeed (follows symrefs; a missing terminal ref, an invalid name or unparseable content
fails; the object is never read), then `refs_reflog_exists(candidate)` ⇒ that name, else
`refs_reflog_exists(resolved)` when the candidate is a symref ⇒ the target's name, else next
candidate; the first hit wins.

#### Change

```ts
// reflog.ts — replaces resolveExpireTargets' single arm
/** git's repo_dwim_log: first candidate that resolves AND has a log (its own, else its symref target's). */
const dwimReflog = async (ctx: Context, arg: string): Promise<RefName> => {
  for (const candidate of refCandidates(arg)) {                       // domain/refs/ref-candidates.ts:19, ref_rev_parse_rules
    const found = await logForCandidate(ctx, candidate);
    if (found !== undefined) return found;
  }
  throw reflogNotFound(arg as RefName);                               // E1, E5, E8, E12, E13
};
const logForCandidate = async (ctx: Context, candidate: RefName | 'HEAD'): Promise<RefName | undefined> => {
  if (!isSafeRefName(candidate)) return undefined;                    // the path guard stays: no I/O for an invalid name (E12)
  const terminal = await resolveTerminalName(ctx, candidate);         // undefined: missing terminal ref, unparseable content
  if (terminal === undefined) return undefined;
  if (await hasReflog(ctx, candidate as RefName)) return candidate as RefName;
  return terminal !== candidate && (await hasReflog(ctx, terminal)) ? terminal : undefined;   // E6b, E7
};
```

- `resolve-ref.ts:14` `ChainOutcome`'s `found` arm gains `readonly name: RefName` (the chain's
  terminal name; `resolveDirectChain` already holds it); a new internal
  `resolveTerminalName(ctx, name): Promise<RefName | undefined>` returns it, `undefined` on
  `missing` and on `INVALID_REF` content (git's `RESOLVE_REF_READING` failure). Cycle/depth
  refusals still propagate.
- `expireKindFor` (`:267`): `peelRefToCommit` → the file's own `peelGently` (`:394`), so a tip
  naming a missing object is `always` (E15).
- The class moves inside `runExpire`, after target resolution (O-a, O-b); zero targets never
  reach it (O-d).
- DC-E2 decides the no-ref case (E10). DC-E1 decides whether DWIM is included.

Behaviour moves: E1/E5/E8/E12/E13 refuse `REFLOG_NOT_FOUND { ref: <argument> }` (git prints the
argument as typed); E4/E6b/E7 succeed on the resolved log; E15 expires by clock.

---

### F — symlinked `HEAD` with a `refs/`-prefixed, format-invalid link text

#### Pins (git 2.55.0; `side` ≠ `main`)

| # | Link text → target | `rev-parse HEAD` | `symbolic-ref HEAD` | `status -b` (`branch.head`) | `commit --allow-empty` |
|---|---|---|---|---|---|
| F1 | `refs/heads/a..b` → absent | 128 `ambiguous argument 'HEAD'` | 128 `ref HEAD is not a symbolic ref` | `(detached)`, oid `(initial)`; `log` 128 `your current branch appears to be broken` | 0; `.git/HEAD` **replaced by a regular file** holding the new commit |
| F2 | `refs/heads/a..b` → file with `side`'s oid | `side`'s oid | 128 not a symbolic ref | `(detached)` | 0; HEAD becomes a regular file; target file unchanged |
| F3 | `refs/heads/a..b` → file `ref: refs/heads/side` | `side`'s oid | **`refs/heads/side`** | `side` | 0; HEAD stays a symlink; **`side` advances** |
| F4 | `refs/heads/../heads/side` (not a valid refname) → resolves to `refs/heads/side` as a path | `side`'s oid | 128 not a symbolic ref | `(detached)` | 0; HEAD becomes a regular file |
| F5 | `refs/heads/x.lock` → file with an oid | the oid | 128 | `(detached)` | 0; regular file |
| F6 | `refs/heads/a..b` → a directory | 128 ambiguous | 128 | `(detached)`, `(initial)` | 128 `cannot lock ref 'HEAD': there is a non-empty directory '.git/HEAD' blocking reference 'HEAD'` |
| F7 | `refs/heads/valid-dangling` → absent | 128 ambiguous | `refs/heads/valid-dangling` | `valid-dangling` | 0; HEAD stays a symlink, the branch is created (tsgit agrees today) |
| F8 | `refs/heads/sp ace` → file with an oid | the oid | 128 | `(detached)` | 0; regular file |

Discovery accepts every row (`validate_headref`, `setup.c`, checks only the `refs/` prefix —
tsgit's `isRefsLinkText` already matches). Source `refs/files-backend.c:516-570`
`read_ref_internal`: symlink ⇒ `strbuf_readlink`; `starts_with(buf, "refs/") &&
!check_refname_format(buf, 0)` ⇒ symref; otherwise fall through, `open(path)` follows the link,
`ENOENT` ⇒ missing, a directory target fails the read.

#### Change

```ts
// ref-store.ts — resolveHeadDirect (:417), symlink arm
if (head.kind === 'symlink') return resolveHeadSymlink(head.linkText);

/** read_ref_internal's symlink rule: a refs/-prefixed VALID refname is a symref; anything else is read through. */
async function resolveHeadSymlink(linkText: string): Promise<ResolveDirectResult> {
  const text = linkText.replace(/\\/g, '/');
  if (text.startsWith('refs/') && isSafeRefName(text)) return { kind: 'symbolic', target: text as RefName };
  return resolveFollowedHead();
}
/** The file the link points to, read FRESH every call — never slotted: the slot's identity is the
 *  link's own lstat, which a rewrite of the target does not change. */
async function resolveFollowedHead(): Promise<ResolveDirectResult> {
  const path = `${ctx.layout.gitDir}/HEAD`;
  try {
    if ((await ctx.fs.stat(path)).isDirectory) return { kind: 'missing' };   // F6 (Node readUtf8 would map EISDIR to PERMISSION_DENIED)
    return fromLooseContent(await ctx.fs.readUtf8(path));                     // the `file` arm's parseLooseRef mapping, extracted; F2–F5, F8; malformed → INVALID_REF
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'missing' };                     // F1
    throw err;
  }
}
```

- `head-file.ts` is unchanged: the slot keeps the link text (identity = the link's `lstat`), the
  gate keeps `isRefsLinkText`.
- Applies to primitive-only sessions too: a non-`refs/` link text reaching `resolveDirect`
  without a gate (today `INVALID_REF`) is read through, as git's `read_ref_internal` does for any
  text.
- HEAD writes are untouched. For F2/F4/F5/F8 `resolveDirect` now reports `direct`, so a
  `commit` writes `HEAD` itself (lock + rename replaces the link with a regular file, as git
  does); for F3 it reports `symbolic side`, so the commit advances `side` and leaves the link.
- **Residual (F1, F6):** the followed read yields `missing`, and `readHeadRaw`
  (`internal/repo-state.ts:336`) turns a missing `HEAD` into `REF_NOT_FOUND`, so tsgit's `status`
  and `commit` refuse where git reports a detached `(initial)` head and `commit` writes a detached
  `HEAD` file (F6's commit refuses in git too). `resolveRef('HEAD')` matches git (both fail).
  Reaching git's answer means giving `HeadState` a "detached, unborn" arm — a change to every
  `readHeadRaw` consumer for a state only a hand-planted symlink produces; recorded, not done.
- **Residual:** `isSafeRefName` also refuses the bidi override code points U+202A–U+202E and
  U+2066–U+2069, which `check_refname_format` accepts — a link text carrying one reads through
  in tsgit and is a symref in git. The same grammar difference exists for every ref name; not
  changed here.

---

### H — width-derived valves (FlatTree and parsed memo)

#### Measurements

| Workload (real sizer) | sha1 (hexLength 40) | sha256 (hexLength 64) | Valve today |
|---|---|---|---|
| FlatTree, 50 000 files, 14-char paths | 8 200 048 B | 9 400 048 B | 8 388 608 (both) — sha256 overruns; 44 620 files fit |
| Memo, typical commit (216-char message, one parent) | 512 B | 536 B | 16 777 216 (both); `32 768 × 536 = 17 563 648` overruns ⇒ 31 300 entries |

`flatTreeByteSize` charges `path.length + id.length + 110` per entry, `parsedObjectByteSize`
charges `parents × hexLength`: in both sizers the width enters only through the oid string
length, one byte per hex character.

#### Change (as recommended in DC-H1 (a))

The reference count stays width-independent and dial-scaled; the valve adds exactly what the
sizer charges for the wider oids of that count.

```ts
// object-caches.ts
const SHA1_HEX_LENGTH = 40;
/** Tracked files the FlatTree default admits per 16 MiB of dial, at every width. */
const FLAT_TREE_REFERENCE_FILES = 50_000;
const REFERENCE_DIAL_BYTES = 16 * 1024 * 1024;

const oidWidthSurcharge = (ctx: Context): number => ctx.hashConfig.hexLength - SHA1_HEX_LENGTH;

const defaultFlatTreeValve = (ctx: Context): number => {
  const dial = ctx.deltaCache.maxSize;
  const files = Math.floor((FLAT_TREE_REFERENCE_FILES * dial) / REFERENCE_DIAL_BYTES);
  return dial * FLAT_TREE_DEFAULT_SHARE + files * oidWidthSurcharge(ctx);     // sha1: 8 388 608 · sha256: 9 588 608
};
/** The dial-derived entry count — the valve's reference, independent of an explicit entry option. */
const defaultMemoEntries = (ctx: Context): number =>
  Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_TYPICAL_ENTRY_BYTES);
export const memoMaxEntries = (ctx: Context): number =>
  ctx.cacheBudgets?.parsedObjectMemoMaxEntries ?? defaultMemoEntries(ctx);
export const memoByteValve = (ctx: Context): number =>
  ctx.deltaCache.maxSize + defaultMemoEntries(ctx) * oidWidthSurcharge(ctx); // sha1: 16 777 216 · sha256: 17 563 648
```

The surcharge multiplies the **dial-derived** count, never a caller's explicit
`parsedObjectMemoMaxEntries`: an explicit entry cap must not grow the byte valve (ADR-851 keeps
`deltaCacheMaxBytes` as the one dial that scales bytes).

- At sha1 every number is byte-identical to ADR-851's (8 MiB, 16 MiB, 32 768); at sha256 the
  FlatTree admits 51 003 reference files (sha1: 51 149) and the memo admits its full 32 768
  typical commits with the valve exactly equal to `entries × 536`.
- `memoMaxEntries` no longer derives from `memoByteValve` (which now depends on it); both derive
  from the dial — the ordering `entries × typical(width) ≤ valve` holds structurally at every dial
  and width.
- An explicit `flatTreeCacheMaxBytes` / `parsedObjectMemoMaxEntries` still wins verbatim.
- If DC-O1 (a) is also ratified, the memo valve becomes `memoMaxEntries × typicalEntryBytes(width)`
  with O's honest constant; the width surcharge is then inside that product (O section).
- Tests: `read-head-tree.test.ts:473-528` — the sha256 row flips from "refused" to "admitted";
  both widths measured through `flatTreeByteSize`; the 44 620 boundary row is replaced by the new
  sha256 boundary. `object-caches.test.ts:224-275` — the invariant row is parameterised over
  `hexLength ∈ {40, 64}` with `parsedObjectByteSize` at that width; a 4 MiB-dial row at sha256.

---

### I — structural `isObjectNotFound`

#### Call sites (serena `find_referencing_symbols` + `rg`, ten)

| # | Site | Try body | A foreign-graph `{ data: { code: 'OBJECT_NOT_FOUND' } }` rejection now… |
|---|---|---|---|
| 1 | `read-object.ts:186` `withLazyFetchRetry` | `run()` → `resolveObject` / `resolveObjectContentWithDepth` | triggers the promisor lazy-fetch + one retry instead of propagating (only reachable if an `fs`/`compressor` adapter itself throws the shape) |
| 2 | `cat-file-batch.ts:44` `readOne` | `readObject` | yields `{ ok: false, reason: 'missing' }` and the batch continues, instead of aborting the stream |
| 3 | `internal/read-commit.ts:30` `readCommit` (`ignoreMissing`) | `readObject` | records the id in `missing` and returns `undefined` |
| 4 | `internal/closure-not-marks.ts:91` `readTreeIfPresent` | `readObject` | skips that negative tree (over-reports, git's quiet-on-missing) |
| 5 | `internal/closure-not-marks.ts:144` `readCommitMetaIfPresent` | `readCommitMeta` | skips that negative commit |
| 6 | `commands/reflog.ts:316` `readAncestorMeta` | `readCommitMeta` | marks the id `failed` (kept, never reachable-by-parse) |
| 7 | `commands/reflog.ts:398` `peelGently` | `peelRefToCommit` | treats the oid as reachable (entry kept) |
| 8 | `commands/bundle-verify.ts:166` `resolveExternalBase` | `readObject {verifyHash}` + reserialise | returns `undefined` (external base unavailable) |
| 9 | `commands/bundle-verify.ts:187` `isMissingObject` | `readObject {verifyHash}` | counts a missing prerequisite |
| 10 | `primitives/walk-submodules.ts:135` `tryReadTree` | `readTree` | returns `undefined` (submodule tree not fetched) |

Every `OBJECT_NOT_FOUND` producer inside those try bodies is same-graph application code
(`object-resolver.ts:104/:443/:458/:571`, `internal/peel.ts:27/:29`, `blob-source.ts:105`,
`read-object.ts:377`), so for errors tsgit raises itself nothing changes. The new classification
is reachable only through a Context port that re-throws a foreign value verbatim — a
dist-bundle adapter or promisor in a mixed-module-graph harness, a dual-package (ESM + CJS)
consumer, or a user adapter throwing a duck-typed `{ data: { code } }` — and at each site that
value is now folded exactly as a native miss. A value with a non-string `code`, or no `data`,
still propagates.

#### Change (as recommended in DC-I1 (a))

`errorDataCode` moves to `src/domain/error-data-code.ts` (pure, zero outward imports — valid in
`domain/`); its 15 application consumers re-point the import; `isObjectNotFound = (err: unknown):
boolean => errorDataCode(err) === 'OBJECT_NOT_FOUND'`. The `import { TsgitError }` in
`domain/objects/error.ts` stays (the factories construct it). The 72 remaining `instanceof
TsgitError` classifications in `src/` (73 today minus this one; `reflog.ts:458` `tryResolve`
among them) are the same class of defect and are **not** swept here (out of scope, counted).

---

### K — `runExpire` under 20 lines

Constraint check, stated rather than assumed: `runExpire` runs once per `reflog expire` command;
each loop iteration already awaits a reflog read and a commit walk (tens of µs to seconds), so an
extracted `async` helper's extra microtask (~67–200 ns) is below measurement. It is not the
per-object read path Post-review correction 8 protects.

```ts
const runExpire = async (ctx: Context, opts: ExpireOptions): Promise<ReflogResult> => {
  const policy = resolveExpiryPolicy(Math.floor(Date.now() / 1000), opts);        // K commit: today's two constants, sync
  const targets = await resolveExpireTargets(ctx, opts);                          // K commit: unchanged (hasReflog guard inside)
  const outcome = await expireTargets(ctx, targets, policy);
  // One transaction for every target — reftable stack cost and no partial rewrite (comment kept verbatim).
  await getRefStore(ctx).applyRefUpdates(outcome.updates);
  return { kind: 'expire', removed: outcome.removed, kept: outcome.kept };
};

/** Strictly sequential: each target's reachability state is built inside expireReflog, never shared. */
const expireTargets = async (ctx, targets, policy): Promise<ExpireOutcome> => {
  let removed = 0;
  let kept = 0;
  const updates: RefUpdate[] = [];
  for (const ref of targets) {
    const { expireCut, unreachableCut } = policy.cutoffsFor(ref);
    const outcome = await expireReflog(ctx, ref, expireCut, unreachableCut);
    removed += outcome.removed;
    kept += outcome.kept;
    updates.push(outcome.update);                                                  // pushed even when nothing prunes
  }
  return { removed, kept, updates };
};
```

The K commit introduces `ExpiryPolicy` with a constant `cutoffsFor` (the two `resolveCutoff`
calls of today) so D replaces its body without reshaping `runExpire` again — D's only edit to
`runExpire` itself is that first line becoming `await resolveExpiryPolicy(ctx, opts)` (it reads
config); E replaces
`resolveExpireTargets`' single arm and moves the class check in (`runExpire` gains one line and
stays ≤ 20). Preservation proof: the K commit changes no test assertion.

---

### M — the HEAD slot's freshness epoch

Code (`head-file.ts:128-164`): `validateHead` (every gate) sets `trusted = true`; `readHeadFile`
returns a trusted slot with zero I/O; nothing at the end of a command clears it. The epoch is
therefore **gate to gate** on every adapter — on Node the next gate's `lstat` identity check
refreshes it; on `ino === 0` adapters the next gate re-reads. Pinned live on the memory adapter:
after a gated command, a raw HEAD rewrite is invisible to primitive reads until the next gate.
The docstring (`:120-127`, `:148-155`), ADR-855 ("shared only within the command") and ledger L1
("trusted for the rest of that command") all say *command*. This is the same shape as the config
epoch, whose own contract (ADR-850, ledger L2) reads "a raw external write is seen at the next
operational gate".

No "command end" exists to hook: the parent design rejected facade-`guard()` scoping (no
post-call hook; command functions called directly bypass the facade).

Change per DC-M1. Under (a): the two docstrings, ledger L1, `internals.md`'s HEAD-slot paragraph
and a correction note on ADR-855 state "trusted from a gate until the next gate, our own HEAD
write, or an `lstat` failure — primitive reads between commands are served from it"; a
`head-file.test.ts` case pins exactly that (gate → raw rewrite → `readHeadFile` returns the old
content → next `validateHead` returns the new). Under (b): `readHeadFile` trusts a slot only when
`identity !== undefined` **and** it re-`lstat`s — see the table.

---

### N — repo-settings verdict on a primitive-only first touch

Measured (correction 9): one compute. Change per DC-N1 (a): a regression pin, no runtime change.
`read-object.test.ts`: a bare Context (no gate) with `cacheBudgets.deltaBaseCacheMaxBytes` set,
`instrumentedContext` over the config path — first `readObject` issues exactly one `stat` and one
`readUtf8` of `.git/config`; a `vi.spyOn` over `config-read.ts`'s `findLastInvalidMaxTreeDepth`
is called once across `readObject` + a second `readObject`; without the option, two `stat`s and
still one finder call. The finding is closed in the review record as not reproduced.

---

### O — parsed-memo accounting

#### Measurements

Isolated (`parseObjectContent` × 20 000 retained, then inserted into `createLruCache`):

| Commit shape (sha1 / sha256) | Parsed object | LRU node + `Map` entry | Total real | Sizer | Ratio |
|---|---|---|---|---|---|
| short message `c\n`, one parent | 894 / 943 B | 111 B | 1 005 / 1 054 B | 298 / 322 B | 3.37× / 3.27× |
| typical 216-char message, one parent | 1 101 / 1 149 B | 111 B | 1 211 / 1 260 B | 512 / 536 B | 2.37× / 2.35× |
| long 556-char message, one parent | 1 446 / 1 494 B | 111 B | 1 557 / 1 605 B | 852 / 876 B | 1.83× |
| two parents, short message | 950 / 1 020 B | 111 B | 1 061 / 1 131 B | 338 / 386 B | 3.14× / 2.93× |

End to end (5 000 commits written to a memory repository, read through `readObject` so the memo
and `ctx.deltaCache` fill; heap with the memo populated minus heap after `forgetParsedObjectMemo`
for every id, `ctx.deltaCache` identical in both):

| Message length | Real per entry | Sizer | Ratio | `arrayBuffers` delta |
|---|---|---|---|---|
| 2 | 989 B | 298 B | 3.32× | 0 |
| 60 | 1 045 B | 356 B | 2.94× | 0 |
| 216 | 1 197 B | 512 B | 2.34× | 0 |
| 600 | 1 581 B | 896 B | 1.76× | 0 |

Fit: real ≈ 987 B + 0.99 B × message length; the sizer charges 296 B + message length ⇒ the
fixed term is under by ≈ 690 B (honest fixed overhead ≈ 947 B at sha1; ≈ +24 B at sha256 for the
wider tree oid). Parsed commits pin no content buffer (`arrayBuffers` delta 0). At the default
32 768-entry cap of typical commits the memo's real footprint is ≈ 37.7 MiB against a stated
16 MiB valve.

Sibling, measured for scope: `flattenTree` over 50 000 files retains 215 B/entry (13-char
paths) and 239 B/entry (39-char paths) against the sizer's 163 / 189 B — 1.32× / 1.26×.

#### What each DC-O1 alternative does

- **(a) Correct and keep the ratified entry counts.** `PARSED_OBJECT_FIXED_OVERHEAD_BYTES` →
  a measured constant (≈ 950 B, sha1), `PARSED_OBJECT_TYPICAL_ENTRY_BYTES` → its honest value
  (≈ 1 206 B), a new `PARSED_OBJECT_DIAL_BYTES_PER_ENTRY = 512` keeps the dial-derived count
  `floor(dial / 512)` = 32 768, and `memoByteValve = floor(dial / 512) × typicalEntryBytes(width)`
  (≈ 37.7 MiB at sha1; H's width surcharge is inside `typicalEntryBytes(width)`; an explicit
  `parsedObjectMemoMaxEntries` still sets only the entry cap). Real memory for a typical walk is unchanged (the overhead was always
  there, bounded by the entry cap); the valve and the documented family total become honest
  (136 → ≈ 158 MiB with the FlatTree left as is). One real change: a walk of atypically large
  entries (e.g. 4 KiB messages) now binds at an honest ≈ 37.7 MiB instead of ≈ 18 MiB real.
  Amends ADR-851 ("16 MiB valve") and ADR-852 (family total). The valve-ordering invariant test
  keeps its shape with the new constant.
- **(b) Correct the constants and keep the 16 MiB valve.** The derived cap drops to
  ≈ 13 900 entries: the medium fixture's 5 000-commit walk still fits, a 20 000-commit walk
  re-enters the LRU cliff ADR-851 removed.
- **(c) Document the gap.** Constants unchanged; `object-caches.ts` states that the valve is a
  *charged* proxy and records the measured ratios; `internals.md` / `performance.md` state the
  real ceiling (≈ 38 MiB memo, ≈ 1.3× FlatTree) beside the 136 MiB charged total. No behaviour
  change, no ADR number moves.

---

### Cross-item ownership

| Function / file | Owner (commit order) | Notes |
|---|---|---|
| `domain/error-data-code.ts` (new), 15 importers | P13 (I) | P16 edits `ref-store.ts`, P17 `update-ref.ts` after P13 re-pointed their import |
| `domain/objects/git-object.ts`, `object-resolver.ts` loose arm + `verifyObjectContent`, `blob-source.ts` `toBytesSource`, `cat-file-batch.ts`, `read-object.ts` (`readObjectWithSize`) | P14 (A) | `read-object.ts` otherwise gains only P17's `withLazyFetchRetry` export |
| `internal/object-caches.ts` | P15 commit 1 (H), commit 2 (O) | `read-head-tree.ts` sizer constants only if DC-O1 extends to the FlatTree |
| `ref-store.ts` `resolveHeadDirect` | P16 commit 1 (F) | |
| `internal/head-file.ts` docstrings (+ code under DC-M1 (b)) | P16 commit 2 (M) | |
| `internal/ref-target.ts` (new), `update-ref.ts`, `clone.ts`, `internal/blob-source.ts` (`verifyStoredObject`, loose stream arm), `stream-blob.ts`, `internal/whitespace-drop-predicate.ts`, `read-object.ts` (`withLazyFetchRetry` export) | P17 commit 1 (C) | `read-object.ts` is P14's file too; P17 only adds the export |
| `commands/tag.ts` `tagCreate` | P17 commit 2 (B) | |
| `commands/reflog.ts` | P18 commits 1 (K) → 2 (E) → 3 (D) | `resolve-ref.ts` `ChainOutcome` (E); `config-read.ts` token walk + `domain/reflog/expire-policy.ts` + shared ref glob (D) |
| `read-object.test.ts`, `pack-registry.test.ts` pins | P19 (N) | test-only |

---

### Partition proposal

Dependency order: **P13 → P14 → P15 → P16 → P17 → P18 → P19.** P13 first because it re-points
imports in `ref-store.ts`, `update-ref.ts` and `branch.ts` that P16/P17 then edit; P14–P16 are
independent in files but P15's H commit and P14 both run `object-caches`-adjacent unit suites,
so they stay sequential to keep gates attributable; P18 depends on P13 (`reflog.ts` imports
`isObjectNotFound`, unchanged path under DC-I1 (a), but its tests exercise the structural
classifier) and on nothing else; P19 anywhere. Part gate: `npx vitest run <touched tests>` +
`npx tsc --noEmit -p tsconfig.json` + biome + `npx cspell --no-progress <files>`; interop files
run individually (git-spawning: one shared `beforeAll` repo, 60 s timeout, `GIT_*` scrubbed).
Phase gate: `npm run validate`. **Seven parts, twelve commits** (P13, P14, P19 one each; P15,
P16, P17 two each; P18 three).

#### P13 — Structural `isObjectNotFound` (I)

- **Behaviour:** narrow classification change at ten sites (feature-scoped review of the table
  in I).
- **Files:** new `src/domain/error-data-code.ts` (body of
  `src/application/primitives/internal/error-data-code.ts:14`, docstring updated — consumers now
  include `isObjectNotFound`); delete the application module; re-point imports in
  `commands/branch.ts:16`, `commands/internal/gc-pipeline.ts:34`,
  `commands/internal/fsck/roots.ts:12`, `primitives/{fetch-pack.ts:23, ref-store.ts:35,
  pack-registry.ts:24, update-ref.ts:6, reftable-transaction.ts:85}`,
  `primitives/internal/{shallow-set, pack-byte-source.ts:24, loose-oid-cache, write-pack-artifacts.ts:28,
  reftable-source.ts:20, cruft-pack-lifecycle.ts:20, midx-source}.ts`; `domain/objects/error.ts:79`
  `isObjectNotFound` body.
- **Signatures:** `errorDataCode(error: unknown): string | undefined` unchanged;
  `isObjectNotFound(err: unknown): boolean` unchanged.
- **Tests:** `test/unit/domain/objects/error.test.ts:184-230` — add "Given a foreign-shaped
  error `{ name: 'TsgitError', data: { code: 'OBJECT_NOT_FOUND', id } }` not `instanceof`" →
  `true`; "Given `data.code` a number" → `false`; new `test/unit/domain/error-data-code.test.ts`
  (no dedicated test exists today — `errorDataCode` is covered only through its consumers:
  object / `null` / non-object / missing `data` / non-string `code` / string `code`); one call-site test for the batch fold (`cat-file-batch.test.ts`: a
  `ctx.fs.read` double that rejects a plain object `{ data: { code: 'OBJECT_NOT_FOUND', id } }` →
  entry `{ ok: false, reason: 'missing' }`).
- **Gates:** `npm run check:architecture` (domain import direction), `check:dead-code` (the
  deleted module). **Surface:** none public (`api.json` has neither symbol). **Runtime code:**
  ≈ 0 (one helper replaces an `instanceof` expression).

#### P14 — Size-lying loose header (A)

- **Behaviour change.** Depends on DC-A1, DC-A2.
- **Files / symbols:** `src/domain/objects/git-object.ts` — new `splitLooseObject`,
  `assertLooseSizeConsistent` beside `splitObject:21` (kept; neither is on the
  `domain/objects/index.ts` barrel — import from the module as `object-resolver.ts:7` does);
  `src/application/primitives/object-resolver.ts`
  — `resolveObjectContentWithDepth:67` loose arm `:91-99`, every arm's return literal gains
  `declaredSize`; `verifyObjectContent:254` gains `declaredSize = content.byteLength`;
  `cacheEntry:691` call gated; `internal/blob-source.ts:141` `toBytesSource`;
  `read-object.ts` — new `readObjectWithSize` beside `readObject:199` over `withLazyFetchRetry:173`
  and `parsedObjectMemoFor`; `cat-file-batch.ts:21,:35`.
- **Current signatures:** `resolveObjectContentWithDepth(ctx, registry, id, verifyHash, maxBytes,
  externalDepth): Promise<ObjectContent & { chainDepth: number }>`;
  `verifyObjectContent(ctx, id, type, content, verifyHash): Promise<void>`;
  `splitObject(rawBytes): { type; content; bytes }`; `parseHeader(rawBytes): { type; size;
  contentOffset }` (`header.ts:8`); `serializeHeader(type, contentSize)` (`header.ts:38`).
- **Fixtures/helpers:** `buildSeededContext` + `computeLooseObjectPath`
  (`domain/storage/loose-path.js`) + `ctx.compressor.deflate` — the forge pattern already at
  `read-object.test.ts:211-247`; a hasher double recording `update` calls for the verify path.
- **Tests:** `git-object.test.ts` (`splitLooseObject` per type; `assertLooseSizeConsistent`
  blob-mismatch passes, commit/tree/tag-mismatch throws with the verbatim reason, equal sizes
  pass; `splitObject:158` row unchanged); `object-resolver.test.ts` (lying blob: bytes returned,
  `ctx.deltaCache.has(id) === false`, `declaredSize` = claim; lying commit refuses; `verifyHash`
  on a lying blob → `OBJECT_HASH_MISMATCH` and the hasher saw `serializeHeader(type, claim)`);
  `read-object.test.ts:211-247` rewritten — the blob forge with `maxBytes: 4` now refuses
  `OBJECT_TOO_LARGE { actualSize: 8, limit: 4 }` (the cap measures actual bytes, the claim is
  ignored — the security intent of the old test, re-pinned), plus a commit forge still refusing
  `INVALID_OBJECT_HEADER`; `blob-source.test.ts` buffered arm; `stream-blob.test.ts:905-975` rows
  unchanged; `cat-file-batch.test.ts` (lying blob → `size` = claim, content real; honest objects
  → `size === payloadByteLength`); `read-object-metadata.test.ts` (lying blob → content length).
  New `test/integration/loose-header-size-interop.test.ts` (`@proves surface: readObject, bucket:
  cross-tool-interop, interopSurface: readObject, catFile, streamBlob`): A1's `cat-file -s`/`-p`/
  `--batch` rows against `catFile`/`readObject`/`streamBlob` for claim < real and claim > real;
  A2's commit rows (`cat-file -p` refuses both tools; the `log` under-run row pinned **as the
  recorded residual**, title says so); `fsck --full` hash-path mismatch vs `verifyHash` refusal.
- **Surface:** `docs/use/primitives/read-object.md`, `stream-blob.md`, `cat-file-batch.md`,
  `commands/cat-file.md` (size semantics); `docs/use/errors.md` `INVALID_OBJECT_HEADER` row
  (commit/tree/tag only) and `OBJECT_HASH_MISMATCH` row (stored header hashed); `api.json`:
  none (`splitObject` is not public; `CatFileBatchEntry.size` keeps its type). **Runtime code:**
  ≈ +300 B.

#### P15 — Width-derived valves (H), then memo accounting (O) *(2 commits)*

- **Commit 1 (H), tuning fix.** Depends on DC-H1.
  - **Files:** `internal/object-caches.ts` — `memoByteValve:70`, `memoMaxEntries:91-93`,
    `FLAT_TREE_DEFAULT_SHARE:109` docstring, `budgetsFor:124-128`; new `oidWidthSurcharge`,
    `defaultFlatTreeValve`, constants. `ctx.hashConfig.hexLength: 40 | 64`
    (`domain/objects/hash-config.ts:4`).
  - **Tests:** `test/unit/application/primitives/read-head-tree.test.ts:473-528`
    (`syntheticTreeOf(entryCount, hexLength)` fixture kept; sha256 row → admitted; boundary row
    at the new sha256 valve); `internal/object-caches.test.ts:224-275` (invariant parameterised
    over width via `parsedObjectByteSize(typicalCommitData, hexLength)`; the sha256 context comes from
    `MemoryAdapterOptions.algorithm: 'sha256'` (`adapters/memory/memory-adapter.ts:25`) — check
    whether each suite's local `createMemoryContext` helper forwards it, and extend the helper if
    not).
- **Commit 2 (O).** Depends on DC-O1.
  - **Files:** (a) `object-caches.ts:80` `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`, `:165`
    `PARSED_OBJECT_FIXED_OVERHEAD_BYTES`, new `PARSED_OBJECT_DIAL_BYTES_PER_ENTRY`,
    `memoByteValve` as `entries × typical(width)`; docstrings carry the measurement method (not
    the ADR number). (c) docstrings only.
  - **Tests:** (a) `object-caches.test.ts` invariant with the new constant and the cap still
    32 768; a 4 KiB-message row showing the honest valve binds. (c) none.
- **Surface:** `docs/use/primitives/internals.md` (memo/FlatTree budgets, family total),
  `docs/understand/performance.md:59`; `api.json`: none. **Runtime code:** ≈ +80 B (H), ≈ 0 (O).

#### P16 — Symlink fall-through (F), then the HEAD-slot epoch (M) *(2 commits)*

- **Commit 1 (F), behaviour change.**
  - **Files:** `src/application/primitives/ref-store.ts` — `resolveHeadDirect:417-431` symlink
    arm; new closure functions `resolveHeadSymlink`, `resolveFollowedHead` inside
    `createFilesRefStore`; `isSafeRefName` (`domain/refs/ref-validation.ts:64`), `isFileNotFound`
    (`ref-store.ts:315`), `parseLooseRef` (already imported).
  - **Tests:** `ref-store.test.ts` (memory adapter `symlink`; F1 target absent → `missing`; F2
    oid → `direct`; F3 `ref:` content → `symbolic side`; F4 `..` path → `direct`; F6 directory →
    `missing`; F7 valid text → `symbolic` unchanged; a target rewritten between two
    `resolveDirect('HEAD')` calls **after a gate** is observed — the followed read is not slotted;
    an EACCES `stat` rethrows); `test/integration/head-symlink-interop.test.ts` extended with
    F2–F5 and F8 (`revParse`, `status` branch, `commit` then `git rev-parse HEAD` + `.git/HEAD`
    file type, F3's `side` advance) and F1 (`resolveRef('HEAD')` fails in both; `status` /
    `commit` titled as the recorded residual).
  - **Surface:** `docs/use/primitives/internals.md` RefStore paragraph. **Runtime:** ≈ +200 B.
- **Commit 2 (M).** Depends on DC-M1.
  - **Files:** (a) `internal/head-file.ts:120-127,:148-155` docstrings; ledger row L1 in
    `docs/design/session-caches-per-command-floor.md` (a dated correction line in its
    Post-review corrections block); `internals.md` HEAD-slot paragraph. (b) `readHeadFile:156-164`.
  - **Tests:** `test/unit/application/primitives/internal/head-file.test.ts` — the epoch pin (a) or
    the re-validation pin (b), memory adapter plus the `ino !== 0` proxy fixture the suite already
    has.
  - **Runtime:** (a) 0; (b) ≈ +40 B.

#### P17 — Ref-write verification (C), then `tag.create`'s order (B) *(2 commits)*

- **Commit 1 (C), behaviour change.** Depends on DC-C1, DC-C2.
  - **Files:** new `src/application/primitives/internal/ref-target.ts`; `primitives/update-ref.ts:17`
    (`updateRef(ctx, name, newId, options: UpdateRefOptions): Promise<void>`, call after
    `validateRefName`, skipped when `options.delete === true`); `commands/clone.ts:321`
    `writeRef`, `:353` `applyRemoteHead` detached arm; `primitives/internal/blob-source.ts` — new
    `verifyStoredObject` / `hashStoredObject` beside `openBlobSource:75`, `resolveLoose:175`
    stream arm parses its header at open, `stripHeader:310` reports instead of refusing,
    `BlobSource` stream arm `type: ObjectType`; `primitives/stream-blob.ts:21` and
    `primitives/internal/whitespace-drop-predicate.ts:46` drop the `!== undefined` half;
    `primitives/read-object.ts:173` exports `withLazyFetchRetry`. Helpers: `openBlobSource`,
    `MAX_BUFFERED_BLOB_BYTES` (`blob-source.ts:40`), `peekPackRegistry` / `getPackRegistry`,
    `unexpectedObjectType` (`domain/objects/error.ts:85`), `HEADS_PREFIX`
    (`domain/refs/ref-prefixes.ts:6`), `zeroOid` (`domain/objects/object-id.ts:87`).
  - **Tests:** `update-ref.test.ts` (tree/blob/tag-object to `refs/heads/x` and `HEAD` → refuse
    with `{ expected, actual, id }`; nonexistent to `refs/tags/x` → `OBJECT_NOT_FOUND { id }`;
    tree to `refs/tags/x`, `refs/remotes/o/x`, `ORIG_HEAD` → written; wrong `expected` +
    nonexistent → `OBJECT_NOT_FOUND`, not `REF_UPDATE_CONFLICT` (C7); delete unverified;
    hash-mismatching loose blob to `refs/tags/x` and hash-mismatching commit to `refs/heads/x` →
    `OBJECT_HASH_MISMATCH { expected, actual }`, nothing written, and the commit reports the hash
    not the type (C8); a target warmed into `ctx.deltaCache` and the parsed memo by `readObject`
    → the hasher double still records the `update` calls for it (a cache hit never answers); a
    loose blob above the gate → written, `ctx.compressor.inflate` never called on its bytes
    (streamed); an annotated tag object to `refs/heads/x` → `actual: 'tag'`, not peeled);
    `blob-source.test.ts` (`verifyStoredObject` per arm: cache hit, buffered loose, streamed loose
    commit and blob, packed base buffered and streamed, packed delta; a promised object fetched
    once through `ctx.promisor`); `stream-blob.test.ts:200` and `whitespace-drop-predicate.test.ts`
    loose non-blob rows (same refusal data, raised at open); `clone.test.ts` (an advertisement whose
    `refs/heads/x` names a tree the pack carries → refused, nothing written).
    **Enumeration:** tests that write refs to synthetic oids through `updateRef` (60 calls in
    18 files) — run those 18 files, give each failing fixture a real object (`writeObject`) or a
    non-branch ref; `applyRefUpdates` fixtures are untouched under DC-C2 (c).
    New `test/integration/ref-write-verification-interop.test.ts` (`@proves bucket:
    cross-tool-interop, interopSurface: updateRef, tag.create`): C1–C9, plus the empty-tree-id
    target row named in C.
  - **Surface:** `docs/use/primitives/update-ref.md`; `docs/use/errors.md` `OBJECT_NOT_FOUND`
    and `UNEXPECTED_OBJECT_TYPE` rows gain `updateRef` / `clone` throwers and the caller
    composition of git's two lines. **Runtime:** ≈ +350 B.
- **Commit 2 (B), behaviour change.**
  - **Files:** `commands/tag.ts:85-107` — the non-force `refExists` pre-check before
    `createAnnotatedTag`; imports `refExists` (already), `tagExists` (already).
  - **Tests:** `tag.test.ts` (lightweight → nonexistent refuses `OBJECT_NOT_FOUND`, nothing
    written; → tree/blob/tag object written; existing name + nonexistent → `TAG_EXISTS`; force +
    nonexistent → `OBJECT_NOT_FOUND`; annotated existing name + nonexistent → `TAG_EXISTS`);
    interop B1–B6 in the P17 interop file.
  - **Surface:** `docs/use/commands/tag.md`. **Runtime:** ≈ +60 B.

#### P18 — `reflog expire`: refactor (K), target resolution (E), config policy (D) *(3 commits)*

- **Commit 1 (K), pure refactor.**
  - **Files:** `commands/reflog.ts:164-194` `runExpire` → `runExpire`, `expireTargets`,
    `resolveExpiryPolicy`; `ExpiryPolicy` type (constant cutoffs). No assertion changes.
  - **Tests:** `reflog.test.ts`, `reflog-interop.test.ts` run unchanged.
- **Commit 2 (E), behaviour change.** Depends on DC-E1, DC-E2.
  - **Files:** `reflog.ts:79` `reflog` (expire dispatched before `assertRepoSettingsValid`),
    `:201` `resolveExpireTargets` → `dwimReflog` / `logForCandidate`, `:267` `expireKindFor`
    (`peelGently:394`), class check inside `runExpire` after targets; `resolve-ref.ts:14`
    `ChainOutcome` `found.name`, `resolveDirectChain:64`, new internal `resolveTerminalName`;
    `refCandidates` (`domain/refs/ref-candidates.ts:19`), `isSafeRefName`.
  - **Tests:** `reflog.test.ts` (E1 gone ref → `REFLOG_NOT_FOUND { ref }`, log bytes untouched;
    E4 short name; E5 dangling symref; E6/E6b symref own/target log; E7 `HEAD` without its log;
    E8 unborn; E12 invalid name → `REFLOG_NOT_FOUND`, no fs call; E13 unparseable ref; E14/E15
    missing tip object → by clock; E10 per DC-E2; class ordering: malformed class + unresolvable
    ref → `REFLOG_NOT_FOUND`, + no ref → per DC-E2, + resolvable ref → `CONFIG_BAD_NUMERIC_VALUE`);
    `resolve-ref.test.ts` (terminal name for a two-hop chain); `repo-settings-config-interop.test.ts`
    reflog rows re-checked (O5 still holds for `HEAD`); `reflog-interop.test.ts` extended with
    E1, E4, E6b, E7, E8, E10, E15, O-a, O-d.
  - **Surface:** `docs/use/commands/reflog.md` Behaviour; `docs/use/errors.md` `REFLOG_NOT_FOUND`
    row; `api.json` only under DC-E2 (c). **Runtime:** ≈ +350 B.
- **Commit 3 (D), behaviour change.** Depends on DC-D1, DC-D2, DC-D3.
  - **Files:** `primitives/config-read.ts` — `readReflogExpiryConfig` beside
    `findFirstValuelessInSection:699` (uses `readConfigEntry:487` tokens, `matchesSection:640`
    lowercase section rule, subsection verbatim); new `src/domain/reflog/expire-policy.ts`
    (`buildExpiryPolicy`); shared ref glob — under DC-D3 (b) `matchRefGlob`
    (`domain/name-rev/ref-pattern.ts:20`) moves to `src/domain/refs/ref-glob.ts` with bracket
    expressions and `\` escapes, `name-rev` re-points; `reflog.ts:69-70` constants → DC-D1's
    values, `resolveExpiryPolicy` body; `domain/commands/error.ts:648` `configBadDateValue` per
    DC-D2; `resolveExpiryCutoff` (`primitives/expiry-cutoff.ts`) bound to `now` as the parser.
  - **Tests:** new `test/unit/domain/reflog/expire-policy.test.ts` (the D matrix as parameterised
    rows over a fixed `now`: explicit per slot, first pattern wins, merged pattern, unset slot
    never, stash, defaults, invalid on non-matching pattern, valueless, duplicates last-wins);
    `expire-policy.properties.test.ts` only if a lens fits (the policy is compositional over
    entries — lens 2: empty entries ⇒ defaults; appending a non-matching pattern never changes
    `cutoffsFor(ref)`); `config-read.test.ts` token walk (subsection verbatim, line numbers,
    valueless); `ref-glob.test.ts` (+ properties if the matcher grows); `reflog.test.ts`
    (config refusal precedes `REVPARSE_UNRESOLVED`, target resolution and the class; `show` /
    `delete` / `exists` ignore a bogus value — D16–D18). New
    `test/integration/reflog-expire-config-interop.test.ts`: D0–D13b with entries dated at
    whole days relative to the test's own clock (one-hour margins so git's `time(NULL)` and
    tsgit's `Date.now()` cannot straddle a boundary), D10–D10g refusals reconstructed from the
    error data, D14/D15/D20 ordering.
  - **Surface:** `docs/use/commands/reflog.md` (config keys, precedence, defaults, stash);
    `docs/use/errors.md` `CONFIG_BAD_DATE_VALUE` (per DC-D2) and `CONFIG_MISSING_VALUE` rows;
    `api.json` under DC-D2 (a)/(c). **Runtime:** ≈ +1.2 KiB (policy + token walk) + ≈ 0.5 KiB
    under DC-D3 (b).

**Tarball:** P14 + P15 + P16 + P17 + P18 add ≈ 2.5–3.1 KiB of runtime code against 937 B of
headroom — the cap is crossed inside P17 or P18; the part that crosses it raises
`tooling/verify-tarball.sh`'s cap with the measured tarball and per-part attribution, as the
eleven previous raises did.

#### P19 — Verdict single-compute pin (N)

- **Test-only** (DC-N1 (a)). **Files:** `test/unit/application/primitives/read-object.test.ts`,
  `pack-registry.test.ts`; `config-read.ts` untouched.
- **Fixtures:** `instrumentedContext` (`test/unit/application/primitives/fixtures.ts:343`),
  `vi.spyOn` on the finder module export, `cacheBudgets` spread on a bare memory Context.
- **Surface:** none. **Runtime:** 0.

---

### Docs consequences

For the docs phase: `docs/use/primitives/read-object.md`, `stream-blob.md`, `cat-file-batch.md`,
`commands/cat-file.md` (A: blob reads serve the body; `size` is the stored claim; commit/tree/tag
refuse; the cap measures actual bytes); `docs/use/primitives/update-ref.md` and
`commands/tag.md` (C/B: existence, branch typing, order); `commands/reflog.md` (D/E: config keys
and precedence, stash, defaults, target resolution, no-ref behaviour, class ordering);
`primitives/internals.md` (F RefStore HEAD paragraph; M HEAD-slot epoch; H/O budgets and family
total); `docs/understand/performance.md:59` (family total); `docs/use/errors.md` rows named in
each part; a 5.0 migration-note line for every behaviour change a caller can observe (A, B, C,
D, E, F). ADR-851/852/855/857 correction notes are written by the decisions phase with the new
ADRs, not by the docs phase.

---

## Decision candidates

### Ratified decisions (2026-09-14)

The user decided every candidate below. One deviates from this design's recommendation: **DC-C1**.

- **DC-A1 (b)** — type-directed: a size-lying loose blob takes git's streaming contract (real bytes
  served, never cached, `verifyHash` hashes the stored header); commit/tree/tag keep the refusal.
  ADR-863.
- **DC-A2 (a)** — `catFile`'s `size` reports the stored header claim; `readObjectMetadata` stays
  content-derived. ADR-863.
- **DC-C1 (a)** — full `parse_object` parity, **deviating from the recommended (b)**: the target
  exists and its hash verifies; `HEAD` and `refs/heads/*` also need a commit, a tag object not
  peeled; verification precedes the CAS; the C8 residual is removed. Section C is rewritten for it.
  ADR-864.
- **DC-C2 (c)** — `updateRef` plus `clone`'s `writeRef` and `applyRemoteHead`'s detached arm.
  ADR-864.
- **DC-D1 (a)** — follow the binary: git ≥ 2.50's effective defaults, total 30 days, unreachable
  90 days. Verified in git's source: v2.49.0 `builtin/reflog.c:311-312` set unreachable = now − 30 d
  and total = now − 90 d; v2.50.0, v2.55.0 and `master` `reflog.h:25-28` `REFLOG_EXPIRE_OPTIONS_INIT`
  set total = now − 30 d and unreachable = now − 90 d; `Documentation/config/gc.adoc` on `master`
  still documents 90/30. An upstream regression; faithfulness binds to the binary (ADR-226).
  ADR-865.
- **DC-D2 (a)** — `CONFIG_BAD_DATE_VALUE` gains optional `key`, `source`, `line`. ADR-866.
- **DC-D3 (b)** — `name-rev`'s matcher promoted to a shared `domain/refs/ref-glob.ts` with bracket
  expressions and backslash escapes; `name-rev` re-pointed. ADR-866.
- **DC-E1 (a)** — full `repo_dwim_log` transcription. ADR-867.
- **DC-E2 (a)** — `expire` with no ref and no `all` is a no-op `{ removed: 0, kept: 0 }`; the
  repo-settings class is not reached. ADR-867.
- **DC-H1 (a)** — width surcharge. ADR-869.
- **DC-I1 (a)** — `errorDataCode` moves to `src/domain/`; `isObjectNotFound` becomes structural.
  ADR-870.
- **DC-M1 (a)** — document the gate-to-gate epoch and pin it by test; correction note on ADR-855.
- **DC-N1 (a)** — regression pin only, no runtime change.
- **DC-O1 (a)** — parsed-memo constants corrected to the measured overhead, the 32 768
  dial-derived entry count kept, valve = entries × honest typical bytes (≈ 37.7 MiB at sha1),
  documented cache family total 136 → ≈ 158 MiB. ADR-869.

F (symlinked `HEAD` fall-through) carried no candidate; it is recorded as ADR-868.

### Candidates as tabled

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-A1 | What tsgit's read does with a loose object whose header size ≠ body length | (a) Refuse on every read, `streamBlob` included (count bytes, refuse at stream end), ADR records git's permissive tiers · (b) Type-directed: blobs take git's streaming contract (body served, never cached, `verifyHash` hashes the stored header); commit/tree/tag keep today's refusal · (c) Serve the body for every type; refuse only under `verifyHash`/`fsck` | **(b)** | (b) matches every user-facing git blob read (`cat-file -p`, `show`, `checkout`, `--batch`) and every git commit/tree parse (`corrupt` / `hash mismatch`), removes tsgit's own `streamBlob`-vs-`readObject` disagreement, and allocates nothing from the claim. (a) diverges from git's most common blob paths; (c) diverges on nearly every commit/tree command. Residuals: no truncation/padding on buffered consumers, `gc` repairs where `repack` corrupts, `log` on an under-running commit |
| DC-A2 | What `catFile`'s entry `size` reports for a size-lying blob | (a) The stored header claim (git `--batch`, `-s`, `ls-tree -l`); `readObjectMetadata` stays content-derived · (b) The body length (today's derivation), residual recorded · (c) The claim on both `catFile` and `readObjectMetadata` | **(a)** | `size.ts`'s own contract is "the `size` field of git's `cat-file --batch` header"; (c) feeds an untrusted number to `deltify` and the pack writer, whose sizes must equal the bytes they write; (b) is lossy data. Cost: one internal read variant and a `declaredSize` slot on the resolver's return literal |
| DC-C1 | Strength of the ref-target check | (a) `readObject { verifyHash: true }` for every target (`parse_object` parity, corrupt objects refused) · (b) Presence for non-branch refs, header-only type probe for `HEAD`/`refs/heads/*`, no hash · (c) Full `readObject` (no hash) for every target | **(b)** — **ratified: (a)** | Designer's case: (b) never inflates a blob for a presence question and reads one pack header for a branch; (a) as tabled fully inflates and hashes large blobs on every tag/remote write and is the only way to catch C8; (c) pays (a)'s inflate without its benefit. **Ratified (a)** — full parity, C8 refused. C builds it on the verified blob source instead of `readObject`, so bodies above the buffer gate are hashed without being materialised: (a)'s memory objection no longer holds, its hashing cost per update does |
| DC-C2 | Where the check lives | (a) `updateRef` only · (b) The `RefStore.applyRefUpdates` seam on both backends (git's transaction-layer placement; every writer) · (c) `updateRef` plus the two direct writers of remote-sourced ids (`clone` `writeRef`, `applyRemoteHead`'s detached arm) | **(c)** | (c) covers every surface whose ids arrive from outside the process; the other direct writers set ids the same command just wrote. (b) is structurally faithful but verifies internal writes git also verifies, touches every store unit test that seeds a synthetic oid (heuristic upper bound: 711 `'x'.repeat(40|64)` literals across 172 test files) and adds a probe to the direct writers too; (a) leaves `clone` planting a tree at `refs/heads/*` |
| DC-D1 | `reflog expire`'s defaults when nothing is configured | (a) git 2.55's effective defaults — total 30 days, unreachable 90 days (the v2.50.0 `REFLOG_EXPIRE_OPTIONS_INIT` swap, still on `master`), pinned D0/D1 · (b) The documented 90/30 (today's constants; git ≤ 2.49; `git-reflog(1)`), recorded as a divergence from the pinned binary · (c) (b) now, plus an upstream report, switching to whatever upstream ships | **(a)** | ADR-226 pins against the binary; the behaviour is present in every release since 2.50.0. Cold truth for the user: (a) makes tsgit expire reachable entries 30–90 days old that git's documentation promises to keep — exactly what git 2.55 does. (b) keeps the documented contract and diverges from real git on every default expire. This is an upstream regression; the choice is whether faithfulness binds to it |
| DC-D2 | Refusal data for an unparseable `gc.reflogExpire*` value | (a) Extend `CONFIG_BAD_DATE_VALUE` with optional `key`, `source`, `line` (present for config-file sources; `gc.pruneExpire` keeps `{ value }`) · (b) Reuse `CONFIG_BAD_DATE_VALUE { value }` as is · (c) New `CONFIG_INVALID_DATE_VALUE { key, source, value, line }` | **(a)** | git's two lines need key, file and line (D10); (b) cannot reconstruct them; (c) adds a code for the same refusal class. (a) is additive — `api.json` and the errors row change, no exhaustiveness switch does |
| DC-D3 | Pattern matcher for `gc.<pattern>` | (a) Reuse `name-rev`'s `matchRefGlob` (`*`, `?` only) and record `[…]` / `\` as a residual · (b) Promote it to a shared `domain/refs/ref-glob.ts` with bracket expressions and backslash escapes (git's `wildmatch(…, 0)` subset that differs), `name-rev` re-pointed · (c) A dedicated matcher inside the policy module | **(b)** | Both callers are `wildmatch(pattern, refname, 0)` in git; (b) fixes one residual in two commands and keeps one dialect; (a) is cheapest for the tarball (≈ 0.5 KiB less); (c) duplicates a dialect |
| DC-E1 | How far `expire`'s target resolution transcribes `repo_dwim_log` | (a) Full: `ref_rev_parse_rules` DWIM + must resolve + own log else symref target's log · (b) Verbatim name + must resolve + own log else target's log (no DWIM) · (c) Verbatim name + must resolve + own log only | **(a)** | (a) is one function in git and `refCandidates` already transcribes the rules; for a full refname rule 1 is the name itself, so every call that works today still resolves the same log. (b)/(c) keep `expire side` refusing and (c) keeps E6b/E7 refusing where git succeeds |
| DC-E2 | `reflog({ action: 'expire' })` with no `ref` and no `all` | (a) No-op `{ removed: 0, kept: 0 }`, class not reached — git (E10, O-d) · (b) Keep expiring `HEAD`, recorded divergence · (c) Type-level: the expire arm requires `ref` or `all: true` | **(a)** | (a) is the pinned behaviour with no public type change. (c) fails loud at compile time but is an `api.json` break with no git counterpart; (b) silently does work git does not. A caller relying on the `HEAD` default loses it silently under (a) — named in the 5.0 migration note |
| DC-H1 | How the default FlatTree and memo valves derive from hash width | (a) Width surcharge: reference count dial-scaled and width-independent (50 000 files, 32 768 commits per 16 MiB), valve += count × (hexLength − 40) · (b) Per-width literals (FlatTree share ½ / 9⁄16; memo valve 16 / 17 MiB) · (c) Width-proportional scaling by a typical-entry ratio (needs a typical path length constant) | **(a)** | (a) adds exactly what the sizers charge for wider oids (their only width term), leaves every sha1 number byte-identical to ADR-851, admits the same reference workload at both widths, and needs no path-length guess (the constant removed by Post-review correction 5). (b) leaves 197 files of sha256 headroom and hides the rule; (c) reintroduces a typical-path constant |
| DC-I1 | Where the shared structural classifier lives | (a) Move `errorDataCode` to `src/domain/`, re-point 15 imports, `isObjectNotFound` uses it · (b) Keep it in application; move `isObjectNotFound` next to it and re-point its 10 call sites · (c) A second structural check inside `domain/objects/error.ts` | **(a)** | A pure `unknown → string` function belongs in the innermost layer; one helper for 16 consumers. (b) evicts a domain-shaped guard from the domain; (c) duplicates the helper the brief asks to reuse |
| DC-M1 | HEAD-slot epoch: fix the words or the code | (a) Document gate-to-gate (docstrings, ADR-855 note, ledger L1, `internals.md`) and pin it by test — the config epoch's shape · (b) `readHeadFile` trusts a slot only when `identity !== undefined` and re-`lstat`s it (Node +1 hop per `resolveDirect('HEAD')`; memory/browser lose the intra-command share) · (c) Clear `trusted` at command end via the facade | **(a)** | (a) matches ADR-850's config contract, costs nothing, and makes the real contract executable. (b) buys between-command freshness for primitive reads at a per-read cost on every adapter and reverses ADR-855's hop table; (c) has no hook — command functions called directly bypass the facade (rejected in the parent design) |
| DC-N1 | The "computed twice" finding | (a) No runtime change; pin one compute (finder spy) and the stat count, close as not reproduced · (b) Fold the registry's budget read into the verdict's compute (one `stat` on a primitive-only first touch) · (c) Close without a pin | **(a)** | Measured single compute (correction 9); the remaining `stat` is the budget resolver's primitive-only per-read freshness, which ADR-850 keeps on purpose. (b) couples the budget to the verdict memo for a primitive-only micro-saving; (c) lets the claimed defect appear silently later |
| DC-O1 | Parsed-memo accounting | (a) Correct the constants to the measured overhead, keep 32 768 entries, valve = entries × honest typical bytes (≈ 37.7 MiB), amend ADR-851/852 numbers · (b) Correct the constants, keep the 16 MiB valve (cap ≈ 13 900 entries) · (c) Document the valve as a charged proxy with the measured ratios; no code change | **(a)** | (a) keeps the workload ADR-851 sized for, makes the stated family total true, and changes real memory only for walks of atypically large entries (≈ 18 → ≈ 37.7 MiB ceiling). (b) re-opens the cliff for > 13 900-commit walks; (c) keeps a documented 16 MiB that is really ≈ 38 MiB |

---

## Test strategy

House rules: `describe('Given …')` › `describe('When …')` › `it('Then …')`, AAA, `sut`, 100 %
coverage, error assertions on `data` field by field, guard clauses isolated, no ignore directives.

### Unit, per item (mutation-resistant shape)

| Item | Kill shape |
|---|---|
| I | foreign-shaped error true / non-string code false / `new Error` false kills the `===` and property-read mutants; the batch-fold call-site test kills a reverted `instanceof` |
| A | blob-vs-commit mismatch pair kills the type guard; equal-size commit kills the size comparison; `ctx.deltaCache.has` after a lying read kills the cache gate; the recorded hasher `update` sequence (`serializeHeader(type, claim)` bytes) kills a `content.byteLength` default mutant; `OBJECT_TOO_LARGE.actualSize === 8` kills a cap-on-claim mutant |
| H | the sha256 admitted row and the sha1 byte-identical row together kill a dropped or doubled surcharge; a 4 MiB-dial sha256 row kills a surcharge not scaled by the dial |
| O (a) | the invariant row with the new constant; a 4 KiB-message row kills a valve left at the dial |
| F | F1/F2/F3/F4/F6 each isolate one arm (`startsWith`, `isSafeRefName`, directory, ENOENT, parse); the post-gate target rewrite kills slotting the followed content |
| M (a) | gate → rewrite → stale read → next gate fresh |
| C | branch/non-branch pair kills `isBranchRef`; `HEAD` isolated from `refs/heads/`; `ORIG_HEAD` kills a `name.includes('HEAD')` mutant; wrong-`expected` + nonexistent kills a reordering; delete isolation kills an unconditional call; a hash-mismatching commit on a branch reporting `OBJECT_HASH_MISMATCH` kills a type-before-hash reordering; the hasher `update` record on a cache-warmed target kills a cache or memo short-circuit; `inflate` never called on a streamed loose blob kills a buffered fallback |
| B | existing name + nonexistent (`TAG_EXISTS`) vs force + nonexistent (`OBJECT_NOT_FOUND`) |
| K | no assertion change; the existing R-matrix and single-transaction spy (`applyRefUpdates` called once with N updates, including a zero-prune target) |
| E | each `logForCandidate` arm isolated (invalid name, unresolvable, own log, target log, neither); DWIM order via a name present as both `refs/tags/x` and `refs/heads/x` logs (tags first); class-ordering trio |
| D | parameterised matrix rows each flip one precedence rule; duplicate-valid last-wins vs invalid-anywhere; non-matching invalid pattern; stash with and without a pattern |
| N | finder spy count 1 across two reads; stat count 1 with the option |

### Interop (real git, `test/integration/*-interop.test.ts`)

| Test | Pins |
|---|---|
| new `loose-header-size-interop.test.ts` | A1 `-s`/`-p`/`--batch` rows vs `catFile`/`readObject`/`streamBlob`; A2 commit rows; `fsck` vs `verifyHash`; the `log` under-run residual titled as such |
| new `ref-write-verification-interop.test.ts` | C1–C9; B1–B6; the empty-tree-id target row |
| new `reflog-expire-config-interop.test.ts` | D0–D13b, D10–D10g, D14, D15, D20 |
| `reflog-interop.test.ts` (extend) | E1, E4, E6b, E7, E8, E10, E15, O-a, O-d |
| `head-symlink-interop.test.ts` (extend) | F2–F5, F8; F1 with its `status`/`commit` residual titled |
| `repo-settings-config-interop.test.ts` | re-run unchanged (O5 for `HEAD` holds) |

### Measurement oracles (recorded in the PR, not asserted in CI)

The heap scripts behind O's tables (esbuild bundle of the worktree source, `--expose-gc`,
six-GC settle) and the config-stat counter behind N, re-run on the branch tip after P15/P19.

---

## Out of scope

- **`reflog delete` / `reflog show` target resolution** (E1d/E1e) — the same `repo_dwim_log`
  and revision-parsing differences exist; E is scoped to `expire`.
- **Multiple ref arguments to `expire`** (E9) — tsgit's API takes one ref.
- **tsgit `gc` / `maintenance` running a reflog expire** — git's does (`gc.c:359`); tsgit's never
  did; D only makes the command honour the keys.
- **The other 72 `instanceof TsgitError` classifications** — same defect class as I; a sweep of
  its own (reflog `tryResolve` included).
- **Verification of internal ref writers** — per DC-C2. **Structural parsing of a hash-valid ref
  target** (`parse_object_buffer`'s commit/tag/tree parse) — the ratified DC-C1 rule is existence
  plus hash plus branch typing; recorded as a residual in C.
- **Header claims in `(2^53, 2^64)`** (A3) — `number` cannot carry them; git's header tier prints
  them.
- **Buffered-tier truncation/padding and `repack` persisting a size-lying blob** (A1) — the
  allocation-from-claim behaviour the threat model rules out.
- **FlatTree sizer accounting (1.26–1.32×)** — measured and reported under O; changing its
  constant is not in DC-O1 unless the user extends it.
- **Bidi override code points in a symlinked `HEAD`'s link text** — the repo-wide ref grammar
  difference, not the symlink rule.
- **A "detached, unborn" `HEAD` state** (F1, F6) — `status`/`commit` on a symlink whose target
  is absent; needs a new `HeadState` arm across every `readHeadRaw` consumer.
- **`core.warnAmbiguousRefs`** — `repo_dwim_log` stops at the first hit when it is off and keeps
  counting when on; the chosen log is the first hit either way.
- **Global/system `gc.reflogExpire*`** (D11d) — ADR-637's recorded local-only scope.
