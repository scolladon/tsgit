# Design — snapshot source accessors (revisit the deferred weigh)

## Goal

Revisit the four first-class **source accessors** that ADR-260 deferred:

```
repo.tree(rev)   repo.index   repo.workdir   repo.stash
```

ADR-260 split the snapshot-surface work into *deliverable 1* (de-leak the wiring
internals — **shipped** in 23.4a) and *deliverable 2* (the accessors —
**deferred, not dropped**). The deferral rested on three frictions, two of which
were "this preempts not-yet-designed items":

1. `repo.stash` **collides** with the shipped stash *command* namespace.
2. `repo.tree(rev)` needs rev→tree resolution — *"the heart of 23.4c
   (`readFileAt`) and 23.4e (the `rev` vocabulary)"* — so building it then would
   have preempted two undesigned items.
3. `repo.index` / `repo.workdir` are thin getters *"whose final shape belongs to
   the read-model convergence capstone (23.4j)"*.

This item exists because **the gate has cleared**: 23.4c, 23.4e, and 23.4j are
all shipped. The weigh is now decidable on its merits rather than blocked. This
doc is the analysis; the disposition is a user-judgment call captured as an ADR.

This is **not** a faithfulness change — no SHA, ref, reflog, on-disk state,
refusal, or output is touched under any option. It is a pure public-API
ergonomics decision, taken inside the 23.4 breaking window (so any shape may be
chosen without a deprecation cycle).

## What "the gate cleared" actually revealed

The deferral's load-bearing premise was 23.4j's over-design caution: *"force
nothing until the right shape is evident from the full surface."* 23.4j has now
landed — and the way it converged is the decisive datum:

> **The read-model convergence routed `log` and `diff` through the Tier-2 read
> *primitives* (`walkCommitsByDate`, `revParse`, `readTree`, `resolveCommit`/
> `resolveTreeish`), not through `repo.snapshot.*` and not through any new
> `repo.tree(rev)` / `repo.index` / `repo.workdir` accessor.**

ADR-272 says it in as many words: the convergence adds *"no new abstraction
layer, no new accessors."* So the abstraction we deferred to "prove out across
the command set" was proven *unnecessary* for the internal consumers it was
meant to serve. The only remaining argument for the accessors is **external
consumer ergonomics** — saving a caller one word or one `revParse` call.

## The current surface (what the accessors would sit beside)

`repo.snapshot` is a `SnapshotFactory` — a deliberate, cohesive **power-tool
namespace** (`docs/use/snapshots.md`), distinct from the everyday porcelain on
`repo.*`. Every source is reached through it:

| factory method | signature | returns |
|---|---|---|
| `head(opts?)` | `SnapshotOptions` | `TreeSnapshot` |
| `commit(oid, opts?)` | tree of a commit oid | `TreeSnapshot` |
| `tree(oid, opts?)` | a **tree** oid, no peeling | `TreeSnapshot` |
| `index(opts?)` | `SnapshotOptions` | `IndexSnapshot` |
| `workdir(opts?)` | `WorkdirSnapshotOptions` | `WorkdirSnapshot` |
| `mergeHead/cherryPickHead/revertHead/fetchHead(opts?)` | compound state | `Promise<TreeSnapshot \| null>` |
| `stashEntry(i, opts?)` | stack index | `Promise<StashSnapshot \| null>` |

Two structural facts constrain the accessors:

- **`index` / `workdir` carry options.** `index(opts?: SnapshotOptions)` and
  `workdir(opts?: WorkdirSnapshotOptions)` both take a bag. A bare-property
  getter `repo.index` cannot carry one, so it would be **strictly less capable**
  than the method it shadows; a method `repo.index(opts?)` would be a **verbatim
  alias** of `repo.snapshot.index(opts?)`.
- **`tree` already exists with a different parameter.** `repo.snapshot.tree(oid)`
  takes a resolved **tree `ObjectId`**. `repo.tree(rev)` would take a **revision
  string** and rev-parse + peel-to-tree. Same word, different concept, on a
  different object.

## Per-accessor weigh

### `repo.stash` — blocked, not a weigh

`repo.stash` is the stash **command** namespace (`{push,list,apply,pop,drop}`).
A source accessor here is a hard collision; it cannot ship without reshaping a
shipped porcelain namespace. The snapshot equivalent already exists as
`repo.snapshot.stashEntry(i)`. **Disposition: cannot add — decline.**

### `repo.index` / `repo.workdir` — alias or amputation

Both options are bad:

- **As getters** (`repo.index`) they cannot carry `SnapshotOptions` /
  `WorkdirSnapshotOptions` → a strictly-less-capable surface that shadows the
  real method. Object-Calisthenics / "one obvious way" violation.
- **As methods** (`repo.index(opts?)`) they are verbatim aliases of
  `repo.snapshot.index(opts?)` → two ways to do exactly one thing, surface
  bloat, DRY/KISS violation.

