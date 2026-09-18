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
| `remove` | Drop the config section, delete the tracking refs this remote alone fetches into, clear `branch.<X>.remote` / `branch.<X>.merge` referrers. |
| `rename` | Move the section; move the tracking refs its fetch refspecs bring in; rewrite those refspecs and the `branch.<X>.remote = <new>` referrers. A refspec that does not fetch into `refs/remotes/<old>/` is preserved verbatim. |
| `setUrl` | Replace `remote.<n>.url`. `push: true` writes `remote.<n>.pushurl` instead — `push` consumes `pushurl ?? url`. |
| `show` | Local-only structured view: config plus the tracking refs its fetch refspecs bring in (loose+packed) plus tracking branches. No network query. A name no remote is configured under is described with the name itself as its `url`, as `git remote show -n` does. |

## Behaviour

- **Name validation.** `add` and `rename`'s `to` follow git's `valid_remote_name`: the name must form a valid `refs/remotes/<name>/` ref name — an empty name, a control character, a space, a backslash, `..`, a leading `.`, a `.lock` suffix, `:`, `~`, `^`, `?`, `*`, `[` or `@{` refuse with `REMOTE_NAME_INVALID`, while `/`, `"` and `]` are accepted. `add` also refuses a name nested under or over a configured remote (`a/b` next to `a`), as git does. Both checks run after the existing-remote check and before anything is written; `remove`, `rename`'s `from`, `setUrl` and `show` only look the remote up.
- **URL validation.** Only control-char rejection at write time (`\n` / `\r` / `\0`). Scheme / SSRF guards apply when the URL is consumed by `clone` / `fetch` / `push` — matching canonical git.
- **Which tracking refs a remote owns.** `remove`, `rename` and `show` all go by the remote's **fetch refspecs**, as git does. `show` attaches every ref under `refs/` that at least one of them fetches into — wherever it lives, so a destination such as `+refs/heads/*:refs/other/origin/*` attaches refs under `refs/other/origin/` and none under `refs/remotes/<name>/` — and applies no "another remote covers it" exclusion. `remove` deletes every ref under `refs/remotes/` that this remote's refspecs fetch into and no other configured remote's refspecs do. `rename` moves the refs under `refs/remotes/<old>/` only when at least one refspec fetches into that namespace — a remote with no fetch refspec, a mirror's `+refs/*:refs/*`, or a destination elsewhere leaves every ref where it is, while the section and the `branch.<X>.remote` referrers are still re-pointed.
- **Ordering on `rename`, and the half-written config it leaves behind.** The config **section header** is renamed first, before any ref moves; the rewritten refspecs and referrers are written only after every ref has moved. The ref move itself is prepared in full before anything is written, so a refusal leaves every ref and log untouched — but the config is **not rolled back**. After a refused rename, `.git/config` carries `[remote "<to>"]` with no `[remote "<from>"]` left, while inside it `fetch` still reads `+refs/heads/*:refs/remotes/<from>/*` and every `branch.<X>.remote` still names `<from>`. **This is what the git binary does, measured, not a tsgit design choice** — the same half-renamed config comes out of `git remote rename` on the same input. Re-running the rename, or fixing the two values by hand, is the way out.
- **A tracking `HEAD` pointing outside the remote, and the dangling symref that produces.** `rename` rewrites a symbolic tracking ref's target by overwriting a **fixed byte slice** — the bytes at positions 13 through `13 + len(<from>)`, right after `refs/remotes/` — with no check that the target points inside the remote being renamed, or anywhere near it. **Again this is the git binary's own observed behaviour, transcribed deliberately**, not something tsgit chose. Renaming `origin` to `up2` therefore rewrites a `refs/remotes/origin/HEAD` aimed at `refs/remotes/other/main` into `refs/remotes/up2main` — a symbolic ref pointing at a name that does not exist. The rename returns normally and nothing warns. Other slices land as oddly: `refs/heads/feature-long-name` becomes `refs/heads/feup2long-name`, `refs/remotes/myorigin/main` becomes `refs/remotes/up2in/main`. A target **too short** for the slice (`refs/heads/main`, at 15 bytes, against a 19-byte slice) has no bytes to overwrite and refuses `INVALID_REF`, aborting the whole rename with every tracking ref where it was — and that refusal fires ahead of a name conflict, so it is the first thing you see.
- **Packed refs.** `remove` deletes packed-only tracking refs like any other, and `rename` moves them: the new name is written **loose**, carrying the packed id, and the old line leaves `packed-refs` on the batch delete's single rewrite. `git remote rename` does the same.
- **Reflog on `remove`.** Per-ref reflog files are deleted through the standard delete path, and each tracking ref is removed with `--no-deref` — a symbolic tracking ref is deleted as itself, never followed.
- **Reflog carry-over on `rename`.** A tracking ref that already had a log **keeps its whole history** under the new name and gains one entry: `<id> <id> … remote: renamed refs/remotes/<from>/<branch> to refs/remotes/<to>/<branch>` — git's message names the full ref paths, not the remote names. A tracking ref with **no** log stays unlogged on the files backend: nothing is moved and no rename entry is invented for it.
- **`refs/remotes/<from>/HEAD` is re-pointed, not left behind.** It is deleted with `--no-deref` along with the other old names and re-created last, as `refs/remotes/<to>/HEAD`, once its (spliced) target already exists. Its log differs by backend, matching each of git's: the **files** backend moves the old log across and appends a `0{40} 0{40} … remote: renamed refs/remotes/<from>/HEAD to refs/remotes/<to>/HEAD` entry, while **reftable** copies the log to the new name and leaves the old name's own log in place carrying one deletion entry.
- **Tracking refs move only when the remote's fetch refspecs map into `refs/remotes/<from>/`.** A remote with no fetch refspec, a mirror's `+refs/*:refs/*`, or a destination elsewhere leaves every ref where it is while the config is still re-pointed — again matching git.
- **A renamed name that is already taken** refuses `REF_UPDATE_CONFLICT { name, expected: 'absent', actual }` on the first such name in queue order, before anything is written. A *dangling* symref already sitting at the renamed name refuses the same way with `actual: 'absent'`.
- **A repository the acceptance tier rejects.** Every `remote` verb refuses — reads included. This is narrower than `config`'s surviving four read verbs: canonical git refuses `remote`, `remote -v`, `remote get-url` and `remote show -n` on a rejected repository exactly as it refuses the writers (measured on 2.55.0, ownership and format rejections alike), so `list` and `show` sit on the same tier as `add` / `remove` / `rename` / `setUrl`. See [Repository layout](../../understand/repository-layout.md#the-repository-acceptance-tiers).

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
- `DUBIOUS_OWNERSHIP` / `IMPLICIT_BARE_REPOSITORY` / `REPOSITORY_FORMAT_VERSION_UNSUPPORTED` / `REPOSITORY_EXTENSIONS_UNSUPPORTED` — the repository the acceptance tier rejects; every `remote` verb refuses, including `list` and `show` (see [`errors.md`](../errors.md#repository-state)).
- `REMOTE_NOT_CONFIGURED` — `remove` / `rename`'s `from` / `setUrl` targeting an unknown remote; `show` only for the empty name.
- `REMOTE_EXISTS` — `add` against a configured name; `rename` whose `to` is already configured, including a rename onto the remote's own name.
- `REMOTE_NAME_INVALID` — `add` / `rename`'s `to` naming something that cannot form a `refs/remotes/<name>/` ref name, or an `add` nested under or over a configured remote.
- `INVALID_OPTION` — URL contains a control character.
- `REFSPEC_INVALID` — `add({ fetch })` supplied a malformed custom refspec, or any configured `remote.<name>.fetch` / `remote.<name>.push` value fails git's own `parse_refspec`. git builds its whole remote table before a remote command runs any logic of its own, so one unusable value refuses the command whatever remote it names. The two keys are graded differently, exactly as git grades them: a **fetch** spec must have a ref-name-shaped source (or an empty one, standing for `HEAD`) and a ref-name-shaped destination (or an empty or absent one, standing for "do not store"), and refuses a wildcard source with no destination at all; a **push** spec checks its source only when that source is a wildcard — anything else may be an extended object name — and refuses an EMPTY destination that fetch accepts. On both keys a wildcard on one side demands one on the other, each side carries at most one `*`, and a negative (`^`) spec carries a source alone.
- `INVALID_REF` — `rename` met a symbolic tracking ref whose target is too short for the slice git overwrites. The config section header has already been renamed at this point and is not rolled back (see Behaviour).
- `REF_UPDATE_CONFLICT` — `rename` found one of the destination names already taken; `expected` is `'absent'`, and `actual` is `'absent'` too when the occupant is a dangling symref.

## See also

- Primitives: [`updateRef`](../primitives/update-ref.md) (used by `remove`/`rename`).
- Related commands: [`fetch`](fetch.md), [`push`](push.md), [`clone`](clone.md).
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md) (namespace shape) · [176](../../adr/176-remote-add-default-fetch-refspec.md), [177](../../adr/177-remote-remove-cleanup-scope.md), [178](../../adr/178-remote-rename-refspec-rewrite-rule.md), [179](../../adr/179-remote-set-url-push-and-deferrals.md), [180](../../adr/180-remote-show-local-only.md) (behaviour) · [871](../../adr/871-updateref-dereferences-symbolic-refs-and-deletes-as-gits-ref-transaction-does.md), [875](../../adr/875-remote-rename-transcribes-gits-two-rename-bugs.md) (ref moves and the two transcribed git bugs).
- Roadmap: `remote prune` is covered by `fetch({ prune: true })`. Network `show`, `set-url --add` / `--delete`, `remote update` deferred.
```