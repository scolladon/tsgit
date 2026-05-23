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
      expire?: string; expireUnreachable?: string; dryRun?: boolean };

type ReflogResult =
  | { kind: 'show'; entries: ReadonlyArray<ReflogShowEntry> }
  | { kind: 'exists'; exists: boolean }
  | { kind: 'delete'; ref: RefName; index: number; deleted: boolean }
  | { kind: 'expire'; expired: ReadonlyArray<{ ref: RefName; count: number }> };

interface ReflogShowEntry {
  readonly selector: string;       // e.g. 'HEAD@{0}'
  readonly entry: {
    readonly oldId: ObjectId;
    readonly newId: ObjectId;
    readonly identity: { name: string; email: string; timestamp: number; tz: string };
    readonly message: string;
  };
}
```

## Actions

| Action | Meaning |
|---|---|
| `show` (default) | List entries newest-first. `ref` defaults to `'HEAD'`. |
| `exists` | Check whether `.git/logs/<ref>` is present and non-empty. |
| `delete` | Drop entry at `index` (newest = 0). `rewrite: true` shifts subsequent entries up. |
| `expire` | Prune by date (`'90.days.ago'`, `'2026-01-01'`, …) with optional `expireUnreachable` for two-cutoff prune. `dryRun: true` reports without modifying. |

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

## Behaviour

- **Approxidate parser** accepts a subset of git's date forms: `now`, `yesterday`, `<N>.days.ago`, `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`. Anything else throws `INVALID_APPROXIDATE`.
- **HEAD dual logging:** when a branch update advances HEAD (no detach), both `.git/logs/HEAD` and `.git/logs/refs/heads/<branch>` receive entries.
- **Identity:** the writer reads `user.name` / `user.email` from `.git/config` and falls back to a portable identity when absent.

## Throws

- `INVALID_APPROXIDATE` — unparseable date expression.
- `REFLOG_INDEX_OUT_OF_RANGE` — `delete` index ≥ entry count.
- `REF_NOT_FOUND` — referenced ref has no log.

## See also

- Primitives: [`appendReflog`](../primitives/internals.md#appendreflog), [`readReflog`](../primitives/internals.md#readreflog), [`resolveReflogIdentity`](../primitives/internals.md#resolvereflogidentity), [`recordRefUpdate`](../primitives/record-ref-update.md)
- Related commands: [`revParse`](rev-parse.md) (resolves `@{N}` / `@{date}`), [`log`](log.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)
- ADRs: [058](../../adr/058-reflog-integration-point.md), [059](../../adr/059-head-dual-logging.md), [060](../../adr/060-append-utf8-port.md), [061](../../adr/061-reflog-identity.md), [062](../../adr/062-approxidate-subset.md), [063](../../adr/063-log-all-ref-updates.md), [064](../../adr/064-reflog-command-shape.md)
