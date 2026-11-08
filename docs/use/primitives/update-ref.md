# `updateRef`

The coherent ref-write surface: resolves the current ref value and HEAD, builds the ref write together with any coupled-HEAD reflog entry, and commits both in one [`RefStore.applyRefUpdates`](internals.md#refstore--getrefstore) call — the single point at which anything is written, so a refusal (a CAS mismatch, an invalid name) never leaves a ref written with its reflog entry missing. HEAD is resolved *before* that call; an unresolvable HEAD (an invalid target name) is tolerated when updating another ref — the write proceeds with HEAD read as uncoupled, matching git — but any other HEAD read failure still refuses the whole update before anything is written. A positional `newId` keeps the common case ergonomic.

It also transcribes git's ref transaction on the three things easiest to get subtly wrong:
a symbolic `name` is dereferenced and every hop logged, a write's target object is verified
before anything else, and a delete behaves the same whether it is spelled `delete: true` or
as the null object id. Each is detailed below.

## Signature

```ts
repo.primitives.updateRef(
  name: RefName,
  newId: ObjectId,
  options: UpdateRefOptions,
): Promise<void>;

type UpdateRefOptions =
  | {
      readonly delete?: false;
      readonly expected?: ObjectId | 'absent';
      readonly reflogMessage: string;
      readonly noDeref?: boolean;
    }
  | {
      readonly delete: true;
      readonly expected?: ObjectId | 'absent';
      readonly reflogMessage?: string;
      readonly noDeref?: boolean;
    };
```

A **write** requires `reflogMessage` — git's builtins always supply a reason string, and the
type makes every present and future ref write state why the ref moved. A **delete**'s message
is optional: its own reflog file is dropped, but the ref `HEAD` names can still gain a coupled
`logs/HEAD` entry, so the message is what that entry carries (empty when omitted, matching a
bare `git update-ref -d` with no `-m`).

`expected` is git's compare-and-swap: `'absent'` requires the ref not to already exist.
`noDeref` is git's `--no-deref`. The null object id (all-zero, at this repository's hash width)
is treated exactly like `delete: true` — in a sha256 repository a 40-zero id is **not** the null
id, and takes the ordinary verified write path.

## Behaviour

### The write's target is verified first

Before the compare-and-swap and before any symbolic ref is walked, a write's target object is
read and checked, the way git's ref transaction does ([ADR-864](../../adr/864-ref-updates-verify-their-target-as-gits-ref-transaction-does.md)):

| Condition | Refusal |
|---|---|
| no such object | `OBJECT_NOT_FOUND { id }` |
| bytes that do not hash to the id | `OBJECT_HASH_MISMATCH { expected, actual }` |
| a commit git's parser refuses | `INVALID_COMMIT { reason }` |
| a tag git's parser refuses | `INVALID_TAG { reason }` |
| a non-commit written to `HEAD` or `refs/heads/*` | `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }` |

Two consequences worth knowing. First, **verification precedes the compare-and-swap**, so a
wrong `expected` *plus* a bad target reports the target refusal, not `REF_UPDATE_CONFLICT`.
Second, the branch-typing rule is applied to **the name you passed**, never to what a symbolic
ref resolves to: writing a tree to `refs/tags/x` succeeds even when `refs/tags/x` is a symref
onto `refs/heads/y`, and `refs/heads/y` then holds a tree — git behaves identically. Writing
that same tree through a symref *named* `refs/heads/…` refuses.

**Deletes are never verified** (nothing is read, the null id included), and neither are
symbolic writes.

### A symbolic `name` is dereferenced

A default write or delete walks through a symbolic `name` to its **terminal** — the first
non-symbolic name — and acts there, leaving every symbolic ref on the way untouched, the same
way git's ref transaction splits at each hop. The write walk has **no depth cap**: git's has
none either, and a write through a fifty-hop chain still lands on that chain's end, where a
*read* of the same chain stops at git's `SYMREF_MAXDEPTH`. A chain that meets a name twice
refuses `REF_CYCLE_DETECTED { chain }`, and `chain` carries the repeated name at both ends
(`p → q → p` reports `['refs/heads/p', 'refs/heads/q', 'refs/heads/p']`).

