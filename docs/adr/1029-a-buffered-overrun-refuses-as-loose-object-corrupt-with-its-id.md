---
subjects:
  - src/domain/error.ts
  - src/domain/objects/error.ts
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/commands/internal/fsck/stored-corruption.ts
---
# 1029 — A buffered overrun refuses as `LOOSE_OBJECT_CORRUPT` with its id

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (D3, requirement 2) · **Supersedes/Refines:** refines ADR-907 (the refusal's code and data)

## Context

git names the object it refuses: `error: corrupt loose object '<oid>'` from `unpack_loose_rest`,
then `fatal: loose object <oid> (stored in <path>) is corrupt` from `repo_read_object_file`.
tsgit's buffered tier refuses the same overrun with `INVALID_OBJECT_HEADER { reason: 'content
exceeds declared size <claim>' }`, which carries no id: the caller was expected to compose it from
the id it asked for. A gc task reads many objects, so its `tasksFailed[].data` cannot rebuild
either git line. The structured-output rule (ADR-249) wants the data to carry what the lines
need and nothing rendered.

## Options considered

1. **Optional `id` on `INVALID_OBJECT_HEADER`** (recommended by the design) — pros: additive;
   precedent in the optional `headerLimit` / cons: one code keeps covering three different git
   errors (unparseable header, header too long, corrupt body).
2. **A new code `LOOSE_OBJECT_CORRUPT { id }` for every buffered past-window overrun** — pros: one
   code per git error; the data is exactly what git names / cons: breaking for a caller that
   matches `INVALID_OBJECT_HEADER` on an overrun; allowed in the 6.0.0 cut and named here.
3. **Reuse `OBJECT_HASH_MISMATCH`** — cons: git never hashes here, and the shape carries an
   expected/actual oid pair that does not exist.

## Decision

**User-ratified: option 2.** The buffered loose tier's past-window overrun — raised today by
`inflateLooseSinglePass`, `inflateBoundToClaim` and blob-source's `assertWithinClaim` — throws
`LOOSE_OBJECT_CORRUPT { id }`, `id` the object id the read was asked for. `INVALID_OBJECT_HEADER`
keeps the unparseable header, the header-too-long refusal and the commit, tree or tag size
mismatch. `fsck`'s stored-corruption set gains the new code so its verdict on a corrupt loose
object is unchanged. The loose path in git's `fatal:` line is composed by the caller from the id
and the objects directory, never carried.

## Consequences

Breaking for callers matching `INVALID_OBJECT_HEADER` on an overrun; shipped in 6.0.0 and named
in the release notes. The error union, its exhaustiveness switches, the barrel-surface test and
`docs/use/errors.md` gain the code. The `reason` text with the claim is dropped; a diagnostic
field can be added additively later if a consumer needs it. Interop rows rebuild both git lines
from `data.id` alone.
