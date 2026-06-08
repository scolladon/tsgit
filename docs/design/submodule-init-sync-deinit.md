# Design — Submodule write side (local): `init` / `sync` / `deinit`

## Goal & scope

Complete the **local, no-network** half of the submodule write story: register
submodules into `.git/config` (`init`), re-point their configured URLs from
`.gitmodules` (`sync`), and unregister + clear their working trees (`deinit`).
The read side (`list`, formerly `repo.submodules`) shipped in 17.5.

This is backlog **24.1a**. The network half — `add` (clone a new submodule into
the worktree + `.git/modules/<name>`) and `update` (clone-if-missing + checkout
the pinned commit) — needs a clone→checkout-into-modules substrate plus
`git http-backend` integration and is deferred to **24.1b**.

These three verbs touch only **local state already on disk**:

- the **working-tree** `.gitmodules` (read; never the index/tree — `init`/`sync`/
  `deinit` read `$workDir/.gitmodules`, unlike `list` which reads a tree-ish per
  ADR-084),
- `.git/config` `[submodule "<name>"]` sections (read + write),
- for `sync`, an already-present `.git/modules/<name>/config` (write),
- for `deinit`, the submodule's working-tree directory (clear) and its dirtiness
  (read, via a child-context status walk).

No network, no clone, no checkout, no index mutation, no `.gitmodules` rewrite.

## Surface — unified `repo.submodule` namespace (breaking)

The read command shipped flat as `repo.submodules({ action: 'list' })`. The four
other multi-verb CRUD families (`remote`, `branch`, `tag`, `sparseCheckout`) use
a per-verb **namespace** with concrete result types and no discriminator
(ADR-181 / ADR-192). 24.1a folds the submodule read + writes into one such
namespace and **removes** `repo.submodules`:

```ts
repo.submodule.list(opts?)   // was repo.submodules({ action: 'list' }) — `kind` dropped
repo.submodule.init(opts?)   // register submodules into .git/config
repo.submodule.sync(opts?)   // re-point configured URLs from .gitmodules
repo.submodule.deinit(opts)  // unregister + clear working trees
```

`repo.primitives.walkSubmodules` is **unchanged** (the `list` verb still
materialises it). This is the migration ADR-192 explicitly scoped out for the
then-discriminated `submodules` family; we apply the identical pattern now.

## Faithful behaviours (verified against git 2.54.0)

All on-disk effects below are pinned byte-for-byte by the interop suite; the
library itself returns **structured data only** (ADR-249) — the human strings
git prints (`Submodule '…' registered for path '…'`, `Synchronizing submodule
url for '…'`, `Cleared directory '…'`, `… unregistered for path '…'`) are
reconstructed in the interop test from the structured fields, never emitted by
the library.

### `init`

For each in-scope submodule (all in `.gitmodules`, or only `paths`), **in
`.gitmodules` order**:

1. **Validate `update`** (if `.gitmodules` carries `submodule.<name>.update`)
   **before any write**: it must be one of `checkout` / `rebase` / `merge` /
   `none`. A `!command` value or any other token → refuse
   (`invalidOption('submodule.<name>.update', …)`; git: `fatal: invalid value
   for 'submodule.<name>.update'`), writing nothing for that submodule.
2. If `submodule.<name>.url` is **already set** in `.git/config`, the submodule
   is left untouched (register-only-if-absent — preserves a user-customised
   url); it is reported with `registered: false`.