`expected` is compared against the **terminal's** value, never an intermediate link's own
content, and `REF_UPDATE_CONFLICT` names the ref **you passed**, not the terminal. An
`expected: 'absent'` aimed through a dangling symref refuses with `actual: 'absent'` — git's
own "dangling symref already exists".

`noDeref: true` acts on `name` itself: the symbolic ref's stored value is replaced or removed
and no link entries are logged. The current value it compares `expected` against is still read
*through* the referent, so the ordinary read-path depth cap and cycle detection apply there; a
referent that cannot be read at all reads as `'absent'` when no `expected` was given, and
propagates its own refusal when one was.

### Names that select another worktree's store

A `name` in git's per-worktree namespace writes to the store its prefix selects, the way git's
`parse_worktree_ref` does, from the main or a linked working directory alike (`<common>` is the
common git directory):

| `name` | Loose file (files backend) | Its log |
|---|---|---|
| `main-worktree/<per-worktree ref>` (`main-worktree/HEAD`, `main-worktree/refs/bisect/x`) | `<common>/<per-worktree ref>` | `<common>/logs/<per-worktree ref>` |
| `worktrees/<id>/<per-worktree ref>` (`worktrees/wt/HEAD`) | `<common>/worktrees/<id>/<per-worktree ref>` | `<common>/worktrees/<id>/logs/<per-worktree ref>` |
| any other name (`main-worktree/refs/heads/main`, `worktrees/wt/refs/heads/side`) | as without a prefix: the path the name spells, in the current worktree's directory for a per-worktree name and in `<common>` otherwise | under `logs/` in that same directory |

The `<id>` need not name a registered worktree: `worktrees/nope/HEAD` creates
`<common>/worktrees/nope/HEAD`, as git does. On the files backend the compare-and-swap and every
hop of the symbolic walk read the file the write lands on.

- **`main-worktree/HEAD` and `worktrees/<id>/HEAD` dereference like that worktree's `HEAD`.** On a
  branch, the write moves the branch and logs it, and that `HEAD`'s log gains the link entry.
  Detached, or under `noDeref`, the write replaces that `HEAD` file itself, and its existing log
  gains the entry. A symbolic ref whose content names a prefixed name (`ref: main-worktree/HEAD`) is
  followed the same way. A write that lands on the current worktree's own `HEAD` file is seen by
  the next `HEAD` read, whichever name it came through.
- **The reflog auto-create rule judges the name as given** on the files backend: a prefixed name
  is neither `HEAD` nor under `refs/heads/`, so its own log is appended to only when it already
  exists (`main-worktree/refs/bisect/x` gains none). The reftable backend probes the existing
  log by the bare name in the stack the prefix selects, and judges auto-creation on the full
  name: `worktrees/<id>/HEAD` is logged only when that worktree's `HEAD` already has a log.
- **Two names of one write on one loose file refuse `REF_LOCKED`** on the files backend, as
  git's per-name lock does (see [Locks](#locks)). Writing `main-worktree/HEAD` from the main
  worktree, or `worktrees/<id>/HEAD` from that worktree, while its `HEAD` is on a branch is
  refused this way, and so is a ref whose content names `main-worktree/HEAD`, written from the main
  worktree: the coupled `HEAD` entry would lock the same `HEAD` file a second time. With
  `HEAD` detached, or under `noDeref`, no coupled entry is added and the write proceeds.
