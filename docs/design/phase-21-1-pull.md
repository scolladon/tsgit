# Phase 21.1 — `pull` (fetch + merge)

## 1. Purpose

`pull` integrates a remote branch into the current branch by composing two
existing Tier-1 commands: `fetch` (download objects + update remote-tracking
refs) followed by `merge` (integrate the fetched tip into `HEAD`). It is the
first **composition** porcelain of Phase 21 — the backlog frames it as "the
test that 20.4 (merge state machine) + 22.3 (rebase) compose cleanly". 22.3 has
not landed, so this iteration ships **merge-only** integration; the `rebase`
mode is added in the same PR that ships rebase.

The load-bearing invariant: a `pull` that conflicts must leave the repository
in the **exact** state a bare `merge` would (`MERGE_HEAD` / `MERGE_MSG` /
`ORIG_HEAD` + a conflicted stage-1/2/3 index + conflict-marker working-tree
files), so the existing `abortMerge` / `continueMerge` state machine resolves a
pull-initiated conflict with **zero** pull-specific code. This is guaranteed
structurally by delegating integration to `merge` rather than re-implementing
it.

## 2. Git-faithful behaviour (captured empirically)

Reference behaviour was captured from stock `git` (see PR body for the
transcript). The contract `pull` must reproduce:

| Scenario | `git` reflog (HEAD + branch) | Commit / `MERGE_MSG` |
| --- | --- | --- |
| Fast-forward | `pull: Fast-forward` | — (no commit) |
| True merge (clean) | `pull: Merge made by the 'ort' strategy.` | `Merge branch '<branch>' of <url>` |
| Conflict | (branch unmoved → no reflog) | `MERGE_MSG` = `Merge branch '<branch>' of <url>\n\n# Conflicts:\n#\t<path>\n` |
| Up-to-date | (unchanged) | — (`Already up to date.`) |

Notes:

- `git` clone writes the upstream tracking config that `pull` later reads:
  ```ini
  [remote "origin"]
  	url = <url>
  	fetch = +refs/heads/*:refs/remotes/origin/*
  [branch "main"]
  	remote = origin
  	merge = refs/heads/main
  ```
  tsgit's `clone` currently writes **none** of this for a normal (non-partial)
  clone — only partial clones write a `[remote "origin"]` block. That gap is
  closed here (see §6), because without it `fetch`/`pull` after a normal clone
  would throw `REMOTE_NOT_CONFIGURED`.
- The reflog *action* is `pull` (stock git appends the literal CLI args, e.g.
  `pull -q`; a library has no argv, so the faithful action is bare `pull`).
- tsgit's merge strategy label is `'tsgit'`, not `'ort'` — the existing `merge`
  command already writes `Merge made by the 'tsgit' strategy.`, so a
  pull-initiated true merge reads `pull: Merge made by the 'tsgit' strategy.`.

## 3. Public surface

```ts
// src/application/commands/pull.ts
export interface PullOptions {
  /** Remote to pull from. Default: branch.<current>.remote ?? 'origin'. */
  readonly remote?: string;
  /**
   * Short branch name to merge (the remote-side branch, e.g. 'main').
   * Default: short form of branch.<current>.merge. When neither is
   * resolvable, pull throws NO_UPSTREAM_CONFIGURED.
   */
  readonly branch?: string;
  /** Force fast-forward-only; reject when a true merge would be required. */
  readonly fastForwardOnly?: boolean;
  /** Always create a merge commit, even when a fast-forward is possible. */
  readonly noFastForward?: boolean;
  /** Prune deleted remote-tracking refs during the fetch step. */
  readonly prune?: boolean;
  /** Shallow fetch depth, forwarded to fetch. */
  readonly depth?: number;
  /** Override the generated merge commit message / MERGE_MSG. */
  readonly message?: string;
  /** Identity for the merge commit (true-merge path only). */
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

export interface PullResult {
  /** The fetch step's result (url, updatedRefs, prunedRefs, shallow, …). */
  readonly fetch: FetchResult;
  /** The merge step's result (up-to-date | fast-forward | merge | conflict). */
  readonly merge: MergeResult;
}

export const pull = (ctx: Context, opts?: PullOptions): Promise<PullResult>;
```

`rebase` is intentionally **absent** until 22.3 lands (YAGNI — no dead
throw-path to test, no forward-compat stub).

Bound on the facade as a flat Tier-1 method: `repo.pull(opts?)` (sibling of
`fetch` / `merge` / `clone` / `push`).

## 4. Algorithm

