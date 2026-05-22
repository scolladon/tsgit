# ADR-085: Nested-submodule recursion via a child `Context`

## Status

Accepted (at `2ad72af`)

## Context

Phase 17.5 must "recurse into" nested submodules — a submodule whose own tree
contains further gitlinks. A nested submodule's objects (its pinned commit,
its tree, its `.gitmodules` blob) do **not** live in the superproject's object
store; they live in the submodule's own store, which git places — once the
submodule is initialised — at `${superproject.gitDir}/modules/<name>` (the
"absorbed" gitdir layout, default since git 1.7.8).

To walk a nested submodule, a primitive needs a way to read *that* object
store. Options considered:

- **Call `openRepository` per nested submodule.** `openRepository` composes
  adapters, validates options, and wires a dispose lifecycle. A tier-2
  primitive calling it would invert the layering (`primitive → facade`) and
  re-pay adapter composition for every nested repo.
- **Hoist recursion to the command tier.** The `submodules` command would open
  nested repos. It would still need the adapter-composition machinery, and the
  streaming `walkSubmodules` primitive would lose recursion — the asymmetry the
  `log`/`walkCommits` precedent (ADR-083) exists to avoid.
- **Derive a child `Context` by swapping `layout`.** A `Context` is ports
  (`fs`, `hash`, `compressor`, …) plus a `layout` that names `gitDir`/`workDir`.
  The ports are gitdir-agnostic — every read primitive selects an object store
  purely through `ctx.layout.gitDir`. Swapping `layout` on a spread `Context`
  retargets every primitive at the nested store with no new adapters.

## Decision

`walkSubmodules` recurses by deriving a **child `Context`** for each nested
submodule:

```
childGitDir = `${ctx.layout.gitDir}/modules/${name}`
childCtx    = Object.freeze({ ...ctx,
                layout: { workDir: `${ctx.layout.workDir}/${treeRelPath}`,
                          gitDir: childGitDir, bare: false, homeDir },
                cwd: …, promisor: undefined })
```

The formula is uniform at every nesting level: a nested submodule of a
submodule resolves to `${parent.gitDir}/modules/<nested-name>`, which is
exactly where git stores it.

Rules:

- **Reused ports.** Every port — including `deltaCache` — is reused. The
  delta cache is keyed by `ObjectId`, which is content-addressed and therefore
  globally unique across object stores; sharing it is safe and saves a
  re-allocation.
- **`promisor` is dropped.** The parent's promisor closes over the *parent*
  `Context`; left in place it would lazy-fetch a missing nested object from the
  *superproject's* remote — the wrong store. A genuine nested miss must stop
  recursion, not trigger a cross-repo fetch.
- **Uninitialised → skipped.** If `${childGitDir}/HEAD` does not exist
  (probed with `fs.exists`, not a caught exception) the submodule is not
  initialised locally; the parent entry is still yielded, recursion stops.
  `git submodule status --recursive` likewise skips what it cannot reach.
- **Missing pinned commit → skipped.** If the child store lacks the pinned
  commit, `readTree` is caught on `OBJECT_NOT_FOUND` / `FILE_NOT_FOUND` only
  (any other error rethrows — a narrow, code-checked catch, the
  `reflog.tryResolve` idiom); recursion stops.
- **Cycle guarded.** A set of visited gitdir paths is threaded through the
  recursion; a gitdir already in the set is not re-entered.
- **Depth guarded.** `MAX_SUBMODULE_DEPTH = 100` backstops a pathologically
  deep acyclic nest.
- **Unsafe names rejected.** `name` is the only `.gitmodules`-supplied string
  used to build a filesystem path. A name that is empty, `.`/`..`, contains a
  `..` segment or a backslash, is absolute, or begins with `-` is rejected
  (git's `submodule-config` validation, CVE-2018-17456 lineage): its
  `.gitmodules` row is dropped and recursion into it is refused. The child
  `Context` reuses the parent's bounded `FileSystem`, so even a name that
  passes the check cannot escape the superproject root.
- **`recursive` is opt-in.** Both `WalkSubmodulesOptions.recursive` and
  `SubmodulesAction.recursive` default to `false`, matching `git submodule
  status` (non-recursive; `--recursive` opts in).
- **Absorbed layout only.** Only `${gitDir}/modules/<name>` is probed. The
  pre-2015 layout where `<path>/.git` is a real directory is not — it would
  couple recursion to working-tree checkout state, which ADR-084 deliberately
  avoids. A non-absorbed nested submodule contributes its own entry but is not
  recursed into.

## Consequences

### Positive

- No layering inversion: a primitive derives a `Context` (plain data), it does
  not construct a `Repository`.
- No adapter re-composition per nested submodule — only a `layout` swap.
- Recursion lives in the primitive, so the streaming and materialised
  surfaces (ADR-083) both get it.
- Uninitialised / missing / cyclic / too-deep cases degrade to "no child
  entries", never a throw — git-faithful and safe by construction.

### Negative

- A `.gitmodules` `name` with no matching `modules/<name>` directory yields no
  children even when the submodule exists in a non-absorbed layout. Accepted:
  the absorbed layout is git's default for the last decade.
- Recursion cost is one full `walkTree` per visited tree (superproject and
  each recursed submodule).

### Neutral

- The child `Context` is a frozen spread of the parent — it inherits `signal`
  and `config` (abort and parallelism propagate) and omits `promisor`.
</content>
</invoke>
