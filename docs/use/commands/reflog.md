# `reflog`

Show, query, delete, or expire entries in `.git/logs/`. Reflog is automatically written by `recordRefUpdate` whenever a ref moves; this command lets you read or prune those logs.

## Signature

```ts
repo.reflog(opts?: ReflogAction): Promise<ReflogResult>;

type ReflogAction =
  | { action?: 'show'; ref?: string }
  | { action: 'exists'; ref: string }
  | { action: 'delete'; ref: string; index: number; rewrite?: boolean }
  | { action: 'expire'; ref?: string; all?: boolean;
      expire?: string; expireUnreachable?: string };

type ReflogResult =
  | { kind: 'show'; ref: RefName; entries: ReadonlyArray<ReflogShowEntry> }
  | { kind: 'exists'; exists: boolean }
  | { kind: 'delete'; removed?: ReflogEntry }   // absent when `index` named no entry
  | { kind: 'expire'; removed: number; kept: number };

interface ReflogShowEntry {
  readonly index: number;          // 0 = newest
  readonly selector: string;       // e.g. 'HEAD@{0}'
  readonly entry: ReflogEntry;
}

interface ReflogEntry {
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly identity: { name: string; email: string; timestamp: number; timezoneOffset: string };
  readonly message: string;
}
```

## Actions

| Action | Meaning |
|---|---|
| `show` (default) | List entries newest-first. `ref` defaults to `'HEAD'`. |
| `exists` | Check whether `.git/logs/<ref>` is present and non-empty. |
| `delete` | Drop entry at `index` (newest = 0). `rewrite: true` shifts subsequent entries up. |
| `expire` | Prune by date (`'90.days.ago'`, `'2026-01-01'`, …) or by keyword (`never`, `false`, `all`, `now`) — see Behaviour. `expireUnreachable` sets a second cutoff for entries pointing at unreachable commits. |

## Behaviour

- **Lenient reads.** `show`, `delete`, and `expire` all read the reflog leniently: a malformed line is skipped and the surviving entries keep contiguous `@{n}` indices, exactly as git does. The `MAX_REFLOG_BYTES` cap (16 MiB) still refuses regardless.
- **Approxidate parser** accepts a subset of git's date forms: `now`, `yesterday`, `<N>.days.ago`, `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`. Anything else throws `REVPARSE_UNRESOLVED`.
- **`expire` / `expireUnreachable` grammar** resolves a keyword layer first, the same one `maintenance`'s `gc.pruneExpire` uses: `never` (case- and whitespace-tolerant) and the exact-match `false` mean nothing expires; the exact-match `all` and `now` resolve to the maximum time, so everything — future-dated entries included — expires. Uppercase `ALL`/`FALSE` refuse, as in git; anything else falls to the approxidate parser above.
- **Where the cutoffs come from**, per slot — `expire` and `expireUnreachable` resolve independently, in this order:
  1. the explicit option, when supplied;
  2. otherwise the **first** `gc.<pattern>` section whose glob matches the ref's resolved full name. A matching pattern that leaves the other slot unset means `never` for that slot — it does **not** fall through to the global;
  3. otherwise `never`, for `refs/stash` only;
  4. otherwise the plain `gc.reflogExpire` / `gc.reflogExpireUnreachable` value;
  5. otherwise the default.

  Patterns are tried in file order (same-named sections merged into one); duplicate keys inside a group are last-wins. Section and key names fold to lower case, so `[GC] reflogexpire` is the same key as `[gc] reflogExpire`; the pattern between the quotes is kept verbatim and matched case-sensitively, in the same glob dialect [`name-rev`](name-rev.md)'s `refs`/`exclude` uses.
