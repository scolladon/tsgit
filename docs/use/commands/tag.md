# `tag`

List, create, or delete tags via the `repo.tag.{list,create,delete}` nested namespace. `create` makes a lightweight tag by default, an annotated tag when `annotate`/`message` is set, and a GPG-signed annotated tag when `sign` is set.

## Signature

```ts
interface TagInfo {
  readonly name: RefName;
  readonly id: ObjectId;
}

interface TagNamespace {
  list(): Promise<{ tags: ReadonlyArray<TagInfo> }>;
  create(input: {
    name: string;
    target?: string;
    force?: boolean;
    annotate?: boolean;
    message?: string;
    sign?: boolean;
    signKey?: string;
  }): Promise<{
    name: RefName;
    id: ObjectId;
  }>;
  delete(input: { name: string }): Promise<{ name: RefName }>;
}

repo.tag: TagNamespace;
```

Each method returns a concrete result — no discriminator to narrow on at the call site (ADR-181, ADR-192).

## Methods

| Method | Meaning |
|---|---|
| `list()` | List tags (`refs/tags/*`), sorted by name. |
| `create({ name, target?, force?, annotate?, message?, sign?, signKey? })` | Create a tag. Lightweight by default; annotated when `annotate` or `message` is set (`message` is the annotation body); GPG-signed when `sign` is set — signing implies annotated and appends the signature to the tag body. `signKey` overrides `user.signingkey`; `tag.gpgSign` config signs by default. `target` defaults to HEAD; `force` overwrites an existing tag with the same name. |
| `delete({ name })` | Delete a tag. |

## Behaviour

- **`TAG_EXISTS` is checked before the target is verified**, for lightweight and annotated tags alike: `create({ name: '<existing>', target: '<missing oid>' })` reports `TAG_EXISTS`, never `OBJECT_NOT_FOUND`. `force: true` skips that check only — the target is still verified, so a forced tag at a missing object refuses `OBJECT_NOT_FOUND`.
- **A lightweight tag accepts any existing object type** — blob, tree, commit or tag — because `refs/tags/*` is not branch-typed. A full oid naming an object that is not in the store refuses `OBJECT_NOT_FOUND`; a *name* that resolves to nothing refuses `REF_NOT_FOUND` earlier, while the target is being resolved. The target is **not** peeled: a lightweight tag over an annotated one records that tag object's own id, as git's `repo_get_oid` does.
- **A symbolic ref is deleted as itself.** `delete` on a name holding a symbolic ref removes that ref and leaves its target alone (git's `--no-deref`), while a forced `create` through one moves the symref's **target** and keeps the symref in place.
- **For an annotated tag, the ref's verified target is the tag object just written**, never the object you named. Your target is read separately and earlier, only to determine its type, and that read is not git's parse-acceptance check — so an object [`updateRef`](../primitives/update-ref.md) would refuse as a malformed commit can still be wrapped in an annotated tag.

## Examples

```ts
const { tags } = await repo.tag.list();
await repo.tag.create({ name: 'v1.0.0' });
await repo.tag.create({ name: 'v1.0.0', target: 'main', force: true });
await repo.tag.create({ name: 'v1.0.0', message: 'Release 1.0.0' }); // annotated
await repo.tag.create({ name: 'v1.0.0', sign: true, message: 'Release 1.0.0' }); // signed
await repo.tag.delete({ name: 'v1.0.0' });
```

## Throws

- `TAG_EXISTS` — `create` with an existing name and no `force`. Checked before the target is verified.
- `INVALID_REF` — name violates git ref syntax.
- `TAG_NOT_FOUND` — `delete` on a name that does not exist.
- `REF_NOT_FOUND` — `create` whose `target` names something that does not resolve.
- `OBJECT_NOT_FOUND` — `create` whose `target` is a full oid naming an object the store does not hold.
- `OBJECT_HASH_MISMATCH` / `INVALID_COMMIT` / `INVALID_TAG` — `create` whose target fails the ref transaction's own verification (see [`updateRef`](../primitives/update-ref.md#the-writes-target-is-verified-first)).
- `CONFIG_BAD_BOOLEAN_VALUE` — `tag.gpgSign` holds a value git's boolean grammar refuses. Checked for lightweight tags too, before the name/target resolve.
- `SIGNING_FAILED` — `sign` requested but the signing program failed or is unavailable (e.g. off-node, no `gpg`).

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md)
- Related commands: [`branch`](branch.md), [`log`](log.md), [`revParse`](rev-parse.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md), [448](../../adr/448-signed-tag-signature-appended-to-body.md), [449](../../adr/449-annotated-tag-creation-with-signing.md), [627](../../adr/627-boolean-config-values-are-refused-as-git-refuses-them.md)
```
