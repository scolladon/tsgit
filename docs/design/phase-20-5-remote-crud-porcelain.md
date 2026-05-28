# Design — Phase 20.5 `remote` CRUD Porcelain

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.5** — _"`remote` CRUD porcelain (`add` / `remove` / `rename`
/ `set-url` / `show`) on `repo.*`."_

ADRs: 175 (single `repo.remote(action)` action-discriminated surface) ·
176 (default fetch refspec is `+refs/heads/*:refs/remotes/<name>/*`) ·
177 (`remove` deletes config section + tracking refs + clears
`branch.<X>.remote` referrers) · 178 (`rename` updates the default fetch
refspec, moves tracking refs, and rewrites referrers atomically) · 179
(`setUrl --push` writes `remote.<name>.pushurl`; `--add` and multi-URL
deferred) · 180 (`show` is local-only — no network query in this phase).

## 1. Goal

Land Tier-1 porcelain for the five remote CRUD verbs canonical git ships
under `git remote`:

1. **`add <name> <url>`** — register a new remote in `.git/config`.
2. **`remove <name>`** (alias `rm <name>`) — drop the remote, its tracking
   refs, and any branch-upstream referrers.
3. **`rename <from> <to>`** — rename the remote, move its tracking refs,
   rewrite the default fetch refspec, and update branch-upstream
   referrers.
4. **`set-url [--push] <name> <url>`** — change the URL (default) or the
   push URL.
5. **`show <name>` / `show` (list mode)** — surface what tsgit knows
   about the remote(s) without a network query.

All five sit on `repo.remote({ kind, … })`, returning a discriminated
union — the same shape `repo.branch` and `repo.tag` already use.

### 1.1 Why now

`fetch`, `push`, `fetchMissing`, and `clone` already consume the
`remote.<name>.*` config block. Today the only way to create a remote
outside of `clone`'s baked-in `origin` is to write `.git/config` by
hand — a gap newcomers hit on day one. Phase 21 (`pull`) and Phase 22
(`cherry-pick` / `rebase`) inherit this gap because both want a clean
"add a fork as a second remote" story. Closing it in 20.5 keeps the v2
surface complete before the dependent porcelain lands.

It also makes the Phase 17.4 (partial-clone) and 17.5 (submodules)
escape hatches first-class: today a user can opt their `origin` into
`promisor = true` only via `clone --filter`; a `repo.remote('add', …)`
surface lets them register a second remote (or rewrite a stale one)
without re-cloning.

## 2. Out of scope (does NOT ship in 20.5)

- **Network `show`** — canonical `git remote show <remote>` queries
  the remote by default to surface stale/tracked/local-only branches.
  20.5 ships a local-only structured `show`; the network path is
  reserved for a follow-up (`show --network`) once the v2 surface
  settles. ADR-180 captures the cut.
- **`set-url --add` / `set-url --delete`** — multi-URL remotes (a
  pseudo-load-balancer canonical git supports for HTTP). Deferred:
  tsgit's `fetch`/`push` already pick the single URL, and the
  multi-URL semantics drag fail-over into the transport layer. ADR-179.
- **`remote prune <name>`** — already covered by `repo.fetch({ prune:
  true })`. Adding the verb here would just thin-wrap the existing
  call. Keep the surface narrow.
- **`remote update`** — multi-remote fetch. Composes from `fetch` +
  `Promise.all`; lands in a follow-up if a single user demand
  surfaces.
- **`remote set-head` / `set-branches`** — touches the per-remote
  `HEAD` symbolic ref and `remote.<name>.fetch` plumbing for
  shallow-tracking. Out of v2 scope.
- **`remote get-url` / `get-url --push` / `get-url --all`** — the
  data is already available through `repo.remote({ kind: 'show', name
  })`; we don't surface a second read path.

## 3. Surface

