# `packObjects`

Write the objects reachable from `wants` and not reachable from `not` as a
`.pack` + `.idx` pair — the packfile-writing counterpart to
[`revList`](rev-list.md), git's own `git pack-objects`. Composes the same
closure engine, `buildPack`, and the pack/idx writers; no progress line, no
summary line — the pack directory's own state and the returned counts are
the whole result.

## Signature

```ts
repo.packObjects(opts: PackObjectsOptions): Promise<PackObjectsResult>;

interface PackObjectsOptions {
  readonly wants: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  readonly outputDirectory?: string;
  readonly useBitmapIndex?: boolean;
}

interface PackObjectsResult {
  readonly packId: ObjectId;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly indexBytes: number;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `wants` | `ReadonlyArray<string>` | (required) | Revisions to pack (full rev grammar, resolved through `revParse`). |
| `not` | `ReadonlyArray<string>` | `(none)` | Revisions whose reachability is excluded — git's "haves". |
| `outputDirectory` | `string` | the repository's pack directory | Directory to write `pack-<sha>.pack` / `.idx` into. |
| `useBitmapIndex` | `boolean` | `true` | Use the bitmap tier. See "Tiers" below. |

## Behaviour

- **Full object closure, always.** `packObjects` requests the closure with
  `objects: true` unconditionally — a packfile needs its trees and blobs,
  not just its commits and tags, to be usable at all.
- **Tiers, and the OPPOSITE default from `revList`.** `packObjects` answers
  from one of the same two tiers `revList` does, over the same reachability
  question `W AND NOT N`, but defaults the OTHER way: `useBitmapIndex`
  defaults to `true` here, because `pack-objects` carries none of the
  options (`firstParent`, `noWalk`, `maxCount`) that force `revList` back to
  the walk — nothing narrows the default, so the caller's only lever is an
  explicit `useBitmapIndex: false`. This mirrors git's own defaults: `git
  rev-list` walks unless asked; `git pack-objects --revs` uses a usable
  bitmap unless told not to.
- **With `not` haves, the bitmap pack is SMALLER, and that is correct.**
  The bitmap tier computes the exact set difference; the walk tier
  over-reports (see `revList`'s own "Tiers" behaviour) so it can hold MORE
  objects for the identical `wants`/`not` pair. Every object the bitmap
  omits is reachable from a `not` tip, so a peer that already supplied
  those haves already has it — sending the smaller pack is git's own
  default behaviour, not a tsgit optimisation. With no `not` at all, both
  tiers answer the same object SET (in different internal orders, so their
  packs — and `packId`s — are not byte-identical).
- **`packId` is stable per tier, not across tiers.** Objects are written
  into the pack in the closure's own order, and that order differs between
  the bitmap and walk tiers — so the SAME closure written by different
  tiers produces packs with the same contents and DIFFERENT names. Compare
  the object set read back from the `.idx`, never `packId`, across tiers.
- **`outputDirectory`.** Omitted, the pack lands in the repository's own
  pack directory and the pack registry is refreshed, so a follow-up read
  through the same handle sees it. Supplied, the pack is written to that
  directory instead and the registry is left untouched — the pack is not
  part of this repository's store.
- **Empty closure still writes a valid pack.** `wants` fully covered by
  `not` (or resolving to nothing) yields `objectCount: 0` and a valid
  32-byte (header + trailer) `.pack` plus its matching `.idx` — never a
  refusal, matching git's own "nothing to send" behaviour.
- **Nothing beyond `.pack` and `.idx` is written.** No `.rev`, no bitmap,
  no delta compression — every entry is a full base object, exactly like
  [`push`](push.md)'s and [`bundleCreate`](bundle.md)'s own packs.

## Examples

```ts
// Every object reachable from HEAD — the bitmap tier if one is usable.
const { packId, objectCount } = await repo.packObjects({ wants: ['HEAD'] });

// Only what a peer with `main` doesn't already have.
await repo.packObjects({ wants: ['feature/x'], not: ['main'] });

// Force the walk tier (e.g. to compare against the bitmap's exact answer).
await repo.packObjects({ wants: ['HEAD'], useBitmapIndex: false });

// Write outside the repository's own store (no registry refresh).
await repo.packObjects({ wants: ['HEAD'], outputDirectory: '/tmp/export' });
```

## Throws

- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — a `wants` or `not` entry does not resolve.
- `NOT_A_REPOSITORY` — `ctx` does not point at an initialized repository.
- `PACK_TOO_LARGE` — the closure exceeds the walk's object cap.

## See also

- Primitives: [`buildPack`](../primitives/internals.md#buildpack)
- Related commands: [`revList`](rev-list.md), [`push`](push.md), [`bundle`](bundle.md)
