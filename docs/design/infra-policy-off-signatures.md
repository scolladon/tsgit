# Design — infra/policy off op signatures

## Goal

An API **ergonomics + correctness** pass surfaced by the 23.4 API review
(findings **S4** and **S6**). Two pieces of **environment policy** currently
ride on **per-call command options**, where they don't belong:

| Finding | Policy                                              | Rides on (today)                        |
| ------- | --------------------------------------------------- | --------------------------------------- |
| **S4**  | `breakStaleLockMs` (stale-`index.lock` break window) | `AddOptions` / `MvOptions` / `RmOptions` |
| **S6**  | clone SSRF policy (`resolver` / `allowInsecure` / `allowPrivateNetworks`) | `CloneOptions`                          |

Both are **repository-environment policy**, not per-operation intent. Whether
this deployment may break a stale lock, reach `http://`, or talk to a private
network is a property of **how the repository was opened** — fixed for the
process — not something a caller re-decides on every `add` or `clone`. The pass
**removes** these fields from the per-call surfaces; the policy is set **once**,
at `openRepository(...)`, on `config` (the facade-tier `RepositoryConfig`).

Crucially, **every one of these fields already exists on `RepositoryConfig`**
(`config.breakStaleLockMs`, `config.allowInsecure`, `config.allowPrivateNetworks`,
`config.dnsResolver`) and is already validated by `validateOptions`. The per-call
copies are **redundant duplicates** that were never wired through the facade
(`repo.add` / `repo.clone` forward opts verbatim — they never inject `config`
into per-call opts). So this pass **deletes duplication**; it does not relocate a
unique capability.

This is a **breaking** change to callers (removed fields), which the 23.4 window
permits unconstrained — consistent with the clean breaks 23.4a/23.4d/23.4e
already took (no compat aliases).

## Faithfulness anchors (git)

Git-faithfulness binds **observable behaviour** — SHAs, refs, reflogs, on-disk
state, refusals. Neither half changes any of these **under the default**:

- **`breakStaleLockMs`** is a tsgit-specific extension with **no git analogue**:
  canonical git **never** auto-breaks `index.lock` — it always fails with
  "Another git process seems to be running…". tsgit's default is `undefined` ⇒
  strict `RESOURCE_LOCKED`, which *is* the git-faithful behaviour. Moving the
  knob from per-call to config does not change the default, so faithfulness is
  preserved: a repo opened without `config.breakStaleLockMs` behaves exactly
  like git everywhere.
- **clone SSRF** is a tsgit security guard, also with no git analogue. Removing
  the per-call options does not weaken it: the guard is enforced **repo-wide** by
  `wrapTransportValidator`, which `openRepository` already wraps around the
  transport from `config.{allowInsecure,allowPrivateNetworks,dnsResolver}`. The
  clone's first network request (`discoverRefs`) passes through that wrapper, so
  a blocked URL is still refused — just at the transport layer, the single
  enforcement point, rather than redundantly inside `clone`.

No new interop golden is required: there is no new observable behaviour to pin.
The pass is verified by the **type-checker** (removed fields flow through
`BindCtx<…>`), the **unchanged** unit/interop/parity suites, the existing
`wrap-transport-validator` SSRF unit suite, and `reports/api.json` regenerating
to the smaller surface.

## Decision 1 — `breakStaleLockMs`: repo-wide, read in `acquireIndexLock`

`breakStaleLockMs` is removed from `AddOptions` / `MvOptions` / `RmOptions`. The
**single** site that applies the stale-lock policy — `acquireIndexLock` (the
primitive-internal lock acquirer that already receives `ctx`) — reads the window
from `ctx.config?.breakStaleLockMs` when the caller does not pass an explicit
override:

```ts
const breakStaleLockMs = opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs;
```

add / mv / rm then call `acquireIndexLock(ctx)` with **no** lock options — the
policy flows in through `ctx.config`.

### Why read it in `acquireIndexLock` (the chosen shape)

- **DRY + single source of truth.** The lock acquirer is *the* place the
  stale-break policy is applied. Reading the policy there means every
  index-mutating command honours one repo-wide setting, instead of each command
  duplicating a `ctx.config?.breakStaleLockMs` read.
- **Consistent semantics.** Today only add/mv/rm honour the (per-call) knob;
  checkout / merge / rebase / reset / stash / cherry-pick / revert all call
  `acquireIndexLock(ctx)` and silently *never* break a stale lock. That split is
  surprising. After this pass, `config.breakStaleLockMs` is a genuine
  **repo-wide** policy: set it once and every index acquisition obeys it — which
  is exactly what "environment policy on the context" means.