```typescript
export type RemoteAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'add'; readonly name: string; readonly url: string;
      readonly fetch?: string }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'setUrl'; readonly name: string; readonly url: string;
      readonly push?: boolean }
  | { readonly kind: 'show'; readonly name: string };

export interface RemoteInfo {
  readonly name: string;
  readonly url: string;
  readonly pushUrl: string | undefined;
  readonly fetchRefspecs: ReadonlyArray<string>;
}

export interface RemoteShow extends RemoteInfo {
  /** Tracking refs under `refs/remotes/<name>/*`, name → oid. */
  readonly trackingRefs: ReadonlyMap<RefName, ObjectId>;
  /** Local branches with `branch.<X>.remote = <name>`. */
  readonly trackedBy: ReadonlyArray<{
    readonly branch: RefName;
    readonly merge: string | undefined;
  }>;
}

export type RemoteResult =
  | { readonly kind: 'list'; readonly remotes: ReadonlyArray<RemoteInfo> }
  | { readonly kind: 'add'; readonly remote: RemoteInfo }
  | { readonly kind: 'remove'; readonly name: string;
      readonly removedTrackingRefs: ReadonlyArray<RefName>;
      readonly clearedBranches: ReadonlyArray<RefName> }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string;
      readonly movedTrackingRefs: ReadonlyArray<RefName>;
      readonly rewrittenBranches: ReadonlyArray<RefName> }
  | { readonly kind: 'setUrl'; readonly remote: RemoteInfo }
  | { readonly kind: 'show'; readonly remote: RemoteShow };

export const remote = (ctx: Context, action: RemoteAction):
  Promise<RemoteResult>;
```

Bound on the repository as a single flat method, mirroring `branch`:

```typescript
await repo.remote({ kind: 'list' });
await repo.remote({ kind: 'add', name: 'upstream', url: 'https://…' });
await repo.remote({ kind: 'remove', name: 'fork' });
await repo.remote({ kind: 'rename', from: 'origin', to: 'upstream' });
await repo.remote({ kind: 'setUrl', name: 'origin', url: 'https://…' });
await repo.remote({ kind: 'setUrl', name: 'origin', url: 'https://…', push: true });
await repo.remote({ kind: 'show', name: 'origin' });
```

ADR-175 captures the single-method-with-action choice (the same
precedent `branch`/`tag`/`sparseCheckout` already established).

### 3.1 Why a single discriminator and not five flat methods?

Considered both. Single discriminator wins because:

- The shape mirrors `branch` (`list`/`create`/`delete`/`rename`),
  `tag` (`list`/`create`/`delete`), `sparseCheckout`
  (`init`/`list`/`set`/`add`/`disable`/`reapply`). Five new flat
  methods would split the surface across two patterns.
- `remote` is a CRUD family with closely related inputs (every action
  carries a `name`) — exactly the shape the discriminator fits.
- The merge-state-machine flat surface (Phase 20.4) is the counter-
  example: `abortMerge`/`continueMerge` have disjoint inputs and
  belong to no CRUD family.

## 4. Behaviour

### 4.1 `list`

Reads `remote.<name>.*` out of `.git/config`. Returns an alphabetically
sorted array (byte-wise, matching canonical git). Empty array when no
remote is configured. No I/O beyond `readConfig`.

`pushUrl` is the canonical name in our output — `.git/config` stores
it as `pushurl` (lower-case), so the parser is extended in 20.5 to
surface the field (today it silently drops it).

### 4.2 `add { name, url, fetch? }`

```
1. assertRepository(ctx);
2. validateRemoteName(name);              // see §4.7
3. assertNoControlChars(url);             // INVALID_OPTION on \n / \r / \0
4. if (config.remote.has(name)) throw remoteExists(name);
5. const fetchSpec = fetch ?? `+refs/heads/*:refs/remotes/${name}/*`;
6. updateConfigEntries(ctx, [
     { section: 'remote', subsection: name, key: 'url', value: url },
     { section: 'remote', subsection: name, key: 'fetch', value: fetchSpec },
   ]);
7. return { kind: 'add', remote: { name, url, pushUrl: undefined,
                                    fetchRefspecs: [fetchSpec] } };
