# Design — centralize current-branch / default-remote resolution (+ git-faithful fetch/push)

## Context

Backlog 26.2 began as a behavior-preserving refactor: extract the duplicated "current branch from
HEAD" and "default remote" idioms inlined across the command layer. During the ADR conversation the
scope grew — the user ratified correcting two long-standing divergences from canonical git that these
call sites had been papering over. The work now spans **three ADRs**:

- **ADR-456** — shared HEAD-branch / default-remote **primitives** + full 8-site `refs/heads/`
  constant consolidation + submodule read-path migration. **Behavior-preserving.**
- **ADR-457** — `fetch` default-remote becomes **tracking-aware** (`branch.<name>.remote`), matching
  `git fetch`. **Additive behavior change**, interop-pinned.
- **ADR-458** — `push` gains git-faithful **remote selection** (`pushRemote` / `remote.pushDefault`),
  a **`push.default` state machine**, upstream validation, and a **refusal matrix**, plus the config
  parsing those keys require. **Large additive behavior change**, interop-pinned.

These are three *layers on one diff*: ADR-456 is the reusable substrate; ADR-457 and ADR-458 build
their corrections on top of it and each carry their own byte-for-byte interop pins.

### Constraints that bind this change

1. **Git-faithfulness prime directive** (ADR-226, ADR-249). Observable data/on-disk state is
   byte-for-byte fixed. The ADR-456 primitives preserve it per-consumer (proof below); the ADR-457/458
   *behavior changes* are each pinned against real `git` — nothing here is designed from memory.
   Structured-output (ADR-249): the library returns error **codes + data** and structured refspec
   fields; git's stderr text is reconstructed *in the interop test*, never emitted by the library.
2. **Resolution A is not one shape — it is three** (full symbolic ref / short name / throw-on-detached).
   A short-name primitive is not a drop-in for the full-ref consumers. ADR-456 resolves this with a
   full-ref atom + pure transforms; each consumer keeps its own guard/short/throw/fallback.
3. **The `fetch`/`push` no-tracking boundary is deliberately DEMOLISHED** (reversing the original
   design). ADR-457 makes `fetch` tracking-aware; ADR-458 makes `push` fully git-faithful. This is the
   whole point of the scope-fold.
4. **Internal surface only** for the primitives + config parsing. New config *keys* surface as
   `ParsedConfig` fields (already a public type consumed by commands), but no new command-facade option
   or `api.json`/README-count/doc-coverage entry is added. The three new refusal **error codes** are
   part of the existing `CommandError` union (already public) — same surface class as every other error.

