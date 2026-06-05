# ADR-268: Tier-2 primitive audit — delete index-CRUD verbs, demote ref/symref writers

## Status

Accepted (at `eef36ec5`)

## Context

The 23.4 API review (finding **S8**) flagged the curated Tier-2 namespace
`repo.primitives.*` — grown to **26** members — and named six write operations
as candidate *mutation leaks*: low-level operations that may be git plumbing
showing through rather than a real developer extension surface
(`stageEntry`, `unstageEntry`, `setEntryFlags`, `recordRefUpdate`,
`writeSymbolicRef`, `runHook`).

`repo.primitives.*` is the **blessed** extension set — the building blocks the
porcelain itself composes from, handed to consumers verbatim
(`CLAUDE.md` › Domain Invariants: *"Commands are built from primitives (same
building blocks users get)"*). A separate, wider surface — the
`@scolladon/tsgit/primitives` package barrel — is the deliberate "all internals"
escape hatch (it already exports `appendReflog`, `buildPack`, `fetchPack`, the
config readers, …). The two-level model is intentional: **namespace = blessed,
barrel = everything**.

The audit framework: a `repo.primitives.*` member earns its place when **all
four** hold — (1) **composed-from** (≥1 command is actually built from it),
(2) **coherent/safe** (cannot manufacture inconsistent on-disk state no command
produces), (3) **faithful product** (byte-faithful output, not a "good enough"
compromise), (4) **capability, not duplication** (reaches something no other
blessed surface does, or is a meaningfully safer/higher-level convenience —
not a strictly-less-safe sibling).

Audit findings against the six:

- **`stageEntry` / `unstageEntry` / `setEntryFlags`** — **zero** command
  consumers (grep across `src/application`). ADR-164 introduced them in Phase
  20.2 predicting `stash pop` / `mv` would consume them; that prediction failed —
  every index-mutating command goes through `acquireIndexLock` +
  `applyChangeset` / `buildIndexFromTree`. `stageEntry` writes **non-faithful**
  stat fields (zeroed `ctime`/`mtime`/`dev`/`ino`) where `commands/add` records
  real `lstat` data. `setEntryFlags` is pure `git update-index
  --assume-unchanged` / `--skip-worktree` plumbing with no porcelain analogue.
  Fail criteria 1, 3, 4.
- **`recordRefUpdate`** — appends a reflog entry **without moving the ref**: a
  caller can write a reflog that disagrees with its ref, an inconsistent state
  no command produces. `updateRef` is the coherent ref-write surface (ref +
  reflog + coupled HEAD, atomically); `recordRefUpdate` is its private reflog
  step. Composed-from (5 modules), but fails criteria 2, 4.
- **`writeSymbolicRef`** — writes `ref: <target>` symrefs (HEAD & friends).
  Composed-from (`checkout`/`branch`/`rebase`), safe, faithful. Its symbolic-HEAD
  capability is reachable through porcelain (`checkout`/`branch` move HEAD); on
  balance judged an internal ref-backend mechanism rather than a blessed
  building block.
- **`runHook`** — runs a named git hook (`push`/`commit`). Composed-from, safe,
  faithful, maps 1:1 to git's porcelain-tier `git hook run`; the only blessed
  surface that fires a lifecycle hook on demand. A genuine extension point.

## Decision

Pare `repo.primitives.*` from **26 → 21**:

1. **Delete `stageEntry` / `unstageEntry` / `setEntryFlags`** entirely — module +
   tests + docs. They have no internal consumers, so they cannot be demoted to a
   live internal (that would be dead code). ADR-164's own escape hatch applies in
   reverse: remove now in the 23.4 breaking window; re-add **additively** with a
   faithful stat contract if a real consumer ever appears.

2. **Demote `recordRefUpdate` to internal** — remove from the
   `repo.primitives.*` namespace **and** from the `@scolladon/tsgit/primitives`
   barrel **and** from the blessed docs. Keep the module (its five internal
   consumers import it by direct path). The decoupled-reflog footgun becomes
   fully private; `updateRef` is the sole public ref-write surface.

3. **Demote `writeSymbolicRef` to internal** — same treatment (namespace +
   barrel + blessed docs removed; module kept for `checkout`/`branch`/`rebase`).

4. **Keep `runHook`** in the blessed namespace + barrel + docs.

The surviving namespace (21) is the **read Core** (`catFileBatch`, `diffTrees`,
`getRepoRoot`, `hashBlob`, `isIgnored`, `mergeBase`, `readBlob`, `readIndex`,
`readObject`, `readTree`, `resolveRef`, `walkCommits`, `walkCommitsByDate`,
`walkSubmodules`, `walkTree`, `walkWorkingTree`) + **object/ref write**
(`createCommit`, `writeObject`, `writeTree`, `updateRef`) + `runHook`.

This is **breaking** to both public surfaces (a removed namespace key, a removed
barrel export), which the 23.4 window permits unconstrained (no compat aliases,
consistent with 23.4a/d/e/f). It is otherwise **behaviour-preserving** — no SHA,
ref, reflog, on-disk state, refusal, or output change: deleted verbs had no
command path, and the two demoted writers keep firing verbatim from their
internal call sites.

A consequent simplification: with the three index-CRUD verbs (the only
explicit-override callers) gone, `acquireIndexLock`'s
`opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs` collapses to
`ctx.config?.breakStaleLockMs`, and the per-call `AcquireOptions.breakStaleLockMs`
field becomes dead. It is removed in the architecture pass (the `now` clock
test-seam is retained).

## Consequences

### Positive

- The blessed namespace is exactly the building blocks commands are *actually*
  built from — the project invariant, enforced rather than aspirational.
- Two footguns (decoupled reflog write; non-faithful index entry) leave the
  public surface entirely; the inconsistent-state door is closed.
- Net subtractive: −3 modules, −5 namespace keys, smaller `reports/api.json`,
  smaller mutated surface, one dead lock-option field removed.
- `updateRef` is unambiguously *the* ref-write surface; no strictly-less-safe
  sibling competes with it.

### Negative

- Removes the only public door to index-entry mutation from synthetic bytes and
  to symbolic-ref writes. Accepted: building commits needs no index
  (`writeTree` + `createCommit`); a bare-repo default-branch set is a rare need
  that can return additively if demand is shown.
- Breaking to any (undocumented, non-blessed) consumer importing the demoted
  writers from `@scolladon/tsgit/primitives`. Accepted: the 23.4 window permits
  it; the modules remain for internal composition.

### Neutral

- `runHook` is reaffirmed as a blessed primitive, not changed.
- The demoted writers keep their module files and unit tests at the module
  level; only their public advertisement and the bound-facade tests change.
- The two-level model (blessed namespace vs. everything-barrel) is reaffirmed;
  this audit removes leaks from **both** levels for the demoted writers rather
  than relying on the barrel as a catch-all.

## Alternatives considered

- **Keep the index-CRUD verbs** (a "complete" extension tier) — rejected:
  orphaned, non-faithful, and the failed ADR-164 prediction shows the real
  index-mutation building block is the changeset/tree layer, not entry CRUD.
- **Demote `recordRefUpdate` from the namespace only, keep it in the barrel** —
  rejected (the originally-recommended shape): leaving a known footgun on the
  everything-barrel still advertises it; maximum subtraction is cleaner.
- **Keep `writeSymbolicRef` blessed** (pairs with `updateRef` as the
  `{direct, symbolic}` ref-write surface) — rejected: its capability is largely
  porcelain-reachable, and grouping it with `recordRefUpdate` as an internal
  ref-backend mechanism is the more consistent line.
