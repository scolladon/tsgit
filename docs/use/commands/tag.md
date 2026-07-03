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

- `TAG_EXISTS` — `create` with an existing name and no `force`.
- `INVALID_REF` — name violates git ref syntax.
- `TAG_NOT_FOUND` — `delete` on a name that does not exist.
- `SIGNING_FAILED` — `sign` requested but the signing program failed or is unavailable (e.g. off-node, no `gpg`).

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md)
- Related commands: [`branch`](branch.md), [`log`](log.md), [`revParse`](rev-parse.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md), [448](../../adr/448-signed-tag-signature-appended-to-body.md), [449](../../adr/449-annotated-tag-creation-with-signing.md)
```