3. Otherwise write, in this key order (git's order):
   - `submodule.<name>.active = true`
   - `submodule.<name>.url = <resolved>` (relative URLs resolved — see below)
   - `submodule.<name>.update = <value>` iff `.gitmodules` had a (valid) one.

   Reported with `registered: true` and the resolved `url`.

git copies **only** `url` and `update` from `.gitmodules` into config — never
`branch` / `ignore` / `fetchRecurseSubmodules` (those are read live later).

### `sync`

`sync` operates **only on initialized submodules** — those that already carry
`submodule.<name>.url` in `.git/config`. On a fresh clone with nothing inited,
`sync` is a verified no-op (writes nothing, prints nothing). For each in-scope
`.gitmodules` row whose name has a configured url:

1. Recompute the resolved url from the **current** `.gitmodules` url and write it
   to `submodule.<name>.url` in `.git/config` — **overwriting** the existing
   value (unlike `init`).
2. If `.git/modules/<name>/config` exists (the submodule has been checked out),
   set its `remote.origin.url` to the **same** resolved url.

`--recursive` (nested sync into checked-out children) is deferred to 24.1b — it
only bites on checked-out submodules, which this slice never populates.

### `deinit`

Requires either non-empty `paths` or `all: true` (git refuses a bare `deinit`:
`Use '--all' if you really want to deinitialize all submodules`). For each
in-scope submodule:

1. **Dirtiness guard** (unless `force`): if the submodule is checked out and its
   working tree is **not clean** — any modified tracked file **or** any untracked
   (non-ignored) file — refuse (`submoduleHasModifications(path)`; git: `fatal:
   Submodule work tree '<path>' contains local modifications; use '-f' to discard
   them`). Dirtiness is computed by a child-context `status` walk (gitDir =
   `.git/modules/<name>`, workDir = `<path>`); `status.clean === false` ⇒ dirty.
2. Clear the working-tree directory **contents** (the directory itself remains,
   empty) — `cleared: true` when a populated worktree was removed.
3. Remove the `[submodule "<name>"]` section from `.git/config`.

Left intact: `.gitmodules`, the index gitlink, and `.git/modules/<name>` (so a
later re-`init`/`update` is cheap). The message's url is the **raw `.gitmodules`
url** (not the resolved one) — surfaced as `url` on the entry.

### `paths` matching (shared by all three verbs)

`paths` selects submodules by **exact path** against the `.gitmodules` rows
(24.1a does not implement git's full pathspec globbing — a documented divergence;
`.`/dir-prefix pathspecs are 24.1b territory alongside the recursive walks). A
`paths` entry matching no submodule refuses with `pathspecNoMatch(<entry>)` (git:
`error: pathspec '<p>' did not match any file(s) known to git`). Empty/omitted
`paths` means "all submodules" for `init`/`sync`; `deinit` instead requires an
explicit `all: true` for the all-submodules case (a bare `deinit` refuses).

## Relative-URL resolution (faithful port of git's `relative_url`)

`init` and `sync` resolve a relative `.gitmodules` url against the
superproject's **default-remote url**. The base is:

1. the current branch's upstream remote name — `branch.<HEAD-branch>.remote` —
   falling back to `origin`;
2. that remote's `remote.<name>.url`;
3. if unset, the superproject's **absolute worktree path** (git warns "Assuming
   this repository is its own authoritative upstream"; the warning is stderr-only
   display, out of scope for the structured return).

A url is **relative** (resolved) only when it is local-not-ssh **and** not an
absolute path — i.e. it begins `./` or `../` (or is a bare relative path).
`https://…`, `git@host:…` (scp), and `/abs/…` are used verbatim. The resolution
itself is a verbatim port of `remote.c:relative_url` + `chop_last_dir` +
`connect.c:url_is_local_not_ssh` (git 2.54.0):

```
relativeUrl(base, url):
  if !localNotSsh(url) || isAbsolute(url): return url            # verbatim
  base = stripOneTrailingSlash(base)
  isRel = localNotSsh(base) && !isAbsolute(base)                 # base is itself relative
  if isRel && !base.startsWith('./'|'../'): base = './' + base
  colonSep = false
  while url starts with './' or '../':
    if '../': url = url.slice(3); colonSep |= chopLastDir(base, isRel)   # mutates base
    else:     url = url.slice(2)
  out = base + (colonSep ? ':' : '/') + url
  if out endsWith '/': out = out.slice(0, -1)
  if out startsWith './': out = out.slice(2)
  return out                                                     # up_path always undefined here

chopLastDir(base, isRel):  # returns colonSep flag; pops one component off base
  i = lastIndexOf('/')   → if found: base = base[:i];           return false
  i = lastIndexOf(':')   → if found: base = base[:i];           return true
  if isRel || base === '.': die("cannot strip one component off url")
  base = '.';                                                    return false

localNotSsh(u): colon = u.indexOf(':'); slash = u.indexOf('/')
  return colon < 0 || (slash >= 0 && slash < colon) || dosDrive(u)
```

Verified resolutions (origin × `.gitmodules`):

