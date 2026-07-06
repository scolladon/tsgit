# Design — centralize current-branch / default-remote resolution

## Context

Two resolution idioms are hand-inlined across the command layer:

- **Resolution A — current branch from HEAD.** `readHeadRaw(ctx)` → `head.kind === 'symbolic' ? head.target : …`,
  then a per-consumer transform (full ref / short name / throw / fallback). Appears in `pull`, `push`, `branch`,
  `status`, `rebase`, `submodule`, each with a *slightly different* transform.
- **Resolution B — default remote.** `opts.remote ?? branch.<name>.remote ?? 'origin'` (tracking-aware) in `pull`
  and `submodule`; `opts.remote ?? 'origin'` (no tracking) in `fetch` and `push`.

Alongside them, `'refs/heads/'` is redefined as a local `const` **8×** (`pull`, `submodule`, `branch`, `push`,
`checkout`, `worktree`, `clone`, `refspec`) and `'origin'` is a bare literal **4×**.

This is a **behavior-preserving** refactor: extract shared units, migrate the consumers, change **no observable
behavior** (SHAs, refs, reflogs, refusal conditions, `StatusResult` shape, error types). No new external behavior is
introduced, so **no new faithfulness pinning is required** — the existing command + interop tests are the pins and
must stay green unchanged.

### Constraints that bind this change

1. **Git-faithfulness prime directive** (ADR-226, ADR-249). Observable data/on-disk state is byte-for-byte fixed.
   Every migration below carries a per-consumer identity argument. The library returns structured data; none of this
   touches rendered stdout.
2. **Resolution A is not one shape — it is (at least) three.** A short-name primitive is **not** a drop-in for the
   full-ref consumers, and even the two short-name consumers differ (see proof). Conflating them silently changes
   behavior. This design refuses a `currentBranchName` short primitive for exactly that reason.
3. **Resolution B differs by consumer.** `fetch`/`push` today ignore `branch.<name>.remote`. Making them
   tracking-aware is a **behavior change, out of scope** (own backlog + ADR). `fetch`/`push` must keep
   `opts.remote ?? 'origin'` semantics byte-for-byte and must **never** reach into tracking config.
4. **Internal surface only.** New symbols are internal building blocks. None may become a public export (no
   `api.json` / README-count / doc-coverage gate should trigger). Verified: `readHeadRaw`/`repo-state` is not
   re-exported by `src/index.ts` or `src/repository.ts`.

## The behavior-preservation proof

### The three shapes of Resolution A (verified against current code)

| Consumer | Current expression | Shape | Detached → |
|---|---|---|---|
| `status.ts:121` | `head.kind==='symbolic' ? head.target : undefined` | full ref, **no** prefix guard | `undefined` |
| `rebase.ts:456` | `head.kind==='symbolic' ? head.target : undefined` | full ref, **no** prefix guard | `undefined` |
| `branch.ts:66` | `head.kind==='symbolic' && head.target.startsWith(HEADS_PREFIX) ? head.target : undefined` | full ref, **with** guard | `undefined` |
| `push.ts:203-208` | requires `symbolic`, else `throw invalidOption(...)`; `branch = head.target` | full ref, **throws** | *refusal* |
| `pull.ts:101` | `head.kind==='symbolic' ? shortBranchName(head.target) : undefined` | short name, **no** guard | `undefined` |
| `pull.ts:102` | `head.kind==='symbolic' ? head.target : RefName.from('HEAD')` | full ref, `HEAD` fallback | `HEAD` |
| `submodule.ts:146-148` | `head.kind==='symbolic' && head.target.startsWith(HEADS_PREFIX) ? head.target.slice(...) : undefined` | short name, **with** guard | `undefined` |

The single invariant common to *all seven* rows is the atom **`symbolic ? target : undefined`**. Everything else
(prefix guard, short-name slice, throw, `HEAD` fallback) is a per-consumer transform layered on top. Therefore the
correct extraction is the atom plus pure transforms — **not** a fused short-name or guarded primitive that would
bake one consumer's transform into all of them.

Concretely, `status`/`rebase` differ from `branch` *only* by the prefix guard; `pull`'s short name differs from
`submodule`'s *only* by the prefix guard. Those guards are intentional per-consumer semantics (`branch` lists only
local branches; `status` reports whatever HEAD symbolically targets), not accidental duplication. Preserving them =
keeping each transform at its call site.

### The fetch/push no-tracking boundary (out of scope, must be preserved)