Either way they fragment the cohesive snapshot namespace (some sources reachable
top-level, some only via `repo.snapshot.*`) to save **one word**.
**Disposition: decline (YAGNI/KISS).**

### `repo.tree(rev)` — the only one with new capability

This is the sole accessor that is *not* a pure alias: rev→tree resolution is new
capability, now buildable (`revParse` + peel-to-tree, the 23.4c pattern). The
honest case **for** it is symmetry with `repo.readFileAt(rev, path)`: we made
"read a *file* at a rev" first-class porcelain, so "enumerate a *tree* at a rev"
could be expected to be equally first-class, instead of the current power-tool
path `repo.snapshot.commit(await repo.revParse(rev))`.

The case **against**:

1. **Altitude inversion.** A `TreeSnapshot` is a power-tool (lazy, snapshot-
   isolation semantics) deliberately kept off the porcelain `repo.*` surface
   (ADR-260: *"a power-tool surface, not everyday porcelain"*). `repo.tree(rev)`
   would hoist a power-tool up into porcelain space — the opposite of the
   separation ADR-260 affirmed. `readFileAt` is *not* a counter-example: it
   returns **structured data** (`{id, mode, content}`), a porcelain read, not a
   lazy snapshot handle.
2. **Name overload.** `repo.snapshot.tree(oid)` (tree-oid) and `repo.tree(rev)`
   (rev-string) would coexist — same verb, two different parameter meanings on
   two different objects. A documented confusion magnet.
3. **Marginal gain.** It folds exactly one `revParse` call:
   `repo.snapshot.commit(await repo.revParse(rev))` already works today.
4. **Wrong home if wanted at all.** If real demand surfaces, the faithful place
   is *inside the cohesive namespace* (e.g. teach `repo.snapshot.commit`/a
   sibling to accept a rev), preserving altitude — not a top-level `repo.tree`.

**Disposition: decline now; if demand ever materialises, add it inside
`repo.snapshot.*`, not at top level.**

## Recommendation

**Decline all four top-level accessors (Option A).** Convert ADR-260's
*"deferred"* disposition into a settled *"weighed → declined"*, recorded in a new
ADR that supersedes ADR-260's deliverable-2 half. The weigh — not code — is this
item's deliverable; closing it is completing the work, not skipping it.

Rationale, in priority order:

1. **The proof-out gate returned "not needed."** 23.4j converged the command set
   onto Tier-2 primitives with *no* accessors (ADR-272). The abstraction we
   deferred to validate was validated as unnecessary.
2. **Three of four are alias/collision, not capability** — `stash` collides,
   `index`/`workdir` are one-word aliases or amputated getters.
3. **The fourth inverts altitude** — `repo.tree(rev)` pulls a power-tool into
   porcelain and overloads an existing verb, for a one-`revParse` saving.
4. **Cohesion** — `repo.snapshot.*` is a complete, documented, single-namespace
   query surface. Fragmenting it across `repo.*` buys ergonomics the project's
   KISS/YAGNI posture does not value.

## Alternatives (for the ADR conversation)

- **Option A — decline all four (recommended).** No code change; ADR + design +
  backlog flip only. Docs-only PR.
- **Option B — add `repo.tree(rev)` only.** Ship the one accessor with genuine
  new capability; decline `index`/`workdir`/`stash`. Accepts the altitude
  inversion + name overload for the `readFileAt` symmetry. Real code: a Tier-1
  binding + rev→tree + interop test.
- **Option C — add `repo.tree(rev)` + `repo.index()` / `repo.workdir()` as
  methods; leave stash under `repo.snapshot.*`.** Maximum ergonomics, maximum
  surface duplication; accepts two-ways-to-do-one-thing for index/workdir.

## Faithfulness / gates (all options)

- **No git-observable change** under any option — accessors are read-only sugar
  over existing snapshot/rev machinery.
- **`reports/api.json`** changes only under B/C (a new public method on
  `Repository`); unchanged under A.
- **Option A test posture:** the existing `snapshot-barrel-surface.test.ts`
  already pins the de-leaked barrel; add (if anything) a guard asserting no
  `tree`/`index`/`workdir` accessor leaked onto the top-level `repo` handle, so
  the "declined" decision is regression-pinned rather than merely documented.
- **Option B/C test posture:** Tier-1 surface gates (barrel + facade +
  `repository.test` keys + doc-coverage page + browser scenario + README
  count + `api.json`) plus a rev→tree interop test reconstructing
  `git ls-tree <rev>` from the snapshot rows.

## Out of scope

- The de-leak (deliverable 1) — already shipped in 23.4a.
- Any rename of `snapshot` — reaffirmed correct (ADR-260), untouched.
- `readFileAt` (23.4c), `rev` vocabulary (23.4e), read-model convergence (23.4j)
  — the now-shipped items this weigh was gated behind.
