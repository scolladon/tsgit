# Design — session-caches faithfulness addendum (31.2, eleven folded items)

> Brief: fold eleven items into the 31.2 PR on `feat/session-caches-per-command-floor` — six
> pre-existing git-faithfulness gaps pinned against git 2.55.0 (A size-lying loose header, B
> lightweight `tag.create` target, C `updateRef` target verification, D `gc.reflogExpire*`
> config, E single-ref `reflog expire` on a gone ref, F symlinked `HEAD` with a format-invalid
> link text), one sizing fix (H FlatTree default at sha256), two structural items (I structural
> `isObjectNotFound`, K `runExpire` length) and three LOW review findings (M HEAD-slot epoch, N
> repo-settings verdict double compute, O parsed-memo accounting).
> Status: draft → self-reviewed ×3 → decisions ratified (2026-09-14) → ref write/delete semantics and
> memory-adapter parity folded (U1–U6, 2026-09-14; open items O1–O4)

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
| R-C | `updateRef` (and the ref writers ratified in DC-C2) refuses a nonexistent new object `OBJECT_NOT_FOUND`, an object whose stored bytes do not hash to its id `OBJECT_HASH_MISMATCH`, a hash-valid commit or tag that git's `parse_commit_buffer` / `parse_tag_buffer` refuses `INVALID_COMMIT` / `INVALID_TAG` (git's acceptance transcribed, nothing stricter), and a non-commit written to `HEAD` or `refs/heads/*` `UNEXPECTED_OBJECT_TYPE { expected: 'commit' }` (after the hash and the parse), all before the CAS; the hash is computed on every such update (no cache answers for it) and a blob body above the buffer gate is hashed without being materialised; deletes, null ids and symbolic writes are unverified — per DC-C1 (a) as ratified | same interop file (C1–C9); `update-ref.test.ts`, `clone.test.ts` |
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
bytes hash to the id **and**, for a commit or a tag, the bytes pass git's own parse acceptance
(`parse_commit_buffer`, `parse_tag_buffer` — ratified 2026-09-14, transcribed below, not tsgit's
parser); `HEAD` and `refs/heads/*` additionally require type `commit`, with an annotated tag object
refused rather than peeled (C1). The C8 residual (b) carried is gone. (a) as tabled read every
target through `readObject { verifyHash: true }`, which materialises every body; the shape below
keeps the rule and does not materialise a large body.

**git's shape** (`object.c` `parse_object_with_flags`, v2.55.0). An object already parsed in the
running process is returned without hashing (`lookup_object` … `obj->parsed`). Otherwise a
header-only `odb_read_object_info` that answers `OBJ_BLOB` sends the object to
`stream_object_signature`; every other type is read whole (`odb_read_object`) and hashed by
`check_object_signature`. `parse_object_buffer` (`object.c:261`) then parses the buffer: a commit
or tag that `parse_commit_buffer` or `parse_tag_buffer` refuses returns `NULL`; `parse_tree_buffer`
validates nothing and a blob is not parsed. Any failure returns `NULL`, which
`ref_transaction_update` reports as nonexistent; the type test runs only on a parsed object (C8:
`hash mismatch` precedes `nonexistent object`).

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
export interface VerifiedObject {
  readonly type: ObjectType;
  readonly acceptance: ParseAcceptanceScan | undefined;   // commit and tag only: git parses no blob or tree
}
/** git's parse_object read for one id: it exists and its stored bytes hash to it; the stored type is
 *  returned, and a commit's or tag's bytes are scanned for git's parse acceptance as they pass.
 *  Every arm hashes; a body above the buffer gate is hashed as it inflates and never retained. */
export async function verifyStoredObject(ctx: Context, id: ObjectId): Promise<VerifiedObject> {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () => hashStoredObject(ctx, id));
}
async function hashStoredObject(ctx: Context, id: ObjectId): Promise<VerifiedObject> {
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
  const scan = scanFor(source.type, ctx.hashConfig);             // startParseAcceptance for commit/tag, else undefined
  if (source.kind === 'bytes') return { type: source.type, acceptance: feedAll(scan, [source.content]) };
  return { type: source.type, acceptance: await drainScanning(source.stream, scan) };   // the arm's hasher refuses OBJECT_HASH_MISMATCH at the end
}

// src/application/primitives/internal/ref-target.ts (new)
/** git's `is_branch` (refs.c:1072). */
const isBranchRef = (name: RefName): boolean => name === 'HEAD' || name.startsWith(HEADS_PREFIX);

/** git's ref_transaction_update verification (refs.c:1425-1445): parse_object must succeed, then a
 *  branch needs a commit. */
export const assertRefTargetValid = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  if (id === zeroOid(ctx.hashConfig)) return;                                   // git: !is_null_oid
  const { type, acceptance } = await verifyStoredObject(ctx, id);               // OBJECT_NOT_FOUND, OBJECT_HASH_MISMATCH
  if (acceptance !== undefined) await assertParseAccepted(ctx, id, acceptance); // INVALID_COMMIT, INVALID_TAG
  if (type !== 'commit' && isBranchRef(name)) throw unexpectedObjectType('commit', type, id);   // after hash and parse (C8 order)
};
const assertParseAccepted = async (ctx: Context, id: ObjectId, scan: ParseAcceptanceScan): Promise<void> => {
  const parentLookups = needsParentLookups(scan) ? await parentLookupsFor(ctx, id) : 'checked';  // 'skipped' for a shallow boundary
  const refusal = parseAcceptanceVerdict(scan, { parentLookups });
  if (refusal !== undefined) throw toObjectRefusal(refusal);                    // invalidCommit / invalidTag (domain/objects/error.ts)
};

// src/domain/objects/parse-acceptance.ts (new, pure) — git's parse_commit_buffer / parse_tag_buffer acceptance
export type ParseAcceptanceScan = /* immutable; carries at most one partial line (≤ hexLength + 8 bytes),
                                     the decoded tree id and the byte count */;
