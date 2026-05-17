# ADR-009: Shallow Handling Lives in `fetchPack`

## Status

Accepted (at `22f0594`)

## Context

Phase 12.2 lands real shallow support — the `deepen <N>` request line was
already wired in `buildUploadPackRequest` since Phase 8, but the response
side (`shallow <oid>` / `unshallow <oid>` pkt-lines, plus the `.git/shallow`
sidecar file) was deferred to this phase per [ADR-008](008-clone-defer-shallow.md).

Where should the shallow logic live?

**Option A — Generalize `fetchPack` with shallow capabilities.** The primitive
already owns the request body construction, the response parsing, the side-band
drain, and the pack write. Adding optional `depth: number` to its input and
optional `shallow` / `unshallow` to its result is a small surface extension
(~30 LOC). Both `clone({ url, depth })` and `fetch({ depth })` then call the
same primitive with the same shape.

**Option B — Layer a fetch-specific shallow-aware wrapper.** Leave `fetchPack`
alone. Add a `shallow-aware-fetch.ts` that:
1. Calls `fetchPack` without `depth` if depth is unset.
2. When depth is set, intercepts the response stream before `parseUploadPackResponse`,
   peels off the shallow block, then hands the remaining stream back to
   `fetchPack`.

This keeps `fetchPack` "small and pure" but bloats the surface elsewhere and
duplicates a lot of the stream-consumption code.

**Option C — Push shallow handling entirely into a clone- and fetch-side
wrapper each, with no primitive change.** Doubles the code; ADR-008 explicitly
called out that this was the wrong answer.

## Decision

Adopt Option A: `fetchPack` grows optional `depth?: number` in its input and
`shallow: ReadonlyArray<ObjectId>` / `unshallow: ReadonlyArray<ObjectId>` in
its result. `parseUploadPackResponse` grows an optional `expectShallow?: boolean`
flag that, when true, calls `parseShallowResponse` before `splitMeta`.

`clone.ts` and `fetch.ts` both call `fetchPack` with the same shape. Each
command is responsible for taking the resulting shallow oids and persisting
them via the shared `updateShallow` primitive — the primitive does NOT write
to `.git/shallow` itself (that crosses the "primitive ↛ commands" tier rule
the way it accesses ref-update policy).

## Consequences

### Positive

- One code path for shallow request/response handling. The clone command's
  shallow support comes "for free" once the primitive is extended.
- `parseShallowResponse` is testable in isolation (the protocol parser layer
  is the right home for it).
- The "shallow handling is part of negotiation, not a separate concern" model
  matches canonical git's internal organization.
- The Phase 12.1 callers see no behavioral change when `depth` is unset
  (regression-tested).

### Negative

- `FetchPackInput` and `FetchPackResult` grow two fields each. The public API
  was very tight; we trade some surface area for one-path implementation.
  Mitigation: the new fields are optional / always-present-as-empty, so
  existing callers compile unchanged.
- `parseUploadPackResponse` now has three flags (`sideBand`, `onProgress`,
  `expectShallow`). Tolerable; if it grows beyond five we'd refactor to an
  options-object shape (which it already uses).

### Neutral

- `clone.ts`'s `UNSUPPORTED_OPERATION` guard on `opts.depth` is removed in
  the same commit that adds `depth` support to `fetchPack`. The ADR-008
  reopening clause is honored.
- `updateShallow` lives in `application/primitives/shallow-file.ts` rather
  than inside `fetchPack` so the primitive stays focused on pack
  transport, not repository sidecar state.
