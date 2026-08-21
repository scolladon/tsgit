# `init`

Initialize a fresh repository at `ctx.layout.gitDir`. Bootstraps the standard layout: `HEAD` symbolic ref, `refs/heads/`, `objects/`, `objects/pack/`, empty `config`.

## Signature

```ts
repo.init(opts?: InitOptions): Promise<InitResult>;

interface InitOptions {
  readonly initialBranch?: string;
  readonly bare?: boolean;
  readonly objectFormat?: 'sha1' | 'sha256';
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
| `objectFormat` | `'sha1' \| 'sha256'` | `'sha1'` | Object hash algorithm for the new repository, mirroring `git init --object-format`. Absent means sha1 — the default `.git/config` this option does not touch stays byte-identical to before it existed. `'sha256'` writes `[extensions]\n\tobjectformat = sha256\n` before `[core]`, and adds `repositoryformatversion = 1`, `logallrefupdates`, `ignorecase`, `precomposeunicode` to `[core]` — the same block real git writes. |

## Examples

```ts
const repo = await openRepository({ cwd: '/tmp/new-repo' });
await repo.init();
await repo.init({ initialBranch: 'trunk' });
await repo.init({ objectFormat: 'sha256' });
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
  This also covers re-init: real git allows a plain `git init` re-run inside
  an existing repository (format preserved) and refuses
  `--object-format=sha1` inside an existing sha256 repository with a distinct
  "reinitialize with different hash" error; `init` throws
  `ALREADY_INITIALIZED` on both, one refusal ahead of that distinction.

## See also

- Primitives: [`writeSymbolicRef`](../primitives/internals.md#writesymbolicref)
- Related commands: [`clone`](clone.md) (init + remote bootstrap)
