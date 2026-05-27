# ADR-162: `hashBlob` takes an optional `write` flag

## Status

Accepted (at `7d04c08`)

## Context

Phase 20.2 ships `hashBlob` as a Tier-2 primitive. The natural surface
question is whether it should mirror `git hash-object`'s `-w` flag (one
function, two modes) or stay pure (return the OID only; let
`writeObject` handle the disk write).

Callers fall into two camps:

- **Pack/remote uploaders, content-addressable caches, deduplication
  scans** — want the OID and never the file. Pure hashing is a hot
  path; an unconditional `mkdir` + `writeExclusive` is wasted I/O.
- **Programmatic stagers (CI tools, in-memory pipelines, the
  `stageEntry` primitive itself)** — want "compute OID, then file
  the loose object." Today they reach `writeObject({ type: 'blob',
  id: '' as ObjectId, content })`. That works but the `id: ''`
  ceremony leaks the discriminated-union shape into every caller.

Three options surfaced in the design conversation:

1. **Optional `write` flag.** `hashBlob(content, { write: true })`
   files the loose object; the default does not.
2. **Pure hashing only.** Writing stays the domain of `writeObject`.
3. **Always write.** `hashBlob` writes unconditionally; equivalent to
   `writeObject` for blobs but with a content-only signature.

## Decision

Take option (1): `hashBlob(content, opts?)` where `opts.write` defaults
to `false`. When `write` is true the body delegates to `writeObject`
(via the shared `serializeAndHash` helper extracted in §6.1 of the
design) so the on-disk layout, the `FILE_EXISTS` idempotency, and the
mkdir behaviour stay byte-identical across both code paths.

## Consequences

### Positive

- Matches `git hash-object [-w]` muscle memory. Documentation can
  point at a single canonical-git command for both modes.
- Hot path stays pure: a content-only fingerprint never touches `fs`.
- `stageEntry`'s `source.content` path becomes a one-liner
  (`hashBlob(content, { write: true })`) — the primitive composes on
  the new primitive without duplicating the loose-object writer.
- One primitive name to remember for blob-OID computation.

### Negative

- `hashBlob(content)` without `{ write: true }` is a footgun for
  callers expecting `git hash-object`'s default behaviour. The CLI's
  default is "compute and print"; `-w` is opt-in. Our default
  matches that, but a JS dev coming from `git hash-object content
  > file` might assume otherwise. Mitigated by docs and by the
  type of the option name (`write: true`).
- The `opts` parameter is one more shape to test (covered in the
  mutation-resistance checklist in design §9.2).

### Neutral

- `writeObject({ type: 'blob', … })` continues to work — `hashBlob`
  does not replace it, only fronts a blob-specialised entry point.
  No deprecation.
- The shared `serializeAndHash` helper is `internal/` and not
  re-exported.

## Alternatives considered

- **Option 2 (pure)** — rejected because every staging caller would
  pair `hashBlob` with `writeObject` immediately afterward, which is
  exactly the composition this primitive is meant to provide.
- **Option 3 (always write)** — rejected because it makes the OID-only
  hot path impossible without re-exposing `writeObject` for the
  workaround. We'd be back to two primitives that look like one.