| base remote url | `.gitmodules` url | resolved |
|---|---|---|
| `https://h.x/a/b/super.git` | `../sub` | `https://h.x/a/b/sub` |
| `https://h.x/a/b/super.git` | `../../sub` | `https://h.x/a/sub` |
| `https://h.x/a/b/super.git` | `./sub` | `https://h.x/a/b/super.git/sub` |
| `https://h.x/a/b/super.git` | `../sub/` | `https://h.x/a/b/sub` |
| `git@h.x:a/b/super.git` | `../sub` | `git@h.x:a/b/sub` |
| `git@h.x:super.git` | `../sub` | `git@h.x:sub` (colon restored) |
| `https://h.x/a/super.git` | `../../../../sub` | `https:/sub` (over-pop collapses) |
| `/abs/path/super` | `../sub` | `/abs/path/sub` |
| any | `https://other/x.git` | `https://other/x.git` (verbatim) |

Lives as a **pure domain module** `domain/submodule/relative-url.ts` with a
`*.properties.test.ts` sibling (parse/grammar lens — total function over the
ascii-no-NUL url grammar).

## Module structure

```
src/
├── domain/submodule/                     (NEW — pure)
│   ├── relative-url.ts                    (relativeUrl + helpers; verbatim port)
│   ├── update-mode.ts                     (SubmoduleUpdateMode union + parseUpdateMode validator)
│   ├── gitmodules.ts                      (parseGitmodules text→rows + isUnsafeSubmoduleName,
│   │                                       extracted from walk-submodules.ts)
│   └── index.ts
├── application/
│   ├── primitives/
│   │   ├── config-read.ts                 (MODIFIED — ParsedConfig gains `submodule` map)
│   │   ├── walk-submodules.ts             (MODIFIED — consume domain/submodule/gitmodules)
│   │   └── internal/
│   │       └── submodule-context.ts       (NEW — deriveSubmoduleContext, shared by walk + deinit)
│   └── commands/
│       ├── submodule.ts                   (RENAMED from submodules.ts — submoduleList/Init/Sync/Deinit)
│       └── internal/
│           └── submodule-namespace.ts     (NEW — SubmoduleNamespace + bindSubmoduleNamespace)
└── repository.ts                          (MODIFIED — `submodule` namespace replaces `submodules`)
```

`domain/submodule/` is pure (zero outward deps): URL string algebra, the
`update` enum, and `.gitmodules` text parsing + name validation. The
application verbs orchestrate fs/config reads + `updateConfigOperations` writes,
mirroring `commands/remote.ts` exactly (each verb a `Context`-aware function
returning a concrete per-verb result; namespace binder in `internal/`).

`deriveSubmoduleContext` extracts the child-`Context` derivation currently
private to `walk-submodules.ts` (`deriveChildContext`) into a shared internal so
both the walk (recursion) and `deinit` (status) build the child store the same
way — the Nth-consumer-becomes-a-primitive move (still bounded: only these two
consume it).

## Types & result shapes (per-verb concrete, no discriminator — ADR-192)

```ts
export type SubmoduleUpdateMode = 'checkout' | 'rebase' | 'merge' | 'none';

// list — `SubmoduleEntry` unchanged (17.5); result drops `kind`
export interface SubmoduleListOptions {
  readonly ref?: string;
  readonly recursive?: boolean;
  readonly maxDepth?: number;
}
export interface SubmoduleListResult { readonly entries: ReadonlyArray<SubmoduleEntry>; }

export interface SubmoduleInitOptions { readonly paths?: ReadonlyArray<string>; }
export interface SubmoduleInitEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;                       // resolved url written/already in config
  readonly registered: boolean;               // true ⇒ newly registered this call
  readonly update?: SubmoduleUpdateMode;       // copied from .gitmodules, when present
}
export interface SubmoduleInitResult { readonly entries: ReadonlyArray<SubmoduleInitEntry>; }

export interface SubmoduleSyncOptions { readonly paths?: ReadonlyArray<string>; }
export interface SubmoduleSyncEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;                       // resolved url written to config
  readonly syncedRemote: boolean;             // true ⇒ .git/modules/<name>/config remote.origin.url updated
}
export interface SubmoduleSyncResult { readonly entries: ReadonlyArray<SubmoduleSyncEntry>; }

export interface SubmoduleDeinitOptions {
  readonly paths?: ReadonlyArray<string>;
  readonly all?: boolean;
  readonly force?: boolean;
}
export interface SubmoduleDeinitEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly url: string;                       // raw .gitmodules url (git's unregister message)
  readonly cleared: boolean;                  // true ⇒ a populated worktree was removed
}
export interface SubmoduleDeinitResult { readonly entries: ReadonlyArray<SubmoduleDeinitEntry>; }
```

