# Design — Tier-2 primitive audit (`repo.primitives.*`)

## Goal

An API **coherence** pass surfaced by the 23.4 API review (finding **S8**). The
curated Tier-2 namespace `repo.primitives.*` has grown to **26** members, and
the review flagged six of them as candidate **mutation leaks** — low-level
write operations that may be *git plumbing showing through* rather than a real
developer extension surface:

| Candidate         | Shape                                                    |
| ----------------- | ------------------------------------------------------- |
| `stageEntry`      | write one index entry from bytes / OID                  |
| `unstageEntry`    | drop one index entry                                    |
| `setEntryFlags`   | flip `assumeValid` / `skipWorktree` / `intentToAdd`     |
| `recordRefUpdate` | append one reflog entry (ref move *not* included)        |
| `writeSymbolicRef`| write a `ref: <target>` symbolic ref (HEAD & friends)   |
| `runHook`         | run a named git hook                                     |

The pass answers, per candidate, the backlog's question — *real extension
surface, or plumbing leak?* — and pares `repo.primitives.*` to a **minimal,
coherent** set. It is **breaking** to the namespace (a removed/demoted key),
which the 23.4 window permits unconstrained (consistent with 23.4a/d/e/f's clean
breaks, no compat aliases).

## The audit framework — what earns a place in `repo.primitives.*`

The project invariant is explicit (`CLAUDE.md` › Domain Invariants):

> Commands are built from primitives (same building blocks users get).

`repo.primitives.*` is the **curated, blessed** extension set: the building
blocks the porcelain itself composes from, handed to consumers verbatim. A
member earns its place when **all four** hold:

1. **Composed-from.** At least one Tier-1 command is *actually built from it*.
   This is the invariant, read literally. A primitive no command uses is not a
   "same building block users get" — it is speculative surface.
2. **Coherent (safe) contract.** Using it cannot manufacture an on-disk state
   the porcelain could not — i.e. it does not let a caller produce *inconsistent*
   state (a reflog that disagrees with its ref) that no command would.
3. **Faithful product.** Its on-disk output is byte-faithful, not a "good
   enough" compromise. A primitive that writes a *non*-git-faithful artefact is
   plumbing showing through, badly.
4. **Capability, not duplication.** It either reaches a capability no other
   blessed surface reaches, or is a meaningfully higher-level convenience over
   one that does — it is not a strictly-less-safe sibling of an existing member.

The `/primitives` package barrel (`@scolladon/tsgit/primitives`) is a **second,
wider** surface — the deliberate "all internals" escape hatch (it already
exports `appendReflog`, `buildPack`, `fetchPack`, the config readers, … none of
which are in the curated namespace). The two-level model is intentional: the
**namespace is blessed**, the **barrel is everything**. This audit's named scope
is the **namespace** (`.primitives.*`); the barrel only changes where a
*deleted* function ceases to exist.

## Verdicts

### `stageEntry` / `unstageEntry` / `setEntryFlags` — **remove (delete)**

Plumbing leak. Fails criteria **1, 3, 4**.

- **No command is built from them (crit. 1).** Grep across `src/application`
  finds **zero** consumers outside their own modules + the namespace binding +
  the barrel. ADR-164 (Phase 20.2) introduced them predicting downstream callers
  — *"`stash pop` … `mv` … the surface every other consumer wants"*. That
  prediction **failed**: `stash`, `mv`, `cherry-pick`, `rebase` all mutate the
  index through `acquireIndexLock` + `applyChangeset` / `buildIndexFromTree`
  directly. The *actual* index-mutation building block turned out to be the
  changeset / tree primitives, not entry-level CRUD.
- **Non-faithful product (crit. 3).** `stageEntry` zeroes `ctime`/`mtime`/`dev`/
  `ino` on the entry it writes (`Math.floor(Date.now()/1000)` for the times,
  literal `0` for the rest). The porcelain it claims to be a "granular
  counterpart" of, `commands/add`, does the opposite — it `lstat`s the path and
  records the real `ctimeMs`/`mtimeMs`/`dev`/`ino` (the stat-cache that makes
  `status` fast). A tsgit-`stageEntry`-staged entry is *deliberately* not
  byte-faithful to what `git add` writes. A blessed primitive that ships a known
  faithfulness compromise is the definition of plumbing surfacing.