```

- **`name` validation** — must be a non-empty subsection-safe string
  (§4.7). Canonical git rejects names containing `/`, but tsgit follows
  the looser canonical-git rule: the name is the literal subsection
  string, so the only hard bans are the line-surgery bans
  (`\n` / `\r` / `\0` / `"` / `\\` / `]`).
- **`url` validation** — for 20.5 we only ban control characters
  that would break line surgery (per `update-config.ts`'s existing
  guard). Full SSRF / scheme validation is deferred to `clone` /
  `fetch` / `push` consumption — canonical git accepts any string
  too (including local paths, `git://`, `file://`). ADR-176 captures.
- **`fetch` override** — optional. Defaults to the canonical refspec
  for the new remote. The caller must supply a syntactically valid
  refspec; `parseRefspec` runs at write time and rejects malformed
  inputs with the existing `REFSPEC_INVALID` code. ADR-176.
- **Duplicate-name** — throws a new `REMOTE_EXISTS` code (§4.7).

### 4.3 `remove { name }`

```
1. assertRepository(ctx);
2. validateRemoteName(name);
3. const remote = config.remote.get(name);
4. if (remote === undefined) throw remoteNotConfigured(name);
5. // Enumerate referrers BEFORE touching disk so a failure mid-flight
6. // leaves a recoverable state.
7. const trackingRefs = await listTrackingRefs(ctx, name);
8. const referrers = listBranchReferrers(config, name);
9. // 1) delete tracking refs (loose + packed)
10. await deleteTrackingRefs(ctx, trackingRefs);
11. // 2) rewrite config: drop the [remote "<name>"] section entirely,
12. //    AND clear `branch.<X>.remote = <name>` (and `.merge`) for every
13. //    branch that named this remote.
14. await rewriteConfig(ctx, {
15.   removeSection: { section: 'remote', subsection: name },
16.   removeEntries: referrers.flatMap(b => [
17.     { section: 'branch', subsection: b.branch, key: 'remote' },
18.     { section: 'branch', subsection: b.branch, key: 'merge' },
19.   ]),
20. });
21. return { kind: 'remove', name,
22.          removedTrackingRefs: trackingRefs.map(r => r.name),
23.          clearedBranches: referrers.map(b => b.ref) };
```

Decisions (ADR-177):

- **Tracking refs deleted first, config second.** A failure between
  the two leaves the tracking refs dangling but the remote still
  configured — recoverable via re-running `remove`. The opposite
  order leaves orphaned tracking refs with no way to enumerate them.
- **Loose + packed.** Canonical git deletes both. `enumerateRefs`
  surfaces packed entries; we either rewrite packed-refs to drop
  the matching entries or surface `unsupportedOperation` if any
  matching entry is packed-only. For 20.5 we ship the loose-only
  path and surface `unsupportedOperation` on a packed-only tracking
  ref; in practice `fetch` writes everything loose, so a packed
  remote-tracking ref is the artefact of a prior `git pack-refs`
  (out-of-band). ADR-177 captures the cut.
- **Referrers cleared, not the whole `[branch "X"]` section.** Canonical
  git removes `branch.<X>.remote` and `branch.<X>.merge` but leaves
  the section header. We match.
- **Reflog cleanup** — Each deleted tracking ref's reflog (`logs/refs/remotes/<name>/<branch>`)
  is removed alongside the ref via `updateRef`'s `delete: true` path
  (which already calls `deleteReflog`). Standard semantics; no new
  decision.

### 4.4 `rename { from, to }`