- **Faithful default.** Reading `ctx.config?.breakStaleLockMs` with `undefined`
  default keeps every caller strict (git-faithful) unless the repo opts in.
- **Precedent.** Primitives already consult `ctx.config` for environment policy
  (`fetch-pack` reads `ctx.config?.maxResponseBytes` / `?.maxObjectsPerPack`);
  reading `?.breakStaleLockMs` in `index-lock` is the same established pattern,
  not a new cross-layer reach.
- **Precedence preserved.** `opts.breakStaleLockMs ?? ctx.config?.…` keeps an
  explicit per-call value winning. The three Tier-2 primitives
  (`stageEntry` / `unstageEntry` / `setEntryFlags`) still pass their own
  `breakStaleLockMs` option for now (they are **23.4g**'s audit scope, not this
  item's) and keep working unchanged — they override config when set, inherit it
  when not.

### Considered & rejected — read config in each command (B)

Have add/mv/rm each read `ctx.config?.breakStaleLockMs` and thread it to a still-
pure `acquireIndexLock`. Rejected: it duplicates the config read across three
commands, and it bakes in the surprising split (only those three honour the
policy; checkout/merge/etc. don't). It is strictly more code for a strictly
less-coherent semantics. (This is the load-bearing choice escalated to the ADR.)

## Decision 2 — clone SSRF: transport-wrapper only

`resolver` (`DnsResolver`), `allowInsecure`, and `allowPrivateNetworks` are
removed from `CloneOptions`, and the in-`clone` `validateUrl(...)` block (the
`if (opts.resolver !== undefined) { … }` guard) is deleted. The SSRF guard is
enforced **solely** by `wrapTransportValidator`, which `openRepository` already
wraps around `ctx.transport`, reading the policy from
`config.{allowInsecure,allowPrivateNetworks,dnsResolver}`.

### Why drop the in-clone path entirely

- It was **redundant defense-in-depth** that only fired for a hand-built Context
  passing `opts.resolver` — production callers (`openRepository`) always go
  through the transport wrapper, which validated the same URL on the
  `discoverRefs` request. The clone's own block's leading comment already
  documents it as the manual-Context-only path.
- It carried **two `Stryker disable` annotations** (the always-true ternary
  spreads on `allowInsecure`/`allowPrivateNetworks`) — equivalent-mutant noise
  that disappears with the block.
- The "validate up front, before any FS mutation" benefit is preserved by the
  existing rollback: a blocked URL throws inside `discoverRefs`
  (`fetchAndPropagate`), and `clone`'s `catch` already `rmRecursive`s the
  bootstrapped `.git`, leaving a clean workspace — so removing the early check
  does not leak a skeleton repo.
- **Single enforcement point.** SSRF policy now lives in exactly one place
  (`wrapTransportValidator`), the design's intent: a security boundary that a
  caller cannot accidentally bypass by reaching `commands.clone` directly without
  the wrapper is *by definition* a caller who built a raw Context and opted out
  of the guard — the same posture as `unsafeRawAdapters: true`.

`DnsResolver` stays defined in `internal/url-validate.ts` (its own
`UrlValidateOptions.resolver` still uses it) — only `clone.ts`'s
`import { type DnsResolver }` and the field go away. `DnsResolver` is an
`internal/` type, never on the barrel, so its api.json footprint is nil; the
api.json delta is purely the three removed `CloneOptions` fields.

## The removal table (the contract)

| Surface         | Field removed                                  | Now sourced from                          |
| --------------- | ---------------------------------------------- | ----------------------------------------- |
| `AddOptions`    | `breakStaleLockMs?`                             | `config.breakStaleLockMs` (via `acquireIndexLock`) |
| `MvOptions`     | `breakStaleLockMs?`                             | `config.breakStaleLockMs`                  |
| `RmOptions`     | `breakStaleLockMs?`                             | `config.breakStaleLockMs`                  |
| `CloneOptions`  | `resolver?` / `allowInsecure?` / `allowPrivateNetworks?` | `config.{dnsResolver,allowInsecure,allowPrivateNetworks}` (via `wrapTransportValidator`) |

`acquireIndexLock`'s `AcquireOptions.breakStaleLockMs` (and `now`) are
**retained** — the explicit per-call override is still the mechanism the three
Tier-2 primitives use, and the `now` clock is the test seam. Only the
**command** option fields move.

## Scope boundaries (deliberately out)

- **`config.breakStaleLockMs` / `config.allowInsecure` / `config.allowPrivateNetworks`
  / `config.dnsResolver`** — these are the **destination**, already present and
  validated. Untouched (the point of the pass is to make them the *only* home).
- **`index.node.ts`'s `allowInsecureHttp`** — a **separate** Node-HTTP-transport
  plaintext gate (forwarded to `NodeHttpTransport`), distinct from the SSRF
  `config.allowInsecure`. It already lives on `OpenNodeRepositoryOptions`
  (adapter creation), exactly where this pass says environment policy belongs.
  Not in scope, correct as-is.
- **`stageEntry` / `unstageEntry` / `setEntryFlags`'s `breakStaleLockMs`** — the
  Tier-2 primitive option surface is **23.4g**'s audit (is the primitive
  mutation surface a real extension point or git plumbing showing through?).
  These keep their explicit option here; they transparently gain the
  config-fallback via `acquireIndexLock`'s new `?? ctx.config?.…`. Folding them
  in would pre-empt 23.4g.
- **Other index-lock callers** (checkout/merge/rebase/reset/stash/cherry-pick/
  revert) — they call `acquireIndexLock(ctx)` and now transparently honour
  `config.breakStaleLockMs`. No signature change; behaviour-preserving under the
  `undefined` default. This is the *intended* consistency win, not a separate
  edit.

## Surface-gate impact

- **`reports/api.json`** regenerates — the four removed fields drop out;
  committed in-PR (the `check:doc-typedoc` prepush gate). A large typedoc-id
  reshuffle is expected and normal.
- **Docs** — `docs/use/commands/{add,mv,rm,clone}.md` carry the removed options;
  updated to point at `openRepository({ config })`. `docs/understand/security.md`
  (clone SSRF), `docs/understand/architecture.md`, and the relevant
  `docs/design/*` references are swept. The three `docs/use/primitives/*`
  (`stage-entry`/`unstage-entry`/`set-entry-flags`) keep their `breakStaleLockMs`
  documentation (still a primitive option).
- **Tests** — unit (`add`, `mv`, `rm`, `clone`, `validate-options`,
  `index-update`) that pass the removed per-call fields are updated: add/mv/rm
  tests that asserted per-call breaking move to a `config.breakStaleLockMs`
  context; the two in-`clone` SSRF tests (`resolver`-supplied blocked/public)
  are **deleted** (the path they cover is gone — equivalent coverage already
  lives in `wrap-transport-validator.test.ts`). `validate-options.test.ts` keeps
  its `config.breakStaleLockMs` validation cases unchanged.

## Test strategy

1. **Red first** per slice — proving a removed field no longer type-checks is not
   a meaningful test (it's a deletion); the behavioural discipline is:
   - **breakStaleLockMs (add/mv/rm):** add a unit test per command proving
     `config.breakStaleLockMs` drives stale-lock breaking **through the command**
     (Red: with the config wired but `acquireIndexLock` not yet reading it, a
     stale lock is *not* broken → `RESOURCE_LOCKED`; Green: `acquireIndexLock`
     reads `ctx.config?.breakStaleLockMs` and the stale lock breaks).
   - **clone SSRF:** the guard's behaviour is unchanged and already pinned by
     `wrap-transport-validator.test.ts` (blocked-host refusal) plus the
     integration network suites that clone through the wrapped transport. No
     clone-specific SSRF unit test is re-added — the two old ones exercised a
     deleted code path, not the wrapper. The Red/Green here is purely the
     deletion compiling clean (`check:types`) with the suite still green.
2. **Remove** the fields + the in-clone block; `npm run check:types` is the
   completeness oracle (every internal consumer must compile against the smaller
   surface).
3. Mechanically update / delete the affected test call sites + docs.
4. `npm run validate` (full suite + interop + parity) stays green — proving
   byte-for-byte unchanged behaviour under the default.
5. Regenerate `reports/api.json`.

Mutation testing re-runs against the new shape (Step 8). The two deleted
`Stryker disable` annotations in `clone.ts` vanish with the block — a net
suppression **reduction**. `acquireIndexLock`'s new `??` line gets an isolated
test (config-set → broken; config-unset → strict) so the `LogicalOperator`
mutant is killed.

## Decision summary (for ADR-267)

Two load-bearing choices, both resolved toward "**policy on the context, one
enforcement point**":

1. `breakStaleLockMs` → read in `acquireIndexLock` from `ctx.config`
   (repo-wide), not duplicated per command. (Decision 1.)
2. clone SSRF → transport-wrapper only; per-call `CloneOptions` fields +
   in-clone `validateUrl` deleted. (Decision 2.)