- **Pure plumbing, no porcelain analogue (crit. 4).** `setEntryFlags` is
  `git update-index --assume-unchanged` / `--skip-worktree` / `--intent-to-add`
  — the library exposes **no** porcelain for these bits, so the primitive is the
  only door to a capability that is itself raw plumbing.
- They cannot be **demoted** to internal (kept as a module, dropped from the
  surface) because nothing internal calls them — that would leave dead code,
  which the style rules forbid. So the coherent move is **delete** (module +
  tests + docs).
- **Re-entry is cheap.** ADR-164 wrote the escape hatch itself: *"additive, no
  breaking change"* if a real consumer appears. We invoke it in reverse —
  remove now in the breaking window; if a genuine consumer materialises later it
  returns additively, with a faithful stat contract designed against that real
  use.

> Counter (keep): *"a custom-porcelain author needs index-entry mutation and the
> lock is internal."* Rebutted: building a commit needs no index
> (`writeTree(entries)` + `createCommit` bypasses it); interleaving with
> `status`/`add`/`commit` mid-flight is the niche the failed ADR-164 prediction
> already over-served; and shipping a non-faithful entry writer is worse than
> shipping none.

### `recordRefUpdate` — **demote to internal (strip from both public surfaces)**

Plumbing leak on the **coherence/safety** axis (crit. 2, 4), but it *is*
composed-from (crit. 1) so the module stays.

- **Footgun (crit. 2).** `recordRefUpdate` appends a reflog entry **without
  moving the ref**. A caller can write `.git/logs/refs/heads/main` recording a
  transition the ref never made — an inconsistent state **no command produces**.
- **Strictly-less-safe sibling (crit. 4).** `updateRef` is the coherent public
  ref-write surface: it writes the ref **and** records the matching reflog
  **and** logs coupled HEAD, atomically. `recordRefUpdate` is `updateRef`'s
  *private reflog step* — the doc that calls `updateRef` a "wrapper around
  `recordRefUpdate`" has it backwards: `updateRef` is the safe whole, this is
  the unsafe half.
- **Composed-from (crit. 1), so keep the module.** `clone`, `checkout`,
  `commit`, `rebase`, and `update-ref` import it **directly** from
  `./record-ref-update.js` (never via the barrel), so demotion is invisible to
  them. The footgun is removed from **both** public surfaces — the
  `repo.primitives.*` namespace **and** the `@scolladon/tsgit/primitives` barrel
  (and the blessed docs). Maximum subtraction: a known footgun left on the
  everything-barrel is still advertised; making it fully private is cleaner than
  relying on the barrel as a catch-all.

### `writeSymbolicRef` — **demote to internal (strip from both public surfaces)**

A symref-backend mechanism, not a blessed building block.

- **Composed-from (crit. 1):** `checkout`, `branch`, `rebase` — all import it
  **directly** from `./write-symbolic-ref.js`, so the module stays and demotion
  is invisible to them.