```
1. assertRepository(ctx);
2. validateRemoteName(from);
3. validateRemoteName(to);
4. if (from === to) throw invalidOption('remote.rename', 'from and to are equal');
5. const fromRemote = config.remote.get(from);
6. if (fromRemote === undefined) throw remoteNotConfigured(from);
7. if (config.remote.has(to)) throw remoteExists(to);
8. const trackingRefs = await listTrackingRefs(ctx, from);
9. const referrers = listBranchReferrers(config, from);
10. // Move tracking refs first (idempotent), then rewrite config last.
11. await moveTrackingRefs(ctx, from, to, trackingRefs);
12. // Rewrite default fetch refspec if (and only if) the user has the
13. // canonical one. A custom refspec stays untouched — canonical git
14. // matches this conservative behaviour.
15. const rewrittenFetch = rewriteDefaultFetchRefspecs(
16.   fromRemote.fetch ?? [], from, to);
17. await rewriteConfig(ctx, {
18.   renameSection: { from: { section: 'remote', subsection: from },
19.                    to:   { section: 'remote', subsection: to } },
20.   replaceEntry: rewrittenFetch.map(spec => ({
21.     section: 'remote', subsection: to, key: 'fetch', value: spec,
22.   })),
23.   setEntries: referrers.map(b => ({
24.     section: 'branch', subsection: b.branch, key: 'remote', value: to,
25.   })),
26. });
27. return { kind: 'rename', from, to,
28.          movedTrackingRefs: trackingRefs.map(r => `refs/remotes/${to}/${r.suffix}`),
29.          rewrittenBranches: referrers.map(b => b.ref) };
```

Decisions (ADR-178):

- **Tracking refs first, config second.** Same recoverability story
  as `remove`. A mid-flight failure leaves some refs at the new path
  and the old config — re-running `rename` is safe (`listTrackingRefs`
  on `from` returns the residue; `to`-already-exists is detected
  before any I/O).
- **Default-refspec rewrite is conservative.** Only the canonical
  `+refs/heads/*:refs/remotes/<from>/*` form is rewritten; any
  custom refspec the user wrote is left untouched. Canonical git
  matches this rule exactly (`builtin/remote.c::migrate_file`).
  The rewritten value replaces the prior one — multi-fetch remotes
  with one canonical entry and one custom entry get the canonical
  one rewritten, the custom one preserved.
- **Same packed-ref caveat as `remove`** — a packed-only tracking
  ref under `refs/remotes/<from>/*` surfaces `unsupportedOperation`.
  ADR-178.

### 4.5 `setUrl { name, url, push? }`

```
1. assertRepository(ctx);
2. validateRemoteName(name);
3. assertNoControlChars(url);
4. const remote = config.remote.get(name);
5. if (remote === undefined) throw remoteNotConfigured(name);
6. const key = push === true ? 'pushurl' : 'url';
7. await updateConfigEntries(ctx, [
8.    { section: 'remote', subsection: name, key, value: url },
9. ]);
10. // refresh the parsed view to populate the result.
11. const refreshed = (await readConfig(ctx)).remote?.get(name);
12. return { kind: 'setUrl', remote: toRemoteInfo(name, refreshed) };
```

Decisions (ADR-179):

- **`push: true` writes `pushurl`; the default writes `url`.** Matches
  `git remote set-url --push`. The two keys coexist; `fetch` reads
  `url`, `push` reads `pushurl ?? url` (Phase 20.5 also extends
  `push.ts` to honour `pushurl`).
- **`--add` and `--delete` deferred.** ADR-179 explicitly carves them
  out; today's `setUrl` is a single-URL replacer.
- **No URL validation beyond control-char rejection.** Same rationale
  as `add`.

### 4.6 `show { name }`

Local-only structured view. The return type spells out exactly what
tsgit knows:

- `url`, `pushUrl`, `fetchRefspecs` — from `.git/config`.
- `trackingRefs` — every ref under `refs/remotes/<name>/*`, resolved
  via the existing ref store (loose + packed). Map order is the
  enumeration order; callers wanting alphabetic order sort.
- `trackedBy` — every `[branch "X"]` block whose `remote = <name>`,
  with the paired `merge` value (or `undefined` when unset).

No network query, no `HEAD` discovery, no stale-branch detection.
ADR-180 captures the cut: shipping the local view as v1 of `show`
gets the surface in front of users without a smart-HTTP client; a
follow-up adds `{ kind: 'show', name, network: true }` once
demand surfaces.

