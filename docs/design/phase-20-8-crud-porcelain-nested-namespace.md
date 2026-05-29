# Design — Phase 20.8 CRUD-family porcelain → nested namespace

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.8** — _"Migrate CRUD-family porcelain (`repo.remote`,
`repo.branch`, `repo.tag`, `repo.sparseCheckout`) from action-discriminator
(ADR-175) to nested namespace (ADR-181). Mechanical: each
`repo.X({ kind: 'verb', ... })` becomes `repo.X.verb({ ... })`. Touches
porcelain dispatchers + every call site + docs. Marks ADR-175 Deprecated
when shipped."_

Pre-deciding ADRs (accepted at `ab51e0a`):

- **ADR-181** — nested-namespace porcelain for CRUD families. Supersedes
  ADR-175. Explicitly scopes 20.8 to migrate the four families "to match"
  the `repo.config` shape landed in 20.6. The chosen shape is a **plain
  namespace object literal (no callable parent)**: `repo.remote.add(...)`,
  `repo.branch.create(...)`, etc. — `repo.remote` is NOT callable.
- **ADR-175** — the action-discriminator shape this migration retires.
  Marked Deprecated when 20.8 ships.

## 1. Goal & Non-goals

### 1.1 Goal

Replace the action-discriminated facade methods `repo.remote`,
`repo.branch`, `repo.tag`, `repo.sparseCheckout` with nested-namespace
objects, exactly mirroring the `repo.config` structure shipped in 20.6:

| Family | Before (ADR-175) | After (ADR-181) |
|---|---|---|
| remote | `repo.remote({ kind: 'add', name, url })` | `repo.remote.add({ name, url })` |
| branch | `repo.branch({ kind: 'create', name })` | `repo.branch.create({ name })` |
| tag | `repo.tag({ kind: 'create', name })` | `repo.tag.create({ name })` |
| sparseCheckout | `repo.sparseCheckout({ action: 'set', patterns })` | `repo.sparseCheckout.set({ patterns })` |

The verb set per family is unchanged (no behaviour change, no new verbs):

- **remote** — `list`, `add`, `remove`, `rename`, `setUrl`, `show`
- **branch** — `list`, `create`, `delete`, `rename`
- **tag** — `list`, `create`, `delete`
- **sparseCheckout** — `list`, `set`, `add`, `reapply`, `disable`

Every existing per-verb behaviour, error code, refspec rule, ordering, and
git-faithful edge case is preserved byte-for-byte. The only change is the
**call shape** and the **type surface**.

### 1.2 Non-goals

- **No behaviour change.** Same writes, same errors, same results.
- **No new verbs.** Verb sets are frozen; new actions are out of scope.
- **`reflog` and `submodules` stay on the discriminator.** ADR-181 names
  exactly four families; `reflog` (read-mostly, sub-action shape) and
  `submodules` (different family) are explicitly out of scope.
- **No transition shim.** `repo.remote` becomes non-callable; the old
  `repo.remote({ kind })` form is removed outright (see §4, Decision 3).
  v2 is pre-release; breaking the call shape is in-contract.

## 2. The shape decision (recommendation)

ADR-181 says the four families migrate "to match" `repo.config`.
`repo.config` has two defining traits:

1. **Per-action concrete input types, no `kind` discriminator**
   (`ConfigGetInput`, `ConfigSetInput`, …).
