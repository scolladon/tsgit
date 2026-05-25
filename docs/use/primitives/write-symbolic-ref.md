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

## Interop with canonical git

Byte-identical with `git symbolic-ref` output: produces `ref: <target>\n` exactly as canonical git writes it. See [`design/phase-19-7-interop-suite.md`](../../design/phase-19-7-interop-suite.md).

## See also

- Tier-1: [`init`](../commands/init.md), [`checkout`](../commands/checkout.md)
- Related primitives: [`recordRefUpdate`](record-ref-update.md), [`resolveRef`](resolve-ref.md)