`fetch.ts:81` and `push.ts:111` are `opts.remote ?? 'origin'` — they do **not** consult `branch.<name>.remote`.
`defaultRemoteName` (tracking-aware) is therefore used by **pull + submodule only**. `fetch`/`push` change **only**
the literal `'origin'` → the shared `DEFAULT_REMOTE` constant (same string; zero tracking lookup). Whether their
divergence from canonical git is a bug is explicitly **not decided here**.

### Submodule HEAD-read equivalence (the one non-trivial mechanism change)

`submodule.ts:144` reads HEAD via `getRefStore(ctx).resolveDirect(HEAD_REF)`; every other consumer uses
`readHeadRaw(ctx)`. For **HEAD specifically** these are equivalent: both resolve the loose path `${gitDir}/HEAD`
and `parseLooseRef` it; a symbolic HEAD yields `{kind:'symbolic', target}` in both; HEAD is always present after the
repository assertion `submodule` already performed, so `resolveDirect`'s extra `missing` variant is unreachable.
Migrating `submodule` onto `currentBranchRef` (readHeadRaw-based) is thus behavior-preserving and drops a
`getRefStore` dependency. Pinned by the existing submodule init/sync interop tests. (A lower-risk alternative that
keeps `resolveDirect` is offered as a decision candidate.)

## Requirements

- One atom + thin composables covering Resolution A; one pure tracking-aware helper for Resolution B; one shared
  prefix constant and one shared remote-default constant.
- Every consumer's observable output is byte-identical (proven per-consumer below).
- `fetch`/`push` never gain a tracking lookup.
- All new symbols internal; no public-API surface change.
- New units unit-tested to 100% line/branch, mutation-resistant; existing interop/command tests untouched and green.

## Design

### New units (exact signatures + homes)

```ts
// src/domain/refs/ref-prefixes.ts            (domain constant, import directly — NOT via a public barrel)
export const HEADS_PREFIX = 'refs/heads/';

// src/domain/remote.ts                        (domain constant)
export const DEFAULT_REMOTE = 'origin';

// src/domain/refs/short-branch-name.ts        (pure RefName → short-name transform)
export const shortBranchName = (ref: RefName): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

// src/application/primitives/internal/repo-state.ts   (co-located with HeadState + readHeadRaw; stays internal)
export const branchRefFromHead = (head: HeadState): RefName | undefined =>
  head.kind === 'symbolic' ? head.target : undefined;

export const currentBranchRef = async (ctx: Context): Promise<RefName | undefined> =>
  branchRefFromHead(await readHeadRaw(ctx));

// src/application/commands/internal/default-remote.ts (pure; tracking-aware; pull + submodule ONLY)
export const defaultRemoteName = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  DEFAULT_REMOTE;
```

- `branchRefFromHead` is the atom; `currentBranchRef` is the read-once convenience for consumers that need HEAD
  **only** for the branch ref. Consumers that already hold `head` (they need it for something else) call the pure
  `branchRefFromHead(head)` to avoid a second `readHeadRaw`.
- `shortBranchName` returns `string` (a short branch name is not a full `RefName`); the non-prefixed input is
  returned unchanged, exactly reproducing `pull`'s current local helper.
- `defaultRemoteName` is a pure function over the already-parsed `ParsedConfig` — no `ctx`, no I/O, no second
  config read (both callers hold `config`). Its `branch !== undefined` guard matches `pull`'s existing
  `currentBranch !== undefined ?` guard and `submodule`'s inline guard exactly.

### Consumer migration — each with its identity argument

| Consumer | Reads HEAD only for branch? | Uses | Migration |
|---|---|---|---|
| `status` | no (needs `detached = head.kind==='direct'`) | `branchRefFromHead(head)` | keep `head`; `branch = branchRefFromHead(head)` |
| `rebase` | no (needs `head` for headCommit) | `branchRefFromHead(head)` | keep `head`; `branch = branchRefFromHead(head)` |
| `pull` | no (needs `fallbackRef`) | `branchRefFromHead` + `shortBranchName` + `defaultRemoteName` | see below |
| `branch` | yes | `currentBranchRef` + guard | `const ref = await currentBranchRef(ctx); currentTarget = ref !== undefined && ref.startsWith(HEADS_PREFIX) ? ref : undefined` |
| `push` | yes | `currentBranchRef` + throw + `DEFAULT_REMOTE` | `const ref = await currentBranchRef(ctx); if (ref === undefined) throw invalidOption(...); branch = ref` |
| `submodule` | yes (superproject) | `currentBranchRef` + guard + `defaultRemoteName` | see below |
| `fetch` | — | `DEFAULT_REMOTE` only | `remote = opts.remote ?? DEFAULT_REMOTE` |

