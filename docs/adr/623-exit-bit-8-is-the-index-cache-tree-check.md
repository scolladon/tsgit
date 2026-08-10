# 623 — Exit bit 8 is the index cache-tree check

- **Status:** accepted (ratified). **Supersedes its own first two drafts** — see Provenance.
- **Date:** 2026-08-10
- **Design:** docs/design/rev-index-bitmap-read-support.md (composition matrix) · **Refines:** ADR-226, ADR-585

## Context

This entry's `fsck` composition rows could not assert exit-integer equality with git: tsgit
emitted bit 2 where git emitted 2\|8. The cause predates the entry. Settling *why* took three
attempts, and the first two were wrong — both are recorded below so neither is re-proposed.

The mechanism is now read directly out of canonical git's `builtin/fsck.c` (v2.55.0), not
inferred. `ERROR_REFS` (010, decimal 8) has exactly four setters:

| # | function | condition |
|---|---|---|
| 1 | `snapshot_ref` | a ref whose object fails to parse and is not a promisor object |
| 2 | `snapshot_ref` | a **branch** ref pointing at a non-commit |
| 3 | **`fsck_cache_tree`** | **a cache-tree entry whose object fails to parse** |
| 4 | `fsck_resolve_undo` | a resolve-undo entry whose object fails to parse |

And decisively, the count of resolvable refs does **not** set the bit:

```c
if (!default_refs) {
    fprintf_ln(stderr, _("notice: No default references"));
    show_unreachable = 0;
}
```

Setter 3 is the one that explains every measured shape, because the index's cache-tree holds
**tree** oids:

| repository shape | cache-tree trees parse? | git |
|---|---|---|
| a ref to a never-existing oid beside a healthy branch | yes | **2** |
| only the HEAD commit object deleted (trees, blobs, parent intact) | yes | **2** |
| a pack removed but a loose-backed ref still resolves | yes | **2** |
| the whole pack directory removed | no | **10** |
| the sole pack's header version set to 99 | no | **14** (2\|4\|8) |
| every loose object deleted | no | **10** |
| any bare repository (no index at all) | n/a — no cache-tree | never |

## Decision

tsgit reproduces **setter 3**: when the index carries a cache-tree, every cache-tree entry's
tree oid is resolved, and a failure contributes exit bit 8. No index, or an index with no
cache-tree extension, contributes nothing — matching git, which runs no such check there.

Setters 1, 2 and 4 are **not** modelled and that is a stated, bounded divergence: setter 1
would require distinguishing parse failure from absence at the ref layer, setter 2 needs a
branch-target type check, and setter 4 needs resolve-undo. None is exercised by this entry's
rows, and each is named here so a future reader knows the bit is partially modelled rather
than assuming it is complete.

## Consequences

Requires parsing the index's cache-tree (`TREE`) extension, which tsgit did not read before.
The check runs only when that extension is present.

**Rejected proxies, recorded so they are not revived.** An earlier implementation keyed the bit
off *stage-0 index entries* (blob oids) instead of cache-tree tree oids. It matched every
measured row, but diverges on two shapes git treats differently: an index with **no** cache-tree
extension (git: no check at all), and unreadable **blobs** beside readable **trees** (git: no
bit, because it only parses trees).

## Provenance — two falsified drafts

Both were measured, not merely doubted, and both are wrong:

1. **"A ref target listed by a pack index whose pack is unreadable"** (per-oid). Falsified by an
   unreadable pack plus a still-resolving ref, which gives git exit 6, not 14.
2. **"No ref and no reflog entry resolves"** (whole-repository entry point). Falsified by a bare
   repository whose every reflog entry fails to resolve, which stays at exit 2 — and by git's
   source, where the `default_refs == 0` branch prints a notice and sets no bit.