### 4.7 Error model

Two new domain codes land alongside the existing `REMOTE_NOT_CONFIGURED`:

```typescript
| { readonly code: 'REMOTE_EXISTS'; readonly remote: string }
| { readonly code: 'REMOTE_NAME_INVALID'; readonly name: string;
    readonly reason: string }
```

`REMOTE_NAME_INVALID` covers the line-surgery hard bans
(`\n` / `\r` / `\0` / `"` / `\\` / `]`) plus the empty string.
`REMOTE_EXISTS` is the symmetric "you tried to add or rename onto a
slot that is already taken" code. Both have factory functions
(`remoteExists`, `remoteNameInvalid`).

The existing `REMOTE_NOT_CONFIGURED` is reused unchanged for
`remove` / `rename` / `setUrl` / `show` against a missing name.

A `validateRemoteName(name: string)` helper throws
`REMOTE_NAME_INVALID` on:

- empty string
- contains any of `\n`, `\r`, `\0`, `"`, `\\`, `]`

It deliberately does NOT reject `/` (canonical git accepts
hierarchical names, e.g. `team/origin`) or spaces (canonical git
accepts them too, though they're unusual).

### 4.8 Concurrency

`remove` and `rename` mutate both config and refs. They acquire no
new lock — `.git/config` writes are line-surgical and atomic via the
existing `writeUtf8` path, and ref deletes/moves go through
`updateRef`'s atomic write. Per-Context single-threadedness (the
existing library invariant — no concurrent `repo.*` calls inside one
process) keeps the absence of a higher-level lock safe.

Documented explicitly because the multi-step nature of `remove` and
`rename` (refs first, config second) invites a "is this atomic?" review
question. The answer is "the steps are individually atomic; the pair
is recoverable by re-run", and §4.3 / §4.4 spell that out.

### 4.9 Hooks

None. Canonical git's `git remote` does not invoke hooks; we match.

### 4.10 Reflog

`remove` and `rename` write reflog entries on the affected tracking
refs via `updateRef`:

- `remove`: each deleted tracking ref gets a `remote: removed <name>`
  reflog entry (matching the existing `updateRef` delete path).
- `rename`: each moved tracking ref gets a `remote: renamed <from>
  to <to>` entry on the NEW name. The OLD name's loose ref is
  deleted with the standard message.

`add` and `setUrl` and `show` write no reflog entries.

## 5. Module layout

```
src/application/commands/
├── remote.ts                              # NEW
├── internal/
│   └── remote-config.ts                   # NEW — small shared helpers
│                                          #   (validateRemoteName,
│                                          #    listBranchReferrers,
│                                          #    rewriteDefaultFetchRefspecs)
├── index.ts                               # extended: export remote

src/application/primitives/
├── update-config.ts                       # extended:
│   - removeConfigEntry(text, section, subsection, key)
│   - removeConfigSection(text, section, subsection)
│   - renameConfigSection(text, oldSub, newSub, section)
│   - updateConfigOperations (apply a batch of mixed ops)
└── config-read.ts                         # extended: parse `pushurl`

src/domain/commands/
└── error.ts                               # extended:
                                            #   REMOTE_EXISTS
                                            #   REMOTE_NAME_INVALID

src/repository.ts                          # extended: bind remote
src/index.ts                               # (re-export — unchanged)

test/unit/application/commands/
├── remote.test.ts                         # NEW — per-action GWT cases
├── internal/remote-config.test.ts         # NEW — helpers unit
test/unit/application/primitives/
└── update-config.test.ts                  # extended: new operations
test/integration/
└── remote-lifecycle.test.ts               # NEW — round-trip add→fetch→
                                            #   rename→remove (no network)
test/parity/scenarios/
└── remote-crud.scenario.ts                # NEW — Node + Memory + OPFS
```

### 5.1 Why a new module rather than extending an existing one?

