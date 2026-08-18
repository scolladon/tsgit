# `commonGitDir` / `commonDirOf`

The shared **common** git directory — where objects, `packed-refs`, `config`, and
shared refs/reflogs live. Synchronous, pure.

## Signature

```ts
repo.primitives.commonGitDir(): string;
commonDirOf(layout: RepositoryLayout): string; // also exported at the package root
```

## Behaviour

For a normal repository (and a bare one) the common dir *is* the git directory.
Only a **linked worktree** splits them: its `gitDir` is the per-worktree admin
directory (`<main>/.git/worktrees/<name>`), while shared state lives in the main
checkout's git directory. `RepositoryLayout.commonDir` is therefore optional —
absent whenever it equals `gitDir` — and these helpers resolve the fold so callers
never re-implement it:

```ts
import { commonDirOf } from '@scolladon/tsgit';

const shared = commonDirOf(repo.layout); // commonDir when split, gitDir otherwise
```

Use `commonGitDir` when holding a `ctx`, `commonDirOf` when holding a bare
`RepositoryLayout` (for example `repo.layout`). Reading `layout.commonDir`
directly and hand-folding the `undefined` case is exactly what these exist to
replace.