export const startParseAcceptance = (type: 'commit' | 'tag', hexLength: 40 | 64): ParseAcceptanceScan;
export const feedParseAcceptance = (scan: ParseAcceptanceScan, chunk: Uint8Array): ParseAcceptanceScan;  // never throws
export const needsParentLookups = (scan: ParseAcceptanceScan): boolean;       // a parent id equalled the tree id
export const parseAcceptanceVerdict = (
  scan: ParseAcceptanceScan,
  options: { readonly parentLookups: 'checked' | 'skipped' },
): ParseAcceptanceRefusal | undefined;                                        // { type, reason } per the tables below
```

`drainScanning` iterates the stream to its end, feeding each chunk to the scan and discarding it;
the hash lives in the arm's own tail (`yieldAndVerifyChunks`, `yieldAndVerifyPackedBaseChunks`),
so a hash mismatch throws before the loop exits and before any verdict is read — the type and the
scan are returned only after the drain. `feedParseAcceptance` records the first failing condition
and never throws, which keeps the hash refusal first. The shallow set (`loadShallowSet`,
`internal/shallow-set.ts:77`) is read only when the scan saw a parent id equal to the tree id.

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
accept, under the compressor port's 2 GiB cap. A packed **delta** is reconstructed in memory,
bounded by the compressor port's 2 GiB cap, as every tsgit read of a deltified object is — tsgit
has no streaming delta path; recorded, not changed.

**Guarantee — branch typing.** The type comes from the stored header on every arm and is tested
only after the hash and the parse acceptance passed, git's order: a hash-mismatching commit on
`refs/heads/*` reports the hash (C8), a malformed commit on a branch reports its parse refusal,
and an annotated tag object on a branch is `tag`, refused (C1).

**Parse acceptance (commit and tag targets).** Transcribed from v2.55.0 `commit.c:516`
`parse_commit_buffer` and `tag.c:130` `parse_tag_buffer`, read in full. `h` is the hex length (40
or 64); offsets are into the object body, after the loose header; "hex" is `0-9`, `a-f` **or**
`A-F` (the hex digit table in `hex-ll.c`), decoded to bytes before any comparison.

| # | Commit condition that refuses (`commit.c`) | git's `error:` line | `reason` |
|---|---|---|---|
| PC1 | body length ≤ h + 6; or bytes 0–4 ≠ `tree `; or byte h + 5 ≠ LF (`:539-541`) | `bogus commit object <oid>` | `bogus commit object` |
| PC2 | bytes 5 … h + 4 not all hex (`:542-544`) | `bad tree pointer in commit <oid>` | `bad tree pointer` |
| PC3 | a parent line — entered at offset p only while more than h + 7 bytes remain and bytes p … p + 6 are `parent ` — is the last h + 8 bytes of the body, or bytes p + 7 … p + h + 6 are not all hex, or byte p + h + 7 ≠ LF (`:557-563`) | `bad parents in commit <oid>` | `bad parents` |
| PC4 | a parent id equals the tree id, and the commit is not a graft (`:569-575`, below) | `object <tree> is a tree, not a commit` then `bad parent <parent> in commit <oid>` | `bad parent <parent-id>` |

The parent scan stops at the first line PC3 does not enter. Lines are checked in order and the
first refusal wins; within one parent line the grammar (PC3) precedes the lookup (PC4).

| # | Tag condition that refuses (`tag.c`) | git's `error:` line | `reason` |
|---|---|---|---|
| PT1 | body length < h + 24 (`:151`) | none | `tag object too short` |
| PT2 | bytes 0–6 ≠ `object `; or bytes 7 … h + 6 not all hex; or byte h + 7 ≠ LF (`:153-156`) | none | `bad object line` |
| PT3 | the next bytes are not `type `; or no LF follows before the body ends; or the type name before that LF is 20 bytes or longer (`:158-163`) | none | `bad type line` |
| PT4 | the type name, compared up to its first NUL byte (`strcmp`), is not `blob`, `tree`, `commit` or `tag` (`:168-179`) | `unknown tag type '<name>' in <oid>` | `unknown tag type '<name>'` |
| PT5 | four or fewer bytes remain after the type line, or they do not start `tag `; or no LF follows `tag ` (`:186-193`) | none | `bad tag line` |

Every refusal then surfaces from the transaction as `trying to write ref '<ref>' with nonexistent
object <oid>`, prefixed as the C-rows show.

**Not checked by git, so not checked here.** A commit's bytes after its parent lines — `author`
and `committer` (their absence included; `parse_commit_date` returns 0 on anything malformed and
never refuses), `encoding`, `gpgsig`, other headers, the message — and any `parent ` line after the
first line PC3 does not enter. A tag's `tagger` line (optional; its date parse never refuses), the
content of its name (empty accepted), its message and signature, and whether the tagged object
exists or has the type named. A tree: `parse_tree_buffer` (`tree.c:175`) only stores the buffer. A
blob: never parsed. tsgit's own parsers are **not** used, because they refuse objects git accepts:
`parseCommitContent` requires `author` and `committer` (`commit.ts:147,153`), `parseTagContent`
refuses an empty tag name (`tag.ts:106`), and both take object ids through a lower-case-only
pattern (`oid-pattern.ts`).

**In-process type conflicts.** `lookup_tree`, `lookup_commit` and `lookup_tag` return `NULL` when
the id is already in the process's object table as another type (`object.c:165`
`object_as_type`). A fresh `update-ref` process given full hex ids parses them with
`repo_get_oid_with_flags` (`builtin/update-ref.c`), whose full-hex path (`object-name.c:689-701`)
reads refs at most, never objects, so the table holds only the target and the nodes its own parse
creates:

- `bad tree pointer <tree> in commit` (`commit.c:545-549`) needs the tree id to be the commit's own
  id, a hash fixed point — unreachable, not transcribed.
- `bad parent` is reachable: a parent id equal to the tree id meets the node the parse has just
  registered as a tree — PC4. git skips parent lookups for a graft (`graft && (nr_parent < 0 ||
  !grafts_keep_true_parents)`, `:569`): a shallow boundary, or an `info/grafts` entry. PC4 therefore
  applies only when the commit id is not in the shallow set.
- `bad tag pointer to <oid> in <tag>` (`tag.c:181-184`) needs the tagged id to be the tag's own id
  — unreachable, not transcribed.
- A conflict with an object parsed earlier in the same process — another update in one
  `update-ref --stdin` transaction, for instance — has no tsgit counterpart: tsgit keeps no
  process-wide object table. Recorded residual.

After both checks git peels a tag target (`refs.c:1442-1446`, `PEEL_OBJECT_VERIFY_TAGGED_OBJECT_TYPE`);
a failed peel only leaves the update without a peeled value and refuses nothing, so it is not part
of the check.

**Where the bytes come from.** `openBlobSource` gates on stored size, never on type: a loose object
is buffered when its compressed file is at most `MAX_BUFFERED_BLOB_BYTES` (`resolveLoose:181`), a
packed base entry when both its payload and its declared size are (`resolvePackBase:218-221`), and a
cache hit or a packed delta is always bytes. A commit or tag below the gate therefore arrives as one
`bytes` source and is scanned in one feed. Above the gate — a loose commit or tag whose compressed
file exceeds 64 KiB, or a packed base entry above it — it arrives as a stream and is scanned chunk
by chunk while the tail hashes it, so nothing beyond one partial line is retained: the scan's carry
is bounded by the longest line a condition inspects (h + 8 bytes), plus the decoded tree id, and
PT5's newline search keeps only a flag. The verdict therefore needs no second read and no
materialised body.

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
- Refused by git's parse acceptance: `INVALID_COMMIT { reason }` or `INVALID_TAG { reason }`, the
  codes `parseCommitContent` and `parseTagContent` already raise (`domain/objects/error.ts:59,62`,
  errors page "Commit object failed validation" / "Tag object failed validation"), with `reason`
  from the tables above. git's `error:` line composes from `reason` and the target id the caller
  passed — the parent id (lower-case, as `oid_to_hex` prints it) and the tag type name, the two
  values git prints, travel inside `reason`,
  as the tag parser's `invalid object type: <name>` already does, the name passed through
  `sanitizeForDisplay` (`domain/error.ts:124`); its `fatal:` line composes from the id and the ref
  name (ADR-249).
- Non-commit on a branch: `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }` (ADR-861).
- A size-lying loose object (A) of any type refuses `OBJECT_HASH_MISMATCH`: the buffered arm hashes
  the stored bytes before it splits them, the stream arm hashes the stored header. That git refuses
  such a target follows from `parse_object`; its exact lines for a size-lying target are not among
  C1–C9 and are not claimed here.

**Pins to add in P17.** `openBlobSource` has no virtual empty-tree arm, `resolveObjectContentWithDepth`
has one (`:82`). C1–C9 do not probe the empty-tree id as a target in a repository that does not
store it; P17's interop file adds that row, and `hashStoredObject` takes a virtual arm only if git
accepts the write. The parse-acceptance rows (P17) are expected from the source reading above and
confirmed against the binary there.

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
- Parse acceptance adds, for a commit or tag target only, one pass over the bytes its conditions
  inspect — the tree and parent lines, or the object, type and tag lines — riding the same read;
  blob and tree targets pay nothing for it.
- `commit.bench` and the parent design's `branch.create` floor (R2) are re-measured main-vs-branch
  in P17's part gate and recorded in the PR; no figure is claimed here.

**Residuals recorded (ADR).** Writers outside DC-C2's set remain unverified. In-process type
conflicts with objects parsed earlier in the same git process are not modelled (no process-wide
object table). tsgit reads no `info/grafts` file, so for a commit listed there PC4 refuses where
git skips the parent lookup; shallow boundaries match.

**Threat model.** `newId` is caller- or network-controlled (a Tier-2 caller, a fetch/clone
advertisement). The check hashes the target's stored bytes, so what an advertisement can plant
narrows to objects that are both present and intact: a ref to a missing object, a ref to an
object whose bytes do not hash to its name, a commit or tag git's parser refuses, and a
`refs/heads/*` or detached `HEAD` pointing at a non-commit are all refused, as git refuses them.
Memory: no allocation is sized from the target beyond what every tsgit read already allows — a
blob body above the gate is hashed chunk by chunk, a commit-sized body is inflated once under the
compressor port's 2 GiB cap, a packed delta is reconstructed under that same cap, and the parse
scan retains at most one partial line and the tree id, whatever the object's size. CPU: an
attacker who can name a large existing blob as a ref target makes the check hash that blob once
per update, which is also what git does.

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
| `internal/ref-target.ts` (new), `update-ref.ts`, `clone.ts`, `internal/blob-source.ts` (`verifyStoredObject`, loose stream arm), `stream-blob.ts`, `internal/whitespace-drop-predicate.ts`, `read-object.ts` (`withLazyFetchRetry` export), `domain/objects/parse-acceptance.ts` (new) | P17 commit 1 (C) | `read-object.ts` is P14's file too; P17 only adds the export |
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
    `primitives/read-object.ts:173` exports `withLazyFetchRetry`; new
    `src/domain/objects/parse-acceptance.ts` (`startParseAcceptance`, `feedParseAcceptance`,
    `needsParentLookups`, `parseAcceptanceVerdict`), beside the commit and tag grammar in
    `domain/objects/`. Helpers: `openBlobSource`, `loadShallowSet` (`internal/shallow-set.ts:77`),
    `invalidCommit` / `invalidTag` (`domain/objects/error.ts:59,62`), `sanitizeForDisplay`
    (`domain/error.ts:124`),
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
    `refs/heads/x` names a tree the pack carries → refused, nothing written);
    `test/unit/domain/objects/parse-acceptance.test.ts` (one row per PC1–PC4 and PT1–PT5 condition
    and per boundary: a commit body of exactly h + 6 and h + 7 bytes; a parent line that is the last
    h + 8 bytes; a `parent ` prefix with h + 7 bytes left, accepted; upper-case hex accepted; a parent
    equal to the tree id with `parentLookups` `checked` and `skipped`; grammar before lookup on one
    line; a tag of h + 23 and h + 24 bytes; a type name of 19 and 20 bytes; `commit\0x` accepted as
    `commit`; `tag \n` accepted; a commit with no author or committer accepted; both widths) and
    `parse-acceptance.properties.test.ts` (lens 4: the verdict of any partition of the same bytes into
    chunks equals the one-chunk verdict; numRuns 100); `update-ref.test.ts` (a hash-valid malformed
    commit to `refs/tags/x` → `INVALID_COMMIT { reason: 'bogus commit object' }`, nothing written; a
    malformed commit to `refs/heads/x` reports the parse refusal, not the type; a malformed tag →
    `INVALID_TAG`; a tree with garbage entries to `refs/tags/x` → written; a streamed commit above
    the gate with a bad parent line → refused without `ctx.compressor.inflate` on its bytes; the
    shallow set not read unless a parent equals the tree id).
    **Enumeration:** tests that write refs to synthetic oids through `updateRef` (60 calls in
    18 files) — run those 18 files, give each failing fixture a real object (`writeObject`) or a
    non-branch ref; `applyRefUpdates` fixtures are untouched under DC-C2 (c).
    New `test/integration/ref-write-verification-interop.test.ts` (`@proves bucket:
    cross-tool-interop, interopSurface: updateRef, tag.create`): C1–C9; the empty-tree-id target
    row named in C; and the parse-acceptance rows, each object written with `git hash-object
    --literally -w -t <type>` so it is hash-valid, each target written by `git update-ref` and by
    `updateRef` in twin repositories — a commit with no `tree` line (refused, PC1), a commit whose
    parent line carries a non-hex character (refused, PC3), a tag whose type is `bogus` (refused,
    PT4), a tag whose object line is cut short of h hex digits (refused, PT2), a commit with `tree`
    and `parent` lines but no `author` or `committer` on `refs/heads/x` (**accepted** by both), and a
    tree with garbage entries on `refs/tags/x` (**accepted** by both). git's `error:` and `fatal:`
    lines are reconstructed from the refusal data and the ref name in the test, not emitted.
  - **Surface:** `docs/use/primitives/update-ref.md`; `docs/use/errors.md` `OBJECT_NOT_FOUND`,
    `OBJECT_HASH_MISMATCH`, `INVALID_COMMIT`, `INVALID_TAG` and `UNEXPECTED_OBJECT_TYPE` rows gain
    `updateRef` / `clone` / `tag.create` throwers and the caller composition of git's two lines;
    `api.json`: none (every code exists). **Runtime:** ≈ +350 B for the check, plus the scan.
  - **Tarball:** headroom was about 800 B when this part was planned. If `npm run check:tarball`
    fails in the part gate, raise `SIZE_CAP` (`tooling/verify-tarball.sh:152`) by the minimum whole
    KiB that passes, with the measured tarball and this part's attribution in the script comment
    and the commit, as the earlier raises did.
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
  Follow-up ratified the same day: a commit or tag target must also pass git's
  `parse_commit_buffer` / `parse_tag_buffer` acceptance, transcribed, not tsgit's parser. ADR-864.
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

Decided with the user after this design (2026-09-14), specified in
[Ref write and delete semantics, and memory-adapter parity](#ref-write-and-delete-semantics-and-memory-adapter-parity-u1u6):

- **G1 (b)** — the memory adapter follows symlinks on read. Widened by U1. ADR-872.
- **G2 (b)** — a null new id deletes the ref. ADR-871.
- **U1** — the memory adapter resolves every path component; write leaves stay no-follow. ADR-872.
- **U2** — memory refusal codes match the Node adapter's explicit errno mapping (Y4–Y8); Y10/Y11 stay
  under ADR-811 (O4). ADR-872.
- **U3** — a delete of an absent ref is a no-op; commands keep their own refusals. ADR-871.
- **U4** — a packed ref's delete rewrites `packed-refs` under `packed-refs.lock` (and the loose ref's
  lock); `fetch --prune`'s special case removed. ADR-871.
- **U5** — `updateRef` dereferences symbolic refs as git's transaction splits them, `noDeref` added;
  callers classified (A 5, B 7, C 10, D 4, E 1). ADR-871.
- **U6** — every delete path writes the coupled `logs/HEAD` entry. ADR-871. Its `branch.rename` clause
  is contradicted by R11/R12 and waits on **O1**; O2–O4 are open as well.

### Candidates as tabled

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-A1 | What tsgit's read does with a loose object whose header size ≠ body length | (a) Refuse on every read, `streamBlob` included (count bytes, refuse at stream end), ADR records git's permissive tiers · (b) Type-directed: blobs take git's streaming contract (body served, never cached, `verifyHash` hashes the stored header); commit/tree/tag keep today's refusal · (c) Serve the body for every type; refuse only under `verifyHash`/`fsck` | **(b)** | (b) matches every user-facing git blob read (`cat-file -p`, `show`, `checkout`, `--batch`) and every git commit/tree parse (`corrupt` / `hash mismatch`), removes tsgit's own `streamBlob`-vs-`readObject` disagreement, and allocates nothing from the claim. (a) diverges from git's most common blob paths; (c) diverges on nearly every commit/tree command. Residuals: no truncation/padding on buffered consumers, `gc` repairs where `repack` corrupts, `log` on an under-running commit |
| DC-A2 | What `catFile`'s entry `size` reports for a size-lying blob | (a) The stored header claim (git `--batch`, `-s`, `ls-tree -l`); `readObjectMetadata` stays content-derived · (b) The body length (today's derivation), residual recorded · (c) The claim on both `catFile` and `readObjectMetadata` | **(a)** | `size.ts`'s own contract is "the `size` field of git's `cat-file --batch` header"; (c) feeds an untrusted number to `deltify` and the pack writer, whose sizes must equal the bytes they write; (b) is lossy data. Cost: one internal read variant and a `declaredSize` slot on the resolver's return literal |
| DC-C1 | Strength of the ref-target check | (a) `readObject { verifyHash: true }` for every target (`parse_object` parity, corrupt objects refused) · (b) Presence for non-branch refs, header-only type probe for `HEAD`/`refs/heads/*`, no hash · (c) Full `readObject` (no hash) for every target | **(b)** — **ratified: (a)** | Designer's case: (b) never inflates a blob for a presence question and reads one pack header for a branch; (a) as tabled fully inflates and hashes large blobs on every tag/remote write and is the only way to catch C8; (c) pays (a)'s inflate without its benefit. **Ratified (a)** — full parity, C8 refused. C builds it on the verified blob source instead of `readObject`, so bodies above the buffer gate are hashed without being materialised: (a)'s memory objection no longer holds, its hashing cost per update does. Follow-up ratified: git's commit and tag parse acceptance is transcribed into the check (C) |
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
| C | branch/non-branch pair kills `isBranchRef`; `HEAD` isolated from `refs/heads/`; `ORIG_HEAD` kills a `name.includes('HEAD')` mutant; wrong-`expected` + nonexistent kills a reordering; delete isolation kills an unconditional call; a hash-mismatching commit on a branch reporting `OBJECT_HASH_MISMATCH` kills a type-before-hash reordering; the hasher `update` record on a cache-warmed target kills a cache or memo short-circuit; `inflate` never called on a streamed loose blob kills a buffered fallback; one row per PC/PT condition and boundary kills each comparison; the chunk-partition property kills a scan that loses its carry across chunks; a malformed commit on a branch reporting the parse refusal kills a type-before-parse reordering; the no-author commit and the garbage tree accepted kill a check stricter than git |
| B | existing name + nonexistent (`TAG_EXISTS`) vs force + nonexistent (`OBJECT_NOT_FOUND`) |
| K | no assertion change; the existing R-matrix and single-transaction spy (`applyRefUpdates` called once with N updates, including a zero-prune target) |
| E | each `logForCandidate` arm isolated (invalid name, unresolvable, own log, target log, neither); DWIM order via a name present as both `refs/tags/x` and `refs/heads/x` logs (tags first); class-ordering trio |
| D | parameterised matrix rows each flip one precedence rule; duplicate-valid last-wins vs invalid-anywhere; non-matching invalid pattern; stash with and without a pattern |
| N | finder spy count 1 across two reads; stat count 1 with the option |

### Interop (real git, `test/integration/*-interop.test.ts`)

| Test | Pins |
|---|---|
| new `loose-header-size-interop.test.ts` | A1 `-s`/`-p`/`--batch` rows vs `catFile`/`readObject`/`streamBlob`; A2 commit rows; `fsck` vs `verifyHash`; the `log` under-run residual titled as such |
| new `ref-write-verification-interop.test.ts` | C1–C9; B1–B6; the empty-tree-id target row; parse acceptance: no `tree` line, bad parent line, unknown tag type, truncated tag object line (refused), no author/committer, garbage tree on a tag ref (accepted) |
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
- **Verification of internal ref writers** — per DC-C2.
- **tsgit's own commit and tag parsers as a ref-target check** — they refuse objects git accepts;
  C transcribes git's acceptance instead. In-process type conflicts with objects parsed earlier in
  the same git process, and `info/grafts`, are recorded residuals in C.
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

---

## Ref write and delete semantics, and memory-adapter parity (U1–U6)

<!-- cspell:ignore nothere packdel linkdir filelink -->

### Where this comes from

Planning the gap resolutions (G1 memory-adapter symlink reads, G2 null-id delete) surfaced six
pre-existing differences the plan first recorded as open items U1–U6
(`docs/plan/session-caches-faithfulness-addendum.md`). The user decided all six on 2026-09-14 and
folded them into this PR:

- **U5** — `updateRef` dereferences symbolic refs as git does, and gains `noDeref` (git's
  `--no-deref`).
- **U3** — a delete of an absent ref is a no-op success.
- **U6** — deleting the ref `HEAD` points at appends `<old> 0{40} <message>` to `logs/HEAD` on every
  delete path; `branch.rename` gets a non-logging delete so its reflog bytes stay git's.
- **U4** — a delete of a packed-only (or loose-and-packed) ref rewrites `packed-refs` under
  `packed-refs.lock`; `fetch --prune`'s `delete-packed-ref` special case goes.
- **U1** — the memory adapter resolves symlinks in every path component with the 40-hop limit;
  write surfaces keep their leaf no-follow semantics but resolve intermediate components as Node does.
- **U2** — the memory adapter's refusal codes match the Node adapter's for a symlink loop, a read of a
  directory, `readdir` of a missing path, and every other mismatch in the contract suite's scope that
  the Node adapter's errno mapping defines.

This section pins git and Node, then specifies each change. Two parts of the decisions meet a pin
that contradicts their premise or an earlier ratified record; they are stopped and tabled under
[Open items](#open-items-raised-by-the-u1u6-pins), not substituted.

### Pins — symbolic refs on the write path (git 2.55.0)

Scratch repositories, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, every inherited `GIT_*` unset,
identity from repository `user.name`/`user.email`, `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned,
`commit.gpgsign=false`, `tag.gpgsign=false`. `C1`, `C2` commits, `T` a tree. A "log entry" is
`<old> <new> A <a@x> 1700000000 +0000\t<message>`; an empty message ends the line at the zone (no
tab). Both backends unless a row says otherwise (reftable logs read after `git refs migrate
--ref-format=files`, which copies log records verbatim).

| # | Command | Result |
|---|---|---|
| S1 | `update-ref -m m HEAD C2` (HEAD → main = C1) | 0; `main` = C2; `logs/refs/heads/main` and `logs/HEAD` each gain `C1 C2 m` |
| S2 | `update-ref -m m HEAD T`; `--no-deref -m m HEAD T` | both 128 `trying to write non-commit object T to branch 'HEAD'` (C4 re-pinned) |
| S3 | `update-ref -m m refs/heads/s C2` (s → x = C1) | 0; `s` stays `ref: refs/heads/x`; `x` = C2; `logs/refs/heads/x` **and** `logs/refs/heads/s` gain `C1 C2 m` |
| S4 | `update-ref -m m refs/heads/s NEW OLD` through s → x | `OLD` is compared with `x`'s value; mismatch 128 `cannot lock ref 'refs/heads/s': is at <x> but expected <OLD>` (the **given** name, the **target's** value) |
| S5 | `update-ref -m m refs/heads/s2 C2` (s2 → nope, absent) | 0; `refs/heads/nope` created = C2; `logs/refs/heads/nope` and `logs/refs/heads/s2` gain `0{40} C2 m` |
| S6 | `update-ref refs/heads/s3 T` (s3 → nope3) | 128 non-commit **to branch 'refs/heads/s3'** — typed by the given name (C9) |
| S7 | `update-ref refs/heads/s4 C2 0{40}` (s4 → nope4) | 0; `nope4` created — a null old value matches the absent target |
| S8 | `update-ref refs/heads/s C2 0{40}` (s → x, existing) | 128 `cannot lock ref 'refs/heads/s': reference already exists` |
| S9 | `update-ref refs/tags/ts T` (ts → `refs/heads/x`) | **0; `refs/heads/x` now names a tree** — the given name `refs/tags/ts` is not a branch |
| S10 | `update-ref refs/heads/bt T` (bt → `refs/tags/tt`, absent) | 128 non-commit to branch `'refs/heads/bt'` |
| S11 | `update-ref -m m refs/heads/a1 C2` (a1 → a2 → x) | 0; `x` moves; `a1`, `a2`, `x` each gain `C1 C2 m` |
| S12 | same chain, value unchanged (`a1 C2` again) | 0; `a1`, `a2` gain `C2 C2 m`; `x` gains nothing — a symref's log-only entry is unconditional, the target's skips an unchanged value |
| S13 | chains of 5 and 6 symrefs, `update-ref`, `update-ref -d` | 0 — the write path has no depth cap (`rev-parse` refuses the same 6-link chain: `warning: ignoring dangling symref`) |
| S14 | `update-ref refs/heads/p C1` (p → q → p); `-d refs/heads/p`; self-link z → z | 128 / 1 `multiple updates for 'refs/heads/p' (including one via symref 'refs/heads/q') are not allowed`; z: `… for 'refs/heads/z' (including one via symref 'refs/heads/z')` |
| S15 | `update-ref --no-deref -m m refs/heads/p C1` (p → q → p) | 0; `p` becomes a direct ref — `--no-deref` never walks |
| S16 | `update-ref -m m refs/tags/ts C1` (ts → `refs/heads/x`) | `logs/refs/heads/x` gains the entry; no `logs/refs/tags/ts` — each name in the chain passes its own logging gate |
| S17 | `update-ref --no-deref -m nd refs/heads/s C2` (s → x = C1) | 0; `s` = C2 (direct); `x` unchanged; `logs/refs/heads/s` gains **`C1 C2 nd`** — the old value is the referent's |
| S18 | `--no-deref refs/heads/s5 C2 <C2>`; `… <C1>` (s5 → x = C1) | 128 `is at C1 but expected C2`; 0 — compared with the referent's value |
| S19 | `--no-deref refs/heads/s6 C2 0{40}` (s6 → x); `--no-deref refs/heads/s7 C2 0{40}` (s7 → nope7) | 128 `reference already exists`; 128 **`dangling symref already exists`** |
| S20 | `--no-deref -m nd refs/heads/dg C1` (dg → nope) | 0; `dg` direct; `logs/refs/heads/dg` gains `0{40} C1 nd` |
| S21 | `--no-deref -m detach HEAD C1` (HEAD → main = C2) | 0; `HEAD` holds C1; `main` unchanged; `logs/HEAD` gains `C2 C1 detach`; nothing on `main` |
| S22 | HEAD → s → x, `update-ref -m m HEAD C1` | 0; `logs/HEAD`, `logs/refs/heads/s`, `logs/refs/heads/x` each gain `C2 C1 m` |
| S23 | HEAD → s → x (x = C2), `update-ref -m m refs/heads/s C1` | 0; `s`, `x` gain `C2 C1 m`; **files: `logs/HEAD` gains `0{40} C1 m`; reftable: `C2 C1 m`** |
| S24 | HEAD → a2, a1 → a2 → x, `update-ref -m m refs/heads/a1 C2` | files: `logs/HEAD` gains `0{40} C2 m`; reftable: `C1 C2 m`. HEAD → x (the terminal), same update: `C2 C1 m` on **both** |
| S25 | HEAD → s → x, `update-ref -m m refs/heads/x C2` | `x` only; neither `logs/HEAD` nor `logs/refs/heads/s` gains an entry — only the ref `HEAD` names directly couples |
| S26 | HEAD → x, value unchanged (`update-ref -m m refs/heads/x <same>`) | `logs/HEAD` gains `<same> <same> m`; `x` gains nothing (today's coupling rule, re-pinned) |
| S27 | HEAD → s → x (x = C1), `update-ref --no-deref -m m refs/heads/s C2` | 0; `logs/HEAD` gains `C1 C2 m` on **both** backends — an update that is not split logs the resolved old value |
| S28 | `--no-deref refs/heads/p C1 C1` (p → q → p); `--no-deref refs/heads/zz C1 C1` (absent) | 128 `cannot lock ref 'refs/heads/p': error reading reference`; 128 `unable to resolve reference 'refs/heads/zz'` — the referent read fails the update only when an old value is checked (S15 succeeds without one) |

S23/S24 reading. git's files backend splits an update at each symref hop and copies the resolved
old value back up the split chain once the terminal is locked; the `HEAD` log-only update split
from a symref hop is processed before that value exists and logs the null id. The reftable backend
resolves the old value for the `HEAD` entry directly. The rule both backends satisfy: the coupled
`HEAD` entry's old id is the resolved old value, except on the files backend when the ref `HEAD`
names is a symbolic ref the update walks through (the given name or a later hop), where it is
`0{40}`. An update that is not walked (`--no-deref`, S27) and a terminal named by `HEAD` (S24) log
the resolved value on both.

### Pins — deletes (git 2.55.0)

| # | Command | Result |
|---|---|---|
| X1 | `update-ref -d refs/heads/nothere`; `update-ref refs/heads/nx 0{40}` | 0; nothing created, no log file (files and reftable) |
| X2 | `update-ref -d -m why refs/heads/main` (HEAD → main = C2) | 0; `main` and `logs/refs/heads/main` gone; `logs/HEAD` gains `C2 0{40} why` (null id identical) |
| X3 | same without `-m` | `logs/HEAD` gains `C2 0{40} A <a@x> 1700000000 +0000` — no tab, empty message |
| X4 | `update-ref -d -m del refs/heads/s` (s → x = C1) | 0; `x` and `logs/refs/heads/x` gone; `s` kept; `logs/refs/heads/s` gains `C1 0{40} del`. Null id through `t → y` identical |
| X5 | `update-ref -d refs/heads/dd` (dd → nope) | 0; `dd` kept. **files: `logs/refs/heads/dd` gains `0{40} 0{40}` (empty message); reftable: no entry** |
| X6 | `update-ref --no-deref -d refs/heads/u` (u → w = C1) | 0; `u` gone, `w` kept. **files: `logs/refs/heads/u` removed; reftable: the log is kept and gains `C1 0{40}`** (`reflog exists` 0) |
| X7 | `--no-deref -d refs/heads/s2 <C2>`; `… <C1>` (s2 → x2 = C1) | 1 `cannot lock ref 'refs/heads/s2': is at C1 but expected C2`; 0, `s2` gone, `x2` kept |
| X8 | `-d refs/heads/dd2 <C2>`; `… <C1>` (dd2 → x3 = C1) | 1 `is at C1 but expected C2`; 0, `x3` gone, `dd2` kept |
| X9 | `update-ref -d -m m HEAD` (HEAD → main) | 0; `main` gone; `HEAD` kept (`ref: refs/heads/main`); `logs/HEAD` gains `C2 0{40} m` |
| X10 | `update-ref --no-deref -d -m m HEAD` (HEAD → main) | 0; the `HEAD` file **and** `logs/HEAD` removed; `main` and its log kept |
| X11 | HEAD → s → x, `update-ref -d -m m refs/heads/s` | 0; `x` gone; `s` gains `C1 0{40} m`; **files: `logs/HEAD` gains `0{40} 0{40} m`; reftable: `C1 0{40} m`** |
| X12 | HEAD → s → x, `update-ref -d -m m HEAD` | 0; `x` gone; `logs/HEAD` and `logs/refs/heads/s` gain `C1 0{40} m` (both backends) |
| X13 | `update-ref -d refs/heads/lk` with `refs/heads/lk.lock` present; same for an absent `refs/heads/ab` | 1 `cannot lock ref 'refs/heads/lk': Unable to create '<gitdir>/refs/heads/lk.lock': File exists.`; the absent ref refuses the same way |
| X14 | HEAD → dd → nope, `update-ref -d -m m refs/heads/dd` | 0. **files: `logs/HEAD` and `logs/refs/heads/dd` each gain `0{40} 0{40} m`; reftable: neither** |
| X15 | HEAD → main (C1), `update-ref --no-deref -d -m m refs/heads/main` | 0; `logs/HEAD` gains `C1 0{40} m` on both backends |
| X16 | fresh repository (HEAD → unborn main), `update-ref -d -m m refs/heads/main`; the null-id form | 0. **files: `logs/HEAD` is created with `0{40} 0{40} m`, one line per call; reftable: no entry** |
| X17 | reftable, `update-ref --no-deref -d HEAD` | 0; the table's `HEAD` record is gone (`symbolic-ref HEAD` 128 `not a symbolic ref`); `.git/HEAD` still reads `ref: refs/heads/.invalid`. Files (X10): the `HEAD` file itself is removed and the directory stops being a repository |

X5, X14, X16 reading: on the files backend a delete whose target is already absent still
writes every log-only entry it splits (the symrefs walked and the coupled `HEAD`), each `0{40}
0{40}`; the reftable backend writes none of them.

### Pins — commands that delete or rename (git 2.55.0)

| # | Command | Result |
|---|---|---|
| R1 | `branch -d nope`; `branch -D nope` | 1 `error: branch 'nope' not found` |
| R2 | `tag -d nope` | 1 `error: tag 'nope' not found.` |
| R3 | `remote remove nope` | 2 `error: No such remote: 'nope'` |
| R4 | `notes remove HEAD` (no note); `stash drop` (no stash) | 1 `Object HEAD has no note`; 1 `No stash entries found.` |
| R5 | `branch -D s` (s → x) | 0 `Deleted branch s (was refs/heads/x).`; `s` gone, `x` kept — `--no-deref` |
| R6 | `tag -d ts` (ts → `refs/tags/tt`) | 0; `ts` gone, `tt` kept — `--no-deref` |
| R7 | `branch -f s2 C2` (s2 → x2); `tag -f ts3 C2` (ts3 → tt3) | 0; `x2` / `tt3` move, both symrefs kept — dereferenced |
| R8 | `fetch --prune` after upstream deletes `gone` and `main` (clone: `origin/HEAD → origin/main`, tracking refs packed) | 0; packed-only `origin/gone` and `origin/main` deleted; **`origin/HEAD` kept** (`has become dangling`) — git's stale scan skips symrefs |
| R9 | `remote rename origin up2` with packed-only tracking refs and `origin/HEAD → origin/keep` | 0; `refs/remotes/up2/keep` written, the packed `origin/keep` line removed; `up2/HEAD → up2/keep` |
| R10 | `remote remove up2` (packed-only tracking refs + symref) | 0; every tracking ref and the symref gone |
| R11 | `branch -m main renamed` (HEAD → main = C2), files and reftable | 0; `logs/HEAD` gains **two** entries: `C2 0{40} Branch: renamed refs/heads/main to refs/heads/renamed`, then `0{40} C2 Branch: renamed …`; `logs/refs/heads/renamed` = moved history + `C2 C2 Branch: renamed …` |
| R12 | `branch -m main r2` whose own log is absent (HEAD → main = C1) | the same two `logs/HEAD` entries; `logs/refs/heads/r2` = one `C1 C1` rename entry |
| R13 | `branch -m o o2` (HEAD not on `o`); `branch -m main r3` with `core.logAllRefUpdates=false` and no `logs/HEAD` | no `logs/HEAD` entry; `logs/HEAD` stays absent |
| R14 | `notes add -m first HEAD` with `refs/notes/commits → refs/notes/other` (absent) | 0; `refs/notes/other` written, the symref kept — dereferenced |
| R15 | `push origin main` with `refs/remotes/origin/main → refs/remotes/origin/real` | 0; `origin/real` moves, the symref kept — the tracking update dereferences |

### Pins — `packed-refs` on delete (git 2.55.0, files backend)

Base: `pack-refs --all` over `lp`, `main`, `p1`, `p2`, annotated `at1`, `at2`, lightweight `lt`; then a
loose `lp` = C2 over the packed C1.

| # | Command | Result |
|---|---|---|
| Q1 | `-d refs/heads/p1` (packed-only) | 0; the `p1` line removed; `packed-refs` replaced (new inode — lock and rename) |
| Q2 | `-d refs/heads/lp` (loose and packed) | 0; loose file and packed line both gone; `rev-parse --verify refs/heads/lp` 1 |
| Q3 | `-d refs/tags/at1` | 0; its `^<peeled>` line removed with it; `at2`'s kept |
| Q4 | `-d refs/heads/lo` (loose-only) with `packed-refs` present | 0; `packed-refs` untouched (same inode and mtime) |
| Q5 | `packed-refs.lock` present: `-d` packed-only `p2`; `-d` loose-only `lo2`; `-d` absent ref; `update-ref refs/heads/new2 0{40}` (absent) | every delete refuses (1, or 128 on the null-id form) `Unable to create '<gitdir>/packed-refs.lock': File exists.` — even with no `packed-refs` file and nothing to delete; the loose file stays |
| Q6 | same lock, `update-ref -m w refs/heads/new C1` | 0 — a non-delete update never takes `packed-refs.lock` |
| Q7 | null id on packed-only `p2` | 0; line removed (as Q1) |
| Q8 | header-less `packed-refs`, one delete | rewritten with `# pack-refs with: peeled fully-peeled sorted \n` — git writes its canonical header, it does **not** preserve the old one; a `# pack-refs with: peeled \n` header is replaced the same way |
| Q9 | header-less, unsorted `zz`, `mm`, `aa`; `-d mm` | rewritten sorted: `aa`, `zz` |
| Q10 | header-less file with an annotated tag and no `^` line; `peeled`-only header; `fully-peeled` header without `^`; a line naming a missing object | the rewrite copies every surviving line and its existing `^` line verbatim — it never peels and never reads an object |
| Q11 | `-d` of the last packed ref | 0; `packed-refs` kept as the 46-byte header alone |
| Q12 | a line git cannot parse (`not-a-line`) | 128 `fatal: unexpected line in .git/packed-refs: not-a-line`; nothing changed |
| Q13 | `sorted` claimed over unsorted lines, `-d` of a middle ref | 0, but the ref is **not** found (binary search) and nothing changes |
| Q14 | `update-ref -d -m packdel refs/heads/main` (packed-only, HEAD → main) | 0; `logs/HEAD` gains `<old> 0{40} packdel`; `packed-refs` = header only |

### Pins — `NodeFileSystem` against `MemoryFileSystem` (Node 22, macOS, POSIX policy)

Both adapters driven through their built `dist/esm` entries over the same tree: a regular file
`file`, `real/f.txt`, `real/sub/`, links `linkdir → real` (relative), `d/uplink → ../real`,
`dang → nope`, `filelink → file`, `la → lb`, `lb → la`, `dl → dir`. Node's codes come from `mapErrno`
(`src/adapters/node/node-file-system.ts:251-282`).

| # | Call | Node adapter | Memory today | Folded? |
|---|---|---|---|---|
| Y1 | `read`/`readUtf8`/`readSlice`/`stat`/`exists`/`lstat`/`openWithNoFollow(read)` of `linkdir/f.txt`, `d/uplink/f.txt`; `readdir(linkdir)` | follows the component: the target's bytes, size, `true`, a file stat, `f.txt,sub` | `FILE_NOT_FOUND` / `false` / `NOT_A_DIRECTORY` | U1 |
| Y2 | `write`/`writeExclusive`/`writeUtf8`/`appendUtf8`/`writeStream`/`mkdir`/`symlink`/`rename`/`atomicRename`/`rm`/`openWithNoFollow(write)` through `linkdir/…` (parents under the link created in `real/`); a two-hop directory chain | follows every intermediate component, lands in `real/` | `NOT_A_DIRECTORY` (writes) / `FILE_NOT_FOUND` (`rm`, `rename`, `openWithNoFollow`) | U1 |
| Y3 | a leaf that is a link: `write`/`writeUtf8` on `linkdir` or `dang`; `writeExclusive(dang)`; `lstat(linkdir)`; `rmRecursive(link2)` | `PERMISSION_DENIED`; `FILE_EXISTS`; link stat; removes the link only | same | unchanged (leaf no-follow) |
| Y4 | symlink loop, as a component (`la/x`) or a followed leaf (`la`): `read`, `readSlice`, `stat`, `readdir`, `lstat`/`readlink`/`rm`/`rmRecursive`/`symlink`/`mkdir`/`openWithNoFollow` through it, `write` through it | `PERMISSION_DENIED` (`ELOOP`); `exists(la)` **throws** `PERMISSION_DENIED` | `stat`: `UNSUPPORTED_OPERATION { operation: 'stat' }`; `exists`: `true`; others `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` / success | **U2** |
| Y5 | `read`/`readUtf8`/`readSlice` of a directory | `PERMISSION_DENIED` (`EISDIR`) | `FILE_NOT_FOUND` | **U2** |
| Y6 | `readdir` of a missing path; of a dangling link | `FILE_NOT_FOUND` (`ENOENT`) | `NOT_A_DIRECTORY` | **U2** |
| Y7 | `read`/`readUtf8`/`readSlice`/`stat`/`lstat`/`readlink`/`openWithNoFollow(read)`/`rm`/`rename` source/`rmRecursive` of `file/x` (beneath a regular file); the same through `filelink/x` | `NOT_A_DIRECTORY` (`ENOTDIR`); `readdir(file/x)` already agrees | `FILE_NOT_FOUND`; `rmRecursive` resolves | **U2** |
| Y8 | `exists(file/x)`, `exists(filelink/x)` | **throws** `NOT_A_DIRECTORY` | `false` | **U2** |
| Y9 | `exists(dang)` (dangling leaf) | `false` | `true` | G1 (Part 17, unchanged by U2) |
| Y10 | create surfaces whose **immediate parent** is a non-directory: `write(file/x)`, `writeExclusive(file/x)`, `symlink(t, file/l)`, `rename(…, file/x)`, `write(filelink/x)`; `mkdir(file)` | `FILE_EXISTS` (`mkdir -p` sees `EEXIST`); deeper ancestors `NOT_A_DIRECTORY` on both | `NOT_A_DIRECTORY` | **no** — ADR-811 ratified keeping memory's report at depth one |
| Y11 | create surfaces through a **dangling** component: `write(dang/x)`, `writeExclusive(dang/x)` vs `mkdir(dang/x)` | `FILE_NOT_FOUND` vs `NOT_A_DIRECTORY` — the same fault, two codes, decided by `mkdir -p` | `NOT_A_DIRECTORY` | **no** — ADR-811's reasoning (an artefact of `mkdir -p`, no single code to converge on) |
| Y12 | `mkdir(linkdir)` (a link to a directory); `mkdir(dang)` | success (`mkdir -p` follows its leaf); `FILE_NOT_FOUND` | `NOT_A_DIRECTORY` | **no** — the leaf no-follow rule; tabled as open item O2 |
| Y13 | `rm` of an empty and of a non-empty directory | `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'ERR_FS_EISDIR' }` (default arm; not an errno) | removes the empty one; `DIRECTORY_NOT_EMPTY` | **no** — default arm, and the port documents "Remove file or empty directory" |
| Y14 | `readlink(file)` (not a link) | `UNSUPPORTED_OPERATION { reason: 'EINVAL' }` (default arm) | `FILE_NOT_FOUND` | **no** — default arm; the port documents `FILE_NOT_FOUND` |
| Y15 | `openWithNoFollow(dir, 'read')` | opens a handle (no errno) | `FILE_NOT_FOUND` | **no** — operating-system behaviour, not a mapping |
| Y16 | a chain of 32 / 33 links, `stat` | macOS: 32 ok, 33 `ELOOP`; Linux: 40 | 40 (`SYMLINK_FOLLOW_LIMIT`) | **no** — the limit is the platform's; memory keeps Linux's 40 |

"Folded" rule (the user's): the memory adapter takes the Node adapter's code where an explicit
`mapErrno` arm produces it (`ENOENT`, `EEXIST`, `ENOTDIR`, `ENOTEMPTY`, `EACCES`/`EPERM`, `ELOOP`,
`EISDIR`), unless a ratified record decides otherwise (Y10, Y11) or the instruction's own leaf rule
does (Y12). Default-arm pass-throughs (Y13, Y14) and non-errno outcomes (Y15) are listed, not folded.

### What the pins change in the decisions

- **C's typing uses the given name, not the resolved one** (S6, S9, S10, and C4/C9 re-pinned).
  `ref_transaction_update` verifies before the files backend splits the update, so a tree reaches
  `refs/heads/x` through `refs/tags/ts → refs/heads/x` (S9) and `refs/heads/bt → refs/tags/tt` refuses
  (S10). Verification therefore does not depend on dereferencing; the plan still lands U5 before C,
  because C's placement skips every delete form and the delete forms are what U3/U4/U6 reshape.
- **Two backend differences inside git** (S23/S24/X11: the coupled `HEAD` old id; X5/X14/X16: log-only
  entries of a no-op delete; X6: a `--no-deref` delete of a symref keeps its log on reftable). tsgit
  has both backends and transcribes each (below).
- **The `packed-refs` header is not preserved** (Q8): git writes its canonical header on every
  rewrite. The rewrite follows git.
- **Every delete takes `packed-refs.lock`, and the loose ref's lock** (Q5, X13) — even a delete of an
  absent ref (so U3's no-op still refuses under contention). The loose lock is folded into U4 with the
  packed lock: same transaction step, same refusal class.
- **`branch.rename`'s `logs/HEAD` bytes are two entries** (R11, R12), not none. U6's "non-logging
  delete keeps git's bytes" premise does not hold; stopped as open item O1.
- **`fetch --prune` never deletes a symref** (R8); with U5, tsgit's prune would otherwise delete
  `origin/HEAD`'s target through it. Folded into U5's caller audit.
- **`remote rename` moves packed-only tracking refs** (R9); tsgit's refusal
  (`assertRenamableTrackingRef`) existed only because no packed rewrite existed. Tabled as open item O3.

### Change — U5: `updateRef` dereferences as git's ref transaction splits

**Options type** (`src/application/primitives/types.ts:103-118`, public through the facade's
`BindCtx<typeof primitives.updateRef>`, `src/repository.ts:423`, `:999-1002`):

```ts
export type UpdateRefOptions =
  | {
      readonly delete?: false;
      readonly expected?: ObjectId | 'absent';
      readonly reflogMessage: string;
      /** git's `--no-deref`: act on `name` itself even when it is a symbolic ref. */
      readonly noDeref?: boolean;
    }
  | {
      readonly delete: true;
      readonly expected?: ObjectId | 'absent';
      /** The message of the `logs/HEAD` and symbolic-ref entries a delete writes; empty when omitted. */
      readonly reflogMessage?: string;
      readonly noDeref?: boolean;
    };