`name`/`url` are free-form `string`; `path` is branded `FilePath`. The
`registered`/`syncedRemote`/`cleared` booleans + the resolved/raw `url` are
exactly the fields needed to reconstruct git's stdout in interop, nothing more.

## Reading `.git/config` submodule state

`ParsedConfig` (`config-read.ts`) today assembles `core`/`user`/`remote`/
`branch`/`extensions` only. It gains a `submodule` map so the verbs can read
existing state (init idempotency, deinit section presence) through the same
primitive the rest of the codebase uses:

```ts
readonly submodule?: ReadonlyMap<string, {
  readonly url?: string;
  readonly active?: boolean;
  readonly update?: string;
}>;
```

This mirrors the existing `remote` / `branch` assembly (a new `assembleSubmodule`
reducer + a `submodule` branch in the section dispatcher). Additive; no behaviour
change to existing config reads.

## `.gitmodules` parsing extraction (DRY)

`walk-submodules.ts` privately holds `.gitmodules` INI→row reduction
(`reduceSection`, `mergeKey`, `GitmodulesRow`) + name-safety
(`isUnsafeSubmoduleName`, `hasControlChar`, the drive/segment checks). The write
verbs need the **same** parse over the worktree `.gitmodules`. Extract to
`domain/submodule/gitmodules.ts`:

```ts
export interface GitmodulesRow {
  readonly name: string; readonly path?: string;
  readonly url?: string; readonly update?: string; readonly branch?: string;
}
export const parseGitmodules: (text: string) => ReadonlyArray<GitmodulesRow>;  // in-file order, unsafe-named dropped
export const isUnsafeSubmoduleName: (name: string) => boolean;
```

(`update`/`branch` added to the row so the write verbs can read them; the walk
ignores the extra keys.) `walk-submodules` is refactored to consume
`parseGitmodules` (indexing rows by `path` as today). Behaviour-preserving — the
walk's existing example + the new parser unit/property tests pin it.
`domain/submodule/gitmodules.ts` keeps `parseIniSections` reuse via the
`config-read` tokenizer (ADR-086) — the tokenizer stays the single INI grammar.

## Security

