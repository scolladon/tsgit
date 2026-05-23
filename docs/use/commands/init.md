# `init`

Initialize a fresh repository at `ctx.layout.gitDir`. Bootstraps the standard layout: `HEAD` symbolic ref, `refs/heads/`, `objects/`, `objects/pack/`, empty `config`.

## Signature

```ts
repo.init(opts?: InitOptions): Promise<InitResult>;

interface InitOptions {
  readonly initialBranch?: string;
  readonly bare?: boolean;
}

interface InitResult {
  readonly path: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `initialBranch` | `string` | `'main'` | Initial branch name HEAD points at. |
| `bare` | `boolean` | `false` | Bare repository (no working tree); `gitDir === workDir`. |

## Examples

```ts
const repo = await openRepository({ cwd: '/tmp/new-repo' });
await repo.init();
await repo.init({ initialBranch: 'trunk' });
await repo.init({ bare: true });
```

## Throws

- `ALREADY_INITIALIZED` — `.git/HEAD` already exists at the target gitDir.

## See also

- Primitives: [`writeSymbolicRef`](../primitives/write-symbolic-ref.md)
- Related commands: [`clone`](clone.md) (init + remote bootstrap)