```

**The chain** — new `src/application/primitives/internal/ref-write-chain.ts`:

```ts
/** The refs one update touches, as git's transaction splits them (S3, S11, S17). */
export interface RefWriteChain {
  /** Symbolic refs walked from the given name, in order; empty for a direct name or under noDeref. */
  readonly links: readonly RefName[];
  /** The ref whose value changes: the walk's end, or the given name under noDeref. */
  readonly terminal: RefName;
  /** The value the compare-and-swap reads and every entry's old id carries. */
  readonly old: ObjectId | 'absent';
  /** noDeref on a symbolic ref whose referent is absent: the name exists, its value does not (S19). */
  readonly danglingSymref: boolean;
}

export const resolveWriteChain = (store: RefStore, name: RefName, options: UpdateRefOptions): Promise<RefWriteChain> =>
  options.noDeref === true ? resolveWithoutDeref(store, name, options.expected) : walkSymbolicChain(store, name);

/** git's split loop: follow every symbolic hop; a name met twice is git's "multiple updates" refusal (S14). */
async function walkSymbolicChain(store: RefStore, name: RefName): Promise<RefWriteChain> {
  const links: RefName[] = [];
  const seen = new Set<RefName>();
  for (let current = name; ; ) {
    if (seen.has(current)) throw refCycleDetected([...links, current]);
    seen.add(current);
    const value = await store.resolveDirect(current);
    if (value.kind !== 'symbolic') return { links, terminal: current, old: valueOf(value), danglingSymref: false };
    links.push(current);
    current = validateRefName(value.target);
  }
}

