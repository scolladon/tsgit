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
- **`delete` on an index that names no entry is a silent no-op**, matching git: a negative, non-integer, or too-large `index` removes nothing — the result's `removed` is absent — but the reflog file is still rewritten, purging any malformed line it held.
- **`expire` rewrites unconditionally**, every call, even when nothing expires — the only way a malformed line is purged from disk when nothing else changed. A single-ref `expire` on a ref with no reflog at all refuses with `REFLOG_NOT_FOUND`; with `all: true`, a ref with no reflog is simply skipped.
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
```

## Throws

- `REVPARSE_UNRESOLVED` — unparseable date expression (e.g. `expire: 'tomorrow afternoon'`).
- `REFLOG_NOT_FOUND` — `delete`, or a single-ref `expire`, targets a ref with no reflog at all.

## See also

- Primitives: [`appendReflog`](../primitives/internals.md#appendreflog), [`readReflogLenient`](../primitives/internals.md#readrefloglenient), [`resolveReflogIdentity`](../primitives/internals.md#resolvereflogidentity), [`recordRefUpdate`](../primitives/internals.md#recordrefupdate)
- Related commands: [`revParse`](rev-parse.md) (resolves `@{N}` / `@{date}`), [`log`](log.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)
- ADRs: [058](../../adr/058-reflog-integration-point.md), [059](../../adr/059-head-dual-logging.md), [060](../../adr/060-append-utf8-port.md), [061](../../adr/061-reflog-identity.md), [062](../../adr/062-approxidate-subset.md), [063](../../adr/063-log-all-ref-updates.md), [064](../../adr/064-reflog-command-shape.md), [737](../../adr/737-reflog-lenient-read-is-a-ref-store-seam-verb.md), [739](../../adr/739-lenient-reflog-reads-extend-to-every-pinned-reader.md), [741](../../adr/741-reflog-parsers-drop-an-unterminated-final-line.md), [742](../../adr/742-reflog-line-parser-refuses-a-zero-timestamp.md), [743](../../adr/743-reflog-expire-always-rewrites.md), [744](../../adr/744-reflog-delete-out-of-range-is-a-silent-no-op.md), [745](../../adr/745-reflog-rewrite-serializer-always-emits-the-message-tab.md), [746](../../adr/746-reflog-results-carry-no-skipped-line-count.md), [747](../../adr/747-reflog-rewrite-channel-is-byte-faithful.md)