2. **Per-action concrete result types, no `kind` discriminator**
   (`ConfigGetResult`, `ConfigSetResult`, …) — ADR-181 lists this as a
   first-class Positive ("Result types stay per-action … no
   discriminated-union narrowing needed at the call site").

A faithful "match" therefore strips the `kind` discriminator from **both**
the input AND the result of every verb. This is the recommended design and
the rest of this document assumes it. The alternative (keep `kind` on
results / thin-wrapper the existing discriminated function) is captured as
a rejected alternative in §4 and surfaced to the user as an ADR decision.

## 3. Type surface (recommended design)

Each family becomes a module of per-verb Context-aware functions plus a
namespace binder under `commands/internal/`, mirroring `config.ts` +
`internal/config-namespace.ts` exactly. The per-verb functions carry
`assertRepository` (and, for sparse-checkout, `assertSparseReady`)
individually — each function is independently correct, as in `config.ts`.

### 3.1 `remote`

```ts
// commands/remote.ts — shared value types unchanged
export interface RemoteInfo { /* unchanged */ }
export interface RemoteShow extends RemoteInfo { /* unchanged */ }

export interface RemoteListResult { readonly remotes: ReadonlyArray<RemoteInfo> }

export interface RemoteAddInput {
  readonly name: string;
  readonly url: string;
  readonly fetch?: string;
}
export interface RemoteAddResult { readonly remote: RemoteInfo }

export interface RemoteRemoveInput { readonly name: string }
export interface RemoteRemoveResult {
  readonly name: string;
  readonly removedTrackingRefs: ReadonlyArray<RefName>;
  readonly clearedBranches: ReadonlyArray<RefName>;
}

export interface RemoteRenameInput { readonly from: string; readonly to: string }
export interface RemoteRenameResult {
  readonly from: string;
  readonly to: string;
  readonly movedTrackingRefs: ReadonlyArray<RefName>;
  readonly rewrittenBranches: ReadonlyArray<RefName>;
}

export interface RemoteSetUrlInput {
  readonly name: string;
  readonly url: string;
  readonly push?: boolean;
}
export interface RemoteSetUrlResult { readonly remote: RemoteInfo }

export interface RemoteShowInput { readonly name: string }
export interface RemoteShowResult { readonly remote: RemoteShow }

export const remoteList: (ctx: Context) => Promise<RemoteListResult>;
export const remoteAdd: (ctx: Context, input: RemoteAddInput) => Promise<RemoteAddResult>;
export const remoteRemove: (ctx: Context, input: RemoteRemoveInput) => Promise<RemoteRemoveResult>;
export const remoteRename: (ctx: Context, input: RemoteRenameInput) => Promise<RemoteRenameResult>;
export const remoteSetUrl: (ctx: Context, input: RemoteSetUrlInput) => Promise<RemoteSetUrlResult>;
export const remoteShow: (ctx: Context, input: RemoteShowInput) => Promise<RemoteShowResult>;
```

```ts
// commands/internal/remote-namespace.ts
export interface RemoteNamespace {
  readonly list: () => Promise<RemoteListResult>;
  readonly add: (input: RemoteAddInput) => Promise<RemoteAddResult>;
  readonly remove: (input: RemoteRemoveInput) => Promise<RemoteRemoveResult>;
  readonly rename: (input: RemoteRenameInput) => Promise<RemoteRenameResult>;
  readonly setUrl: (input: RemoteSetUrlInput) => Promise<RemoteSetUrlResult>;
  readonly show: (input: RemoteShowInput) => Promise<RemoteShowResult>;
}
export const bindRemoteNamespace: (ctx: Context, guard: () => void) => RemoteNamespace;
```

### 3.2 `branch`

```ts
export interface BranchInfo { /* unchanged */ }
export interface BranchListResult { readonly branches: ReadonlyArray<BranchInfo> }

export interface BranchCreateInput {
  readonly name: string;
  readonly startPoint?: string;
  readonly force?: boolean;
}
export interface BranchCreateResult { readonly name: RefName; readonly id: ObjectId }

export interface BranchDeleteInput { readonly name: string; readonly force?: boolean }
export interface BranchDeleteResult { readonly name: RefName }

export interface BranchRenameInput {
  readonly from: string;
  readonly to: string;
  readonly force?: boolean;
}
export interface BranchRenameResult { readonly from: RefName; readonly to: RefName }

export interface BranchNamespace {
  readonly list: () => Promise<BranchListResult>;
  readonly create: (input: BranchCreateInput) => Promise<BranchCreateResult>;
  readonly delete: (input: BranchDeleteInput) => Promise<BranchDeleteResult>;
  readonly rename: (input: BranchRenameInput) => Promise<BranchRenameResult>;
}
```

`compareRefName` (exported for the equal-keys unit test) stays exported
from `branch.ts`.

### 3.3 `tag`

```ts
export interface TagInfo { /* unchanged */ }
export interface TagListResult { readonly tags: ReadonlyArray<TagInfo> }

export interface TagCreateInput {
  readonly name: string;
  readonly target?: string;
  readonly force?: boolean;
}
export interface TagCreateResult { readonly name: RefName; readonly id: ObjectId }

export interface TagDeleteInput { readonly name: string }
export interface TagDeleteResult { readonly name: RefName }

export interface TagNamespace {
  readonly list: () => Promise<TagListResult>;
  readonly create: (input: TagCreateInput) => Promise<TagCreateResult>;
  readonly delete: (input: TagDeleteInput) => Promise<TagDeleteResult>;
}
```

### 3.4 `sparseCheckout`

The discriminator was `kind: 'list' | 'applied'` — NOT 1:1 with the verb
(`set`/`add`/`reapply`/`disable` all returned `kind: 'applied'`). Under the
stripped shape, `list` returns the list result and the four mutators share
one `SparseCheckoutAppliedResult`:

```ts
export interface SparseCheckoutListResult {
  readonly cone: boolean;
  readonly patterns: ReadonlyArray<string>;
}
export interface SparseCheckoutAppliedResult {
  readonly cone: boolean;
  readonly materialized: number;
  readonly removed: number;
  readonly retained: ReadonlyArray<FilePath>;
}

export interface SparseCheckoutSetInput {
  readonly patterns: ReadonlyArray<string>;
  readonly cone?: boolean;
  readonly force?: boolean;
}
export interface SparseCheckoutAddInput {
  readonly patterns: ReadonlyArray<string>;
  readonly force?: boolean;
}
export interface SparseCheckoutReapplyInput { readonly force?: boolean }
export interface SparseCheckoutDisableInput { readonly force?: boolean }

export interface SparseCheckoutNamespace {
  readonly list: () => Promise<SparseCheckoutListResult>;
  readonly set: (input: SparseCheckoutSetInput) => Promise<SparseCheckoutAppliedResult>;
  readonly add: (input: SparseCheckoutAddInput) => Promise<SparseCheckoutAppliedResult>;
  readonly reapply: (input?: SparseCheckoutReapplyInput) => Promise<SparseCheckoutAppliedResult>;
  readonly disable: (input?: SparseCheckoutDisableInput) => Promise<SparseCheckoutAppliedResult>;
}
```

`reapply`/`disable` take an **optional** input (`force` is the only field);
`reapply()` / `disable()` must work argless.

## 4. Module structure & file layout

```
src/application/commands/
├── remote.ts            # per-verb fns + value/IO types (remoteList, remoteAdd, …)
├── branch.ts            # per-verb fns + types
├── tag.ts               # per-verb fns + types
├── sparse-checkout.ts   # per-verb fns + types
└── internal/
    ├── config-namespace.ts        # (existing — the template)
    ├── remote-namespace.ts        # NEW — RemoteNamespace + bindRemoteNamespace
    ├── branch-namespace.ts        # NEW
    ├── tag-namespace.ts           # NEW
    └── sparse-checkout-namespace.ts  # NEW
```

`commands/index.ts` drops `RemoteAction`/`RemoteResult`/`BranchAction`/…
and `remote`/`branch`/`tag`/`sparseCheckout` (the discriminated dispatchers)
and instead exports the per-verb input/result types, the per-verb functions,
and the four `bind*Namespace` + `*Namespace` types — exactly the config row's
shape.

`repository.ts`:

- The `Repository` interface drops the four `BindCtx<typeof commands.X>`
  lines and replaces them with `readonly remote: commands.RemoteNamespace;`
  (and the three siblings), next to the existing
  `readonly config: commands.ConfigNamespace;`.
- The four facade bindings (`remote: ((action) => …)`) are replaced with
  `remote: commands.bindRemoteNamespace(ctx, guard)` (and siblings),
  next to `config: commands.bindConfigNamespace(ctx, guard)`.

### Decision 1 — strip `kind` from results (RECOMMENDED) vs keep it

- **A (recommended):** per-verb concrete result types, no `kind`. Exact
  `repo.config` parity; honours ADR-181's stated Positive. Wider breaking
  change (result objects lose `kind`).
- **B:** keep `kind` on results; namespace methods return
  `Extract<OldResult, { kind: 'verb' }>`. Smaller diff (result objects
  unchanged) but retains the discriminated union ADR-181 rejected, and
  leaves a statically-redundant `kind` field on every result.

→ ADR (see §8). Recommend A.

### Decision 2 — full split vs thin wrapper

- **Full split (recommended, required by A):** delete the discriminated
  `remote(ctx, action)` dispatcher; export per-verb functions. Module
  structure matches `config.ts`.
- **Thin wrapper (only coheres with B):** keep `remote(ctx, action)`;
  the namespace builds `{ kind, ...input }` and forwards. Smaller module
  diff; keeps the dispatcher + discriminated types alive internally.

→ Coupled to Decision 1. Recommend full split.

### Decision 3 — non-callable namespace (no transition shim)

`repo.remote` becomes a plain object (ADR-181: "no callable parent"). The
old `repo.remote({ kind })` call form is **removed**, not deprecated at
runtime — keeping it callable would require the `function & { add, … }`
intersection ADR-181 explicitly rejected. ADR-175 is marked Deprecated
(doc status). v2 pre-release ⇒ a hard call-shape break is in-contract.

→ ADR (see §8). This is the conservative reading of ADR-181; surfaced for
confirmation rather than as an open trade-off.

### Decision 4 — audit coverage for namespaced commands

The harness audits (`tooling/check-doc-coverage.ts`,
`tooling/audit-browser-surface.ts`) parse `repository.ts` with
`TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</`. A namespace line
(`readonly remote: commands.RemoteNamespace;`) does NOT match `BindCtx<`,
so the four families fall **off** both audits — exactly as `repo.config`
already did silently in 20.6 (`config.md` exists but is not audit-enforced;
the doc-coverage allowlist is empty and `config` has no browser/parity
coverage requirement).

Options:

- **A (recommended):** follow the 20.6 `config` precedent — namespaces are
  invisible to the flat-command audits in 20.8. Keep the four `docs/use/
  commands/*.md` pages (they already exist) and update the browser/parity
  tests to the new call shape (still present, just no longer audit-gated).
  **Document the consequence explicitly** (no silent cap) and file a
  follow-up backlog item to teach the audits about namespaces (covering
  `config` + the four). Keeps 20.8 mechanical and scoped.
- **B:** extend both audit regexes now to recognise
  `readonly (\w+): commands.\w+Namespace`. Safe for doc-coverage (all
  pages exist; retroactively re-covers `config`). For browser-surface it
  also pulls in `config`, which has **no** browser/parity coverage —
  forcing either a new config scenario or a config allowlist entry (scope
  creep into 20.6 territory).

→ ADR (see §8). Recommend A + a follow-up backlog item.

## 5. Migration of consumers

### 5.1 Production (one file)

`src/repository.ts` only. No command composes another family internally
(verified: `commands.{remote,branch,tag,sparseCheckout}` appear nowhere
outside `repository.ts`).

### 5.2 Tests

Mechanical rewrites, `{ kind: 'verb', ...rest }` → `.verb({ ...rest })`
(and result assertions drop `.kind` under Decision A):

- **Unit:** `remote.test.ts`, `branch.test.ts`, `tag.test.ts`,
  `sparse-checkout.test.ts` call the command functions directly. They
  switch from `remote(ctx, { kind: 'add', … })` to `remoteAdd(ctx, { … })`.
- **Parity scenarios:** `remote-crud`, `branch-lifecycle`,
  `sparse-checkout` (+ any merge scenario touching `branch`) call
  `repo.X({ kind })` and assert on `result.kind`. Rewrite to
  `repo.X.verb(...)`; drop `.kind` assertions; update the scenario result
  golden types. The load-bearing `commit.id` parity assertions are
  unaffected (behaviour unchanged).
- **Browser:** `test/browser/surface-parity.spec.ts` declares a local
  `RepoLike` with callable `branch`/`tag` overloads; rewrite to namespace
  objects and update the call sites.
- **Integration:** `sparse-checkout.test.ts`, `sparse-reset-merge.test.ts`,
  merge integration tests touching `branch`/`tag`/`sparseCheckout`.
- **`repository.test.ts`:** any facade-surface assertions over the four.

### 5.3 Docs

- `docs/use/commands/{remote,branch,tag,sparse-checkout}.md` — rewrite
  every snippet to the namespace shape.
- `docs/use/recipes.md`, `docs/use/errors.md`,
  `docs/get-started/migrate-from-isomorphic-git.md` — snippet rewrites.
- `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md` — any snippet using the
  four; the `docs/understand/` pages if they reference the discriminator.

## 6. Testing strategy

- **Unit (per family):** every verb keeps its existing GWT/AAA tests,
  re-pointed at the new per-verb function. The guard-clause isolation,
  specific-error-data assertions, and equivalent-mutant annotations carry
  over verbatim. `assertRepository` per-verb gets one disposed/no-repo test
  per function (mirrors `config.ts`, which asserts per method).
- **Namespace binder unit tests:** mirror the `config-namespace` tests —
  assert each bound method (a) calls `guard()` before forwarding (disposed
  repo throws before any work) and (b) forwards to the right command. The
  returned namespace object is frozen (Object.freeze) — assert immutability.
- **Property tests:** none of the four families is a parser / decoder /
  matcher / round-trip pair (the four lenses in CLAUDE.md). They are
  command facades — integration/parity territory. No `*.properties.test.ts`
  is added; the gap is noted here per the CLAUDE.md contract.
- **Parity / interop:** unchanged behaviour ⇒ existing parity scenarios
  keep their golden `commit.id`; only the call shape in the driver changes.
- **Coverage / mutation:** 100% line/branch/function/statement and 0
  killable mutants on every touched module, same bar as `config`.

## 7. Risks & mitigations

- **Wide but mechanical diff.** Mitigation: one family per slice, validate
  green before each commit; the four families are independent.
- **Result-shape break ripples to scenario golden types.** Mitigation:
  Decision A is confirmed via ADR before implementation; scenario result
  interfaces are updated in the same slice as their driver.
- **Audit blind spot for namespaces (Decision 4A).** Mitigation: explicit
  doc note + a filed follow-up backlog item; the doc pages and
  browser/parity tests still exist and run.
- **`exactOptionalPropertyTypes`.** `reapply`/`disable` optional input and
  the `force`-omission helper (`applyOpts`) already handle this; preserved.

## 8. ADR decisions to surface

1. **Result shape** — strip `kind` (per-verb concrete results, config
   parity) [recommended] vs keep `kind` (thin-wrapper, smaller diff).
   Couples Decisions 1 + 2.
2. **Transition shim** — hard remove the callable form [recommended,
   conservative ADR-181 reading] vs keep `repo.remote({ kind })` working
   with a runtime deprecation warning (requires the rejected callable
   intersection).
3. **Audit coverage** — follow the `config` precedent (namespaces invisible
   to flat-command audits) + file a follow-up [recommended] vs extend the
   audits now (pulls in config browser-coverage work).

## 9. Backlog

Flip `docs/BACKLOG.md` **20.8** `[ ]` → `[x]` inside this PR. Mark ADR-175
`Status: Deprecated`. Append the new ADRs (192+) to the index.
