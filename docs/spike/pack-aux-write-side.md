# Spike — Writing pack auxiliary structures (`.rev`, `.bitmap`, midx)

**Date:** 2026-08-13
**Backlog:** none yet — follow-up question to Phase 28 (28.2/28.3 read support)
**Status:** findings complete, ready for scheduling

## Question

Phase 28 made tsgit *read* the multi-pack-index, `.rev` reverse indexes and
pack bitmaps as accelerators. tsgit never *writes* any of them. Two worries:

1. A repository managed **only** by tsgit never gains these structures, so
   tsgit's own accelerated read paths never fire on its own repos.
2. Is the omission **permanent** — can canonical git still generate the
   optimisations later on a repo whose packs were written by tsgit?

## Method

Empirical, against git 2.55.0 (scrubbed `GIT_*` env, signing off):

- Built a repo, then reduced its pack dir to the exact artifact set tsgit
  writes today (`.pack` + `.idx` only — `repack.writeBitmaps=false`,
  `pack.writeReverseIndex=false`, aux files deleted).
- Ran every retrofit surface git offers over that minimal state.
- Separately observed which aux files git itself writes during everyday
  operations (`clone` non-bare and bare, raw `index-pack`,
  `maintenance run --task=incremental-repack`, plain `gc`).
- Inventoried tsgit's current write surface, backlog, and ADRs.

## Results

### Retrofit on a `.pack`+`.idx`-only repo (worry 2)

| Retrofit surface | Outcome |
|---|---|
| `git multi-pack-index write --bitmap` | **OK** — midx + midx `.bitmap` created; `multi-pack-index verify` passes |
| `git repack -adb` | **OK** — per-pack `.bitmap` + `.rev` created (identical pack SHA reproduced) |
| `git commit-graph write --reachable` | **OK** |
| `git fsck --strict` | clean |
| plain `git gc` (all defaults) | **auto-heals** — writes `.rev` and the commit-graph unasked |

**Worry 2 is disproven.** All three structures (plus the commit-graph) are
derived caches, regenerable from `.pack`+`.idx` at any time by stock git —
nothing tsgit omits today is lost permanently.

### When canonical git itself writes each structure

| Structure | Written during everyday ops? | Written only by maintenance? |
|---|---|---|
| `.rev` | **Yes** — every `.idx` write (`index-pack` on clone/fetch, `pack-objects`) emits a sibling `.rev`; `pack.writeReverseIndex` defaults true since git 2.41 | — |
| `.bitmap` | Never on clone/fetch | `repack -b` / `gc` (bare repos default `repack.writeBitmaps=true`), `multi-pack-index write --bitmap` |
| midx | Never on clone/fetch/gc defaults | `multi-pack-index write`, `maintenance` `incremental-repack` task |
| commit-graph | Not on fetch by default (`fetch.writeCommitGraph=false`) | `gc` (default `gc.writeCommitGraph=true`), `commit-graph write` |

### tsgit's current write surface

One artifact pair — `.pack` + `.idx` (+ `.promisor`), from
`write-pack-artifacts.ts`, called by `fetch-pack` (clone/fetch/fetch-missing)
and `packObjects`; `push`/`bundle-create` keep the pack in memory. No repack,
gc, prune or maintenance command exists (parked indefinitely in the backlog
parking lot, "was 24.1"). tsgit never deletes packs, so it can never strand an
existing midx (the 28.2 constraint binds only a future repack/gc).

## Findings

1. **One genuine faithfulness gap, on the everyday path:** git 2.55 clone
   produces `.pack` + `.idx` + **`.rev`**; tsgit clone produces `.pack` +
   `.idx`. `.rev` is the only aux structure git writes at pack-receive time,
   and its format is fully deterministic (index positions sorted by pack
   offset — the exact sort `pack-offset-table.ts` already performs in memory
   as its `.rev`-absent fallback, thrown away each open).
2. **No gap for `.bitmap`/midx/commit-graph today:** in canonical git these
   are born exclusively in repack/gc/maintenance — surfaces tsgit does not
   have. Writing them at fetch/clone time would itself be *unfaithful*.
3. **Worry 1 is real but narrow.** On any host with git installed, `git gc`
   retrofit covers tsgit-managed repos. The only environment where the
   accelerators are genuinely unreachable is a tsgit-**only** object store —
   above all the browser/memory adapters, which is precisely the revisit
   trigger already recorded on the parked gc/repack item.
4. **Byte-for-byte is the wrong contract for bitmaps.** Bitmap contents
   depend on commit-selection heuristics that vary across git versions; git
   itself does not produce stable bitmap bytes. The precedent already exists:
   `pack-writer.ts` declares `@writes surface: packfile, kind:
   equivalent-under-readback`. Any future bitmap/midx writer should pin
   "git verifies and consumes it" (`multi-pack-index verify`, `fsck`,
   read-back parity), not byte identity. `.rev`, by contrast, *is*
   deterministic and can be pinned byte-for-byte against `git index-pack`'s
   output for the same pack.

## Opinion / proposed lift

- **Do now (small): write `.rev` beside every `.idx`** in
  `write-pack-artifacts.ts`. It closes the one real everyday-path divergence,
  costs a sort tsgit already does on read, and makes tsgit's own next open of
  its own pack take the accelerated path. Honour `pack.writeReverseIndex=false`
  as git does. Interop pin: byte-compare against git's `.rev` for the same
  pack; golden that `git verify-pack`/`fsck` accept it.
- **Defer bitmap + midx + commit-graph writing to the repack/gc/maintenance
  story** (the parked item), because that is where git itself creates them —
  giving tsgit a `repack`/`maintenance` surface is the faithful vehicle, and
  the 28.2 midx-expiry constraint already scopes it. Un-park when the
  tsgit-only story (browser adapter, long-lived busy-fetch repos accumulating
  packs) demands it, not before.
- **Drop the urgency premise:** nothing is foreclosed by not writing these
  files — stock git retrofits or auto-heals all of them from `.pack`+`.idx`.

## Decisions left for a future ADR

- Whether `.rev` writing lands alone (small item) or rides with the next
  pack-writer change.
- Faithfulness kind for future bitmap/midx writers: `equivalent-under-readback`
  (recommended) vs byte-identical.
- Whether a future maintenance surface mirrors `git maintenance` task
  granularity or only `repack`.

## Repro

`git --version` → 2.55.0. Scratch script (not committed) builds the repo,
strips aux files, and runs the retrofit matrix; key commands:

```sh
git -c repack.writeBitmaps=false -c pack.writeReverseIndex=false repack -adq
git multi-pack-index write --bitmap && git multi-pack-index verify
git repack -a -d -b -q        # emits .bitmap + .rev
git commit-graph write --reachable
git gc                  # auto-writes .rev + commit-graph from defaults
```