- `remote.ts` is the natural home — sibling of `branch.ts`, `tag.ts`,
  `submodules.ts`, all of which are flat verbs with a discriminator.
- The shared helpers (`remote-config.ts`) sit under `commands/internal`
  because they're command-private — primitives don't need them.

### 5.2 Config-writer surface

The existing `setConfigEntry` only sets keys. The new operations
needed:

```typescript
// Remove a single `key = value` entry from a section, byte-preserving
// every other line. No-op when the section or key is absent.
export const removeConfigEntry = (
  text: string, section: string, subsection: string | undefined, key: string,
): string;

// Remove an entire section header + body, byte-preserving every other
// section. No-op when the section is absent.
export const removeConfigSection = (
  text: string, section: string, subsection: string | undefined,
): string;

// Rename a section header in place; the body is untouched.
export const renameConfigSection = (
  text: string,
  section: string,
  fromSubsection: string,
  toSubsection: string,
): string;

// Batch operation: apply a sequence of set/remove/remove-section/rename ops.
// Cache-invalidating; used by `remote` for the multi-step rewrites.
export type ConfigOperation =
  | { kind: 'set' } & ConfigEntry
  | { kind: 'removeEntry'; section: string; subsection?: string; key: string }
  | { kind: 'removeSection'; section: string; subsection?: string }
  | { kind: 'renameSection'; section: string; from: string; to: string };

export const updateConfigOperations = async (
  ctx: Context, ops: ReadonlyArray<ConfigOperation>,
): Promise<void>;
```

All three new pure helpers extend the existing line-surgery pattern in
`update-config.ts`. The batch entrypoint (`updateConfigOperations`)
sits next to the existing `updateConfigEntries`; both end with the same
`invalidateConfigCache` call.

### 5.3 `pushurl` in `ParsedConfig`

`ParsedConfig.remote.<name>` gains an optional `pushUrl?: string`
field. The parser case-insensitively matches `pushurl`. No other config
key changes shape.

## 6. Testing strategy

### 6.1 Unit — `remote.test.ts`

GWT split per existing test conventions. Cases by action:

**`list`:**
- "Given no remotes configured, When list runs, Then remotes is empty"
- "Given a single `origin`, When list runs, Then the entry's url and
  fetchRefspecs match the config"
- "Given `origin` with both url and pushurl, When list runs, Then
  pushUrl is set"
- "Given multiple remotes, When list runs, Then they come back sorted
  by name"
- "Given a non-repo, When list runs, Then throws NOT_A_REPOSITORY"

**`add`:**
- "Given a new name and url, When add runs, Then the `[remote …]`
  block is written with the canonical default fetch refspec"
- "Given a custom fetch refspec, When add runs, Then it overrides the
  default"
- "Given an existing remote name, When add runs, Then throws
  REMOTE_EXISTS"
- "Given an invalid remote name (each forbidden char in isolation),
  When add runs, Then throws REMOTE_NAME_INVALID" — one case per
  banned character so a mutant that drops one term in the validator
  is killed.
- "Given an empty remote name, When add runs, Then throws
  REMOTE_NAME_INVALID"
- "Given a url containing a newline, When add runs, Then throws
  INVALID_OPTION"
- "Given a bare repo, When add runs, Then succeeds" (config writes
  are allowed in bare repos).

**`remove`:**
- "Given an unknown remote, When remove runs, Then throws
  REMOTE_NOT_CONFIGURED"
- "Given a configured remote with no tracking refs, When remove runs,
  Then the config block is gone and removedTrackingRefs is empty"
- "Given a configured remote with two tracking refs, When remove
  runs, Then both refs are deleted and reported"
- "Given a packed-only tracking ref under the remote, When remove
  runs, Then throws UNSUPPORTED_OPERATION"
- "Given a branch with `remote = <name>` and `merge = <ref>`, When
  remove runs, Then both keys are dropped and the branch is in
  clearedBranches"
- "Given a branch with `remote = <name>` but no `merge`, When remove
  runs, Then only `remote` is dropped"