/** noDeref: the name is the terminal; a symbolic name's old value is its referent's, read as
 *  refs_resolve_ref_unsafe does — a failed read (cycle, depth) counts only when an old value is checked (S28). */
async function resolveWithoutDeref(store: RefStore, name: RefName, expected: ObjectId | 'absent' | undefined): Promise<RefWriteChain> {
  const value = await store.resolveDirect(name);
  if (value.kind !== 'symbolic') return { links: [], terminal: name, old: valueOf(value), danglingSymref: false };
  const old = await readReferentValue(store, value.target, expected);   // existing read chain, MAX_SYMBOLIC_REF_DEPTH
  return { links: [], terminal: name, old, danglingSymref: old === 'absent' };
}
```

`readReferentValue` reuses `resolve-ref.ts`'s chain walk (`resolveDirectChain`, `:64-104`, exported for
it or re-shaped into a store-level helper) and maps `REF_CYCLE_DETECTED` / `REF_CHAIN_TOO_DEEP` to
`'absent'` when `expected` is `undefined` and rethrows otherwise. The walk has **no depth cap**: git's
split loop has none (S13); the bound is repetition (S14) — see the threat model.

**The compare-and-swap** (today's `update-ref.ts:35-40`, extracted):

```ts
const assertExpected = (name: RefName, expected: ObjectId | 'absent' | undefined, chain: RefWriteChain): void => {
  if (expected === undefined) return;
  if (expected === 'absent' && chain.danglingSymref) throw refUpdateConflict(name, 'absent', 'absent');
  if (expected !== chain.old) throw refUpdateConflict(name, expected, chain.old);
};
```

`REF_UPDATE_CONFLICT { name, expected, actual }` keeps its shape (the data field is `name`). It names
the **given** ref with the **terminal's** value (S4). `expected === actual === 'absent'` occurs only for
S19's dangling symref, so a caller composes git's `dangling symref already exists` from the pair, and
`reference already exists` from `expected: 'absent'` with an id; no new field or code.

**The updates** — a write:

| Update | When | Reflog |
|---|---|---|
| `set terminal` | always | `old → new`, skipped when equal (today's rule, S12) |
| `reflogOnly link` | each walked symref (S3, S5, S11) | `old → new`, even when equal (S12), through `recordRefUpdate`'s per-name gate (S16) |
| `reflogOnly HEAD` | `HEAD` is symbolic, names the terminal or a link, and `HEAD` is not itself `links[0]` (S1/S22 log it as a link; S25) | `coupledOld → new`, even when equal (S26) |

A delete (`delete: true` or the null id, G2):

| Update | When | Reflog |
|---|---|---|
| `delete terminal` | always — the store's delete is now a no-op for an absent ref (U3) and rewrites `packed-refs` (U4) | the terminal's own log is removed (files) / tombstoned (reftable), except X6 |
| `reflogOnly link` | each walked symref (X4) | `old → 0{40}`; for an absent terminal only where the backend logs no-op deletes (X5) |
| `reflogOnly HEAD` | the coupling rule above (X2, X9, X11, X14, X15) | `coupledOld → 0{40}`; for an absent terminal only where the backend logs no-op deletes (X14, X16) |
| `reflogOnly terminal` | reftable only, `noDeref` delete of a symbolic ref (X6) | `old → 0{40}` appended to the kept log |

`message` is `options.reflogMessage ?? ''`. `coupledOld` is `0{40}` on the files backend when `HEAD`
names a link (S23, S24, X11), else `old` (`0{40}` for an absent terminal).

**Backend differences as data** — new `src/application/primitives/internal/ref-transaction-logging.ts`:

```ts
/** Where git's files and reftable backends log the same transaction differently (S23, S24, X5, X6, X11, X14, X16). */
export interface TransactionLogging {
  /** Old id of a `logs/HEAD` entry coupled through a walked symbolic ref. */
  readonly headOldThroughLink: 'null-id' | 'resolved';
  /** Whether a delete of an absent target still writes its split log-only entries. */
  readonly noOpDeleteLogs: 'written' | 'skipped';
  /** Whether a `noDeref` delete of a symbolic ref keeps its log and records the deletion in it. */
  readonly symbolicDeleteLog: 'removed' | 'kept-with-entry';
}
const FILES: TransactionLogging = { headOldThroughLink: 'null-id', noOpDeleteLogs: 'written', symbolicDeleteLog: 'removed' };
const REFTABLE: TransactionLogging = { headOldThroughLink: 'resolved', noOpDeleteLogs: 'skipped', symbolicDeleteLog: 'kept-with-entry' };