**`pull.ts`** — drop local `HEADS_PREFIX` (27) and local `shortBranchName` (63-64); import the domain versions.
Keep the single `readHeadRaw` read; derive both branch shapes from one atom call:
```ts
const branchRef = branchRefFromHead(head);
const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;  // == pull.ts:101
const fallbackRef  = branchRef ?? RefName.from('HEAD');                                    // == pull.ts:102
const remote       = defaultRemoteName(config, opts.remote, currentBranch);               // == pull.ts:86-87
```
Identity: `branchRef` is `symbolic ? target : undefined`; the three derivations reproduce each original expression
verbatim. `shortMergeRef` (66-67, the undefined-tolerant merge-ref strip) is a *different* concern (merge ref, not
current branch) — **left untouched** in scope.

**`submodule.ts` (`resolveBaseUrl`, 144-150)** — drop local `HEADS_PREFIX` (72); import domain. Replace the
`resolveDirect` read:
```ts
const branchRef = await currentBranchRef(ctx);
const branch = branchRef !== undefined && branchRef.startsWith(HEADS_PREFIX)
  ? shortBranchName(branchRef) : undefined;                            // == submodule.ts:146-148
const remoteName = defaultRemoteName(config, undefined, branch);       // == submodule.ts:150
```
Identity: proven HEAD-read equivalence above; guard + `shortBranchName` reproduce the inline slice; `explicit =
undefined` reproduces the no-override remote lookup.

**`status.ts:121`** — `const branch = branchRefFromHead(head)`. `detached = head.kind === 'direct'` unchanged.
Identity: `readHeadRaw` returns only `symbolic|direct`, so `branchRefFromHead(head)` is `symbolic ? target :
undefined` verbatim; `head` is retained for `detached`.

**`branch.ts:66`** — import domain `HEADS_PREFIX`, drop local (58); `currentBranchRef(ctx)` + explicit guard.
Identity: `ref` is `undefined` iff HEAD not symbolic; `ref !== undefined && ref.startsWith(HEADS_PREFIX)` reproduces
`symbolic && target.startsWith` exactly. (If `branch` reads `head` for anything beyond the branch ref, use
`branchRefFromHead(head)` instead — to be confirmed at implement time; either way the expression is identical.)

**`push.ts:203-208 / 111`** — `currentBranchRef(ctx)`; `if (ref === undefined) throw invalidOption(<same args>)`;
`branch = ref`. Remote `opts.remote ?? DEFAULT_REMOTE`. Identity: `ref === undefined` iff `head.kind !== 'symbolic'`,
so the refusal fires on exactly the detached case with the identical error; `REFS_HEADS_PREFIX` (97) is retained
for refspec-dst extraction (283/506) — a **different** concern, out of scope.

**`rebase.ts:456`** — `const branch = branchRefFromHead(head)`; `head` retained (used for the head commit).
Identity: verbatim atom.

**`fetch.ts:81`** — `remote = opts.remote ?? DEFAULT_REMOTE`. Identity: constant swap only, no tracking.

### Optional constant-share migrations (behavior-preserving, low priority)

- **`stash-message.ts` `stashBranchLabel`** (exported, `string | undefined → string`): import `HEADS_PREFIX` (drop
  local 13) and optionally reuse `shortBranchName` for the slice, keeping the `NO_BRANCH` default and guard:
  `branchRef !== undefined && branchRef.startsWith(HEADS_PREFIX) ? shortBranchName(branchRef) : NO_BRANCH`.
  Identity: original is `startsWith ? slice : NO_BRANCH` with `undefined → NO_BRANCH`; the rewrite matches all three
  arms.
- **`submodule.ts` `headBranchName` (580)**: local pure helper defaulting to `''`; may import `HEADS_PREFIX` /
  `shortBranchName` for the strip, preserving its `''` default and defensive `target?.` guard.

These are **constant/strip sharing only** — not folded into `currentBranchRef`. Recommend including them (kills two
more `'refs/heads/'` duplicates) but they can be dropped without affecting the core.

### Sites deliberately NOT migrated (different concern)