- "Given two branches tracking the same remote, When remove runs,
  Then both are cleared"
- "Given a deleted tracking ref's reflog file, When remove runs, Then
  the reflog file is gone"

**`rename`:**
- "Given an unknown `from`, When rename runs, Then throws
  REMOTE_NOT_CONFIGURED"
- "Given `to` equal to `from`, When rename runs, Then throws
  INVALID_OPTION"
- "Given an existing `to`, When rename runs, Then throws REMOTE_EXISTS"
- "Given a remote with the canonical default fetch refspec, When
  rename runs, Then the refspec is rewritten to the new name"
- "Given a remote with a custom (non-canonical) fetch refspec, When
  rename runs, Then the refspec is preserved verbatim"
- "Given a remote with two refspecs (one canonical, one custom),
  When rename runs, Then only the canonical one is rewritten"
- "Given tracking refs under `refs/remotes/<from>/*`, When rename
  runs, Then they are moved to `refs/remotes/<to>/*` with the
  same OIDs"
- "Given a branch with `remote = <from>`, When rename runs, Then it
  now reads `remote = <to>`"
- "Given a packed-only tracking ref under the remote, When rename
  runs, Then throws UNSUPPORTED_OPERATION"

**`setUrl`:**
- "Given an unknown remote, When setUrl runs, Then throws
  REMOTE_NOT_CONFIGURED"
- "Given a known remote, When setUrl({url}) runs, Then `remote.<n>.url`
  is the new value and pushUrl is unchanged"
- "Given a known remote, When setUrl({url, push: true}) runs, Then
  `remote.<n>.pushurl` is the new value and url is unchanged"
- "Given a url containing a newline, When setUrl runs, Then throws
  INVALID_OPTION"

**`show`:**
- "Given an unknown remote, When show runs, Then throws
  REMOTE_NOT_CONFIGURED"
- "Given a remote with tracking refs and tracking branches, When show
  runs, Then trackingRefs and trackedBy reflect them"
- "Given a remote with pushurl set, When show runs, Then pushUrl is
  populated"
- "Given a remote with no tracking refs, When show runs, Then
  trackingRefs is empty"

### 6.2 Unit — `update-config.test.ts` extensions

For each new operation a "round-trip preserves comments and unrelated
sections" test, plus the no-op cases (missing section / missing key)
to kill the "did we silently corrupt the file?" mutants.

### 6.3 Unit — `remote-config.test.ts`

- `validateRemoteName` cases — one per banned character (kills
  StringLiteral mutants on the regex).
- `listBranchReferrers` — empty config, one branch, two branches.
- `rewriteDefaultFetchRefspecs` — canonical replaced, custom preserved,
  mixed list, empty list.

### 6.4 Integration — `remote-lifecycle.test.ts`

End-to-end without a network:

- "Given a fresh repo, When add → list → setUrl → rename → remove run
  in sequence, Then the final config and refs match the expected
  empty state"
- "Given an added remote, When the working `.git/config` is read back
  with `git config --get`, Then the values match" (cross-tool parity
  — `git` invoked as a subprocess in the integration tier, with the
  `GIT_*` env scrubbed per the project's existing test hygiene rule).

`@proves` surface: `repo.remote` — `remote-crud` bucket.

### 6.5 Parity — `remote-crud.scenario.ts`

Drives the five actions through a `Scenario<TResult>` that lands on
Node + Memory + Browser/OPFS via the existing harness. Captures one
load-bearing golden: the SHA of a representative tracking ref before
+ after `rename` to lock the move semantics.

### 6.6 Property tests

Not for this phase. `remote` is a small finite-state CRUD family —
the only "algebraic grammar" is the line-surgery helpers
(`removeConfigEntry` / `removeConfigSection` / `renameConfigSection`).
These extend the existing `update-config.ts` style; the existing
config writer ships example tests only (no property tests on
`setConfigEntry`), and a property test on top of three new helpers
in isolation would be testing the surgical helpers, not the
porcelain. We follow the existing convention.