- **A delete, and a symbolic-ref write, of any of these names refuses `INVALID_REF`** (see
  [Deletes](#deletes)).
- **On the reftable backend** the prefix selects the stack: `main-worktree/…` the main
  worktree's, `worktrees/<id>/…` that worktree's. The lookup reads the bare name in that stack,
  while the written ref and log records keep the full name, as git's do: writing
  `main-worktree/HEAD` with the main `HEAD` detached, or under `noDeref`, stores a ref record
  named `main-worktree/HEAD` and leaves `HEAD` itself unchanged. Nothing is refused for a shared
  lock, and a hop whose bare name is `HEAD` adds no coupled `HEAD` log record. `HEAD`'s
  referent is matched against the bare name too: with `HEAD` on `refs/bisect/x`, writing
  `main-worktree/refs/bisect/x` adds a `HEAD` log record, where the files backend adds none.
- **A worktree that does not exist refuses `FILE_NOT_FOUND`.** On the reftable backend, a name
  under `worktrees/<id>/` whose `<common>/worktrees/<id>/reftable` is missing refuses on that
  directory, and nothing is written; git reports `reftable: transaction prepare: I/O error`.
  On the files backend `worktrees/<id>/…` is written under `<common>/worktrees/<id>/`, as git
  does, but `worktrees/<id>` with nothing after the id locks `<common>/worktrees/<id>/.lock`:
  it refuses `FILE_NOT_FOUND` on that lock when the admin dir is missing, as git's `Unable to
  create … No such file or directory` does, and `NOT_A_DIRECTORY` on it when a regular file
  stands at `<common>/worktrees/<id>` or at `<common>/worktrees`, where git reports `Not a
  directory` or `non-directory in the way`.

### Reflog entries

- **Every walked symbolic ref gains an entry, unconditionally** — even when the value it
  records is unchanged. The terminal's own entry is attached only when the value actually
  moved. All of them carry the chain's resolved old value and the same message.
- **The ref `HEAD` names gains a coupled `logs/HEAD` entry** whenever `HEAD` resolves to the
  terminal or to one of the walked links, written in the **same** transaction as the ref itself
  — a refusal never leaves one without the other. When the walk passes through `HEAD` itself,
  no coupled entry is added (git's `REF_UPDATE_VIA_HEAD`).
- **The two backends write that coupled entry's old id differently**, exactly as git's do, and
  only when `HEAD` names a walked **link** rather than the terminal: the files backend splits
  the update at each hop and logs the coupled entry before the terminal's value is known, so it
  records the **null id**; the reftable backend resolves the old value directly and records the
  **real one**. A `noDeref` update, or one whose terminal is what `HEAD` names, logs the
  resolved value on both.

### Deletes

- **The null id and `delete: true` are one transaction shape**, not two: compare-and-swap
  honoured, the ref's own reflog file removed, no target verified.
- **Deleting a ref that does not exist succeeds.** Every lock is still taken; the no-op is
  proven by nothing changing, not by a refusal. (`branch.delete`, `tag.delete` and
  `remote.remove` keep refusing an unknown name first, on their own checks.)
- **A packed-only or loose-and-packed ref is deleted properly.** `packed-refs` is rewritten
  without it — once for the whole run — under git's canonical header
  (`# pack-refs with: peeled fully-peeled sorted `, trailing space included), which a
  header-less or `peeled`-only file gains. Surviving lines keep the order the snapshot held
  them in, and a surviving `^peel` line is copied verbatim with no object read. Order on disk
  is git's own: locks, then `packed-refs`, then each loose file, then its reflog — so a crash
  between them can leave a loose file holding the ref's current value, never an older packed
  value resurrected.
- **A name git's `refname_is_safe` rejects is refused** before anything is read or locked, on
  both backends: `INVALID_REF { reason: 'refusing to update ref with bad name' }`. That is any
  name outside `refs/` other than uppercase letters and underscores — every `main-worktree/…`
  and `worktrees/<id>/…` name, and a name such as `foo/bar` even when it exists — and any
  `refs/` name with an empty, `.` or `..` component, such as `refs/a/`. It is the only name
  check a delete runs, as in git: a ref whose name the write grammar refuses
  (`refs/heads/bad..name`, `refs/heads/x.lock`, `refs/.x`) can still be deleted. The internal
  `deleteRefs` (one transaction over several names, used by `fetch`, `push` and `remote`) checks every
  name before it plans any, so one unsafe name deletes nothing; the refusal does not say which
  name failed.
- **Deleting the ref `HEAD` names appends one entry to `logs/HEAD`** on every delete path —
  `<old> 0{40} <identity>` plus the message, tab-separated. With no `reflogMessage` the message
  is empty and the line carries no tab at all.

### Locks

- A held `packed-refs.lock` refuses `RESOURCE_LOCKED { resource: 'ref', path }`.
- A held `<ref>.lock` refuses `REF_LOCKED { name }`, and it wins over a held `packed-refs.lock`
  — loose locks are taken first, and every lock already held is released on the way out. This
  applies to an absent ref too, with one condition git shares: a name is lockable only when its
  loose parent directory already exists, so a deeply nested absent name is never locked and
  leaves no directory behind.
- Naming the same ref twice inside one transaction refuses `REF_CYCLE_DETECTED { chain }` —
  git's "multiple updates" — before any lock or mismatched `expected` is even reached.
- Two **different** names of one write on one loose file refuse `REF_LOCKED { name }` on the
  files backend, with `name` the name you passed, and nothing is written. A symbolic hop whose
  file an earlier hop already holds is refused during the walk (`refs/bisect/c` holding
  `ref: main-worktree/refs/bisect/c` names its own file: `REF_LOCKED`, not `REF_CYCLE_DETECTED`).
  A coupled `HEAD` entry whose file a hop or the terminal already holds is refused after the
  compare-and-swap, so a mismatched `expected` reports `REF_UPDATE_CONFLICT` first. The reftable
  backend takes no per-ref lock and refuses neither.

## Example

```ts
await repo.primitives.updateRef('refs/heads/main', newCommitId, {
  expected: previousTip,
  reflogMessage: 'fast-forward to <newCommitId>',
});

// Delete a symbolic ref itself, leaving its target untouched (git's `--no-deref`).
await repo.primitives.updateRef('refs/remotes/origin/HEAD', zeroOid, {
  delete: true,
  noDeref: true,
});

// The null id deletes, exactly as `git update-ref <ref> 0{40}` does.
await repo.primitives.updateRef('refs/heads/stale', zeroOid, {
  reflogMessage: 'cleanup',
});
```

## Throws

- `OBJECT_NOT_FOUND` — a write whose target object is not in the store.
- `OBJECT_HASH_MISMATCH` — a write whose target bytes do not hash to the id.
- `INVALID_COMMIT` / `INVALID_TAG` — a write whose target is a commit or tag git's parser refuses; `reason` carries git's own wording.
- `UNEXPECTED_OBJECT_TYPE` — a non-commit written to `HEAD` or `refs/heads/*`, typed by the name given.
- `REF_UPDATE_CONFLICT` — `expected` does not match the terminal's current value; `name` is the ref you passed.
- `REF_CYCLE_DETECTED` — a symbolic chain that meets a name twice, or the same ref named twice in one transaction; `chain` lists the names walked.
- `REF_LOCKED` — a held `<ref>.lock`, or (files backend) two different names of one write on one loose file; `name` is the ref you passed.
- `RESOURCE_LOCKED` — a held `packed-refs.lock`; `resource` is `'ref'`.
- `NOT_A_DIRECTORY` / `FILE_EXISTS` — git's name-availability check, run over every name the transaction creates or rewrites without requiring a current value: a name blocked by refs **beneath** it (`refs/heads/a` while `refs/heads/a/b` exists) is `FILE_EXISTS`; one blocked by a ref **above** it (`refs/heads/a/b` while `refs/heads/a` exists) is `NOT_A_DIRECTORY`. `path` names the blocking ref's loose path on both backends, even when the blocker is packed or held in a reftable.
- `DIRECTORY_NOT_EMPTY` — the ref's reflog path is occupied by a directory holding real logs; an all-empty directory tree there is removed and the write proceeds.
- `INVALID_REF` — a write's `name` violates git ref syntax, or a delete names a ref git's `refname_is_safe` rejects (`reason: 'refusing to update ref with bad name'`).

## See also

- Related primitives: [`resolveRef`](resolve-ref.md)
- Related commands: [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`remote`](../commands/remote.md), [`fetch`](../commands/fetch.md)
- Internal mechanisms: [`RefStore`](internals.md#refstore--getrefstore), [`recordRefUpdate`](internals.md#recordrefupdate), [`writeSymbolicRef`](internals.md#writesymbolicref)
- ADRs: [864](../../adr/864-ref-updates-verify-their-target-as-gits-ref-transaction-does.md), [871](../../adr/871-updateref-dereferences-symbolic-refs-and-deletes-as-gits-ref-transaction-does.md)
