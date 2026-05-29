# `remote`

CRUD porcelain for `[remote "<name>"]` blocks in `.git/config` plus the tracking refs they own. Nested namespace: `repo.remote.{list,add,remove,rename,setUrl,show}`. Mirrors `git remote` — without a network query (ADR-180).

## Signature

```ts
interface RemoteInfo {
  readonly name: string;
  readonly url: string;
  readonly pushUrl: string | undefined;
  readonly fetchRefspecs: ReadonlyArray<string>;
}

interface RemoteShow extends RemoteInfo {
  readonly trackingRefs: ReadonlyMap<RefName, ObjectId>;
  readonly trackedBy: ReadonlyArray<{ branch: RefName; merge: string | undefined }>;
}

interface RemoteNamespace {
  list(): Promise<{ remotes: ReadonlyArray<RemoteInfo> }>;
  add(input: { name: string; url: string; fetch?: string }): Promise<{ remote: RemoteInfo }>;
  remove(input: { name: string }): Promise<{
    name: string;
    removedTrackingRefs: ReadonlyArray<RefName>;
    clearedBranches: ReadonlyArray<RefName>;
  }>;
  rename(input: { from: string; to: string }): Promise<{
    from: string;
    to: string;
    movedTrackingRefs: ReadonlyArray<RefName>;
    rewrittenBranches: ReadonlyArray<RefName>;
  }>;
  setUrl(input: { name: string; url: string; push?: boolean }): Promise<{ remote: RemoteInfo }>;
  show(input: { name: string }): Promise<{ remote: RemoteShow }>;
}

repo.remote: RemoteNamespace;
```

Each method returns a concrete result — no discriminator to narrow on at the call site (ADR-181, ADR-192).

## Methods

| Method | Purpose |
|---|---|
| `list` | Return every configured remote, sorted by name (byte-wise). |
| `add` | Register `[remote "<name>"]` with `url = <url>` and a default fetch refspec `+refs/heads/*:refs/remotes/<name>/*`. Pass `fetch: <custom>` to override. |
| `remove` | Drop the config section, delete loose tracking refs under `refs/remotes/<name>/*`, clear `branch.<X>.remote` / `branch.<X>.merge` referrers. |
| `rename` | Move the section and (conservatively) rewrite the canonical fetch refspec; move tracking refs; rewrite `branch.<X>.remote = <new>` referrers. Custom refspecs are preserved verbatim (ADR-178). |
| `setUrl` | Replace `remote.<n>.url`. `push: true` writes `remote.<n>.pushurl` instead — `push` consumes `pushurl ?? url`. |
| `show` | Local-only structured view: config plus tracking refs (loose+packed) plus tracking branches. No network query. |

## Behaviour

- **Name validation.** Empty names and names containing `\n` / `\r` / `\0` / `"` / `\\` / `]` are rejected with `REMOTE_NAME_INVALID`. Slashes and spaces are accepted (canonical-git permits them).
- **URL validation.** Only control-char rejection at write time (`\n` / `\r` / `\0`). Scheme / SSRF guards apply when the URL is consumed by `clone` / `fetch` / `push` — matching canonical git.
- **Ordering on multi-step methods.** `remove` and `rename` delete or move tracking refs FIRST, then rewrite config. Mid-flight failures are recoverable by re-running the method (ADR-177, ADR-178).
- **Packed refs.** Tracking refs are deleted via `updateRef`, which rejects packed-only refs with `UNSUPPORTED_OPERATION`. Run `git pack-refs --unpack` and retry.
- **Reflog.** `remove` deletes per-ref reflog files via the standard `updateRef` delete path. `rename` writes a `remote: renamed <from> to <to>` entry on each moved ref.

## Examples

```ts
// Register a fork as a second remote.
await repo.remote.add({
  name: 'upstream',
  url: 'https://github.com/owner/repo.git',
});

// Switch the push URL to SSH while keeping HTTPS for fetch.
await repo.remote.setUrl({
  name: 'origin',
  url: 'git@github.com:owner/repo.git',
  push: true,
});

// Rename `origin` to `upstream` (tracking refs and branch upstreams travel).
await repo.remote.rename({ from: 'origin', to: 'upstream' });

// Drop a remote and its tracking refs.
await repo.remote.remove({ name: 'upstream' });

// Inspect a remote without a network query.
const { remote } = await repo.remote.show({ name: 'origin' });
console.log(remote.url, remote.fetchRefspecs);
for (const [ref, oid] of remote.trackingRefs) console.log(ref, oid);
```

## Throws

- `NOT_A_REPOSITORY` — `.git/HEAD` is absent.
- `REMOTE_NOT_CONFIGURED` — `remove` / `rename` / `setUrl` / `show` targeting an unknown remote.
- `REMOTE_EXISTS` — `add` against a configured name; `rename` whose `to` is already configured.
- `REMOTE_NAME_INVALID` — empty name or any of `\n` / `\r` / `\0` / `"` / `\\` / `]`.
- `INVALID_OPTION` — URL contains a control character; `rename` called with `from === to`.
- `REFSPEC_INVALID` — `add({ fetch })` supplied a malformed custom refspec.
- `UNSUPPORTED_OPERATION` — `remove` / `rename` hit a packed-only tracking ref.

## See also

- Primitives: [`updateRef`](../primitives/update-ref.md) (used by `remove`/`rename`).
- Related commands: [`fetch`](fetch.md), [`push`](push.md), [`clone`](clone.md).
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md) (namespace shape) · [176](../../adr/176-remote-add-default-fetch-refspec.md), [177](../../adr/177-remote-remove-cleanup-scope.md), [178](../../adr/178-remote-rename-refspec-rewrite-rule.md), [179](../../adr/179-remote-set-url-push-and-deferrals.md), [180](../../adr/180-remote-show-local-only.md) (behaviour).
- Roadmap: `remote prune` is covered by `fetch({ prune: true })`. Network `show`, `set-url --add` / `--delete`, `remote update` deferred.
```