Git version pinned throughout: **git 2.55.0** (probes: scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`,
isolated `HOME`, signing off, `mktemp` throwaways).

---

## Part I — ADR-456 refactor (behavior-preserving substrate)

### The three shapes of Resolution A (verified against current code)

| Consumer | Current expression | Shape | Detached → |
|---|---|---|---|
| `status.ts:121` | `head.kind==='symbolic' ? head.target : undefined` | full ref, **no** guard | `undefined` |
| `rebase.ts:456` | `head.kind==='symbolic' ? head.target : undefined` | full ref, **no** guard | `undefined` |
| `branch.ts:66` | `symbolic && target.startsWith(HEADS_PREFIX) ? head.target : undefined` | full ref, **with** guard | `undefined` |
| `push.ts:203-208` | requires `symbolic`, else `throw invalidOption(...)`; `branch = head.target` | full ref, **throws** | *refusal* |
| `pull.ts:101` | `symbolic ? shortBranchName(head.target) : undefined` | short name, **no** guard | `undefined` |
| `submodule.ts:146-148` | `symbolic && target.startsWith(HEADS_PREFIX) ? target.slice(...) : undefined` | short name, **with** guard | `undefined` |

The single invariant common to all rows is the atom **`symbolic ? target : undefined`**. Everything
else (prefix guard, short-name slice, throw, `HEAD` fallback) is a per-consumer transform. The correct
extraction is the atom plus pure transforms — not a fused primitive baking one consumer's transform
into all of them.

### New units (exact signatures + homes — adopted per ADR-456)

```ts
// src/domain/refs/ref-prefixes.ts            (domain constant; import directly, NOT via a public barrel)
export const HEADS_PREFIX = 'refs/heads/';

// src/domain/remote.ts                        (domain constant)
export const DEFAULT_REMOTE = 'origin';

// src/domain/refs/short-branch-name.ts        (pure RefName → short-name transform)
export const shortBranchName = (ref: RefName): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

// src/application/primitives/internal/repo-state.ts   (co-located with HeadState + readHeadRaw; internal)
export const branchRefFromHead = (head: HeadState): RefName | undefined =>
  head.kind === 'symbolic' ? head.target : undefined;

export const currentBranchRef = async (ctx: Context): Promise<RefName | undefined> =>
  branchRefFromHead(await readHeadRaw(ctx));

// src/application/commands/internal/default-remote.ts (pure; tracking-aware; pull + submodule + fetch)
export const defaultRemoteName = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,          // SHORT name (config.branch is keyed by short name)
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  DEFAULT_REMOTE;
```

### Consumer migration — each with its identity argument

| Consumer | Uses | Migration (behavior-identical) |
|---|---|---|
| `status` | `branchRefFromHead(head)` | keep `head` (needs `detached`); `branch = branchRefFromHead(head)` |
| `rebase` | `branchRefFromHead(head)` | keep `head` (needs headCommit); `branch = branchRefFromHead(head)` |
| `pull` | atom + `shortBranchName` + `defaultRemoteName` | one `readHeadRaw`; derive `currentBranch`/`fallbackRef`/`remote` from it (== `pull.ts:101/102/86-87`) |
| `branch` | `currentBranchRef` + guard | `ref !== undefined && ref.startsWith(HEADS_PREFIX) ? ref : undefined` |
| `submodule` | `currentBranchRef` + guard + `defaultRemoteName` | replaces `resolveDirect(HEAD)` (proven equivalent for HEAD; drops `getRefStore` dep) |

**Submodule HEAD-read equivalence** (the one non-trivial mechanism change): `submodule.ts:144` reads
HEAD via `getRefStore(ctx).resolveDirect(HEAD_REF)`; every other consumer uses `readHeadRaw(ctx)`. For
HEAD specifically these are equivalent — both resolve `${gitDir}/HEAD` and `parseLooseRef` it; a
symbolic HEAD yields `{kind:'symbolic', target}` in both; HEAD is always present after the repository
assertion `submodule` already performed, so `resolveDirect`'s extra `missing` variant is unreachable.
Pinned by the existing submodule init/sync interop tests.

**Full 8-site `refs/heads/` consolidation** (ratified in ADR-456): migrate all sites that redefine the
prefix — `pull`, `push`, `branch`, `checkout`, `submodule`, `worktree`, `stash-message`, `refspec` —
onto the single `HEADS_PREFIX` (+ `shortBranchName` where they strip). `stash-message`'s
`stashBranchLabel` shares the constant + strip only, keeping its `NO_BRANCH` sentinel; `refspec.ts`'s
`SHORT_FORM_PREFIX` is the short-form *expansion* prefix — same literal, same constant, different
concern (kept as a constant swap only, its behavior untouched).

`fetch`/`push` are **not** covered by Part I's "behavior-preserving" clause for their *remote*
resolution — that is exactly what ADR-457/458 change (Parts II/III). Part I only swaps their
`'refs/heads/'` / `'origin'` literals for the shared constants where the meaning is unchanged.

---

## Part II — ADR-457: `fetch` tracking-aware default remote

**Today** (`fetch.ts:81`): `const remote = opts.remote ?? 'origin'` — ignores `branch.<name>.remote`.

**Pinned** (git 2.55.0): with `branch.main.remote=upstream`, `git fetch` (no repo arg) fetches
`upstream`; unset → `origin`; detached HEAD → `origin`.

**Design.** `fetch` reads HEAD and shares the ADR-456 tracking chain, exactly like `pull`:

```ts
const head = await readHeadRaw(ctx);
const branchRef = branchRefFromHead(head);
const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
const remote = defaultRemoteName(config, opts.remote, currentBranch); // opts.remote ?? branch.remote ?? origin
```

Detached ⇒ `currentBranch === undefined` ⇒ `defaultRemoteName` returns `opts.remote ?? DEFAULT_REMOTE`.
`fetch` gains one `readHeadRaw` call (it already reads `config` for the remote URL). No other fetch
logic changes.

Interop pins (Part V): {`branch.remote` set/unset} × {explicit remote / none} × {symbolic / detached}.

---

## Part III — ADR-458: git-faithful `push`

`git push` with **no `<refspec>`** does two independent resolutions: (1) pick the **remote**;
(2) pick/validate the **refspec** via `push.default`. tsgit today does neither — it hardcodes
`opts.remote ?? 'origin'` and always pushes the current-branch refspec (throwing only on detached).
This part specifies both, pinned exhaustively against git 2.55.0 (Part IV).

### III.1 Config-parser extension

`ParsedConfig` (`src/application/primitives/config-read.ts`) already models `branch.<name>.{remote,merge}`
and `remote.<name>.{url,pushUrl,fetch,…}`. Three keys must be added.

**`ParsedConfig` type deltas:**

```ts
// widen the branch entry:
readonly branch?: ReadonlyMap<string, {
  readonly remote?: string;
  readonly merge?: string;
  readonly pushRemote?: string;          // NEW — branch.<name>.pushRemote
}>;

// widen the push bucket (already exists for gpgSign):
readonly push?: {
  readonly gpgSign?: 'true' | 'false' | 'if-asked';
  readonly default?: PushDefaultMode;    // NEW — [push] default, canonicalized (tracking→upstream)
};

// NEW top-level scalar for the subsectionless [remote] section:
readonly remotePushDefault?: string;     // remote.pushDefault

// NEW exported enum:
export type PushDefaultMode = 'nothing' | 'current' | 'upstream' | 'simple' | 'matching';
```

**Parser changes (mirroring the existing lenient, key-lowercased style):**

1. **`mergeBranch`** (branch subsection) — add the `pushRemote` key alongside `remote`/`merge`. The
   existing handler matches `remote`/`merge` with exact-case `key === …`; the new key uses
   `key.toLowerCase() === 'pushremote'` (git keys are case-insensitive — the canonical config key is
   `pushRemote`, which the exact-case idiom would miss). Value `null` (valueless) skipped, like the
   siblings.
   > *Latent inconsistency flagged:* `remote`/`merge` use exact-case matching, so `branch.x.Remote`
   > would be dropped where git honors it. Out of scope to fix here; the new `pushRemote` uses the
   > faithful case-insensitive form.

2. **`remote.pushDefault`** — the subsectionless `[remote]` section is currently unrouted
   (`dispatchSection` routes `remote` **only** through `dispatchSubsection`, i.e. only when a
   subsection name is present). Add a subsectionless arm:
   `else if (sec.section === 'remote') mergeRemoteTopLevel(acc, sec);` and a new `mergeRemoteTopLevel`
   handler reading `pushdefault` → `acc.remotePushDefault = value`. **Per-remote `[remote "x"] pushDefault`
   is IGNORED** (pinned V6) — `mergeRemote` must not read it.

3. **`mergePush`** — extend to read `default`:
   `else if (key.toLowerCase() === 'default') { const m = parsePushDefault(value); if (m !== undefined) push.default = m; }`
   with a total classifier:
   ```ts
   const parsePushDefault = (value: string | null): PushDefaultMode | undefined => {
     if (value === 'tracking') return 'upstream';          // deprecated alias (pinned V1)
     if (value === 'nothing' || value === 'current' || value === 'upstream'
       || value === 'simple'  || value === 'matching') return value;
     return undefined;                                      // present-but-invalid → see III.1a
   };
   ```
   **Value is case-SENSITIVE** (pinned V3: `Simple` is rejected) — do NOT lowercase the value.

4. **`finalize`** — the `push` bucket is already carried through `finalizeSigningBuckets`; widening its
   shape needs no finalize logic change beyond the type. `remotePushDefault` is a new top-level scalar:
   add it to `MutableParsedConfig`, to `finalize`'s local `out` type, and
   `if (acc.remotePushDefault !== undefined) out.remotePushDefault = acc.remotePushDefault;`.

The **default** `push.default = simple` (pinned V4) is applied at *read* time by the push command
(`config.push?.default ?? 'simple'`), never stored — absent stays `undefined`, faithful to the parser's
"only store what's present" invariant.

#### III.1a Invalid `push.default` value (decision candidate — faithful refusal)

Pinned (V2/V3): an unrecognized value (including wrong case) is a **hard error**, not a lenient
fallback:

```
error: malformed value for push.default: <v>
error: must be one of nothing, matching, simple, upstream or current
fatal: bad config variable 'push.default' in file '<path>' at line <N>
```

`parsePushDefault` returning `undefined` on assembly is *lenient* (would silently behave as `simple`) —
a **divergence** from git. To stay faithful, push must validate on the refusal/resolution path using
the cached **token** stream (which carries line numbers), mirroring `findFirstValuelessEntry` /
`findFirstInvalidCompression`: a new `findInvalidPushDefault(ctx)` cold-path finder + an early
`assertValidPushDefault(ctx)` in `push`. See Decision candidate 3 for the error code.

### III.2 Push remote-selection chain

Pinned order (P1–P3, T1–T2, S-B, S-G, E1–E2, D0–D1). A **new pure function** parallel to
`defaultRemoteName`:

```ts
// src/application/commands/internal/default-remote.ts (co-located; pure over ParsedConfig)
export const resolvePushRemote = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,          // SHORT name; undefined on detached HEAD
): string =>
  explicit
  ?? (branch !== undefined ? config.branch?.get(branch)?.pushRemote : undefined)
  ?? config.remotePushDefault
  ?? (branch !== undefined ? config.branch?.get(branch)?.remote : undefined)
  ?? DEFAULT_REMOTE;