```
pull(ctx, opts):
  assertRepository(ctx)
  assertNotBare(ctx, 'pull')           # fail fast — merge needs a worktree+branch
  assertNoPendingOperation(ctx)        # fail fast — refuse if a merge is mid-flight
  head ← readHeadRaw(ctx)
  currentBranch ← head.kind === 'symbolic' ? shortName(head.target) : undefined

  config ← readConfig(ctx)
  remote ← opts.remote
         ?? config.branch?.get(currentBranch)?.remote
         ?? 'origin'
  branch ← opts.branch
         ?? stripRefsHeads(config.branch?.get(currentBranch)?.merge)
         ?? throw NO_UPSTREAM_CONFIGURED(head.kind === 'symbolic'
              ? head.target            # RefName e.g. refs/heads/main
              : RefName.from('HEAD'))  # detached fallback

  fetchResult ← fetch(ctx, { remote, prune?, depth? })

  trackingRef ← `refs/remotes/${remote}/${branch}`
  tip ← resolveRef(ctx, trackingRef)   # REF_NOT_FOUND if remote lacks the branch

  mergeResult ← merge(ctx, {
    target:        tip,                 # 40-hex OID — merge.resolveTarget accepts it as-is
    message:       opts.message ?? `Merge branch '${branch}' of ${fetchResult.url}`,
    reflogLabel:   'pull',             # NEW additive merge option (see §5)
    fastForwardOnly?, noFastForward?, author?, committer?,
  })

  return { fetch: fetchResult, merge: mergeResult }
```

### 4.1 Resolution rules (strict, git-faithful)

- **remote**: explicit `opts.remote` wins; else the current branch's
  `branch.<cur>.remote`; else `'origin'`.
