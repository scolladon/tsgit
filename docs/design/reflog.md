# Reflog — Design (Phase 17.1)

> Status: Implemented (v2.0). Backlog item **17.1** complete — "Reflog
> (`HEAD@{N}`, `<branch>@{N}` syntax, `.git/logs/` writers)". See
> [docs/BACKLOG.md](../BACKLOG.md#phase-v20--larger-semantic-surface) for
> acceptance summary and ADRs 058–064.

## 1. Goal & scope

Git records every ref movement in a per-ref append-only log under `.git/logs/`.
The reflog is what makes `HEAD@{1}` ("where HEAD was one move ago"),
`git reflog`, and recovery of orphaned commits possible.

Phase 17.1 delivers the **full read/write loop plus management**, behaving like
canonical git wherever git defines behaviour:

1. **Writers** — every ref/HEAD move appends an entry to `.git/logs/<ref>`,
   gated by `core.logAllRefUpdates` and the default-loggable prefix rule (§10).
2. **`@{N}` / `@{date}` resolution** — `revParse` understands `<ref>@{2}` and
   `<ref>@{yesterday}`.
3. **`repo.reflog()`** — a tier-1 command: `show` / `exists` / `delete` /
   `expire`.
4. **`reflog expire`** — prune by age, with the reachable / unreachable cutoff
   distinction git uses (`90.days` / `30.days`).

### Explicitly out of scope (separate v2.x features)

- `@{-N}` (previous-checkout) and `@{upstream}` / `@{u}` / `@{push}` — these are
  `@{…}` *selectors* but not reflog-index selectors; `@{-N}` reads checkout
  messages, `@{upstream}` reads remote-tracking config. Distinct features, not
  reflog.
- The **full** git approxidate grammar — weekday names, `tea time`, `noon`,
  `@<unix>`, explicit timezone suffixes. We implement the common forms (§3.3);
  the ones we *do* support behave exactly like git.

Nothing in the reflog feature itself is deferred — `expire-unreachable`,
`delete --rewrite`, and `core.logAllRefUpdates=always` are all in.

## 2. On-disk format — `.git/logs/`

One file per logged ref, mirroring the ref's path:

```
.git/logs/HEAD
.git/logs/refs/heads/<branch>
.git/logs/refs/remotes/<remote>/<branch>
```

Each file is append-only, **oldest entry first, newest last**. One entry per
line:

```
<old-oid> SP <new-oid> SP <identity> TAB <message> LF
```

- `old-oid`, `new-oid` — 40-hex SHA-1. The **first** entry for a ref has
  `old-oid` = 40 zeros (`ZERO_OID`).
- `identity` — committer identity in the canonical
  `Name <email> <unix-ts> <tz>` form already produced by
  `serializeIdentity` (`src/domain/objects/author-identity.ts`).
- `TAB` separates identity from message — always present, even when `message`
  is empty.
- `message` — single line, no `LF`/`CR`. Sanitised at the writer (§6.1).

Example (`.git/logs/HEAD`):

```
0000000000000000000000000000000000000000 a1b2…f00 Ada <ada@x> 1716240000 +0000	commit (initial): add readme
a1b2…f00 c3d4…e11 Ada <ada@x> 1716240120 +0000	commit: second
c3d4…e11 a1b2…f00 Ada <ada@x> 1716240200 +0000	reset: moving to HEAD~1
```

`.git/logs/` is **not** created at `init` — git creates it lazily on the first
logged ref update, and so do we (`appendReflog` does `mkdir -p` of the parent).

## 3. Domain layer — `src/domain/reflog/`

Pure, zero-I/O. New module directory.

### 3.1 `reflog-entry.ts`

```ts
export interface ReflogEntry {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly identity: AuthorIdentity;
  readonly message: string;
}
```

### 3.2 `reflog-format.ts`

```ts
/** Serialize one entry to a single LF-terminated line. */
export function serializeReflogLine(entry: ReflogEntry): string;

/** Parse one line (LF already stripped). Throws INVALID_REFLOG_ENTRY. */
export function parseReflogLine(line: string): ReflogEntry;

/** Parse a whole reflog file. Blank trailing line tolerated. Oldest-first. */
export function parseReflog(text: string): ReadonlyArray<ReflogEntry>;
```

Parsing is offset-based, not split-based, because the message may contain
spaces and the identity contains spaces and `<>`:

- `tab = line.indexOf('\t')` → `meta = line.slice(0, tab)`,
  `message = line.slice(tab + 1)`.
- `oldId = meta.slice(0, 40)`, `newId = meta.slice(41, 81)`,
  `identityStr = meta.slice(82)`.
- `meta[40]` and `meta[81]` are asserted to be the field-separator space, and
  `oldId`/`newId` validated through `ObjectId.from`; `identityStr` through
  `parseIdentity`. A missing `TAB`, a misplaced separator, or any sub-parse
  failure → `INVALID_REFLOG_ENTRY`.

Serialization rejects a `message` containing `LF`/`CR` (defence-in-depth —
the writer sanitises first, §6.1).

### 3.3 `approxidate.ts`

Shared by `@{date}` resolution (§8) and `reflog expire` (§9). Pure.

```ts
/** Resolve an approximate-date string to a unix timestamp (seconds).
 *  `now` is the reference instant (also unix seconds). undefined = unparseable. */
export function parseApproxidate(text: string, now: number): number | undefined;
```

Supported forms (documented in [ADR-062](../adr/062-approxidate-subset.md)):

| Form | Example |
|------|---------|
| `now` | `now` |
| `yesterday` | `yesterday` (now − 24h) |
| ISO date | `2026-05-01` |
| ISO datetime | `2026-05-01 12:30:00` |
| relative, dotted | `2.days.ago`, `90.days`, `3.weeks.ago` |
| relative, spaced | `2 days ago`, `3 weeks ago` |

Units: `second`, `minute`, `hour`, `day`, `week`, `month`, `year` (singular or
plural). `month` ≈ 30 days, `year` ≈ 365 days — approximate, as in git's own
relative-date arithmetic. A trailing `.ago` / ` ago` is optional and
semantically a no-op (relative forms always look backward).

**Timezone — git-faithful.** ISO date / datetime forms are interpreted in the
**host's local timezone**, exactly as git's approxidate does, by constructing
the instant from calendar components (`new Date(y, m-1, d, …)`), never via
`Date.parse` (whose date-only handling is UTC and would diverge). Relative
forms (`2.days.ago`) are timezone-agnostic — `now` minus a delta. Unit tests
pin `TZ=UTC` in the vitest environment for determinism (git's own test suite
does the same); the *behaviour* matches git on every host.

The forms we do not implement (§1) simply return `undefined` → the caller
surfaces `REVPARSE_UNRESOLVED`.

### 3.4 `should-log.ts`

Pure predicate for the default-loggable prefix rule (§10):

```ts
export interface LogAllRefUpdates {
  readonly logAllRefUpdates?: boolean | 'always';
  readonly bare?: boolean;
}
/** git's should_autocreate_reflog: does config + ref-prefix call for a log? */
export function shouldAutocreateReflog(ref: RefName, cfg: LogAllRefUpdates): boolean;
```

Logic (mirrors git's `core.c` / `refs.c`):

- `logAllRefUpdates === 'always'` → `true` (log every ref, tags included).
- `logAllRefUpdates === false` → `false`.
- otherwise *enabled* = `logAllRefUpdates === true ? true : !bare` (unset →
  `!bare`); when enabled, log only the **default-loggable** refs: `HEAD`, and
  anything under `refs/heads/`, `refs/remotes/`, `refs/notes/`.

`refs/tags/*` is not default-loggable — matching git, tag creation is not
reflogged unless `always` is set or a tag reflog file already exists (§6.1).

### 3.5 `error.ts`

```ts
export type ReflogError =
  | { readonly code: 'INVALID_REFLOG_ENTRY'; readonly reason: string }
  | { readonly code: 'REFLOG_NOT_FOUND'; readonly ref: RefName }
  | {
      readonly code: 'REFLOG_ENTRY_OUT_OF_RANGE';
      readonly ref: RefName;
      readonly requested: number;
      readonly available: number;
    };
```

`ReflogError` is added to the `TsgitErrorData` union in `src/domain/error.ts`,
with `extractDetail` arms. An unparseable `@{date}` is **not** a new code — it
surfaces as the existing `REVPARSE_UNRESOLVED`.

### 3.6 `index.ts`

Barrel re-exporting the public surface.

### 3.7 `ZERO_OID`

A `ZERO_OID` constant (`ObjectId` of 40 zeros) is added to
`src/domain/objects/` and re-exported. Three call sites already inline
`'0'.repeat(40) as ObjectId` (`branch.ts`, `tag.ts`, `fetch.ts`); they migrate
to the constant in passing.

## 4. Port addition — `FileSystem.appendUtf8`

The reflog is append-structured; the `FileSystem` port has no append. Adding
one method is cleaner than read-modify-write under a lock (see
[ADR-060](../adr/060-append-utf8-port.md)).

```ts
/** Append UTF-8 to a file, creating parent directories and the file as
 *  needed. Atomic per-call for line-sized writes (relies on O_APPEND). */
readonly appendUtf8: (path: string, content: string) => Promise<void>;
```

Adapter implementations:

| Adapter | Implementation |
|---------|----------------|
| Node | `fs.appendFile(path, content, 'utf8')` after `mkdir -p`; `O_APPEND` gives per-write atomicity for line-sized content. |
| Memory | `map.set(path, (map.get(path) ?? '') + content)` — single-threaded, trivially atomic. |
| Browser (OPFS) | `createWritable({ keepExistingData: true })`, `write({ type:'write', position:<size>, data })`, `close()`. |

This is the same atomicity model git relies on: the ref `.lock` protects the
ref *file*; the reflog append itself rides `O_APPEND`. The contract is
exercised by the shared `file-system.contract.ts` suite, so all three adapters
get coverage.

## 5. Application primitives — `src/application/primitives/`

### 5.1 `reflog-store.ts`

Thin I/O layer over `.git/logs/<ref>`.

```ts
export function appendReflog(ctx, ref: RefName, entry: ReflogEntry): Promise<void>;
export function readReflog(ctx, ref: RefName): Promise<ReadonlyArray<ReflogEntry>>; // [] if absent
export function reflogExists(ctx, ref: RefName): Promise<boolean>;
export function writeReflog(ctx, ref: RefName, entries: ReadonlyArray<ReflogEntry>): Promise<void>; // full rewrite — expire/delete
export function deleteReflog(ctx, ref: RefName): Promise<void>; // remove the file
export function listReflogs(ctx): Promise<ReadonlyArray<RefName>>; // every file under .git/logs/ — expire all
```

`appendReflog` serialises one line and calls `ctx.fs.appendUtf8`. `writeReflog`
serialises all entries and uses `ctx.fs.writeUtf8` (whole-file replace — only
used by `expire`/`delete`, not on any hot path). `listReflogs` recursively
walks `.git/logs/` via `ctx.fs.readdir`, returning each file's path relative to
`logs/` as a `RefName`.

A bounded read: a reflog file larger than `MAX_REFLOG_BYTES` (16 MiB — generous;
`expire` is the size-management story, §7) throws `INVALID_REFLOG_ENTRY` rather
than buffering unbounded input — mirrors the `MAX_GITIGNORE_BYTES` /
`MAX_INDEX_BYTES` guards.

### 5.2 `record-ref-update.ts` — the reflog writer

The single reflog *writer*. **Self-contained** — it reads config, applies the
gate, resolves identity, and appends. Callers supply only a message.

```ts
/** Append a reflog entry for `ref` IF logging applies. No-op when the gate
 *  (§10) is closed for `ref`. One reflog file — HEAD coupling is updateRef's
 *  job (§6.2). */
export function recordRefUpdate(
  ctx: Context,
  ref: RefName,
  oldId: ObjectId,
  newId: ObjectId,
  message: string,
): Promise<void>;
```

Internally:

1. **Gate** — log iff `reflogExists(ctx, ref)` *or*
   `shouldAutocreateReflog(ref, config.core)` (§3.4). The existing-file arm
   mirrors git: once a ref has a log, every update appends to it regardless of
   prefix. Gate closed → return without writing.
2. **Identity** — `resolveReflogIdentity(ctx)` (§6.1).
3. **Message** — `sanitizeReflogMessage` collapses `CR`/`LF` to a space, trims.
4. `appendReflog(ctx, ref, { oldId, newId, identity, message })`.

`recordRefUpdate` is the *only* place a reflog line is born. It reads
`.git/config` through `readConfig`, which is why `config-read` moves down into
the primitive tier ([ADR-058](../adr/058-reflog-integration-point.md), §9) —
config reading is a low-level repo-file operation and a primitive importing
from `commands/internal/` would violate the dependency direction anyway.

### 5.3 `reflog-identity.ts`

```ts
/** Committer identity for reflog entries: config user.* + a fresh timestamp,
 *  or a portable fallback when user.* is unset. Never throws. */
export function resolveReflogIdentity(ctx: Context): Promise<AuthorIdentity>;
```

`readConfig(ctx).user` → `{ name, email, timestamp: now, timezoneOffset }`.
Unlike `commit`, reflog logging **never throws `AUTHOR_UNCONFIGURED`**: git
keeps logging even with no `user.*`. Git's fallback is the system
`username@hostname`, which is not portable (the browser adapter has no such
notion); tsgit uses a fixed portable fallback — `name = 'tsgit'`,
`email = 'tsgit@localhost'` ([ADR-061](../adr/061-reflog-identity.md)). When
`user.*` *is* set, the identity matches git exactly.

### 5.4 `path-layout.ts` additions

```ts
export const logsDir = (gitDir: string): string => `${gitDir}/logs`;
export const reflogPath = (gitDir: string, ref: RefName): string =>
  `${gitDir}/logs/${ref}`;
```

`ref` is always a `validateRefName`-checked branded `RefName`, so
`${gitDir}/logs/${ref}` cannot escape the git dir (the argument `looseRefPath`
already relies on).

### 5.5 `enumerate-refs.ts`

`reflog expire`'s unreachable cutoff (§7) needs the tips of every current ref.

```ts
/** All current refs: HEAD, loose refs under refs/**, and packed-refs. */
export function enumerateRefs(ctx: Context): Promise<ReadonlyArray<RefName>>;
```

A loose walk of `.git/refs/` + `parsePackedRefs` + `HEAD`, deduplicated. Used
only by `expire`; not on any hot path.

## 6. Writer integration — automatic, git-faithful

Git's model: a ref update **logs itself** as part of the ref transaction,
gated by config; the caller only supplies the *reason string*. tsgit follows
that — logging is automatic inside `updateRef` and `recordRefUpdate`; callers
pass a message, never an "intent" or an opt-out flag.

HEAD moves happen through three mechanisms; all three log:

1. `updateRef` — direct ref writes (`commit`, `branch`, `reset`, `merge`,
   `fetch`, `push`, `clone`, `tag`).
2. `writeSymbolicRef` — HEAD repointing at branch switch (`checkout`).
3. Raw `ctx.fs.writeUtf8('.git/HEAD', …)` — detached-HEAD moves
   (`commit` detached, `checkout` detached).

### 6.1 Identity, gate, message

All three live *inside* the writer primitives (`recordRefUpdate`, §5.2):

- **Gate** — `reflogExists || shouldAutocreateReflog` (§5.2 / §10). No command
  evaluates `core.logAllRefUpdates` itself.
- **Identity** — `resolveReflogIdentity` (§5.3).
- **Message sanitising** — `sanitizeReflogMessage`, applied by
  `recordRefUpdate`.

There is **no** `reflog-intent.ts` and **no** `buildReflogIntent` — the earlier
draft's per-command intent plumbing is gone. A command's only obligation is to
hand a human-readable message to the ref-write call.

### 6.2 `updateRef` — automatic logging + HEAD coupling

`updateRef`'s options become a discriminated union — a write requires a
`reflogMessage` (git's builtins always supply one); a delete does not
([ADR-058](../adr/058-reflog-integration-point.md)):

```ts
export type UpdateRefOptions =
  | { readonly delete?: false;
      readonly expected?: ObjectId | 'absent';
      readonly reflogMessage: string }     // write — message required
  | { readonly delete: true;
      readonly expected?: ObjectId | 'absent' }; // delete — no message

export function updateRef(
  ctx: Context, name: RefName, newId: ObjectId, options: UpdateRefOptions,
): Promise<void>;
```

`reflogMessage` being required on the write arm is the breaking change (v2.0):
the type checker forces every present and future `updateRef` write to state why
the ref moved. New behaviour:

1. Capture `oldId` — the ref's current direct value, or `ZERO_OID` if absent
   (one loose-ref read; `updateRef` already does this for `expected`).
2. Perform the write (`atomicWriteRef`) — or the delete.
3. **On a write:**
   - `recordRefUpdate(ctx, name, oldId, newId, reflogMessage)` — self-gates.
   - **HEAD coupling** — `getRefStore(ctx).resolveDirect('HEAD')`; if it is
     symbolic with `target === name`, also
     `recordRefUpdate(ctx, 'HEAD', oldId, newId, reflogMessage)`
     ([ADR-059](../adr/059-head-dual-logging.md)). Reproduces git logging both
     `.git/logs/refs/heads/main` and `.git/logs/HEAD` when you commit on `main`.
4. **On a delete:** `deleteReflog(ctx, name)` — git drops the reflog file when
   the ref is deleted.

`updateRef` resolves HEAD via the ref store (a primitive) — no command-tier
import. The gate is evaluated inside `recordRefUpdate`, so a closed gate makes
both calls cheap no-ops.

### 6.3 HEAD moves outside `updateRef`

`writeSymbolicRef` stays reflog-free (it writes a symref, not a value — no
old/new OID). The HEAD-moving command logs explicitly by calling
`recordRefUpdate` for `HEAD`:

- `checkout` branch switch — after resolving `oldOid` (HEAD before) and
  `newOid` (HEAD after): `recordRefUpdate(ctx, 'HEAD', oldOid, newOid,
  'checkout: moving from <A> to <B>')`.
- `checkout` / `commit` detached-HEAD raw writes — the same direct
  `recordRefUpdate(ctx, 'HEAD', …)` call.

No wrapper helper is needed — `recordRefUpdate` *is* the shared call, and it
self-gates and self-resolves identity.

**Branch rename** is the one site that must not recreate a log. `branch` rename
runs as `updateRef` create-`to` + delete-`from`; the defaults would write a
fresh single-entry log for `to` and `deleteReflog` the history of `from`.
Instead `branch.ts` moves the log explicitly — `readReflog(from)` →
`writeReflog(to, …)` → `deleteReflog(from)` — then `recordRefUpdate(to, …,
'branch: renamed <old> to <new>')`. The create-`to`/delete-`from` `updateRef`
calls still run for the ref files; the create passes a `reflogMessage` but its
`recordRefUpdate` simply appends one more entry after the moved history.

### 6.4 Per-command message catalogue

Matches canonical git wording so third-party reflog readers stay happy:

| Command | Ref(s) logged | Message |
|---------|---------------|---------|
| `commit` (first) | branch, HEAD | `commit (initial): <subject>` |
| `commit` | branch, HEAD | `commit: <subject>` |
| `commit` resolving a conflicted merge | branch, HEAD | `commit (merge): <subject>` |
| `branch` create | `refs/heads/<n>` | `branch: Created from <start-point>` |
| `branch` rename | `refs/heads/<new>` | log moved (§6.3); `branch: renamed <old> to <new>` |
| `checkout` switch | HEAD | `checkout: moving from <A> to <B>` |
| `reset` (soft/mixed/hard) | branch, HEAD | `reset: moving to <target>` |
| `merge` fast-forward | branch, HEAD | `merge <name>: Fast-forward` |
| `merge` clean merge commit | branch, HEAD | `merge <name>: Merge made by the 'tsgit' strategy.` |
| `fetch` | `refs/remotes/<r>/<b>` | `fetch <remote>: storing head` |
| `push` | `refs/remotes/<r>/<b>` | `update by push` |
| `clone` | branch, HEAD | `clone: from <url>` |
| `tag` | `refs/tags/*` | `tag: <name>` — passed, but the gate skips `refs/tags/*` unless `always` / an existing tag log |

`<subject>` is the commit message's first line, sanitised. `branch` *delete*
removes the reflog file (the `updateRef` delete path). Two distinct `merge`
rows: `merge.ts` calls `updateRef` directly (it does not route through the
`commit` command) — a clean merge it completes itself logs `merge <name>: …`; a
merge that hits conflicts does **not** move HEAD (no entry), and the user's
later resolving `commit` logs `commit (merge): …`.

## 7. `repo.reflog()` — tier-1 command

`src/application/commands/reflog.ts`. One command, discriminated `action`
(default `'show'`) — same shape pattern as `branch` / `tag`
([ADR-064](../adr/064-reflog-command-shape.md)):

```ts
export type ReflogAction =
  | { readonly action?: 'show'; readonly ref?: string }      // default
  | { readonly action: 'exists'; readonly ref: string }
  | { readonly action: 'delete'; readonly ref: string;
      readonly index: number; readonly rewrite?: boolean }
  | { readonly action: 'expire'; readonly ref?: string; readonly all?: boolean;
      readonly expire?: string;             // approxidate, default '90.days.ago'
      readonly expireUnreachable?: string }; // approxidate, default '30.days.ago'

export interface ReflogShowEntry {
  readonly index: number;             // 0 = newest
  readonly selector: string;          // '<ref>@{0}'
  readonly entry: ReflogEntry;
}
export type ReflogResult =
  | { readonly kind: 'show'; readonly ref: RefName;
      readonly entries: ReadonlyArray<ReflogShowEntry> }   // newest-first
  | { readonly kind: 'exists'; readonly exists: boolean }
  | { readonly kind: 'expire'; readonly removed: number; readonly kept: number }
  | { readonly kind: 'delete'; readonly removed: ReflogEntry };

export function reflog(ctx: Context, opts?: ReflogAction): Promise<ReflogResult>;
```

- **`show`** — `readReflog`, reverse to newest-first, attach `index` +
  `selector`. `ref` defaults to `'HEAD'`. A missing reflog → empty `entries`
  (not an error — matches `git reflog` on a fresh repo).
- **`exists`** — `reflogExists`.
- **`delete`** — drop entry `index` (counted newest-first, like `@{N}`),
  `writeReflog` the remainder, return the removed entry. With
  `rewrite: true`, the entry that followed the deleted one (in file order) has
  its `oldId` rewritten to the deleted entry's `oldId`, repairing the
  old→new chain — git's `--rewrite`. A `ref` with no reflog file →
  `REFLOG_NOT_FOUND`; out-of-range `index` → `REFLOG_ENTRY_OUT_OF_RANGE`.
- **`expire`** — git's two-cutoff prune:
  - `cut = parseApproxidate(expire ?? '90.days.ago', now)`,
    `cutU = parseApproxidate(expireUnreachable ?? '30.days.ago', now)`.
  - Build the **reachable commit set**: `enumerateRefs` (§5.5) → `walkCommits`
    from each tip, collecting every reachable commit id into a `Set`.
  - For each entry, keep iff
    `reachable(entry.newId) ? ts >= cut : ts >= cutU` — unreachable entries
    expire on the shorter clock, exactly as git. An entry's `newId` that is not
    a commit (never the case for ref values today) is treated as unreachable.
  - `writeReflog` the survivors. `all: true` runs every file from
    `listReflogs`; otherwise the single `ref` (default `HEAD`). Returns
    `removed` / `kept` totals. Unparseable cutoff → `REVPARSE_UNRESOLVED`.

`reflog` is bound onto the `Repository` facade as `repo.reflog`. `revParse`
stays in `commands.*`; `recordRefUpdate` is exported from the primitives barrel
and bound under `repo.primitives.recordRefUpdate` for advanced callers.

## 8. `@{N}` / `@{date}` in `revParse`

### 8.1 Grammar — `commands/internal/rev-parse-grammar.ts`

Today `parseExpression` does `if (raw.includes('@{')) fail(raw)`. That guard is
replaced with real parsing. The reflog selector binds to the **base ref**,
*before* any `~`/`^` operations:

```
<base> @{ <selector> } <op>*
```

`RevExpression`'s `ref-or-hex` variant gains an optional `reflog` field:

```ts
export type ReflogSelector =
  | { readonly kind: 'index'; readonly n: number }   // @{2}
  | { readonly kind: 'date'; readonly raw: string }; // @{yesterday} — resolved by evaluator

export type RevExpression =
  | { readonly kind: 'ref-or-hex'; readonly base: string;
      readonly reflog?: ReflogSelector;
      readonly operations: ReadonlyArray<RevOperation> }
  | { readonly kind: 'index-stage'; … };
```

Parsing rules:

- Split on the first `@{`; the matching `}` is found with `indexOf('}', …)`.
  Text after `}` is the operation chain (existing `parseOperations`).
- Selector body **all digits** → `{ kind:'index', n }`. Anything else →
  `{ kind:'date', raw }` — the evaluator resolves the date, keeping the parser
  pure and clock-free.
- Empty selector body `@{}` → `fail`; an unbalanced `@{…` → `fail`.
- `base` empty (bare `@{N}`) is **allowed** → resolved against the current
  branch (§8.2). Bare `@{N}` and `HEAD@{N}` are *different* logs in git —
  `@{N}` is the checked-out branch's reflog, `HEAD@{N}` is HEAD's.

### 8.2 Evaluation — `rev-parse.ts`

A new branch in `evaluate`: when `expr.reflog` is set, the base resolves
through the reflog instead of `resolveBase`'s ref/hex lookup.

```
resolveReflogBase(ctx, base, selector, now):
  ref = base === ''  ? currentBranchRef(ctx)   // HEAD's symbolic target;
                                               // detached → 'HEAD'
                     : canonicalizeRef(ctx, base)
  entries = readReflog(ctx, ref)
  if entries empty → REVPARSE_UNRESOLVED
  selector.kind === 'index' → pickByIndex(entries, n, ref)
  selector.kind === 'date'  → pickByDate(entries, parseApproxidate(raw, now))
```

`canonicalizeRef` maps a short base to the `RefName` whose log to read: it tries
the same candidate ladder as `resolveBase` (`base`, `refs/heads/base`,
`refs/tags/base`, `refs/remotes/base`, plus the `HEAD` literal) and picks the
first whose reflog file exists (`reflogExists`); if none has a log it falls
back to the first that resolves as a ref, so the empty-reflog →
`REVPARSE_UNRESOLVED` path still fires with a sensible `ref`.

- **`pickByIndex`** — entries are oldest-first; `@{n}` →
  `entries[len - 1 - n].newId`. `n > len - 1` →
  `REFLOG_ENTRY_OUT_OF_RANGE { requested:n, available:len }`.
- **`pickByDate`** — newest entry with `identity.timestamp <= target` → its
  `newId`; if `target` precedes the oldest entry → `entries[0].oldId` (git's
  "ref had this value before the log starts" behaviour). Unparseable date →
  `REVPARSE_UNRESOLVED`.

The resolved `ObjectId` then flows through the existing `~`/`^` operation loop
unchanged, so `HEAD@{2}^` and `main@{yesterday}~3` work for free.

`now` is sourced once per `revParse` call (`Date.now()`) and threaded down — the
grammar parser stays pure and deterministic; only the evaluator touches the
clock.

## 9. Module structure / file layout

```
src/domain/reflog/                    NEW
  reflog-entry.ts        ReflogEntry type
  reflog-format.ts       serialize/parse line + parseReflog
  approxidate.ts         parseApproxidate (shared: @{date} + expire)
  should-log.ts          shouldAutocreateReflog (pure gate predicate)
  error.ts               ReflogError union + constructors
  index.ts               barrel
src/domain/objects/
  object-id.ts           + ZERO_OID constant
src/domain/error.ts      + ReflogError in TsgitErrorData + extractDetail arms

src/ports/file-system.ts + appendUtf8
src/adapters/node|browser|memory/…    + appendUtf8 impl + contract test

src/application/primitives/
  reflog-store.ts        NEW — append/read/write/exists/delete/list
  record-ref-update.ts   NEW — recordRefUpdate (the reflog writer)
  reflog-identity.ts     NEW — resolveReflogIdentity
  enumerate-refs.ts      NEW — enumerateRefs (expire reachability)
  config-read.ts         MOVED from commands/internal/ — + core.logAllRefUpdates field
  path-layout.ts         + logsDir, reflogPath
  update-ref.ts          MODIFIED — UpdateRefOptions union, auto-log, HEAD coupling, delete→deleteReflog
  index.ts               + exports

src/application/commands/
  reflog.ts              NEW — tier-1 reflog command
  internal/rev-parse-grammar.ts  MODIFIED — @{…} parsing
  rev-parse.ts           MODIFIED — reflog base resolution
  commit.ts branch.ts checkout.ts reset.ts merge.ts fetch.ts push.ts clone.ts tag.ts
                         MODIFIED — pass reflogMessage / call recordRefUpdate for HEAD
  index.ts               + reflog export
  (every importer of the old commands/internal/config-read path updates the import)

src/repository.ts        + repo.reflog binding, + primitives.recordRefUpdate
README.md DESIGN.md RUNBOOK.md CONTRIBUTING.md   docs refresh
```

`config-read.ts` moving from `commands/internal/` to `primitives/` is a
mechanical import-path change at its existing consumers (`commit.ts`,
`repo-state.ts`, the gitignore predicate, …); dependency-cruiser enforces the
layering, so the move is the *correct* placement, not merely convenient.

### Implementation slices (parallelism for the plan)

1. **Domain + port** — `reflog/*`, `ZERO_OID`, `appendUtf8` across 3 adapters.
   Self-contained. *(Parallelizable with slice 2.)*
2. **Config move + store/writer primitives** — `config-read` relocation,
   `reflog-store.ts`, `record-ref-update.ts`, `reflog-identity.ts`,
   `enumerate-refs.ts`, `path-layout` additions. Depends on slice 1.
3. **`updateRef` integration + command sites** — `UpdateRefOptions` union,
   HEAD coupling, wiring `commit`/`branch`/`checkout`/`reset`/`merge`/`fetch`/
   `push`/`clone`/`tag`. Depends on slice 2.
4. **`reflog` command** — `show`/`exists`/`delete`/`expire`. Depends on slice 2.
   *(Parallelizable with slice 3.)*
5. **`@{N}` / `@{date}` in revParse** — grammar + evaluator. Depends on slice 2.
   *(Parallelizable with slices 3–4.)*
6. **Facade + docs** — `repository.ts` bindings, doc refresh. Depends on 3–5.

Each slice lands as one or more atomic conventional commits.

## 10. `core.logAllRefUpdates`

Git logs ref updates only when `core.logAllRefUpdates` allows it — default
`true` for repos with a working tree, `false` for bare repos, and `always`
to log every ref including tags and pseudo-refs.
[ADR-063](../adr/063-log-all-ref-updates.md):

- A new `ParsedConfig.core.logAllRefUpdates` field, typed `boolean | 'always'`.
  `config-read.ts`'s `mergeCore` parses the `logallrefupdates` key: literal
  `always` → `'always'`; otherwise the existing `parseGitBoolean`.
- The effective per-ref decision is the pure `shouldAutocreateReflog`
  predicate (§3.4): `always` → log everything; `false` → log nothing;
  `true`/unset → log the default-loggable prefixes (`HEAD`, `refs/heads/`,
  `refs/remotes/`, `refs/notes/`), with unset defaulting to `!bare`.
- An **existing** reflog file is always appended to, regardless of the
  predicate — `recordRefUpdate` checks `reflogExists` first (§5.2). This
  matches git's `log_ref_setup`.

The `reflog` *command* (show/expire/delete) ignores the gate — it inspects and
manages logs that already exist; only *writers* are gated.

## 11. Testing strategy

Per `CLAUDE.md`: 100% line/branch/function/statement coverage, 0 surviving
mutants, Given/When/Then titles, AAA bodies, `sut`.

### Unit

- **`reflog-format`** — serialize↔parse round-trip; first-entry `ZERO_OID`;
  empty message; message-with-spaces; identity-with-`<>`-in-name; rejects
  missing `TAB`, short OID, non-hex OID, misplaced separator, `LF` in message;
  `parseReflog` multi-line + tolerated trailing blank line.
- **`approxidate`** — every supported form; `.ago` no-op equivalence; unknown
  unit / garbage → `undefined`; `month`/`year` approximation pinned; ISO forms
  asserted under a pinned `TZ`.
- **`should-log`** — every arm: `always`, `false`, `true`, unset×`!bare`,
  each default-loggable prefix, `refs/tags/*` excluded. Isolated per-arm tests
  (mutation).
- **`reflog-store`** — append creates `.git/logs/` dir; `readReflog` of a
  missing file → `[]`; `writeReflog` round-trip; `MAX_REFLOG_BYTES` guard;
  `deleteReflog` of a missing file is a no-op; `listReflogs` recursion.
- **`record-ref-update`** — gate-open appends; gate-closed is a silent no-op;
  existing-log arm appends even for a non-default prefix; message sanitised.
- **`reflog-identity`** — config `user.*` honoured; portable fallback when
  unset; never throws.
- **`enumerate-refs`** — loose + packed + HEAD union, deduped.
- **`rev-parse-grammar`** — `HEAD@{2}`, `main@{0}^`, `@{yesterday}`,
  bare `@{1}`, `@{}` rejected, unbalanced `@{2` rejected, digits→index vs.
  text→date discrimination.
- **`rev-parse` reflog evaluator** — `pickByIndex` newest-first mapping +
  out-of-range throw; `pickByDate` boundary (target before oldest →
  `entries[0].oldId`, target after newest → newest `newId`); `canonicalizeRef`
  ladder; empty reflog → `REVPARSE_UNRESOLVED`.
- **`reflog` command** — `show` ordering + selectors, default ref, empty-log;
  `exists`; `delete` removes the right entry, `rewrite` repairs the chain,
  out-of-range throws; `expire` reachable vs. unreachable partition, `all`.
- **`updateRef`** — write logs; delete removes the reflog file; HEAD coupling
  fires only when HEAD's symref target equals the ref. Isolated guard tests for
  the symbolic-vs-target condition (mutation).
- **port contract** — `appendUtf8` in `file-system.contract.ts` (node + memory
  + browser): creates file, creates parent dirs, appends to existing,
  sequential-append accumulation.

### Integration (`test/integration/`)

- Real repo: `init` → `commit` ×2 → assert `.git/logs/HEAD` and
  `.git/logs/refs/heads/main` line count, OIDs, messages.
- `branch` / `checkout` / `reset` / `merge` ff / `fetch` each produce the
  expected entry; conflicted `merge` produces none; bare repo logs nothing.
- `revParse('HEAD@{1}')` after two commits === first commit;
  `revParse('main@{0}')` === tip; `HEAD@{2}^` chains; `@{date}` against a
  seeded reflog with controlled timestamps.
- `reflog expire` prunes reachable vs. unreachable on the two clocks;
  `reflog delete` drops one entry, `rewrite` repairs continuity.
- **Interop**: parse a reflog produced by canonical `git` (fixture) and assert
  `parseReflog` agrees; write one and assert `git reflog` reads it (where `git`
  is on the runner).

### Property-based

`serializeReflogLine ∘ parseReflogLine` round-trips for arbitrary valid entries
(fast-check generators for OID, identity, message).

## 12. Key design decisions (→ ADRs)

Recorded under `docs/adr/` before implementation:

| ADR | Decision |
|-----|----------|
| 058 | Logging is **automatic** inside `updateRef` / `recordRefUpdate` (git-faithful); a write passes a required `reflogMessage`. `config-read` moves to the primitive tier to enable it. |
| 059 | HEAD dual-logging — updating a branch HEAD points at also appends `.git/logs/HEAD`. |
| 060 | `FileSystem.appendUtf8` port addition (vs. read-modify-write). |
| 061 | Reflog identity from `user.*`; portable `tsgit@localhost` fallback when unset (git's `username@hostname` is not portable); reflog never throws `AUTHOR_UNCONFIGURED`. |
| 062 | approxidate **form subset**, but supported forms behave like git — ISO dates parsed in host-local tz; tests pin `TZ`. |
| 063 | `core.logAllRefUpdates` honoured incl. `always`; default `!bare`; default-loggable prefix rule; existing log files always appended. |
| 064 | Single discriminated `reflog` command; `expire` does git's reachable/unreachable two-cutoff prune; `delete` supports `--rewrite`. |

## 13. Risks & mitigations

- **Missed writer site** — a future ref write that forgets to log. Mitigated by
  the required `reflogMessage` on the `updateRef` write arm (compile error if
  omitted) and by `recordRefUpdate` being the single chokepoint every writer
  funnels through; the integration suite asserts per-command entries.
- **Append atomicity** — interleaved appends from concurrent processes could
  tear a line. Same risk git carries; `O_APPEND` makes line-sized writes atomic
  on POSIX. tsgit is single-process per `Context`; documented, not engineered
  around.
- **Reflog append fails after the ref moved** — the entry is appended *after*
  the `atomicWriteRef` rename (§6.2 step 3). If the append throws, the ref has
  moved but is unlogged — the lesser evil (logging *before* the write risks a
  logged move that never happened), and it matches git, where the reflog is
  best-effort relative to the ref update. The error still propagates; it is not
  swallowed.
- **Clock in the parser** — kept out: the grammar parser is pure; only the
  evaluator and `reflog`/`recordRefUpdate` read `Date.now()`, injected as `now`
  / read at the I/O edge. Preserves deterministic unit tests.
- **`@{date}` ambiguity** — a digits-only selector is always an index, never a
  unix timestamp. Documented; matches git.
- **`config-read` relocation blast radius** — moving the module changes import
  paths at ~6 consumers. Mechanical; dependency-cruiser + `tsc` catch any miss.
- **Breaking `updateRef` signature** — acceptable: 17.x targets v2.0 (major)
  and tsgit has no released consumers to migrate yet.