`checkout.ts:50/76`, `worktree.ts:57`, `clone.ts:221`, `fetch.ts:350/386` (advertised-ref parsing),
`push.ts:283/506` (refspec-dst extraction), `refspec.ts:43` (`SHORT_FORM_PREFIX`, short-form *expansion*). These use
`'refs/heads/'` for refspec/worktree/advertisement purposes, not current-branch resolution. Adopting the shared
`HEADS_PREFIX` there is a pure constant swap but is a **separate constant-consolidation pass**; kept out to bound
this diff. Listed so their retention reads as deliberate, not an oversight.

### Net delta

Removed: 3 local `HEADS_PREFIX`/`REFS_HEADS_PREFIX` consts at resolution sites (pull, submodule, branch), 1 local
`shortBranchName` (pull), 4 inline `'origin'` literals, 6 inline `symbolic ? target : …` expressions, 2 inline
tracking-remote lookups. Added: 5 small internal units (2 constants, `shortBranchName`, `branchRefFromHead` +
`currentBranchRef`, `defaultRemoteName`). Net: fewer lines, one source of truth per idiom, no public surface change.

## Decision candidates

1. **Resolution-A primitive shape** *(recommended first)*
   - **(a) Full-ref atom + pure transforms** — `branchRefFromHead(head)` + `currentBranchRef(ctx)` + domain
     `shortBranchName(ref)`; each consumer keeps its guard/short/throw/fallback. **Recommended.** Only shape that
     preserves all seven divergent transforms byte-for-byte; smallest common denominator.
   - (b) Two primitives `currentBranchRef` (full) + `currentBranchName` (short). Rejected: the two short consumers
     (`pull` no-guard vs `submodule` guard) diverge, so a single short primitive silently changes one → **not
     behavior-preserving**.
   - (c) Short-only primitive, migrate `pull`+`submodule` only. Rejected for the same divergence; also leaves the
     full-ref duplication (status/rebase/branch/push) untouched.
   - *Tradeoff:* (a) is the only faithful full-coverage option; (b)/(c) trade faithfulness or coverage for a
     terser-looking API.

