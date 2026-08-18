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
```

`bare: true` writes `bare = true` into `[core]` at `ctx.layout.gitDir` — it
does not relocate the layout the `Context` was opened with. To get a
repository `openRepository` (or real git) can reopen, open with `gitDir`
equal to `cwd` so the constructed layout already has no work tree, byte-
identical to `git init --bare`:

```ts
const bare = await openRepository({ cwd: '/tmp/new.git', gitDir: '/tmp/new.git', bare: true });
await bare.init({ bare: true });
```

## Throws

- `ALREADY_INITIALIZED` — `.git/HEAD` already exists at the target gitDir.

## See also

- Primitives: [`writeSymbolicRef`](../primitives/internals.md#writesymbolicref)
- Related commands: [`clone`](clone.md) (init + remote bootstrap)