```

- **Symbolic:** `opts.remote ?? branch.<cur>.pushRemote ?? remote.pushDefault ?? branch.<cur>.remote ?? origin`.
- **Detached** (`branch === undefined`): the two `branch !==` guards short-circuit, leaving
  `opts.remote ?? remote.pushDefault ?? origin` — exactly ADR-458's detached rule (branch.* excluded).
  Pinned by D0 (→origin) and D1 (pushDefault→pushdef).

### III.3 `push.default` state machine + refusal matrix

Let `pushRemote = resolvePushRemote(...)`, `fetchRemote = defaultRemoteName(config, undefined, cur)`
(= `branch.<cur>.remote ?? origin`), and **`triangular = pushRemote !== fetchRemote`** (pinned: E1/E2,
S-B vs U0, S-G, T1/T2). `merge = branch.<cur>.merge` (full ref, e.g. `refs/heads/other`);
`cur` = short current-branch name; `branchFull = refs/heads/<cur>`.

**When an explicit `opts.refspecs` is given, `push.default` is IGNORED entirely** (pinned X1) — the
existing `resolveRefspecsInput` explicit path is unchanged, and a **detached** HEAD with an explicit
refspec pushes normally (pinned X2). The matrix below applies **only** to the no-explicit-refspec case.
Remote selection (III.2) always applies.

| `push.default` | detached, no refspec | symbolic, no refspec | refspec pushed | refusal condition |
|---|---|---|---|---|
| **nothing** | refuse `NOTHING` | refuse `NOTHING` | — | always (before contacting remote) |
| **current** | refuse `DETACHED` | push `branchFull:branchFull` | `refs/heads/<cur>:refs/heads/<cur>` | detached only |
| **upstream** | refuse `DETACHED` | see tree ↓ | `branchFull:<merge>` | `DETACHED` / `TRIANGULAR` / `NO_UPSTREAM` |
| **simple** | refuse `DETACHED` | see tree ↓ | triangular: `branchFull:branchFull`; central: `branchFull:<merge>` | `DETACHED` / `NO_UPSTREAM` / `SIMPLE_MISMATCH` |
| **matching** | expand ↓ (HEAD-independent) | expand ↓ | one `refs/heads/<b>:refs/heads/<b>` per match | none (empty match set ⇒ nothing to push) |

**upstream** decision tree (pinned U0–U3, T1/T2, S-D, S-F, V1):
```
if detached                       → refuse DETACHED
elif triangular                   → refuse TRIANGULAR        (fires even when merge IS set — pinned T1/T2)
elif merge is unset               → refuse NO_UPSTREAM
else                              → push refs/heads/<cur> : <merge>
```
> The triangular check **dominates** the no-upstream check: S-D (triangular + no merge) refuses
> `TRIANGULAR`, not `NO_UPSTREAM`. This reorders git's literal source order but is **observationally
> identical** across all pinned cells (proven by Part IV + interop). `push` models a single `merge`
> value; git's `branch.merge_nr != 1` "multiple upstream branches" refusal is **out of scope** (tsgit's
> `ParsedConfig.branch.merge` is a single string — a pre-existing modeling limitation, flagged).

**simple** decision tree (pinned U0–U3, T1/T2, S-A/C/E/G, E1/E2/E4, V4):
```
if detached                       → refuse DETACHED
elif triangular                   → push refs/heads/<cur> : refs/heads/<cur>   (current-like; NO upstream needed)
elif merge is unset               → refuse NO_UPSTREAM
elif shortBranchName(merge) != cur → refuse SIMPLE_MISMATCH
else                              → push refs/heads/<cur> : <merge>            (== :refs/heads/<cur>)
```

**current**: `if detached → refuse DETACHED; else push refs/heads/<cur> : refs/heads/<cur>` — never
consults upstream/triangular (pinned U0–U3, T1/T2).

**matching** (pinned U0–U3, T1/T2, D0/D1, V7): **HEAD-independent** — works on a detached HEAD (D0
pushed `feature`+`main`). For each local `refs/heads/<b>` **that is advertised by the push remote**,
push `refs/heads/<b>:refs/heads/<b>`. This is a **refspec expansion computed against the wire
advertisement**, not local config (V7: a local branch absent on the remote is not pushed).

**nothing** (pinned U0–T2, D0/D1): always refuses `NOTHING`, before the remote is contacted
(`resolved-To` empty in every cell).

### III.4 Error taxonomy mapping

| Refusal | git 2.55.0 stderr (shape) | tsgit error data |
|---|---|---|
| `NO_UPSTREAM` | `fatal: The current branch <b> has no upstream branch.` | **reuse** `noUpstreamConfigured(branchFull)` → `{ code:'NO_UPSTREAM_CONFIGURED', branch: RefName }` (already thrown by `pull`; `branch` = full ref, matching `pull`'s usage) |
| `SIMPLE_MISMATCH` | `fatal: The upstream branch of your current branch does not match the name of your current branch.` | **new** `{ code:'PUSH_UPSTREAM_NAME_MISMATCH', branch: RefName, upstream: RefName }` |
| `TRIANGULAR` | `fatal: You are pushing to remote '<r>', which is not the upstream of your current branch '<b>', without telling me what to push …` | **new** `{ code:'PUSH_REMOTE_NOT_UPSTREAM', remote: string, branch: RefName }` |
| `NOTHING` | `fatal: You didn't specify any refspecs to push, and push.default is "nothing".` | decision candidate 3 |
| `DETACHED` | `fatal: You are not currently on a branch.` | decision candidate 3 (today: `invalidOption('refspecs','no-default-refspec (HEAD is detached)')`) |
| invalid `push.default` | `fatal: bad config variable 'push.default' in file '<f>' at line <N>` | decision candidate 3 |
| `remote.pushDefault` → unknown remote | `fatal: '<r>' does not appear to be a git repository` | **existing** `resolveRemoteUrl` → `remoteNotConfigured('<r>')` (pinned V5; the resolved name flows into the pre-existing URL-resolution path) |