export const transactionLogging = (ctx: Context): TransactionLogging =>
  ctx.layout.refStorage === 'reftable' ? REFTABLE : FILES;
```

`ctx.layout.refStorage` is the same discriminant `createRefStore` dispatches on
(`src/application/primitives/ref-store.ts:332-336`). The reftable store's `applyDeleteRecords`
(`src/application/primitives/reftable-transaction.ts:490-501`) keeps a **symbolic** record's logs
(it tombstones only a direct record's), which X6's `kept-with-entry` needs; a walked delete never
reaches a symbolic record.

**`updateRef`** (`src/application/primitives/update-ref.ts:17-49`) becomes, with Part 19's
verification line shown for placement:

```ts
export async function updateRef(ctx: Context, name: RefName, newId: ObjectId, options: UpdateRefOptions): Promise<void> {
  validateRefName(name);
  // Part 19: if (!isDelete(ctx, newId, options)) await assertRefTargetValid(ctx, name, newId);
  const store = getRefStore(ctx);
  const chain = await resolveWriteChain(store, name, options);
  const head = await resolveHeadForCoupling(store);
  assertExpected(name, options.expected, chain);
  const logging = transactionLogging(ctx);
  const updates = isDelete(ctx, newId, options)
    ? deleteUpdates(ctx, chain, head, options, logging)
    : writeUpdates(ctx, chain, head, newId, options, logging);
  await store.applyRefUpdates(updates);
}
```

`isDelete` is `options.delete === true || newId === zeroOid(ctx.hashConfig)`; `writeUpdates` and
`deleteUpdates` build the tables above, each under 20 lines, sharing a `coupledHeadEntry` helper that
replaces `coupledHeadTarget` (`:79-81`). The single `applyRefUpdates` call keeps today's "nothing
written before a refusal" property: every read (chain, `HEAD`, CAS) precedes it.

### Change — U3: a delete of an absent ref is a no-op

Both stores stop refusing: the files backend's `applyDelete` (`ref-store.ts:836-858`) no longer throws
`refNotFound` (`:857`), and the reftable backend's `applyDeleteRecords` (`reftable-transaction.ts:490-501`)
returns without a record instead of throwing at `:497`. Only two callers put a `delete` through
`applyRefUpdates`: `updateRef` and `stash-ref.ts:102` (which deletes `refs/stash` it has just read), so
the store-level change is the U3 change. A no-op delete on the files backend still takes both locks
(Q5, X13) and still writes the split log-only entries (X5, X14, X16); on reftable it writes nothing.

`updateRef`'s commands keep git's own refusals **before** the delete (R1–R4, verified in the
caller audit): `branch.delete` (`branch.ts:147-163`, `refExists` → `branchNotFound`), `tag.delete`
(`tag.ts:214-224`, `refExists` → `tagNotFound`), `remote.remove` (`remote.ts:168-176`, `remoteNotConfigured`),
`notes.remove` (`notesObjectHasNone`, no delete) and `stash.drop` (its own empty-stash refusal, not
`updateRef`).

### Change — U6: every delete path logs the ref `HEAD` points at

The `delete: true` arm and the null id share `deleteUpdates` (U5), so the coupled `HEAD` entry is
written on both (X2, X3, X9, X15) with `options.reflogMessage ?? ''`. G2's null-id-only entry (ADR-864's
note, Part 18 commit 1 as first planned) becomes the general rule; no path writes it separately.

`branch.rename` (`branch.ts:165-234`) deletes the old name while `HEAD` still points at it (`:228`), then
re-points `HEAD` (`:229-232`). git writes two `logs/HEAD` entries there (R11, R12), not none, so U6's
"non-logging delete" does not keep git's bytes — tabled as **O1**; the plan carries both outcomes.

### Change — U4: a packed ref's delete rewrites `packed-refs` under git's locks

**Files backend `applyDelete`** (`ref-store.ts:836-858`):

```ts
/** git's files-backend delete: lock the loose ref (when its directory exists), lock packed-refs, drop
 *  the name from packed-refs (rewritten only when it held it), then remove the loose file and its log. */
