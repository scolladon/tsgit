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
- `REF_LOCKED` — a held `<ref>.lock`.
- `RESOURCE_LOCKED` — a held `packed-refs.lock`; `resource` is `'ref'`.
- `NOT_A_DIRECTORY` / `FILE_EXISTS` — git's name-availability check, run over every name the transaction creates or rewrites without requiring a current value: a name blocked by refs **beneath** it (`refs/heads/a` while `refs/heads/a/b` exists) is `FILE_EXISTS`; one blocked by a ref **above** it (`refs/heads/a/b` while `refs/heads/a` exists) is `NOT_A_DIRECTORY`. `path` names the blocking ref's loose path on both backends, even when the blocker is packed or held in a reftable.
- `DIRECTORY_NOT_EMPTY` — the ref's reflog path is occupied by a directory holding real logs; an all-empty directory tree there is removed and the write proceeds.
- `INVALID_REF` — `name` violates git ref syntax.

## See also

- Related primitives: [`resolveRef`](resolve-ref.md)
- Related commands: [`branch`](../commands/branch.md), [`tag`](../commands/tag.md), [`remote`](../commands/remote.md), [`fetch`](../commands/fetch.md)
- Internal mechanisms: [`RefStore`](internals.md#refstore--getrefstore), [`recordRefUpdate`](internals.md#recordrefupdate), [`writeSymbolicRef`](internals.md#writesymbolicref)
- ADRs: [864](../../adr/864-ref-updates-verify-their-target-as-gits-ref-transaction-does.md), [871](../../adr/871-updateref-dereferences-symbolic-refs-and-deletes-as-gits-ref-transaction-does.md)