### III.5 Architectural integration (the matching split)

Today `push` resolves refspecs **before** opening the session (`resolveRefspecsInput` in `pushViaSession`).
`matching` cannot: it needs `discoverReceivePackRefs(session).refs` (the advertisement). The pipeline
therefore splits refspec resolution into **plan → finalize**:

```ts
type PushRefspecPlan =
  | { kind: 'explicit';  refspecs: ReadonlyArray<ParsedRefspec> }   // opts.refspecs given (push.default ignored)
  | { kind: 'fixed';     refspecs: ReadonlyArray<ParsedRefspec> }   // simple/current/upstream → one refspec
  | { kind: 'matching' };                                            // deferred; expanded post-advertisement
```

- **`planPushRefspecs(ctx, config, opts, head)`** runs **before** the session and throws the *early*
  refusals it can prove from local state: `NOTHING`, `DETACHED`, `NO_UPSTREAM`, `SIMPLE_MISMATCH`,
  `TRIANGULAR`, and (III.1a) invalid `push.default`. Returns `explicit` / `fixed` / `matching`.
- **`finalizePushRefspecs(plan, adv, localHeads)`** runs **inside `negotiateAndSend`** after
  `discoverReceivePackRefs`. `explicit`/`fixed` pass through unchanged; `matching` expands against
  `adv.refs ∩ localHeads` (each `refs/heads/<b>:refs/heads/<b>`). `matching` needs the **local branch
  list** — a new `refs/heads/*` enumeration (via the existing ref store); note this added read.