- **These keys are read from the repository's own config only** — a cutoff set in the user's global config is ignored, where git honours it. A recorded divergence, pinned against real git.
- **The defaults are 30 days total and 90 days unreachable.** They follow git's **binary** (`REFLOG_EXPIRE_OPTIONS_INIT`, git 2.50 and later), not git's own documentation, which still states 90/30 — the two disagree, and the binary is what anyone actually observes. Consequence worth knowing: because the unreachable cutoff is the *older* of the two under the defaults, a default expire is a flat 30-day clock and runs **no reachability walk at all**, and a reachable entry between 30 and 90 days old now expires ([ADR-865](../../adr/865-reflog-expire-defaults-follow-gits-binary-not-its-documentation.md)).
- **`refs/stash` never expires** unless an explicit option, or a `gc.<pattern>` section matching it, says so — a plain `gc.reflogExpire` global does not touch it. Matched on the resolved full name `refs/stash` exactly.
- **A single-ref `expire` resolves its target as git's `repo_dwim_log` does.** The argument is tried as given, then under `refs/`, `refs/tags/`, `refs/heads/`, `refs/remotes/` and `refs/remotes/<arg>/HEAD` — **tags before branches**. A symbolic ref (`HEAD` included) that has its own log expires that log; one that does not expires its target's. The argument must both resolve *and* reach a log along that chain. A deleted ref whose log file survives, a dangling symref, an unborn `HEAD`, a name git's ref syntax refuses, a `@{…}`-suffixed argument, and unparseable ref content all refuse `REFLOG_NOT_FOUND { ref }` carrying **the argument exactly as passed**, never a resolved name; an invalid name refuses without touching the filesystem. `gc.<pattern>` globs are matched against the *resolved* name, not the argument ([ADR-867](../../adr/867-reflog-expire-resolves-its-target-as-repo-dwim-log-does.md)).
- **A tip naming a missing object expires by the clock** rather than throwing — git's `lookup_commit_reference_gently`: it simply never resolves to a commit, so no reachability walk is attempted. An *entry* oid that is missing goes the other way: it is never called unreachable, so such an entry is kept on reachability grounds.
- **`expire` with neither `ref` nor `all` does nothing**, returning `{ kind: 'expire', removed: 0, kept: 0 }` without reading or rewriting a single log. It used to expire `HEAD`'s log; git has always behaved this way.
- **Refusal order.** Every `gc.reflogExpire*` value is parsed first, in file order, and the first invalid one refuses — even when it belongs to a pattern that cannot match this target, and even when a later duplicate would have overridden it. Only then are the `expire` / `expireUnreachable` options parsed, then the target resolved, then the repo-settings class (`core.maxTreeDepth`, `core.deltaBaseCacheLimit`) checked. So a malformed config value beats a malformed option, which beats an unresolvable ref, which beats a malformed `core` numeric. The operational gate runs ahead of all of it, so a malformed streaming `[core]` value is reported before any of these whatever line it sits on — a recorded divergence from git, which takes the two in file order.
- **A sweep commits as it goes.** Under `all: true` each target's rewrite lands as the sweep reaches it, so a refusal part-way through leaves the earlier targets already rewritten.
- **`expire` reachability rule** follows git's own, exactly: below `expire`, an entry is dropped unconditionally, no reachability check at all; at or above `expireUnreachable`, it is always kept; in between, it is dropped when either its old or its new oid is unreachable. "Unreachable" is answered by a mark-and-sweep walk from the ref's own tip — every ref under `refs/` for `HEAD` specifically (`HEAD` itself is never one of its own marks), the single peeled tip for any other ref. The walk is **not** permanently bounded by `expire`'s date: it expands each commit's parents only while the frontier stays at or above that date, but on the first reachability question the bounded pass cannot answer, it drops the date bound entirely and resumes from the commits the bound skipped, down to the root — so the eventual verdict is exact full-ancestry reachability, and the date bound is a laziness optimisation, never a permanent cutoff (matching git's `mark_reachable`/`unreachable()` pair). A null oid, or an oid that never resolved to an object, or one that does not peel to a commit is never treated as unreachable — such an entry is kept on reachability grounds (it may still expire by the clock alone). Superseded from ADR-064's "fully faithful" claim — see [ADR-857](../../adr/857-reflog-expire-follows-git-reachability-rule.md) for the full pin matrix (R1–R7) against real git.
- **`delete` on an index that names no entry is a silent no-op**, matching git: a negative, non-integer, or too-large `index` removes nothing — the result's `removed` is absent — but the reflog file is still rewritten, purging any malformed line it held.
- **`expire` rewrites unconditionally**, on every call that has a target, even when nothing expires — the only way a malformed line is purged from disk when nothing else changed. A single-ref `expire` whose argument reaches no log refuses `REFLOG_NOT_FOUND` (see the target-resolution rule above); with `all: true`, a ref with no reflog is simply skipped.
- **Rewrite byte form.** `delete` and `expire` re-emit git's REWRITE encoding: the message TAB is always present — the append writer omits it only for an empty message — and non-UTF-8 bytes already stored in identities or messages round-trip verbatim.
- **HEAD dual logging:** when a branch update advances HEAD (no detach), both `.git/logs/HEAD` and `.git/logs/refs/heads/<branch>` receive entries.
- **Identity:** the writer reads `user.name` / `user.email` from `.git/config` and falls back to a portable identity when absent.

## Examples

```ts
// Show HEAD reflog
const { entries } = await repo.reflog();

// Show a branch's reflog
await repo.reflog({ ref: 'main' });

// Resolve via @{N} or @{date} (combined with revParse)
const oid = await repo.revParse('main@{2}');           // 2 moves back
const old = await repo.revParse('main@{yesterday}');   // at yesterday 00:00 local time

// Delete the newest entry
await repo.reflog({ action: 'delete', ref: 'main', index: 0 });

// Expire entries older than 90 days across every ref
await repo.reflog({ action: 'expire', all: true, expire: '90.days.ago' });

// Expire on the defaults — a flat 30-day clock, no reachability walk
await repo.reflog({ action: 'expire', all: true });

// Without a ref and without `all`, nothing happens at all
await repo.reflog({ action: 'expire' });   // { kind: 'expire', removed: 0, kept: 0 }
```

## Throws

- `REVPARSE_UNRESOLVED` — unparseable date expression in `expire` / `expireUnreachable` (e.g. `'tomorrow afternoon'`).
- `REFLOG_NOT_FOUND` — `delete`, or a single-ref `expire`, whose argument reaches no reflog: a ref with no log, a deleted ref whose log survives, a dangling symref, an unborn `HEAD`, an invalid ref name, a `@{…}`-suffixed argument, or unparseable ref content. `ref` carries the argument exactly as it was passed.
- `CONFIG_MISSING_VALUE` — a `gc.reflogExpire*` key present with no value at all (git's NULL); carries `{ key, source, line }`.
- `CONFIG_BAD_DATE_VALUE` — a `gc.reflogExpire*` value the date grammar refuses, an empty one included; carries `{ value, key, source, line }`. The key is reported lower-cased with its pattern verbatim (`gc.refs/tags/*.reflogexpire`), `source` is the config file's path, and `line` is 1-based.
- `CONFIG_BAD_NUMERIC_VALUE` — the repo-settings class (`core.maxTreeDepth`, `core.deltaBaseCacheLimit`), checked after the target resolves.

## See also

- Primitives: [`appendReflog`](../primitives/internals.md#appendreflog), [`readReflogLenient`](../primitives/internals.md#readrefloglenient), [`resolveReflogIdentity`](../primitives/internals.md#resolvereflogidentity), [`recordRefUpdate`](../primitives/internals.md#recordrefupdate)
- Related commands: [`revParse`](rev-parse.md) (resolves `@{N}` / `@{date}`), [`log`](log.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)
- ADRs: [058](../../adr/058-reflog-integration-point.md), [059](../../adr/059-head-dual-logging.md), [060](../../adr/060-append-utf8-port.md), [061](../../adr/061-reflog-identity.md), [062](../../adr/062-approxidate-subset.md), [063](../../adr/063-log-all-ref-updates.md), [064](../../adr/064-reflog-command-shape.md) (command shape only — its reachability claim is superseded by [857](../../adr/857-reflog-expire-follows-git-reachability-rule.md)), [737](../../adr/737-reflog-lenient-read-is-a-ref-store-seam-verb.md), [739](../../adr/739-lenient-reflog-reads-extend-to-every-pinned-reader.md), [741](../../adr/741-reflog-parsers-drop-an-unterminated-final-line.md), [742](../../adr/742-reflog-line-parser-refuses-a-zero-timestamp.md), [743](../../adr/743-reflog-expire-always-rewrites.md), [744](../../adr/744-reflog-delete-out-of-range-is-a-silent-no-op.md), [745](../../adr/745-reflog-rewrite-serializer-always-emits-the-message-tab.md), [746](../../adr/746-reflog-results-carry-no-skipped-line-count.md), [747](../../adr/747-reflog-rewrite-channel-is-byte-faithful.md), [857](../../adr/857-reflog-expire-follows-git-reachability-rule.md), [865](../../adr/865-reflog-expire-defaults-follow-gits-binary-not-its-documentation.md), [866](../../adr/866-reflog-expire-honours-the-gc-reflog-expire-keys.md), [867](../../adr/867-reflog-expire-resolves-its-target-as-repo-dwim-log-does.md)
