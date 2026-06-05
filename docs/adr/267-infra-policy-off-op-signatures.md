# ADR-267: Infra/policy off per-call op signatures

## Status

Accepted (at `<sha>`)

## Context

The 23.4 API review (findings **S4**, **S6**) flagged two pieces of
**repository-environment policy** riding on **per-call command options**:

- **S4** — `breakStaleLockMs` (the stale-`index.lock` break window) on
  `AddOptions` / `MvOptions` / `RmOptions`.
- **S6** — the clone SSRF policy (`resolver` / `allowInsecure` /
  `allowPrivateNetworks`) on `CloneOptions`.

Both describe *how the repository is deployed* (may we break a stale lock? may we
reach `http://` or a private network?), not *what this one operation should do*.
That class of knob belongs on the context, fixed at `openRepository(...)` — not
re-decided on every call. Decisively, **all four values already exist on
`RepositoryConfig`** (`config.breakStaleLockMs`, `config.allowInsecure`,
`config.allowPrivateNetworks`, `config.dnsResolver`), already validated by
`validateOptions`, and the facade (`repo.add` / `repo.clone`) forwards per-call
opts **verbatim** — it never injects `config` into them. So the per-call fields
are **redundant duplicates**, not a unique capability that needs relocating.

Two load-bearing choices had to be settled:

1. **Where is `breakStaleLockMs` read** once off the command surface? In the
   single shared lock acquirer (`acquireIndexLock`, which already takes `ctx`),
   or duplicated in each of add/mv/rm?
2. **How far to remove the clone SSRF guard** — drop the public fields only
   (keeping an internal in-`clone` `validateUrl` for hand-built contexts), or
   delete the in-`clone` path entirely and rely on the transport wrapper?

Both fields' removal is **breaking** to callers; the 23.4 window permits this
unconstrained (no release-bundling), consistent with 23.4a/23.4d/23.4e.

## Decision

**1. `breakStaleLockMs` is read repo-wide in `acquireIndexLock`.** The field is
removed from `AddOptions` / `MvOptions` / `RmOptions`. `acquireIndexLock` — the
one site that applies the stale-break policy — resolves the window as
`opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs`. add/mv/rm call
`acquireIndexLock(ctx)` with no lock options; the policy flows through
`ctx.config`. Consequently **every** index-lock caller (checkout / merge /
rebase / reset / stash / cherry-pick / revert, alongside add/mv/rm) honours the
single repo-wide knob. The `opts`-first precedence keeps an explicit per-call
override winning, which is what the three Tier-2 primitives
(`stageEntry` / `unstageEntry` / `setEntryFlags`) still use — they are
**23.4g**'s audit scope and are left untouched here, transparently gaining the
config fallback.

**2. The clone SSRF guard is removed entirely from `clone`; the transport wrapper
is the sole enforcement point.** `resolver` / `allowInsecure` /
`allowPrivateNetworks` are removed from `CloneOptions`, and the in-`clone`
`if (opts.resolver !== undefined) { validateUrl(...) }` block is deleted. The
SSRF guard is enforced by `wrapTransportValidator`, which `openRepository`
already wraps around the transport using
`config.{allowInsecure,allowPrivateNetworks,dnsResolver}`. A blocked URL is still
refused on the clone's first request (`discoverRefs`); `clone`'s existing
rollback `rmRecursive`s the bootstrapped `.git` on that throw, so no skeleton
leaks. `DnsResolver` stays defined in `internal/url-validate.ts` (still used by
its own `UrlValidateOptions`); only `clone.ts`'s import + field go away.

These refine — they do not diverge from — the git-faithfulness prime directive
([ADR-226](226-git-faithfulness-prime-directive.md)): `breakStaleLockMs` and the
SSRF guard are both tsgit-specific extensions with **no git analogue** (git never
auto-breaks `index.lock`; git has no SSRF guard). Under the `undefined` /
unconfigured default, behaviour is byte-for-byte identical to git, so moving the
knobs to config changes no observable git behaviour.

## Consequences

### Positive

- **One home, one enforcement point** for each policy: `config.breakStaleLockMs`
  read in `acquireIndexLock`; SSRF in `wrapTransportValidator`. No duplicated
  reads, no second redundant guard.
- **Consistent repo-wide semantics** — `config.breakStaleLockMs` now governs
  *all* index mutations, not just three commands; the prior surprising split is
  gone.
- **Smaller, cleaner public surface** — four fields drop from `api.json`; two
  `Stryker disable` annotations in `clone.ts` vanish with the deleted block (net
  suppression reduction).
- **Established pattern** — primitives already read `ctx.config` for environment
  policy (`fetch-pack` → `maxResponseBytes` / `maxObjectsPerPack`); this extends
  it, no new cross-layer reach.

### Negative

- **Breaking** for any caller passing these per-call fields; no compat alias
  (24.x deprecation window only opens later). Migration: set them on
  `openRepository({ config })`.
- A caller who reaches `commands.clone` with a **hand-built** Context that did
  not wrap the transport gets no SSRF guard. This is intended (same posture as
  `unsafeRawAdapters: true`) but is a real reduction in defense-in-depth for that
  narrow path.

### Neutral

- The three Tier-2 primitives keep their `breakStaleLockMs` option (deferred to
  **23.4g**); precedence (`opts ?? config`) makes the coexistence well-defined.
- `index.node.ts`'s `allowInsecureHttp` (the Node-HTTP plaintext gate, distinct
  from the SSRF `config.allowInsecure`) is unaffected — it already lives at
  adapter creation, exactly where this ADR says such policy belongs.