- Everything downstream (`resolveAllRefspecs`, force/lease, pack build, report-status, tracking-cache)
  is unchanged — it already operates on a `ReadonlyArray<ParsedRefspec>`.

`resolveRemoteUrl` keeps its `REMOTE_NAME_RE` guard and valueless-config assertion; `remoteName` is now
the output of `resolvePushRemote` instead of `opts.remote ?? 'origin'`.

---

## Part IV — Pinned real-git matrix (git 2.55.0, scrubbed env, `--dry-run`)

Remotes: `origin`/`upstream`/`pushdef`/`pushrem` are four distinguishable bares; the "To …" line names
the contacted remote; the `<src> -> <dst>` line names the refspec. (Non-fast-forward rejections are
transport-layer artifacts of divergent seeds — they confirm git got *past* selection to the wire.)

### Remote selection (no refspec)
| Case | config | resolved remote |
|---|---|---|
| P1 | `branch.remote=upstream` | `upstream` |
| P2 | + `remote.pushDefault=pushdef` | `pushdef` |
| P3 | + `branch.pushRemote=pushrem` | `pushrem` (pushRemote wins) |
| P4 / U0 | nothing | `origin` |
| D0 | detached, nothing | `origin` |
| D1 | detached + `remote.pushDefault=pushdef` (+branch.* set) | `pushdef` (branch.* excluded) |
| E1 | explicit `origin` | `origin` |

### `push.default` × config × HEAD (no refspec) — outcome
| Cell | mode | config | HEAD | outcome |
|---|---|---|---|---|
| nothing/* | nothing | any | any | **refuse** `You didn't specify any refspecs … push.default is "nothing"` |
| current U0–U3 | current | any (remote/merge) | symbolic | push `main->main` to selected remote |
| current T1/T2 | current | pushDefault=pushdef / pushRemote=pushrem | symbolic | push `main->main` to pushdef / pushrem |
| current D0/D1 | current | — | detached | **refuse** `You are not currently on a branch.` |
| upstream U1 | upstream | remote=origin, merge=refs/heads/main | symbolic | push `main->main` |
| upstream U2 | upstream | remote=origin, merge=refs/heads/other | symbolic | push `main->other` (no name check) |
| upstream U0/U3 | upstream | no merge (central) | symbolic | **refuse** `has no upstream branch` |
| upstream T1/T2 | upstream | merge set, triangular | symbolic | **refuse** `not the upstream of your current branch` |
| upstream S-D | upstream | no merge, triangular (pushDefault=pushdef) | symbolic | **refuse** `not the upstream` (triangular dominates) |
| upstream S-F | upstream | merge=main, pushRemote=origin (central) | symbolic | push `main->main` |
| upstream V1 | `tracking` alias | remote=origin, merge=refs/heads/other | symbolic | push `main->other` (⇒ tracking == upstream) |
| simple U1 | simple | remote=origin, merge=refs/heads/main (central) | symbolic | push `main->main` |
| simple U2 | simple | remote=origin, merge=refs/heads/other (central) | symbolic | **refuse** `does not match the name of your current branch` |
| simple U0/U3 | simple | no merge (central) | symbolic | **refuse** `has no upstream branch` |
| simple T1/T2 | simple | triangular (pushDefault=pushdef / pushRemote=pushrem) | symbolic | push `main->main` to pushdef / pushrem |
| simple S-B | simple | remote unset, pushDefault=pushdef (triangular) | symbolic | push `main->main` to pushdef |
| simple S-G | simple | remote=pushdef, merge=main (central, push==fetch) | symbolic | push `main->main` to pushdef |
| simple E4 | simple | explicit `origin`, merge=other (central) | symbolic | **refuse** `does not match` |
| simple D0/D1 | simple | — | detached | **refuse** `You are not currently on a branch.` |
| matching U*/T* | matching | any | symbolic | push every local `refs/heads/<b>` advertised by the remote |
| matching D0 | matching | — | detached | push `feature->feature` + `main->main` (HEAD-independent) |
| matching V7 | matching | local main+feature, only main on remote | symbolic | push `main->main` only |
| X1 | any | explicit `origin main` | symbolic | push `main->main` (push.default ignored) |
| X2 | any | explicit `origin HEAD:refs/heads/main` | detached | push `HEAD->main` (push.default ignored) |