- **Capability largely porcelain-reachable (crit. 4).** Its one distinctive use
  — setting HEAD symbolically without a checkout (`git symbolic-ref HEAD
  refs/heads/<b>`, e.g. a bare repo's default branch) — is niche; `checkout` and
  `branch` already move HEAD through porcelain. On balance it reads as the ref
  backend's symbolic-write half, the symref counterpart to `recordRefUpdate`'s
  reflog-write half, rather than a building block users reach for.
- **Coherent + faithful (crit. 2, 3):** it *is* safe and byte-faithful — this is
  not a footgun demotion but a **coherence** one: grouping the two ref-backend
  writers as internal, leaving `updateRef` as the single blessed ref-write
  surface. Removed from the namespace **and** the barrel **and** the blessed
  docs; the module stays. If a bare-repo default-branch need is shown it returns
  additively.

### `runHook` — **keep**

Real extension surface. Passes all four.

- **Composed-from (crit. 1):** `push`, `commit` (via `internal/commit-hooks`).
- **Capability (crit. 4):** lets custom porcelain fire git lifecycle hooks —
  maps 1:1 to git's own porcelain-tier `git hook run <name>`. No other blessed
  surface runs a hook on demand.
- **Coherent + faithful (crit. 2, 3):** a no-op when no `HookRunner` is wired or
  the hook is absent/non-exec; throws `HOOK_FAILED` on non-zero exit. No on-disk
  artefact, no faithfulness surface, no inconsistent state reachable.

## The other 20 — confirmed coherent, no change

The remaining members are the **read Core** (the 23.4 thesis: a strong read
model the inspection commands 23.5–23.8 build on) plus the **object/ref write**
primitives — every one is composed-from by a command and passes the framework:

- **Read:** `catFileBatch`, `diffTrees`, `getRepoRoot`, `hashBlob`, `isIgnored`,
  `mergeBase`, `readBlob`, `readIndex`, `readObject`, `readTree`, `resolveRef`,
  `walkCommits`, `walkCommitsByDate`, `walkSubmodules`, `walkTree`,
  `walkWorkingTree` (16).
- **Write (object/ref):** `createCommit`, `writeObject`, `writeTree`,
  `updateRef` (4) — object construction + the coherent ref-write surface.

Together with the kept `runHook`, the surviving blessed namespace is **21**.

Net namespace: **26 → 21** (delete 3, demote 2).

## Consequence — `AcquireOptions.breakStaleLockMs` collapses

After 23.4f, `add`/`mv`/`rm` call `acquireIndexLock(ctx)` with **no** options,
sourcing the stale-lock window from `ctx.config?.breakStaleLockMs`. The **only**
callers that still pass an explicit `breakStaleLockMs` override are the three
index-CRUD primitives being deleted. With them gone, `acquireIndexLock`'s
`opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs` has no `opts` branch left
to exercise — it collapses to `ctx.config?.breakStaleLockMs`, and the
per-call override field on `AcquireOptions` becomes dead. Removing it (keeping
`now`, the clock test-seam) is an in-scope, behaviour-preserving simplification
folded into the architecture pass (Step 7) — it traces directly to the deletion.

## Faithfulness anchors (git)

Pure **surface** change. No SHA, ref, reflog, on-disk state, refusal, or output
changes — every behaviour is removed (the three deleted verbs had no command
path) or relocated to an internal-only call site (`recordRefUpdate` keeps firing
verbatim from `updateRef`/commands; `writeSymbolicRef` from
`checkout`/`branch`/`rebase`). No new interop golden is required; there is no new
observable behaviour to pin. Verified by:

- the **type-checker** (`check:types`) as the completeness oracle — every
  internal consumer must compile against the smaller surface;
- the **unchanged** unit / interop / parity suites staying green (proving the
  internal reflog/symref/hook paths are byte-for-byte unchanged);
- `reports/api.json` regenerating to the smaller surface.

## Surface-gate impact

A namespace member touches a fixed set of gates (per the "adding a Tier-1
command" surface map, applied as removals):

- **`src/repository.ts`** — drop **5** entries from the
  `Repository['primitives']` type block and 5 from the `Object.freeze({…})`
  binding (`stageEntry`, `unstageEntry`, `setEntryFlags`, `recordRefUpdate`,
  `writeSymbolicRef`); fix the stale `Tier-2 primitives (16)` comment to the real
  count (**21**).
- **`src/application/primitives/index.ts`** (barrel) — drop the three **deleted**
  functions' exports + their type exports (`StageEntrySource`,
  `StageEntryOptions`, `UnstageEntryOptions`, `SetEntryFlagsOptions`), **and** the
  two **demoted** writers' exports (`recordRefUpdate`, `writeSymbolicRef`). Both
  demoted modules remain on disk (live, internally consumed by direct import);
  only their barrel advertisement goes.
- **Deleted modules + tests** — `src/application/primitives/{stage-entry,
  unstage-entry,set-entry-flags}.ts` and their mirrored unit tests under
  `test/unit/application/primitives/` (no co-located property siblings exist).
- **`test/unit/repository/repository.test.ts`** — drop the **five** keys from the
  documented-surface key list; drop the bound-`recordRefUpdate` behaviour test
  (the capability is still covered by `record-ref-update.test.ts` at the module
  level, and end-to-end by the command suites).
- **`test/unit/application/primitives/index.test.ts`** (barrel test) — drop all
  five names (`stageEntry`, `unstageEntry`, `setEntryFlags`, `recordRefUpdate`,
  `writeSymbolicRef`) from its two export-name lists.
- **`test/parity/scenarios/phase-20-2-primitives.scenario.ts`** — the bundled
  parity scenario covers `hashBlob`, `isIgnored`, `stageEntry`, `unstageEntry`,
  `setEntryFlags`. Trim it to the two survivors (`hashBlob`/`isIgnored`):
  remove the `staged*`/`afterUnstageEntryCount`/`skipWorktree*` result fields,
  the `stageEntry`/`setEntryFlags`/`unstageEntry` calls, and the matching
  `expected`. The deleted primitives leave the 19.5a-tracked parity surface
  (they no longer exist to cover) — the surface-coverage audit stays green.
- **`test/unit/application/commands/internal/clean-work-tree.test.ts`** — one
  test arranges a skip-worktree entry via `setEntryFlags(ctx, 'a.txt',
  { skipWorktree: true })`. Migrate the arrangement to write the index entry
  with the flag set directly (the file already uses `writeFramedIndex` + a local
  entry builder for its stage-1 case) — behaviour under test unchanged.
- **Docs** — delete `docs/use/primitives/{stage-entry,unstage-entry,
  set-entry-flags}.md`; move `record-ref-update.md` **and** `write-symbolic-ref.md`
  out of the blessed set (their mechanisms are documented in `internals.md`,
  where the reflog-store layer already lives); drop all **five** rows from
  `docs/use/primitives/README.md`; sweep cross-references (`create-commit.md`,
  `update-ref.md`, `internals.md`, `errors.md`, and any command page linking the
  two writers). Update the README headline count if it names a primitive total.
- **`reports/api.json`** — regenerates (committed in-PR, `check:doc-typedoc`
  prepush gate; a large typedoc-id reshuffle is expected and normal).

## Test strategy

This is a **subtractive** pass — the discipline is "prove the capability still
exists where it should, prove the removed surface is gone, keep everything else
byte-identical":

1. **Deleted verbs** — removal, not a new behaviour. Delete the three modules +
   their test files; `check:types` is the oracle that nothing referenced them.
   The doc-coverage check (parses the `Repository` interface → asserts a doc
   page per namespace key) becomes the gate that the docs moved in lockstep.
2. **`recordRefUpdate` / `writeSymbolicRef` demotion** — both writers' behaviour
   is unchanged and stays pinned at the module level (`record-ref-update.test.ts`,
   `write-symbolic-ref.test.ts`) + every command interop/parity suite that
   asserts reflog/ref/HEAD contents (`commit`, `checkout`, `clone`, `branch`,
   `rebase`). The Red/Green is the namespace key-list + barrel-export tests:
   update them to exclude both names, watch them fail against the still-bound
   facade / still-exporting barrel (Red), drop the bindings + barrel exports
   (Green).
3. **`runHook`** — unchanged; its existing module + command tests stay green.
4. **`AcquireOptions.breakStaleLockMs` collapse** (Step 7) — `index-lock.test.ts`
   keeps the `config`-driven stale-break cases; the per-call-override case (only
   reachable through the deleted primitives) is removed with the field. The
   collapsed `ctx.config?.breakStaleLockMs` line keeps an isolated set/unset test
   so its mutant stays killed.
5. `npm run validate` (full suite + interop + parity) green throughout —
   byte-for-byte unchanged behaviour. Regenerate `reports/api.json`.

Mutation (Step 8) re-runs against the smaller shape. Deleting the three modules
**reduces** the mutated surface; no new suppressions are introduced.

## Decision summary (ratified — ADR-268)

Three load-bearing judgments, resolved toward "**blessed = composed-from, safe,
faithful; everything else is gone from every public surface**":

1. **`stageEntry` / `unstageEntry` / `setEntryFlags` → delete** (orphaned,
   non-faithful, pure plumbing; re-add additively if a real consumer appears).
2. **`recordRefUpdate` → demote to internal, stripped from both the namespace and
   the `@scolladon/tsgit/primitives` barrel** (`updateRef` is the coherent
   ref-write surface; the decoupled reflog write is a footgun; module kept for
   its 5 internal consumers).
3. **`writeSymbolicRef` → demote to internal, stripped from both surfaces**
   (a symref-backend mechanism, largely porcelain-reachable; module kept for
   `checkout`/`branch`/`rebase`). **`runHook` → keep** (genuine extension, maps to
   `git hook run`, safe + faithful, composed-from).

Net: `repo.primitives.*` **26 → 21**; the `/primitives` barrel loses 5 exports
(3 deleted + 2 demoted).