async function applyDelete(update: Extract<RefUpdate, { kind: 'delete' }>): Promise<void> {
  await checkExpected(update.name, update.expected);
  const loose = looseRefPath(refDir(update.name), update.name);
  await withLooseRefLock(ctx, update.name, loose, () =>
    withLockFile(ctx, packedRefsPath(commonGitDir(ctx)), packedRefsLocked, (commit) =>
      removeEverywhere(update.name, loose, commit),
    ),
  );
}

async function removeEverywhere(name: RefName, loose: string, commitPacked: (content: string) => Promise<void>): Promise<void> {
  const packed = await readPackedRefsContent();             // undefined when the file is absent
  if (packed !== undefined && packedRefsHold(packed, name)) {
    await commitPacked(packedRefsWithout(packed, name));   // write <packed-refs>.lock, rename over packed-refs
    packedCache = undefined;
  }
  await rmIfPresent(loose);
  await removeReflogFile(name);
  if (name === HEAD_NAME) invalidateHeadSlot(ctx);
}
```

- **Lock helper** — `src/application/primitives/atomic-write.ts` gains `withLockFile(ctx, path, onLocked,
  body)`: `writeExclusive(<path>.lock, empty)` (a `FILE_EXISTS` becomes `onLocked(lockPath)`), runs
  `body(commit)` where `commit(content)` writes the lock and renames it onto `path`, and removes the lock
  in `finally` when `body` did not commit (a `FILE_NOT_FOUND` on that removal is swallowed, as
  `atomicWriteFile` does at `:37-45`). `atomicWriteFile` (`:20-47`) keeps its shape.
- **Loose lock** — `withLooseRefLock` takes `<loose>.lock` with `refLocked(name)` (X13) **only when the
  loose path's parent directory exists**: a lock file cannot exist without it, so contention is
  unobservable there, and taking it would create directories git leaves absent (probe: `update-ref -d
  refs/heads/deep/er/absent` leaves no `refs/heads/deep/`).
- **Packed lock refusal** — `RESOURCE_LOCKED { resource: 'ref', path: '<commonGitDir>/packed-refs.lock' }`,
  an existing code and resource (`src/domain/error.ts:37-42`); git's `Unable to create '<path>': File
  exists.` composes from `path`. Lock order is git's: the loose lock's `REF_LOCKED` wins when both are
  held.
- **Rewrite** — a new pure domain function in `src/domain/refs/packed-refs.ts` (not barrelled),
  `packedRefsWithout(content: string, name: RefName): string`: parse with `parsePackedRefs`, drop the entry
  (its `peeled` value goes with it, Q3), serialize sorted (Q9) with git's canonical header `# pack-refs
  with: peeled fully-peeled sorted ` whatever the old header was (Q8), copying each surviving entry's
  `peeled` verbatim and never peeling (Q10), and emitting the header line alone for zero entries (Q11) —
  `serializePackedRefs` returns `''` there (`:92-95`) and stays unchanged. A malformed file refuses
  `INVALID_PACKED_REFS` from the parse before anything is written (Q12).
- **Order** — git's: packed rewrite first, then the loose file, then the log. A crash between the two
  leaves the loose file holding the ref's current value, never an older packed value resurrected (the
  resurrection today's loose-only delete produces for a loose-and-packed ref, Q2).
- **`fetch --prune`** — `isPackedRefDeleteError` (`fetch.ts:406-411`) and its `try`/`catch` and warn
  (`:391-400`) are deleted; the packed-only tracking ref is deleted (R8).
- **Reftable** — nothing: the reftable backend has no `packed-refs`, and its delete already writes a
  tombstone (`applyDeleteRecords`). U3's no-op and X6's kept log are its only changes.
- **`packRefs`** (`ref-store.ts:917-952`) writes `packed-refs` with a bare `writeUtf8` (`:940`), no lock.
  Not changed here; recorded as a residual.

### Change — U1 and U2: the memory adapter walks every component, and refuses as the Node adapter maps

Supersedes the planned leaf-only `followLinks` (Part 17 commit 1 as first planned). One private walk
in `src/adapters/memory/memory-file-system.ts` replaces `statFollowing` (`:164-179`):

```ts
/** POSIX path resolution over the in-memory tree (Y1, Y2, Y4, Y7): every symlinked component is followed
 *  — a relative link text against the link's own directory — and the leaf too under 'follow'.
 *  40 hops per call; a loop refuses PERMISSION_DENIED, the Node adapter's ELOOP mapping. */