### Value parsing
| Case | `push.default` value | result |
|---|---|---|
| V1 | `tracking` | alias for `upstream` |
| V2 | `bogus` | **fatal** `bad config variable 'push.default' in file … at line N` |
| V3 | `Simple` | **fatal** (same) — value is case-sensitive |
| V4 | *(unset)* | behaves as `simple` |
| V6 | `[remote "origin"] pushDefault=x` | **ignored** (only top-level `[remote] pushDefault` is read) |

---

## Part V — Interop test matrix

Fetch/push interop lives in the `git-http-backend` harness (`test/integration/network/*-http-backend.test.ts`,
`@proves` docblocks, `runGit`/`runGitEnv`, `SOURCE_GIT`, goldens computed **signing off**). Each case
runs the twin (real git vs tsgit) against the same bare backend(s) and asserts the **observable data**:
which remote's bare repo received which refs (or, on refusal, the tsgit error **code + data**, with
git's stderr reconstructed from those fields per ADR-249). Remote-selection cases need **2–3 backend
bares** to distinguish the contacted remote.

### `fetch`-interop (ADR-457)
1. `branch.remote=<upstreamBare>`, no explicit remote, symbolic HEAD → fetched refs land from the
   upstream bare (not origin).
2. `branch.remote` unset, symbolic → fetches origin.
3. explicit `opts.remote` overrides `branch.remote`.
4. detached HEAD, `branch.remote` set → fetches origin (branch.remote ignored).

### `push`-interop (ADR-458) — remote selection
5. `branch.pushRemote` wins over `remote.pushDefault` wins over `branch.remote` wins over origin
   (assert which bare received the push).
6. detached + `remote.pushDefault` set + `branch.*` set → pushes the pushDefault bare (branch.* excluded).

### `push`-interop (ADR-458) — `push.default` success paths
7. `current` symbolic → `main:main`; `current` + `pushRemote` → same, to the pushRemote bare.
8. `upstream`, merge=`refs/heads/other`, central → pushes `main:other`.
9. `simple`, merge=main, central → `main:main`.
10. `simple` triangular (pushDefault ≠ branch.remote) → `main:main` to the push bare (current-like).
11. `matching`, two local branches both present on remote → both pushed; a third local branch absent on
    remote → not pushed (V7).
12. `matching` on **detached** HEAD → still expands and pushes matching branches.
13. explicit refspec on detached HEAD → pushes (push.default ignored).
14. `tracking` alias behaves as `upstream`.

### `push`-interop (ADR-458) — refusal conditions (assert error **code + data**, not just throw)
15. `simple`/`upstream`, no `branch.merge`, central → `NO_UPSTREAM_CONFIGURED { branch: refs/heads/<cur> }`.
16. `simple`, merge name mismatch, central → `PUSH_UPSTREAM_NAME_MISMATCH { branch, upstream }`.
17. `upstream`, triangular (merge set) → `PUSH_REMOTE_NOT_UPSTREAM { remote, branch }`.
18. `upstream`, triangular + no merge → `PUSH_REMOTE_NOT_UPSTREAM` (triangular dominates — pin S-D).
19. `current`/`simple`/`upstream` on detached HEAD → `DETACHED` refusal (code per decision 3).
20. `nothing` → `NOTHING` refusal (code per decision 3), remote not contacted.
21. invalid `push.default` value (and wrong-case `Simple`) → config refusal with key/source/line
    (code per decision 3).
22. `remote.pushDefault` naming an unconfigured remote → `REMOTE_NOT_CONFIGURED { remote }` (V5).

Each refusal case is a distinct `it` (per the "isolated guard tests" convention) so one mutant can't
be killed by a sibling.

---

## Part VI — Unit test strategy

New pure units at 100% line/branch, mutation-resistant (specific returned values; isolated `??`-level
tests; try/catch + `.data` assertions for errors; no `toThrow(Class)`-only):