- **Unsafe submodule names** — a `.gitmodules` subsection name that is empty,
  `.`/`..`, contains a `..`/empty path segment, a backslash, a control char, a
  drive prefix, or a leading `-` is **dropped** (not registered/synced/deinit'd),
  reusing the read side's `isUnsafeSubmoduleName` (CVE-2018-17456 lineage). For
  the write verbs this additionally prevents a hostile name from corrupting
  `.git/config` (newline/NUL in a section header) or escaping into a crafted
  `.git/modules/<name>` path.
- **`update = !command` rejection** — `init` refuses to copy a command-form
  `update` mode (git's invalid-value `die`); only the four named modes are
  copied. No command is ever stored or executed (this slice never runs an
  `update` mode regardless — it is data only).
- **URL is opaque** — resolved URLs are written to config as data; never fetched
  (no network in this slice), so no SSRF surface is added. `relativeUrl` is pure
  string manipulation with no filesystem access.
- **`deinit` containment** — the cleared directory is `$workDir/<path>` where
  `<path>` comes from `.gitmodules` and is bounded by the superproject's
  `FileSystem` adapter root; a traversal attempt is rejected by the adapter. The
  child status context reuses that bounded adapter.
- **Bounded reads** — the worktree `.gitmodules` is read with the existing
  `MAX_GITMODULES_BYTES` (1 MiB) cap before parse.

## Migration & surface gates (breaking)

Removing `repo.submodules` + renaming the read result touches the full
new-command surface set:

- `src/application/commands/index.ts` — drop `submodules`; export `submoduleList`
  / `submoduleInit` / `submoduleSync` / `submoduleDeinit`, the per-verb types, and
  `SubmoduleNamespace` / `bindSubmoduleNamespace`.
- `src/repository.ts` — `readonly submodule: commands.SubmoduleNamespace;` replaces
  `readonly submodules`; bind via `bindSubmoduleNamespace`; `walkSubmodules`
  primitive binding unchanged.
- `test/unit/repository/repository.test.ts` — the bound-key set swaps
  `submodules` → `submodule`; add a namespace-shape + disposed-guard assertion.
- `test/parity/scenarios/submodules-empty.scenario.ts` — update to
  `repo.submodule.list(...)` (drop `kind`).
- `docs/use/commands/submodules.md` → `submodule.md` (list + init + sync + deinit);
  `docs/use/commands/README.md` count/list; `reports/api.json` regenerated;
  `README.md` command count.
- Browser parity scenario referencing the list command updated.

## Testing strategy

Conventions: `Given/When/Then` titles, AAA bodies, `sut`, 100% coverage, 0
killable mutants. Property tests for the two parser/grammar modules.

### Domain (unit + properties)
- `relative-url.test.ts` — every row of the resolution table above; verbatim
  (absolute/scp/https) pass-through; no-`/`-no-`:` over-pop hitting the
  `die`-equivalent. `relative-url.properties.test.ts` — total function over the
  ascii-no-NUL url grammar (never throws on the safe subset; `./x`/`../x` always
  resolve to a non-empty string).
- `update-mode.test.ts` — each valid mode parses; `!cmd` / unknown token rejected.
- `gitmodules.test.ts` — section reduction, case-insensitive keys, unsafe-name
  drop, last-wins on duplicate path. `gitmodules.properties.test.ts` — round-trip
  / idempotence over generated `.gitmodules` (parse∘serialize-ish), unsafe-name
  invariants.

### Primitive (unit)
- `config-read.test.ts` (extended) — a `[submodule "x"]` section surfaces in
  `ParsedConfig.submodule` with `url`/`active`/`update`.
- `submodule-context.test.ts` — child gitDir/workDir derivation; promisor+hooks
  dropped; uninitialised HEAD → undefined (shared-helper behaviour preserved).
- `walk-submodules.test.ts` (unchanged behaviour, re-pointed at `parseGitmodules`).

### Command (unit, memory adapter)
- `submodule.test.ts` — `list` (migrated), and per verb: init registers (active/
  url/update, key order); init preserves an already-set url (`registered:false`);
  init refuses invalid `update`; sync overwrites + updates a seeded
  `.git/modules/<name>/config`; deinit clears a populated worktree + removes the
  config section; deinit refuses a dirty worktree without `force`; deinit `force`
  discards; deinit with neither `paths` nor `all` refuses; `paths` filtering;
  unsafe-named submodule dropped; `assertRepository` gate.

### Integration / interop (node adapter, real git)
- `submodule-init-sync-deinit-interop.test.ts` — build a real superproject with a
  `.gitmodules` (relative + absolute + scp urls), run the tsgit verb, then
  reconstruct `git submodule init/sync/deinit`'s `.git/config` (byte-for-byte
  section order/keys) and stdout messages from the structured result and compare
  to real `git`. Covers relative-URL resolution against `remote.origin.url`, the
  no-origin fallback, the checked-out `sync` updating `.git/modules/<name>/config`,
  and the `deinit` dirty refusal. Scrubbed `GIT_*`.
- `test/integration/submodules.test.ts` — re-pointed at `repo.submodule.*`.

## Decisions (see ADRs)

| # | Decision |
|---|----------|
| (this) | Scope 24.1a = `init`/`sync`/`deinit` (local); `add`/`update` (network) → 24.1b |
| NNN | Surface: unified `repo.submodule` namespace; remove `repo.submodules` (breaking) |
| NNN+1 | `relativeUrl` is a verbatim port of git's `relative_url`; lives in `domain/submodule/` |

Decisions pre-settled by existing ADRs: per-verb concrete results, no
discriminator (ADR-192); namespace binder in `internal/` (ADR-181); `.gitmodules`
reuses the config INI tokenizer (ADR-086); structured-data-only return, display
reconstructed in interop (ADR-249); tree-ish source for `list` only (ADR-084).