private walk(path: string, leaf: 'follow' | 'no-follow'): string {
  let pending = this.segmentsOf(this.resolve(path));      // lexical collapse first, as resolveRead does
  let current = this.rootDir;
  for (let hops = 0; pending.length > 0; ) {
    const next = `${current}/${pending[0]}`;
    const target = this.symlinks.get(next);
    if (target === undefined || (pending.length === 1 && leaf === 'no-follow')) {
      if (pending.length > 1) this.assertTraversable(next, path);      // a file → NOT_A_DIRECTORY (Y7)
      current = next;
      pending = pending.slice(1);
      continue;
    }
    hops += 1;
    if (hops > MemoryFileSystem.SYMLINK_FOLLOW_LIMIT) throw permissionDenied(path);
    pending = [...this.segmentsOf(this.resolve(this.linkBase(current, target))), ...pending.slice(1)];
    current = this.rootDir;
  }
  return current;
}
```

`this.resolve` keeps structural containment: a followed target outside the root refuses
`PERMISSION_DENIED` (the contract's `symlinkReadEscape: 'refused'` posture,
`test/unit/adapters/memory/memory-file-system.test.ts:14-21`). `assertTraversable` refuses
`notADirectory(path)` when an intermediate component is a regular file. A missing intermediate is left to
the surface: reads land on an absent key (`FILE_NOT_FOUND`), writes create it as today. The hop limit is
Linux's 40 (Y16), kept so the existing 40-hop rows stay meaningful.

**Per surface** (every row pinned against the Node adapter in the contract suite):

| Surface | Walk | Refusals after the walk (U2 changes in bold) |
|---|---|---|
| `read`, `readUtf8`, `readSlice` | `follow` | absent → `FILE_NOT_FOUND`; **a directory → `PERMISSION_DENIED` (Y5)** |
| `stat` | `follow` | absent → `FILE_NOT_FOUND`; **loop → `PERMISSION_DENIED` (was `UNSUPPORTED_OPERATION { operation: 'stat' }`)** |
| `exists` | `follow` | absent or dangling → `false`; **beneath a file → throws `NOT_A_DIRECTORY` (Y8); loop → throws `PERMISSION_DENIED` (Y4)** |
| `readdir` | `follow` | **absent or dangling → `FILE_NOT_FOUND` (Y6)**; a file → `NOT_A_DIRECTORY` |
| `lstat`, `readlink`, `openWithNoFollow` | `no-follow` | as today on the leaf (`openWithNoFollow` refuses a link leaf `PERMISSION_DENIED`); **beneath a file → `NOT_A_DIRECTORY`** |
| `rm`, `rename`, `atomicRename`, `rmRecursive`, `chmod` | `no-follow` (both `rename` paths) | as today on the leaf; **a source beneath a file → `NOT_A_DIRECTORY`; `rmRecursive` beneath a file stops resolving silently and refuses `NOT_A_DIRECTORY`** |
| `write`, `writeStream`, `writeUtf8`, `appendUtf8`, `writeExclusive`, `symlink` | `no-follow` | leaf refusals unchanged (ADR-815, ADR-818); parent creation on the walked path, so nothing is ever filed beneath a symlink key; a non-directory at the immediate parent keeps `NOT_A_DIRECTORY` (Y10, ADR-811) and so does a dangling component (Y11) |
| `mkdir` | `no-follow` for the leaf pending O2; intermediates walked | a link at the leaf keeps `NOT_A_DIRECTORY` (Y12, O2) |

Consumers that name the memory adapter's old `readdir` code in comments keep working (they accept both
codes) but their words go stale: `src/application/commands/internal/gc-pipeline.ts:157-170`
(`isFanoutDirAbsent`), `src/application/primitives/pack-registry.ts:586-590` (`isMissingPackDir`), and the
`NOT_A_DIRECTORY` notes at `src/application/primitives/internal/shallow-set.ts:36`,
`src/application/primitives/internal/loose-oid-cache.ts:39`,
`src/application/primitives/internal/midx-source.ts:97`. The port's `readdir` comment
(`src/ports/file-system.ts:120`, "Throws NOT_A_DIRECTORY if not a directory") gains the missing-path
`FILE_NOT_FOUND`; that JSDoc is in `reports/api.json`.

The key-set invariant ADR-818 records (files, directories and symlinks pairwise disjoint; nothing filed
beneath a symlink key) holds: a write through `linkdir/…` files its key at the walked `real/…` path.

### Caller audit — `updateRef` (U5)

serena `find_referencing_symbols` on `updateRef` (`src/application/primitives/update-ref.ts`), cross-checked
with `rg '\bupdateRef\('`: 27 internal call sites in 14 command files plus the facade. Classes:

- **A — direct at call time**: the name cannot be a symbolic ref when called; unaffected.
- **B — may name a symref; git dereferences**: today tsgit overwrites the symref with an id; U5 writes its
  target instead (fixed).
- **C — passes `HEAD`'s symbolic target where git writes through `HEAD`**: switch to `HEAD`. For a direct
  target the entries are byte-identical either way; through `HEAD → symref → branch` only `HEAD` gives
  git's coupled old id on the files backend (S22 against S23), and a compare-and-swap refusal then names
  `HEAD`, as git's `cannot lock ref 'HEAD'` does.
- **D — a delete git performs with `--no-deref`**: must pass `noDeref: true`.
- **E — git never deletes a symref here**: skip symbolic candidates.

| # | Call site | Name passed | git | Class | Change |
|---|---|---|---|---|---|
| 1 | `abort-merge.ts:56` | `head.target` | `merge --abort` → `reset --merge` updates `HEAD` | C | `HEAD` |
| 2 | `internal/abort-sequencer-reset.ts:32` | `options.branch` (from `cherry-pick.ts:631`, `revert.ts:572`) | sequencer rollback resets `HEAD` | C | `HEAD` |
| 3 | `branch.ts:132` | `refs/heads/<name>` (create / force) | `branch -f` through a symref moves the target (R7) | B | none |
| 4 | `branch.ts:161` | `refs/heads/<name>`, `delete: true` | `branch -D` deletes the symref itself (R5) | D | `noDeref: true` |
| 5 | `branch.ts:228` | `from`, `delete: true` | rename deletes the old name with `REF_NO_DEREF` | D | `noDeref: true`; logging per O1 |
| 6 | `cherry-pick.ts:347` | `branch` (= `head.target`, `:433-446`) | sequencer commits through `HEAD` | C | `HEAD` |
| 7 | `cherry-pick.ts:483` | `branch` | same | C | `HEAD` |
| 8 | `commit.ts:236` | `branch` (= `head.target`, `:171`) | `commit` updates `HEAD` | C | `HEAD` |
| 9 | `fetch.ts:322` | `refs/remotes/<r>/<b>` | fetch's ref update dereferences (flags 0) | B | none |
| 10 | `fetch.ts:392` | each `listRefs('refs/remotes/<r>/')` entry, `delete: true` | stale scan skips symrefs (R8) | E | skip `entry.value.kind === 'symbolic'`; remove the packed-only catch (U4) |
| 11 | `merge.ts:182` | `head.target` | fast-forward updates `HEAD` | C | `HEAD` |
| 12 | `merge.ts:298` | `branchName` (= `head.target`, `:193`) | merge commit updates `HEAD` | C | `HEAD` |
| 13 | `notes.ts:120` | the notes ref | dereferences (R14) | B | none |
| 14 | `notes.ts:203` | the notes ref | same | B | none |
| 15 | `push.ts:545` | `refs/remotes/<r>/<b>` | tracking update dereferences (R15) | B | none |
| 16 | `rebase.ts:304` | `HEAD` | detached for the whole rebase | A | none |
| 17 | `rebase.ts:383` | `branch` (the rebase's head-name) | finish updates the head-name, flags 0 | B | none |
| 18 | `rebase.ts:554` | `HEAD` | detached | A | none |
| 19 | `rebase.ts:775` | `HEAD` | detached | A | none |
| 20 | `remote.ts:181` | each tracking ref (symrefs included, `listTrackingRefs:162-166`), `delete: true` | `remote remove` deletes each with `REF_NO_DEREF` (R10) | D | `noDeref: true` |
| 21 | `remote.ts:221` | the new tracking name, `expected: 'absent'` | fresh name | A | none |
| 22 | `remote.ts:222` | the old tracking name, `delete: true` | guarded direct at `:215-216` | A | none |
| 23 | `reset.ts:87` | `branch ?? 'HEAD'` | `reset` updates `HEAD` | C | `HEAD` |
| 24 | `revert.ts:183` | `branch` | sequencer commits through `HEAD` | C | `HEAD` |
| 25 | `revert.ts:460` | `branch` | same | C | `HEAD` |
| 26 | `tag.ts:200` | `refs/tags/<name>` | `tag -f` through a symref moves the target (R7) | B | none |
| 27 | `tag.ts:221` | `refs/tags/<name>`, `delete: true` | `tag -d` deletes the symref itself (R6) | D | `noDeref: true` |
| F | `src/repository.ts:999-1002` | caller's | `update-ref` | — | public type gains `noDeref` and the delete arm's `reflogMessage` |

Counts: **A 5, B 7, C 10, D 4, E 1** (27). Behaviour changes a caller can see: class B writes a
symref's target instead of replacing the symref (3, 9, 13, 14, 15, 17, 26); class C changes only
through `HEAD → symref → branch` chains, plus `REF_UPDATE_CONFLICT.name` = `HEAD` on a raced commit,
merge, reset, cherry-pick or revert; class D keeps today's symref-itself delete (without `noDeref` it
would start deleting targets); class E stops pruning `refs/remotes/<r>/HEAD` (tsgit prunes it today, git
never does).

Test call sites (serena counts, all class A — a fixture writing a direct name): `update-ref.test.ts` 25,
`merge.test.ts` 7, `commondir-per-worktree-refs.test.ts` 4, `branch.test.ts` 3, `commit-ish.test.ts` 3,
`loose-ref-interop.test.ts` 2, `reftable-ref-storage-interop.test.ts` 2, and one each in `laws.test.ts`,
`name-rev.test.ts`, `pull.test.ts`, `rebase.test.ts`, `test/bench/fixtures.ts`,
`test/bench/name-rev.bench.ts`, `test/parity/scenarios/reftable-refs.scenario.ts`. `merge.test.ts:1720-1800`
patches `readUtf8` to fail the *second* read of `refs/heads/main`; a class-C switch reads `HEAD` first
and the patch's count needs re-deriving.

### Caller audit — callers that relied on `REF_NOT_FOUND` from a delete (U3)

`rg 'REF_NOT_FOUND|refNotFound' src/application` — none of the thirteen hits reads the delete path's
refusal; they classify `resolveRef` reads. Every `delete: true` caller either checks first or iterates
names it has just listed:

| Caller | Before the delete | git's refusal (pin) | After U3 |
|---|---|---|---|
| `branch.delete` (`branch.ts:147-163`) | `refExists` → `branchNotFound` (`:158-160`) | R1 | unchanged; a ref removed between the check and the delete now succeeds (git's `delete_refs` does too) |
| `branch.rename` (`branch.ts:165-234`) | `resolveRef(from)` (`:172`) | — | unchanged |
| `tag.delete` (`tag.ts:214-224`) | `refExists` → `tagNotFound` (`:217-219`) | R2 | unchanged |
| `remote.remove` (`remote.ts:168-200`) | `remoteNotConfigured` (`:175`); deletes listed names | R3 | unchanged |
| `remote.rename` → `moveTrackingRef` (`remote.ts:209-223`) | `resolveDirect` guard (`:215-216`) | — | unchanged |
| `fetch --prune` (`fetch.ts:373-403`) | iterates `listRefs` | — | unchanged |
| `stash` drop (`stash-ref.ts:102`, store-level) | reads the stash first | R4 (its own `No stash entries found.`) | unchanged |
| `notes.remove` (`notes.ts`, `:190`) | `notesObjectHasNone` — writes, never deletes | R4 | unaffected |

Count: **0** callers change behaviour; the tests that pin the old refusal flip:
`test/unit/application/primitives/update-ref.test.ts:302-318`, `test/unit/application/primitives/ref-store.test.ts:500-521`,
`test/unit/application/primitives/reftable-transaction.test.ts:438-466`.

### Cost

- **Writes (U5).** One `resolveDirect` per chain hop instead of one in total: a direct name costs what it
  does today (the walk ends at the first read); a symref costs one read per hop plus one `recordRefUpdate`
  per link. Class C's switch to `HEAD` adds one `resolveDirect('HEAD')` per commit/merge/reset — served by
  the HEAD slot (`readHeadFile`, ADR-855) inside a gated command, so no extra syscall there; the coupling
  read `resolveHeadForCoupling` is already paid today.
- **Deletes (U4, U3).** Every files-backend delete now performs: `stat` of the loose parent directory,
  `writeExclusive` + `rm` of `<ref>.lock` (when that directory exists), `writeExclusive` + `rm` of
  `packed-refs.lock`, one `packed-refs` read (served by the store's mtime-keyed `packedCache` when warm),
  and — only when the name is packed — one parse, one serialize and one `writeUtf8` + `rename` of the
  whole file: O(P) in the packed ref count, git's cost too. A loose-only delete adds four small syscalls
  and no rewrite (Q4). `fetch --prune` of N stale packed refs rewrites `packed-refs` N times where git's
  single transaction rewrites it once — see residuals.
- **Memory adapter (U1, U2).** Every call walks its path's segments once (O(depth) map probes), where
  `read` did one probe; the adapter is a test and browser-less in-memory store, not a hot path.
- **Runtime size.** U5 chain + logging table ≈ +700 B, U4 lock helper + rewrite ≈ +450 B, U3/U6
  ≈ +100 B, memory walk and codes ≈ +500 B (in the tarball and `Facade (memory shim)`, not the no-build
  bundle). The tarball's ≈ 937 B headroom is crossed by the memory-adapter commit or U5 at the latest.

### Threat model

- **Symref chains and cycles (U5).** A planted chain of distinct symrefs is followed to its end, as git's
  split loop does (S13); a repeated name refuses `REF_CYCLE_DETECTED { chain }` (S14) before anything is
  written. The walk keeps a `Set` of visited names (O(1) membership — the read path's `chain.includes`,
  `resolve-ref.ts:85`, is O(n²) and must not be copied), so a chain of N refs costs N reads and N log
  appends: linear in content the attacker already had to write as N ref files. Each hop's target passes
  `validateRefName` before it builds a path, so a link text cannot escape `refs/`. No numeric cap: a cap
  would refuse chains git follows (a divergence on a refusal condition).
- **`--no-deref` referent read** reuses the read chain's `MAX_SYMBOLIC_REF_DEPTH` and cycle detection;
  its failure is swallowed only when no old value is checked (S15, S28).
- **Lock files (U4).** Both locks are created with `writeExclusive` (`O_EXCL`), so a planted
  `packed-refs.lock` or `<ref>.lock` refuses instead of being truncated or followed (the Node adapter's
  exclusive create refuses a symlink leaf with `FILE_EXISTS`; the exclusive-create refusals are proven in the port contract suite, ADR-812). A lock this process created is
  removed on every exit path (`finally`), and a failed `rename` leaves the old `packed-refs` intact. A
  stale lock from a crash refuses every later delete until removed — git's behaviour and message.
- **Rewrite input.** `packed-refs` is parsed by the existing strict `parsePackedRefs`; a malformed file
  refuses before a lock is committed (Q12), and the rewrite only removes lines, so a hostile file cannot
  grow through it. Peeled values are copied, never computed: no object read is triggered (Q10).
- **Memory adapter walk (U1).** The 40-hop bound is per call; a followed target is re-validated by
  `resolve`'s structural containment on every hop, so a link cannot address a key outside the root.
  Writes still never follow a leaf link.

### Residuals

- **Empty parent directories after a delete.** git removes `refs/heads/nest/` and `logs/refs/heads/nest/`
  once their last entry is deleted; tsgit leaves them (pre-existing). The port has no directory removal
  that works on Node (`rm` refuses any directory, Y13).
- **`fetch --prune` and `remote.remove` delete one ref per transaction**, so a batch rewrites
  `packed-refs` once per packed name and is not atomic across names; git deletes them in one transaction.
- **`packRefs` writes `packed-refs` without `packed-refs.lock`** (`ref-store.ts:940`).
- **A `sorted` trait over unsorted lines** (Q13): git's binary search misses the ref and changes nothing;
  tsgit's name-indexed lookup finds and deletes it.
- **`remote.rename` leaves `refs/remotes/<old>/HEAD`** in place (`moveTrackingRef` returns for a
  non-direct source, `remote.ts:215-216`); git re-points it to the new remote (R9). Not changed here.
- **Memory adapter**: Y10–Y16 as listed; a `..` inside a link text after a symlinked component is collapsed
  lexically (the adapter joins before it walks), where POSIX resolves it physically.

### Open items raised by the U1–U6 pins

| # | Item | Reason | Options |
|---|---|---|---|
| O1 | `branch.rename`'s `logs/HEAD` entries (U6) | The decision gives rename a non-logging delete "so its reflog bytes stay git's". git writes **two** `logs/HEAD` entries when renaming the branch `HEAD` points at, on both backends (R11, R12); tsgit writes none today, so a non-logging delete keeps a divergence rather than git's bytes. | (a) Rename logs both: its `noDeref` delete carries `reflogMessage: branchRenamed(from, to)` (U6's coupled entry, `<old> 0{40}`), and the `HEAD` re-point becomes a `setSymbolic` update carrying `reflog: { oldId: 0{40}, newId: <id>, message }` — git's bytes, recommended. (b) Non-logging delete as decided (a store-level `delete` bypassing `updateRef`), today's zero entries recorded as a residual. (c) The logging delete only (first entry), the second recorded. |
| O2 | `MemoryFileSystem.mkdir` on a symlink leaf (U1/U2) | The Node adapter's `mkdir -p` follows its leaf: a link to a directory is a no-op success, a dangling link `FILE_NOT_FOUND`, a loop `PERMISSION_DENIED` (Y12). The decision keeps write surfaces' leaf no-follow semantics, and memory refuses `NOT_A_DIRECTORY`. | (a) Follow the leaf on `mkdir` only, as Node does. (b) Keep `NOT_A_DIRECTORY`, record Y12 (the plan's default until decided). (c) Refuse `PERMISSION_DENIED`, as the other write leaves do. |
| O3 | `remote.rename` refuses a packed-only tracking ref (`assertRenamableTrackingRef`, `ref-store.ts:288-307`, `rename-packed-tracking-ref`) | Its only stated reason is "would require a packed-refs rewrite the files backend doesn't perform", which U4 removes; git renames packed-only tracking refs (R9). Not among U1–U6. | (a) Remove the refusal in U4's commit (`moveTrackingRef` then writes the new loose ref and deletes the packed one). (b) Keep it, recorded as a residual. (c) A separate follow-up. |
| O4 | Depth-one non-directory parent and dangling component on memory create surfaces (U2) | Explicit `mapErrno` arms give `FILE_EXISTS` / `FILE_NOT_FOUND` on Node (Y10, Y11), but ADR-811 ratified keeping the memory adapter's `NOT_A_DIRECTORY` because `mkdir -p` makes Node inconsistent. | (a) Keep ADR-811 (not folded; the design's default). (b) Reopen ADR-811 and mirror Node, depth-one `FILE_EXISTS` included. |

### Docs consequences

- `docs/use/primitives/update-ref.md` — its signature block documents `{ oldId?, message? }`, which no
  release has had; replace it with `UpdateRefOptions` (both arms, `noDeref`, the delete arm's
  `reflogMessage`) and add: dereferencing and the reflog entries per link, `noDeref`, the null id and
  `delete: true` as deletes, absent-ref no-op, the coupled `HEAD` entry on deletes, packed-refs rewrite
  and its two lock refusals, the backend differences (S23, X5, X6).
- `docs/use/errors.md` — `REF_UPDATE_CONFLICT` (given name, terminal's value; the `absent`/`absent`
  dangling-symref pair), `REF_CYCLE_DETECTED` (new `updateRef` thrower), `RESOURCE_LOCKED`
  (`resource: 'ref'`, `packed-refs.lock`), `REF_LOCKED` (deletes), `REF_NOT_FOUND` (no longer from a
  delete), `UNSUPPORTED_OPERATION` (`delete-packed-ref` removed).
- `docs/use/commands/fetch.md` (prune deletes packed-only refs, keeps symrefs), `branch.md`, `tag.md`,
  `remote.md` (symrefs deleted as themselves), `commit.md`/`merge.md`/`reset.md` only if they state which
  ref is written.
- `docs/understand/security.md:31-33` — the memory adapter walks every component; loop refusal code.
- `src/ports/file-system.ts:120` (`readdir`), and the `NOT_A_DIRECTORY` comments listed under U1/U2.
- `reports/api.json` — `UpdateRefOptions`, the port's `readdir` JSDoc.
- 5.0 migration notes (plan): one line per U1–U6 observable change.