- **`branchRefFromHead`** — symbolic → exact target; direct → `undefined` (two isolated tests).
- **`currentBranchRef`** — over in-memory ctx: symbolic → exact `RefName`; detached → `undefined`.
- **`shortBranchName`** — `refs/heads/main`→`main`; nested `refs/heads/feature/x`→`feature/x`
  (kills slice off-by-one); non-prefixed `refs/tags/v1`→unchanged (kills "always slice").
- **`defaultRemoteName`** — isolated per `??` level (explicit>tracking>origin; `branch===undefined`
  short-circuit; assert literal `'origin'`).
- **`resolvePushRemote`** — isolated per level: explicit; `pushRemote`; `remotePushDefault`;
  `branch.remote`; `DEFAULT_REMOTE`; **detached (`branch===undefined`)** proving `pushRemote` and
  `branch.remote` are skipped but `remotePushDefault` survives (kills the two guard mutants).
- **`parsePushDefault`** — each valid value → itself; `tracking`→`upstream`; `Simple`/`bogus`→`undefined`
  (case-sensitivity + alias mutants).
- **push.default dispatcher** (`planPushRefspecs` mode logic) — one test per matrix cell in Part IV,
  driven from an in-memory ctx (the refusal *conditions* especially: triangular-dominates, name-mismatch,
  detached-per-mode, matching-detached). These complement — never replace — the interop pins.
- **config parser** — `branch.x.pushRemote` parsed; `[remote] pushDefault` parsed; `[remote "x"] pushDefault`
  ignored (V6); `push.default` enum incl. `tracking`; absent `push.default` → `undefined`.
- **Constants** — `HEADS_PREFIX` `toBe('refs/heads/')`, `DEFAULT_REMOTE` `toBe('origin')`.