If a future reviewer pushes for round-trip properties on the line
surgery, that would land as a `update-config.properties.test.ts`
file — independent of 20.5.

### 6.7 Mutation

Stryker on `remote.ts`, `internal/remote-config.ts`, and the new
operations in `update-config.ts`. Target: 0 new killable survivors.
Per-character validator tests (§6.1) protect against StringLiteral
mutants on the regex.

## 7. Repository binding

`src/repository.ts` gains:

```typescript
readonly remote: BindCtx<typeof commands.remote>;
```

bound in the factory with the standard `guard()` + `commands.remote`
glue.

`src/application/commands/index.ts` re-exports:

```typescript
export {
  type RemoteAction,
  type RemoteInfo,
  type RemoteResult,
  type RemoteShow,
  remote,
} from './remote.js';
```

## 8. Browser-surface coverage

Phase 19.5a gates `repo.*` names against parity scenarios + allowlist.
`repo.remote` is the new name; the bundled `remote-crud.scenario.ts`
(see §6.5) closes the gap. No allowlist entry needed.

## 9. Open questions

- **Q1: Should `add` also write a per-remote `tagopt` default?** No.
  Canonical git defaults to `--tags`/`--no-tags` only on `clone`; bare
  `git remote add` does not touch tagopt. We match.
- **Q2: Should `rename` rewrite `branch.<X>.pushRemote`?** No remote
  consumer of `pushRemote` ships in v1; the config key is read only
  by `push` (which falls back to `branch.<X>.remote`). Adding the
  rewrite now is premature. ADR-178 §3 captures.
- **Q3: Should `remove` archive the dropped tracking refs into
  `refs/archive/<remote>/*` like some tools do?** No. Canonical git
  deletes them outright; we match.
- **Q4: `show --network` later — do we change the result shape?**
  No. The result will land as `{ kind: 'show', remote: RemoteShow,
  network?: { … } }` — additive. ADR-180 captures.

## 10. Self-review log

### Pass 1 → Pass 2

- §3 made the discriminator explicit and named every result variant;
  earlier draft folded `remove`+`rename` results behind a flat
  "boolean success", which lost the "what was removed?" payload
  reviewers asked about.
- §4.3, §4.4 added the "refs first, config second" ordering note
  and the recoverability rationale — the multi-step concern is the
  most likely review question.
- §4.7 split out the error model; a `REMOTE_EXISTS` code is needed
  for both `add` and `rename`'s target collision; `REMOTE_NAME_INVALID`
  belongs to the validator helper, not inside each action.
- §6.1 expanded the per-character validator-test list — without it,
  Stryker would survive `'"'` → `''` mutants on the regex.

### Pass 2 → Pass 3

- §4.4 spelled out the conservative refspec rewrite — canonical git
  matches this rule exactly (`migrate_file`), and a draft reviewer
  could otherwise argue both ways.
- §4.5 made the `pushurl` precedence explicit (`fetch` reads `url`;
  `push` reads `pushurl ?? url`) and noted the `push.ts` extension
  that lands in this PR alongside `remote.ts` so the two halves of
  the surface stay consistent.
- §5.2 captured the new `update-config` API surface as a typed
  block; the implementation plan (Phase 4 of the workflow) needs
  this to enumerate atomic commits.
- §6.6 explained the property-test decision so reviewers don't ask
  again — the four-lens check from CLAUDE.md applied honestly.
- §4.3 clarified packed-ref handling — earlier draft was silent on
  packed-only refs, which ADR-177 now spells out as
  `unsupportedOperation` with the same precedent `update-ref`'s
  packed-only-delete code uses.

### Pass 3 → converged

- §4.10 added — reflog behaviour is the kind of canonical-git muscle-
  memory detail that needs documenting once and only once.
- §8 added — Phase 19.5a's audit would otherwise fail CI on a missing
  scenario.
- §11 questions Q1-Q4 captured to forestall bikesheds during review.
