# `writeSymbolicRef`

Write a symbolic ref (e.g. `HEAD → refs/heads/main`). Atomic.

## Signature

```ts
repo.primitives.writeSymbolicRef(name: RefName, target: RefName): Promise<void>;
```

## Example

```ts
await repo.primitives.writeSymbolicRef('HEAD', 'refs/heads/main');
```

## See also

- Tier-1: [`init`](../commands/init.md), [`checkout`](../commands/checkout.md)
- Related primitives: [`recordRefUpdate`](record-ref-update.md), [`resolveRef`](resolve-ref.md)
