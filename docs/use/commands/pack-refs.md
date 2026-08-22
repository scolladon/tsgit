# `packRefs`

Pack every ref this Context can see into the backend's most-compact on-disk
form — git's `pack-refs --all`, always. There is no bare/tags-only mode:
the reftable backend's whole-stack compaction has no per-namespace
equivalent to express one, so both backends stay uniformly "pack
everything." Removes whatever the packing makes redundant — packed loose
files on the files backend, orphaned `*.ref` / `*.temp` reftable tables on
the other — the only place tsgit ever cleans that residue, since tsgit has
no `gc` or `prune`.

## Signature

```ts
repo.packRefs(): Promise<PackRefsResult>;

interface PackRefsResult {
  readonly packedRefCount: number;
  readonly prunedLooseRefCount: number;
  readonly removedOrphanCount: number;
}
```

## Behaviour

**Files backend — measured against canonical `git pack-refs`.** Every
packable ref (loose ∪ already-packed) is rewritten into `packed-refs`, and
every loose file that duplicated a now-packed ref is deleted:

| probe | measured result |
|---|---|
| `git pack-refs --all` | every ref (branches AND tags) is packed; each newly-packed ref's loose file is removed |
| `git pack-refs` (bare, no `--all`) | only tags, plus refs that were ALREADY packed with no live loose override, are (re)packed; a loose branch is left untouched even if it was packed before and has since moved — `packRefs` never replicates this scope, see below |
| header traits | `# pack-refs with: peeled fully-peeled sorted ` (trailing space) — emitted unconditionally, even when no entry needs peeling |
| `HEAD` / per-worktree refs | never packed, on either backend — `HEAD` stays symbolic and loose; a linked worktree's own branch (shared `refs/heads/*`) IS eligible, only the per-worktree pseudorefs (`HEAD`, `refs/bisect/`, `refs/worktree/`, `refs/rewritten/`) are excluded |
| already-packed repository, re-run | idempotent — byte-identical `packed-refs`, nothing pruned |
| empty repository (no refs at all) | git still writes a 47-byte header-only `packed-refs`; `packRefs` writes **nothing** — see "Empty repository" below |

- **Always `--all`, never bare.** git's bare default only packs tags and
  refs it already had packed, leaving a moved loose branch's packed entry
  stale. `packRefs` never reproduces that partial scope: the reftable
  backend's compaction has no notion of "tags only," so a caller-visible
  `all` toggle would mean two different things on the two backends. Every
  packable ref is always in scope.
- **Empty repository is left unchanged, not header-only.** Measured: real
  git writes a 47-byte `# pack-refs with: peeled fully-peeled sorted \n`
  file even with zero refs to pack. `packRefs` writes nothing when there is
  nothing to pack — a deliberate, measured divergence, safe under this
  surface's `equivalent-under-readback` contract: an absent `packed-refs`
  and a header-only one both read back to the identical empty ref set.
- **Annotated tags carry a peeled `^` line**, exactly like git's own
  `packed-refs` — the tag chain is followed to its first non-tag object.
- **Reftable backend.** Compacts the whole stack — segment `[0, n)` over
  every table currently listed — so ref and log tombstones are always
  elided (a merge that starts at table 0 always qualifies). Reuses the
  auto-compaction lock/merge protocol unchanged: under contention from a
  concurrent writer, the lockable range shrinks exactly like auto-compaction
  does, so a caller racing `packRefs` against another writer gets a
  best-effort compaction, not a guaranteed single table. Then, under a
  fresh `tables.list.lock` acquisition, every `*.ref` / `*.temp` file the
  resulting list doesn't name is unlinked — crash residue from any writer's
  aborted commit or compaction, tsgit's own or git's. **The resulting table
  count is never a contract** — auto-compaction's own size metric can
  legitimately differ, byte for byte, between two equally correct
  implementations (a two-byte deflate difference can flip a merge
  decision).
- **Deletes no objects.** `packRefs` packs refs; `extensions.preciousObjects`
  is unaffected and still honoured by construction.

## Examples

```ts
// Pack every ref into packed-refs (files) or one compacted table (reftable).
const { packedRefCount, prunedLooseRefCount, removedOrphanCount } = await repo.packRefs();

// A second run is a no-op once everything is already packed.
await repo.packRefs();
await repo.packRefs(); // prunedLooseRefCount: 0, removedOrphanCount: 0
```

## Throws

- `NOT_A_REPOSITORY` — `ctx` does not point at an initialized repository.
- `REFTABLE_LOCKED` — another writer holds the reftable stack's
  `tables.list.lock` past the retry budget, during either the compaction or
  the orphan sweep.

## See also

- Related commands: [`packObjects`](pack-objects.md), [`branch`](branch.md), [`tag`](tag.md)
- ADRs: [707](../../adr/707-tsgit-gains-a-pack-refs-surface.md)
