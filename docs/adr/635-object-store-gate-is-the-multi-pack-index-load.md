# 635 — The object-store gate is the multi-pack-index load, and nothing else

- **Status:** accepted
- **Date:** 2026-08-14
- **Design:** docs/design/cold-read-first-access.md · **Supersedes/Refines:** refines ADR-226; refines ADR-509 (precedence unchanged); upholds checkcontainment-hot-path Lever 5c as out of scope

## Context

`resolveObjectBytes` calls `registry.assertLoadable()` before the empty-tree short-circuit, the delta-cache probe and the loose read, and `openBlobSource` repeats it. `assertLoadable` awaited the whole `scanPacks` generation for its rejection alone, so every first object access — including one that hits a loose object — paid `exists(objects/pack)` + `readdir(objects/pack)` + candidate construction. The brief proposed removing the gate from the loose path outright, on the premise that canonical git reads a loose object without consulting the pack store. The in-code comment asserted the opposite. Both claims were unpinned.

Pinned against `git version 2.55.0` in a `mktemp -d` throwaway (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed), fixture = three packed commits + `git repack -adq` + `git multi-pack-index write` + one loose object, probe = `git cat-file -p <loose-oid>`:

- **A structurally self-inconsistent multi-pack-index denies the loose read.** Corrupt signature, unrecognised version, and an out-of-order fanout each exit 128 with no output and a `fatal:` line. The in-code comment is right; the brief's premise is false.
- **Every other object-store fault serves the loose read at exit 0** — corrupt `.idx`, truncated `.idx`, unreadable `.idx`, orphan `.idx` (pack deleted), `.idx` claimed by a healthy midx, midx naming a deleted or renamed pack, no midx, no `objects/pack` directory, and a Tier-B (truncated / garbage-chain) midx. Git surfaces some as stderr diagnostics; under ADR-249 tsgit's analogue is a structured `ctx.logger.warn`, which is data, not stdout bytes.
- **Three of those rows are places tsgit is stricter than git.** A `chmod 000` `objects/pack` makes tsgit's eager `readdir` reject and the loose read fail with `PERMISSION_DENIED` where git serves the object; an `objects/pack` that is a regular file reaches the midx probe as `NOT_A_DIRECTORY`, which was not classified Tier-B and so denied every read, where git prints `error: unable to open object pack directory: …: Not a directory` and serves at exit 0; and tsgit warns `skipping pack index with no pack file` on a loose hit where git is silent.

## Options considered

1. **Move `assertLoadable` after `tryLoose`** — pros: removes all store setup from a loose hit / cons: contradicts Pin A; a Tier-A midx would stop denying loose reads, an observable divergence in the permissive direction.
2. **Split the registry into a `storeGate` memo (the midx load) and the existing `scan` memo, gate as a strict prefix (recommended)** — pros: keeps Tier-A denial byte-identical while deferring the directory listing and pack construction behind the loose miss; closes both strictness divergences / cons: two memos to keep coherent across `refresh()`/`dispose()`; the warn loop must be split by faithfulness, not by convenience.
3. **Nest `packs`/`fileNames`/`midx` behind a memo inside `PackGeneration`, leaving `midxLoad` eager** — pros: same I/O saved / cons: buries the pinned fact inside a generation struct whose "one `scanPacks` call" invariant then reads false.

## Decision

**Option 2 (user-ratified).** `assertLoadable()` awaits a `storeGate` memo that is exactly `loadMidxSet`, and keeps returning `void` so it never becomes a second route to the packs. The `objects/pack` listing, `fileNames`, candidate `RegisteredPack` construction and `bindMidx` move behind the `scan` memo, forced only by `lookup`/`all`/`health`/`indexFaults`/`midxHealth`/`midxBitmap`. `refresh()` clears both memos in one synchronous step so no read pairs one generation's midx with another's packs; `dispose()` peeks the scan memo only, so a Context that only ever hit loose objects disposes without listing the pack directory.

Warn placement follows the pin, not the seam's convenience: the `discarding unusable multi-pack-index` warn moves **into the gate** (git prints its Tier-B midx diagnostic on a loose read), while the orphan-`.idx` warn stays on the **deferred** side (git is silent about it on a loose read). `ctx.fs.exists(packsDir)` is deleted — `probeFlat` already maps `FILE_NOT_FOUND` to absent, and the scan's own `readdir` folds `FILE_NOT_FOUND`/`NOT_A_DIRECTORY` to an empty listing while propagating every other fault to the consumers that actually need the pack store.

Loose-before-pack precedence (ADR-509) and the per-fanout-dir membership set are untouched: only what the gate costs changes, never the order.

Alongside it, and carried by this same record because the containment surface barely moves: `openRepository` already realpaths `cwd` and canonicalises `gitDir`/`commonDir`, then hands `layoutRootsOf(layout)` to a `NodeFileSystem` whose `loadRootSet` realpaths every root again on the first port call. The adapter now takes a private `rootsArePreResolved` flag; when set, `canonicalizeRoots()` returns `getRootDirPrefixes()` unchanged instead of realpathing. The shim sets it only when every `realpath` it performed actually succeeded — false for the `init`/`clone` case where the target does not yet exist, and for the `findLayout`-found-nothing branch whose `gitDir` was never realpathed at all.

A flag, deliberately, and not the hand-off of resolved *values* first proposed. `loadRootSet` computes `all = unionRootPrefixes(getRootDirPrefixes(), canonical)`, and every containment verdict consults `all` — so a caller-supplied canonical array is an **additive confinement input**, not a computation shortcut. Security review executed the counterexample: `new NodeFileSystem(['/tmp/r1'], nativePolicy, undefined, ['/etc']).readUtf8('/etc/hosts')` returned content where the two-argument form denied it. With a flag the union collapses to `raw ∪ raw = raw`, so a wrongly-set flag can only ever narrow the containment set — the property is structural rather than argued. `NodeFileSystem` is exported via the `adapters/node` subpath and the parameter is reachable by a consumer; under this shape that is harmless, because the same consumer already chooses `rootDir` outright. Nothing is added to `OpenNodeRepositoryOptions`. This is deliberately not Lever 5c, which proposes *skipping* the check for paths lexically under the canonical gitDir and remains out of scope pending its own security-reviewed proposal.

## Consequences

A first loose read performs two midx presence stats instead of two stats plus an `exists` and a `readdir`. Three divergences close in git's direction: a pack directory whose listing is refused no longer denies a loose read, a pack directory that is a regular file no longer denies one either, and the orphan-`.idx` warn no longer fires on a loose hit. That second change is observable to consumers reading the logger channel — they still receive it on any read that reaches the pack store. The `.idx`-parse diagnostic gap (git prints `error: non-monotonic index` on a loose read where tsgit is silent, because `.idx` parsing was already lazy behind `generation.indexed`) is pre-existing, diagnostic-only under ADR-249, and explicitly unchanged here.

The pinned matrix in the design doc is the durable artifact: pack-first reordering has now been proposed and rejected three times, and Pin A is the reason it stays foreclosed.