2. **Submodule HEAD-read mechanism** *(recommended first)*
   - **(a) Migrate `resolveDirect(HEAD)` → `currentBranchRef` (readHeadRaw).** Recommended: proven equivalent for
     HEAD, drops a `getRefStore` dependency, keeps `branchRefFromHead` cleanly typed to `HeadState`.
   - (b) Keep `resolveDirect`; widen `branchRefFromHead` param to `HeadState | ResolveDirectResult`. Lower mechanism
     risk (zero change to submodule's read path) at the cost of a wider, looser helper type.
   - *Tradeoff:* (a) is cleaner and pinned by existing interop tests; (b) is maximally conservative on the read path.

3. **`defaultRemoteName` shape** *(recommended first)*
   - **(a) Pure function over `ParsedConfig`** `(config, explicit, branch) → string`. Recommended: no I/O, no second
     config read (both callers hold `config`), trivially unit-testable, matches both call sites' guards exactly.
   - (b) `ctx`-taking Tier-2 primitive `(ctx, explicit, branch)` that reads config itself. Matches the "primitive"
     literal naming but double-reads config at both call sites (a perf/cleanliness regression; still
     behavior-preserving).
   - *Tradeoff:* both are faithful; (a) wins on purity/testability/no double-read.

4. **Constant homes** *(recommended first)*
   - **(a) `HEADS_PREFIX` in `src/domain/refs/`, `DEFAULT_REMOTE` in `src/domain/remote.ts`, imported directly (not
     via a re-exported public barrel).** Recommended: domain owns the git-defined ref namespace + remote default;
     direct import keeps them internal. *Must-verify at implement:* that the chosen module is not auto-surfaced into
     `api.json` via `domain/index`; if it is, import from the leaf module, don't add to the barrel.
   - (b) Co-locate both constants application-side next to the pure helpers. Simpler import graph; weaker on
     domain-ownership of invariants.

5. **Constant-migration scope** *(recommended first — forced-ish)*
   - **(a) Migrate only the resolution sites** (pull/submodule/branch). Recommended: bounded, every touched site is
     provably identical.
   - (b) Full 8-site `'refs/heads/'` consolidation (incl. refspec/checkout/worktree/clone/advertisement/dst). Broader
     and tangential; a separate constant-consolidation backlog.
   - *Tradeoff:* (b) is also behavior-identical but sprawls the diff beyond the resolution concern.

6. **`stashBranchLabel` / `headBranchName` consolidation** *(recommended first)*
   - **(a) Constant/strip share only** — import `HEADS_PREFIX` (+ optionally `shortBranchName`), preserve
     `NO_BRANCH`/`''` defaults and guards. Recommended: kills two more duplicates, provably identical.
   - (b) Leave both fully untouched. Zero risk, leaves duplication.

**Non-negotiable (not candidates — forced by faithfulness):**
- `fetch`/`push` keep `opts.remote ?? DEFAULT_REMOTE` inline and **never** call `defaultRemoteName` (no tracking
  lookup). Making them tracking-aware is a separate backlog + ADR.
- All new symbols are internal — no `api.json` / README-count / doc-coverage surface change.

## Test strategy

New unit tests (100% line/branch, mutation-resistant per project conventions — specific returned values, isolated
guard tests, no `toThrow(Class)`-only):

- **`branchRefFromHead`** — (i) symbolic head → returns the *exact* target `RefName`; (ii) direct head → `undefined`.
  Two isolated tests; assert the concrete ref value (kills "return target regardless" / "return undefined regardless"
  mutants).
- **`currentBranchRef`** — over an in-memory ctx: (i) symbolic `refs/heads/main` → `RefName('refs/heads/main')`;
  (ii) detached (direct) → `undefined`. Assert exact ref.
- **`shortBranchName`** — (i) `refs/heads/main` → `main`; (ii) nested `refs/heads/feature/x` → `feature/x` (kills
  slice off-by-one); (iii) non-prefixed input (`refs/tags/v1`) → returned unchanged (kills "always slice" mutant and
  documents the no-guard contract).
- **`defaultRemoteName`** — isolated per `??` level: (i) `explicit` present with tracking also set → `explicit`
  (kills precedence-swap mutants); (ii) no explicit, tracking present → tracking remote; (iii) no explicit, `branch`
  defined but no `branch.<name>.remote` → `'origin'`; (iv) `branch === undefined` → `'origin'` (kills the
  `branch !== undefined` guard mutant, proving it short-circuits before `config.branch?.get`); (v) both explicit and
  tracking absent → `'origin'`. Assert the literal `'origin'` to pin `DEFAULT_REMOTE`.
- **Constants** — `HEADS_PREFIX` `toBe('refs/heads/')`, `DEFAULT_REMOTE` `toBe('origin')` (single-source StringLiteral
  kill).

Property tests: **not warranted.** `shortBranchName` is a one-way strip (no serialize pair); `defaultRemoteName` is a
3-case precedence function (small enum → the parameterised example sweep above is clearer per the project's
"skip property tests for small enums" rule).

Behavior-preservation pins (existing, must stay green **unchanged** — they are the faithfulness proof):
- `pull` command + interop (tracking-remote resolution, current-branch derivation).
- `push` command + interop (detached-HEAD refusal → `invalidOption`; `opts.remote` default).
- `fetch` command + interop (`opts.remote` default, no tracking).
- `branch` (current-branch marker / listing), `status` (`StatusResult.branch` + `detached`).
- `submodule` init/sync interop (superproject branch → tracking remote → base URL).
- `rebase` (current-branch derivation).

No new interop/golden is needed: this refactor introduces no new external behavior.

## Slicing hint for the planner

1. Land the leaf units first, each with its unit tests (RED→GREEN): constants → `shortBranchName` →
   `branchRefFromHead` + `currentBranchRef` → `defaultRemoteName`.
2. Migrate the head-in-hand consumers (`status`, `rebase`, `pull`) using `branchRefFromHead`.
3. Migrate the branch-only consumers (`branch`, `push`, `submodule`) using `currentBranchRef`; migrate `pull` +
   `submodule` remote onto `defaultRemoteName`; swap `fetch`/`push` `'origin'` → `DEFAULT_REMOTE`.
4. Optional: `stashBranchLabel` / `headBranchName` constant-share.
Each step keeps `npm run validate` green; consumers migrate independently once the leaves exist.

## Out of scope

- Making `fetch`/`push` tracking-aware (behavior change → own backlog + ADR).
- Full 8-site `'refs/heads/'` constant consolidation (refspec expansion, worktree, clone/advertisement, refspec-dst).
- `shortMergeRef` (pull) — merge-ref resolution, not current-branch.
- Any new public export or `api.json` surface change.