Property tests: not warranted — `shortBranchName` is a one-way strip; the remote chains and `push.default`
dispatcher are small precedence/enum functions (the project's "skip property tests for small enums" rule).

Behavior-preservation pins (Part I) — existing `pull`/`branch`/`status`/`rebase`/`submodule` command +
interop tests stay green **unchanged**.

---

## Part VII — Slicing hint for the planner

Push is large; partition along the pinned seams so each part is independently green + interop-pinnable:

1. **Leaf units (Part I).** Constants → `shortBranchName` → `branchRefFromHead`/`currentBranchRef` →
   `defaultRemoteName`, each with unit tests. (ADR-456 substrate.)
2. **ADR-456 migrations.** Head-in-hand consumers (`status`, `rebase`, `pull`); then branch-only
   (`branch`, `push`-detached-atom, `submodule`); full 8-site `refs/heads/` consolidation. Behavior-preserving.
3. **ADR-457 fetch.** `fetch` onto the tracking chain + its 4 interop cases.
4. **Config parsing (ADR-458 infra).** `ParsedConfig` deltas + `mergeBranch.pushRemote` +
   `mergeRemoteTopLevel` + `mergePush.default` + `parsePushDefault` + finalize; parser unit tests. No
   behavior change to any command yet.
5. **Push remote chain.** `resolvePushRemote` + wire `push` onto it (still current-branch refspec) +
   remote-selection interop (cases 5–6). Isolated, easily pinned.
6. **`push.default` modes — incrementally.** (a) `current`; (b) `nothing`; (c) `upstream` (+triangular
   +no-upstream); (d) `simple` (+triangular-current +mismatch); (e) `matching` (needs the plan/finalize
   split of III.5 + local-head enumeration). Each mode is its own part with its success + refusal
   interop cells.
7. **Refusal-data + invalid-`push.default`.** New error codes (decision 3) + `findInvalidPushDefault`
   cold-path + refusal-data interop (cases 15–22).

Parts 1–3 are behavior-preserving/ADR-457-additive and can land ahead of the heavy push work; parts 4–7
are the ADR-458 body. The III.5 plan/finalize refactor should land with part 6(e) at the latest (only
`matching` needs it), but landing it in 6(a) keeps every subsequent mode a pure addition to the dispatcher.

---

## Decision candidates

ADR-456 (primitive shapes, `defaultRemoteName` purity, constant homes, full-consolidation scope,
submodule read-path), ADR-457 (fetch chain), and ADR-458 (push chain, `push.default` semantics, config
keys) are **already decided**. The choices ADR-458 leaves to implementation:

1. **`push.default` refspec-resolution integration (III.5)** *(recommended first)*
   - **(a) plan → finalize split** — `planPushRefspecs` (pre-session, throws early refusals) +
     `finalizePushRefspecs` (post-advertisement, expands `matching`). **Recommended:** only shape that
     lets `matching` see the advertisement while keeping every other mode's refusal *before* any wire
     contact (git refuses `nothing`/`detached`/`no-upstream` without touching the remote — Part IV).
   - (b) Resolve everything after discovery. Simpler control flow, but contacts the remote before
     refusing — an observable divergence (git refuses locally) and a needless network round-trip.
   - *Tradeoff:* (a) preserves git's refuse-before-contact ordering; (b) is smaller but diverges.

2. **`remote.pushDefault` home in `ParsedConfig`** *(recommended first)*
   - **(a) flat `remotePushDefault?: string`.** **Recommended:** the `remote` name is already the
     per-remote `Map` key, so the top-level scalar cannot nest there; a flat field mirrors how
     `commit`/`tag`/`push` sit as flat top-level buckets. Minimal finalize change.
   - (b) nested `remoteDefaults?: { pushDefault?: string }`. Groups future `[remote]` top-level keys,
     at the cost of a new bucket + finalize arm for a single key today.
   - *Tradeoff:* (a) is minimal; (b) pre-builds a bucket for keys that may never come.

3. **Error codes for `NOTHING` / `DETACHED` / invalid-`push.default`** *(recommended first)*
   - **(a) three dedicated codes** — `PUSH_DEFAULT_NOTHING {}`, `DETACHED_NO_REFSPEC {}` (or reuse the
     branch-carrying shape), and a config `CONFIG_BAD_ENUM_VALUE { key, source, line, value }` for the
     invalid value. Plus the two new refusal codes from III.4 (`PUSH_UPSTREAM_NAME_MISMATCH`,
     `PUSH_REMOTE_NOT_UPSTREAM`). **Recommended:** distinct codes let callers branch on cause and let
     interop assert precise data (the mutation-resistant "specific error data" rule); consistent with
     the fine-grained `CommandError` union.
   - (b) reuse `INVALID_OPTION { option, reason }` for `NOTHING`/`DETACHED` (today's detached path
     already does) and a generic config error for the bad value. Smaller union; weaker caller
     discrimination and looser interop assertions.
   - *Note:* the `DETACHED` refusal is a **behavior refinement** of the current
     `invalidOption('refspecs','no-default-refspec (HEAD is detached)')` — existing push tests asserting
     that exact reason string must be updated to the chosen code. Flag for the ADR if (a) is chosen.
   - *Tradeoff:* (a) maximizes faithfulness/testability + follows the union's grain; (b) minimizes new
     surface.

4. **Invalid-`push.default` enforcement** *(recommended first)*
   - **(a) faithful hard refusal** via a `findInvalidPushDefault` cold-path finder (token stream →
     key/source/line), asserted early in `push`. **Recommended:** git refuses (V2/V3); lenient silence
     is a prime-directive divergence.
   - (b) lenient fallback to `simple`. Simpler, but diverges from git — rejected on faithfulness.
   - *Tradeoff:* (a) costs one cold-path finder to stay byte-faithful; (b) is a sanctioned-divergence
     we have no reason to take.

**Non-negotiable (forced by the ADRs):**
- `fetch`/`push` are now tracking-aware / fully git-faithful (ADR-457/458) — the original "no-tracking
  boundary" is removed.
- `push.default` default is `simple`; `tracking` aliases `upstream`; the value is case-sensitive; the
  triangular check dominates the no-upstream check — all pinned against git 2.55.0, not chosen.
- Per-remote `[remote "x"] pushDefault` is ignored; only top-level `[remote] pushDefault` is read.

## Out of scope

- `branch.<name>.merge` multiple-value support (`merge_nr != 1` "multiple upstream branches" refusal) —
  `ParsedConfig` models a single `merge` string; pre-existing limitation.
- The `branch.remote`/`branch.merge` exact-case parsing latent bug (git is case-insensitive) — flagged,
  not fixed here; the new `pushRemote` key uses the faithful case-insensitive form.
- `git remote_get_default`'s "single configured remote" special-case for the fetch fallback — tsgit
  (ADR-457) always falls back to `origin`; the triangular `fetchRemote` reuses that same chain for
  internal consistency. Flag: a repo whose only remote is *not* named `origin` may compute
  `triangular` differently from git. See "reconcile with ADR" below.
- `push.default = matching`'s tag/non-branch edge cases beyond `refs/heads/*` — pinned by interop rather
  than hand-modeled (ADR-458 neutral).

## Flags for ADR reconciliation

1. **Triangular dominance (S-D).** ADR-458 lists the refusals as "`simple`/`upstream` without
   `branch.<name>.merge`; `simple` name-mismatch" and "detached". Real git (S-D) shows the **triangular**
   refusal *outranks* the no-upstream refusal even when merge is absent. The design models this
   (triangular dominates); ADR-458's prose could add the triangular-dominance note. No decision change —
   just precision.
2. **`tracking` alias + case-sensitivity + invalid-value refusal** were not named in ADR-458; they are
   pinned here (V1/V2/V3). Consider a one-line ADR addendum so the enum contract is explicit.
3. **`origin` vs single-remote fetch default** (out-of-scope bullet 3): ADR-457 fixed fetch to
   `branch.remote ?? origin`; git's actual default has a single-remote special case. This pre-existing
   `DEFAULT_REMOTE` divergence now also feeds push's triangular computation. Worth a sentence in ADR-457
   acknowledging the sanctioned divergence.
</content>
