# `abbreviateObjectId`

Abbreviate an object id the way `git rev-parse --short` does: start from a base length, then extend it until no other object in any object source shares the prefix.

## Signature

```ts
repo.primitives.abbreviateObjectId(id: ObjectId): Promise<string>;
```

## Length rules

- Base length is `core.abbrev` when it is a number (`full` gives the whole id). When unset or `auto`, it grows with the approximate packed-object count over every source, with a floor of 7.
- The result is then extended past the longest prefix shared with any other loose or packed object in the local store or any usable alternate.
- An invalid `core.abbrev` value, or a listed alternate that cannot be loaded, is refused as in `readObject`.

The id itself is not required to exist.

## Example

```ts
const { id } = await repo.commit({ message: 'seed' });
const short = await repo.primitives.abbreviateObjectId(id);
console.log(short); // e.g. '3f2a9c1'
```

## See also

- Related primitive: [`objectSources`](object-sources.md) — the stores whose objects are compared.