- **branch to merge**: explicit `opts.branch` wins; else the short form of
  `branch.<cur>.merge` (strip a leading `refs/heads/` if present, else use the
  stored value verbatim); else `NO_UPSTREAM_CONFIGURED`. After `clone` writes upstream (§6), a no-arg
  `pull()` works on the cloned default branch; a locally-created branch with no
  upstream requires an explicit `branch` (faithful to git's "no tracking
  information" error).
- **detached HEAD**: `currentBranch` is `undefined`; config-derived defaults are
  unavailable. With no `opts.branch` → `NO_UPSTREAM_CONFIGURED`. With an
  explicit `opts.branch`, the fetch+resolve succeed but `merge` throws its
  existing `UNSUPPORTED_OPERATION` ("cannot merge with detached HEAD") — pull
  inherits that limitation unchanged.

### 4.2 Fast-fail guards before the network

`assertNotBare` and `assertNoPendingOperation` run **before** `fetch` so a
pull that the merge step would certainly refuse (bare repo, merge in progress)
does not waste a network round-trip. `merge` re-checks both (idempotent); the
early guards are a UX optimisation, not a correctness dependency.

### 4.3 Why no working-tree materialisation

`merge` advances refs and writes conflict state, but does **not** materialise
the merged tree into the working tree / index on the fast-forward and clean
paths (working-tree materialisation tracks Phase 20.1, still `[~]`). `pull`
delegates integration to `merge`, so it inherits this contract **exactly** — no
better, no worse than a direct `merge`. Documented, not a pull bug.

## 5. `merge` changes

### 5.1 Additive `reflogLabel`

To reproduce git's `pull:`-prefixed reflog while keeping `merge` as the single
integration engine, `MergeOptions` gains one optional field:

```ts
export interface MergeOptions {
  // … existing fields …
  /**
   * Reflog action prefix, mirroring git's GIT_REFLOG_ACTION. Replaces the
   * default `merge <target>` prefix in the fast-forward and merge-commit
   * reflog messages. Defaults to `merge <target>` (unchanged behaviour).
   */
  readonly reflogLabel?: string;
}
```

The two reflog write sites change from a hard-coded `merge ${opts.target}` to
`${opts.reflogLabel ?? \`merge ${opts.target}\`}`:

- Fast-forward: `${label}: Fast-forward`
- Merge commit: `${label}: Merge made by the 'tsgit' strategy.`

`pull` passes `reflogLabel: 'pull'` → `pull: Fast-forward` /
`pull: Merge made by the 'tsgit' strategy.`. A direct `merge('feature')` is
unchanged (`merge feature: Fast-forward`).

This is the **whole-prefix** override (not just the action word) because git's
pull reflog has no merged-ref suffix (`pull: …`, never `pull <oid>: …`), whereas
direct merge does (`merge feature: …`). A single replaceable prefix reproduces
both observed shapes. The field is the library analogue of
`GIT_REFLOG_ACTION` — a principled, faithful knob, not a pull-specific hack.

### 5.2 Broaden `resolveTarget` to gitrevisions ref-DWIM

Stock `git merge <commit-ish>` accepts any ref the gitrevisions DWIM rules
resolve — `git merge origin/main`, `git merge v1.0`, `git merge refs/...`.
tsgit's `resolveTarget` currently only matches a 40-hex OID or `refs/heads/<x>`,
so `merge({ target: 'origin/main' })` fails (it probes `refs/heads/origin/main`).
This is broadened to the gitrevisions ref-DWIM ladder, **reusing** the exact
candidate sequence `rev-parse` already applies (consistency + DRY), plus tag
peeling:

```ts
export const resolveTarget = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;        // unchanged
  for (const candidate of refCandidates(target)) {                     // shared ladder
    try {
      return await resolveRef(ctx, candidate, { peel: true });         // peel annotated tags → commit
    } catch {
      // try the next candidate
    }
  }
  throw refNotFound(target as RefName);
};
```

`refCandidates(base)` — `[base, refs/heads/base, refs/tags/base, refs/remotes/base]`
— is **extracted** from `rev-parse.ts` (where it is currently a private const)
into a shared pure helper `src/domain/refs/ref-candidates.ts`, imported by both
`rev-parse.ts` and `merge.ts`. One ref-resolution order across tsgit; no
duplication.

`{ peel: true }` follows an annotated-tag chain to its underlying object so
`merge('sometag')` merges the tagged commit (faithful). A target that resolves
to a tree/blob still fails downstream in `getTree` (`UNEXPECTED_OBJECT_TYPE`,
git's "not something we can merge").

Bounded: the 40-hex direct path is unchanged (pull passes a commit OID);
revision **operators** (`~`, `^`, `@{…}`) remain `rev-parse`-only — a caller
wanting those resolves via `revParse` first. The candidate ladder matches
`rev-parse`'s existing order (heads before tags), a minor, pre-existing
deviation from strict gitrevisions precedence, kept for tsgit-internal
consistency.

### 5.3 `pull` still passes a resolved OID

Independently of 5.2, `pull` resolves the tracking ref → OID itself (early
`REF_NOT_FOUND` check) and passes the OID to `merge` (ADR-197). The 5.2
broadening benefits **direct** `merge` callers; `pull`'s wiring stays decoupled
from merge's resolver order.

## 6. `clone` change — write upstream tracking config

Stock git's clone writes the `[remote "origin"]` block and a `[branch "<head>"]`
upstream block. tsgit's clone writes them **only** for partial clones. This is
generalised so **every** clone writes them (the faithful behaviour, and a hard
prerequisite for fetch/pull after a normal clone):

```
writeCloneConfig(ctx, { url, headBranch, filterSpec }):
  entries ← [
    { core.repositoryformatversion = filterSpec ? '1' : (omit — bootstrap already wrote '0') },
    remote.origin.url = url,
    remote.origin.fetch = '+refs/heads/*:refs/remotes/origin/*',
  ]
  if headBranch !== undefined:          # non-detached clone
    entries += [
      branch.<headBranch>.remote = 'origin',
      branch.<headBranch>.merge  = 'refs/heads/<headBranch>',
    ]
  if filterSpec !== undefined:          # partial clone extras (existing behaviour)
    entries += [
      remote.origin.promisor = 'true',
      remote.origin.partialclonefilter = filterSpec,
      extensions.partialClone = 'origin',
      core.repositoryformatversion = '1',
    ]
  updateConfigEntries(ctx, entries)
```

This **subsumes** the existing `writePromisorConfig`: the `remote.origin.url` +
`fetch` entries (previously written only inside the partial-clone branch) move
to the always-run path, and the partial-clone-only entries layer on top.
`writePromisorConfig` is removed; `writeCloneConfig` is always invoked.

The `headBranch` is the symref-tracked branch already computed by
`headTrackedBranch(advertisement)` / `applyRemoteHead`. A detached clone (no
symref) writes the remote block but no `[branch …]` block (faithful).

## 7. New error — `NO_UPSTREAM_CONFIGURED`

```ts
// domain/commands/error.ts — add to the CommandErrorData union
| { readonly code: 'NO_UPSTREAM_CONFIGURED'; readonly branch: RefName }

export const noUpstreamConfigured = (branch: RefName): TsgitError =>
  new TsgitError({ code: 'NO_UPSTREAM_CONFIGURED', branch });
```

Surfaced when `pull` cannot determine the branch to merge (no `opts.branch`,
no `branch.<cur>.merge`, possibly detached HEAD). Carries the branch (or
`HEAD`) for a faithful, actionable message. `branch` is a `RefName` brand built
via `RefName.from('HEAD')` for the detached fallback.

## 8. Module structure & file layout

```
src/application/commands/pull.ts          NEW  — PullOptions, PullResult, pull()
src/domain/refs/ref-candidates.ts          NEW  — shared gitrevisions DWIM ladder (pure)
src/application/commands/merge.ts          EDIT — MergeOptions.reflogLabel + 2 reflog sites; resolveTarget DWIM + peel
src/application/commands/rev-parse.ts      EDIT — import refCandidates from the shared helper (drop private const)
src/application/commands/clone.ts          EDIT — writeCloneConfig (subsumes writePromisorConfig)
src/application/commands/index.ts          EDIT — export { PullOptions, PullResult, pull }
src/domain/commands/error.ts               EDIT — NO_UPSTREAM_CONFIGURED + factory
src/repository.ts                          EDIT — Repository.pull binding (guarded)
```

`ref-candidates.ts` lives in `domain/refs/` because it is a pure string→string[]
function over ref-name grammar with zero platform/ctx dependency — domain-fit,
importable by both commands.

`pull.ts` follows the small-function / early-return / immutable conventions:
guard helpers, a pure `resolveUpstream(config, currentBranch, opts)` returning
`{ remote, branch }` or throwing, and the orchestration body. No function
exceeds 20 lines; upstream resolution is extracted to a named helper to avoid
nesting.

## 9. Testing strategy

### 9.1 Unit — `test/unit/application/commands/pull.test.ts`

**Object-graph construction.** Rather than hand-rolling commit-graph pack bytes,
the real commit graph is built with the actual `init` / `add` / `commit` /
`branchCreate` / `checkout` commands in a `createMemoryContext`, and refs are
manipulated to create the desired divergence. The fake remote then **advertises
the target tip** (`refs/heads/<branch>` → the chosen local commit) and serves an
**empty** synthetic pack (`buildSyntheticPack(ctx, [])` → a valid 0-entry pack),
because the wanted objects already exist locally. `fetch` writes
`refs/remotes/<remote>/<branch>` from the advertisement regardless of pack
contents, so `pull` then resolves and merges a genuine commit. Remote config
(`remote.origin.url`, and upstream `branch.<cur>.remote/merge` where the case
needs it) is seeded via the config primitives / `remoteAdd`. The fake transport
is a small inline `HttpTransport` (advertisement for `info/refs`, empty-pack
body otherwise) — no edit to `fetch.test.ts` required.

Scenario graphs:
- **fast-forward**: commit A on main; commit B (child of A); reset main to A so
  HEAD=A with B's objects retained; advertise main→B.
- **up-to-date**: advertise main→A (== local HEAD).
- **true merge / conflict**: commit A; branch feature, commit B on it; commit X
  on main; HEAD=main=X (base A); advertise main→B. Distinct files → clean
  merge; same file → conflict.

GWT / AAA / `sut`. Cases:

- **Fast-forward**: local behind remote → `merge.kind === 'fast-forward'`,
  branch advances to the fetched tip, reflog reads `pull: Fast-forward`.
- **Up-to-date**: local == remote → `merge.kind === 'up-to-date'`, no reflog
  entry added.
- **True merge (clean, diverged non-conflicting)** with `noFastForward` or
  natural divergence → `merge.kind === 'merge'`, two parents, commit message
  `Merge branch '<branch>' of <url>`, reflog `pull: Merge made by the 'tsgit'
  strategy.`.
- **Conflict** (diverged, same path edited both sides) → `merge.kind ===
  'conflict'`, `MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD` written, conflicted index;
  then `abortMerge` restores `ORIG_HEAD` (composition proof, in this file or the
  integration suite).
- **Upstream resolution**:
  - explicit `{ remote, branch }` honoured;
  - default from `branch.<cur>.remote` / `branch.<cur>.merge`;
  - `NO_UPSTREAM_CONFIGURED` when neither is available (isolated test per guard
    arm: no-opts-no-config, and detached-HEAD-no-branch);
  - default remote falls back to `'origin'` when branch has `merge` but no
    `remote`.
- **Guards** (each isolated, per CLAUDE.md): `assertNotBare` (bare → throws,
  no fetch), `assertNoPendingOperation` (MERGE_HEAD present → throws),
  `REF_NOT_FOUND` when the remote does not advertise the requested branch.
- **`fastForwardOnly`** over a diverged history → propagates merge's
  `NON_FAST_FORWARD` (assert `.data.code` + ref/oids, not just the class).
- **`message` override** flows into the merge commit / MERGE_MSG.
- **Result shape**: `fetch` + `merge` both surfaced; `fetch.updatedRefs`
  reflects the remote-tracking update.

Error assertions use try/catch + direct `.data` assertions (mutation-resistant
per CLAUDE.md), never bare `toThrow(ErrorClass)`.

### 9.2 `merge.reflogLabel` unit coverage (in `merge.test.ts`)

- default (`reflogLabel` omitted) → reflog `merge <target>: Fast-forward`
  (existing behaviour, pin it);
- explicit `reflogLabel: 'pull'` → reflog `pull: Fast-forward` and
  `pull: Merge made by the 'tsgit' strategy.` (FF + merge-commit sites, isolated
  tests so each site's substitution is independently proven).

`resolveTarget` DWIM (in `merge.test.ts`, exported helper already tested
directly):
- `merge({ target: 'origin/main' })` resolves via `refs/remotes/origin/main`
  and merges (the user's headline case);
- bare branch name still resolves `refs/heads/<x>` (regression-pin);
- annotated tag name peels to its commit (`{ peel: true }` path);
- unknown name → `REF_NOT_FOUND` (try/catch + `.data` assertion);
- `ref-candidates.ts` gets its own pure unit test (each candidate in order).

### 9.3 `clone` config unit coverage (in `clone.test.ts`)

- normal clone → `remote.origin.url` + `remote.origin.fetch` +
  `branch.<head>.remote=origin` + `branch.<head>.merge=refs/heads/<head>` via
  `readConfig`;
- partial clone (`filter`) → the above **plus** `promisor`,
  `partialclonefilter`, `extensions.partialClone`,
  `core.repositoryformatversion=1` (regression-pin the subsumed behaviour);
- detached clone (no symref) → remote block written, **no** `[branch …]` block.

### 9.4 Integration — `test/integration/network/pull-http-backend.test.ts`

Against the real `git http-backend` harness already used by
`fetch-http-backend.test.ts` / `clone-http-backend.test.ts`: `clone` a seeded
source, advance the source, `pull`, assert fast-forward + working data; then a
diverged-conflict `pull` that lands in conflict state and is resolved via
`continueMerge` (and a separate `abortMerge`). This is the end-to-end proof that
fetch + the 20.4 merge state machine compose.

### 9.5 Repository facade

`repository.test.ts` enumerates `Object.keys(sut).sort()` — add `'pull'`. Bound
method is `guard()`-wrapped like its siblings; the "every top-level method is a
function" assertion already covers it.

### 9.6 Property tests

Not applicable: `pull` is orchestration/IO composition with no parser, matcher,
round-trip, or algebraic grammar (per CLAUDE.md's "NOT appropriate" list —
command facades belong in integration/parity tests). The upstream-resolution
helper is a small enum-like decision tree better covered by a parameterised
example sweep than a property.

## 10. Key decisions (→ ADRs)

1. **Strict upstream + clone writes tracking config** (ADR-196). Alternatives:
   pull-infers-with-no-clone-change; hybrid lenient. Chosen: strict + clone
   writes upstream — most git-faithful on both ends; closes the latent
   normal-clone `[remote "origin"]` gap.
2. **OID passthrough + additive `merge.reflogLabel`** for the most git-faithful
   reflog/message (ADR-197). pull resolves the tip to an OID, passes a faithful
   commit message, and a `reflogLabel` so the reflog reads `pull:` exactly like
   git — merge stays the single integration engine.
3. **Broaden `merge.resolveTarget` to gitrevisions ref-DWIM** (ADR-199). Chosen
   alongside ADR-197 (user directive): `merge({ target: 'origin/main' })` now
   resolves like `git merge origin/main`, reusing rev-parse's candidate ladder
   (extracted to a shared helper) + tag peeling.
4. **Omit `rebase` until 22.3** (ADR-198). Alternative: present-but-throws.
   Chosen: omit — YAGNI, no dead path, add it with the feature.

## 11. Out of scope

- `--rebase` integration (22.3).
- Working-tree materialisation on FF/clean merge (20.1).
- `FETCH_HEAD` authoring (pull resolves the tracking ref directly).
- Revision **operators** in `merge.resolveTarget` (`~`, `^`, `@{…}`) — ref-DWIM
  only; operators stay `rev-parse`-only (§5.2).
- Multi-ref / multi-remote pulls, `pull --all`, tag-following nuances.
- git's "non-default remote requires explicit branch" arg-parsing nicety: pull
  defaults `branch` from `branch.<cur>.merge` regardless of which remote is
  named (documented simplification).
