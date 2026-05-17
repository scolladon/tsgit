# ADR-008: Shallow Clone (`depth: N`) Deferred to Phase 12.2

## Status

Accepted (at `1c23aae`)

## Context

`CloneOptions.depth?: number` already exists on the public API surface, declared during the Phase 9 clone-stub design so the type would not break when the feature landed. The `WantHaveRequest` shape also already carries an optional `depth` field, and `buildUploadPackRequest` already serializes a `deepen N` pkt-line when `req.depth !== undefined`.

What does NOT exist is the response-parsing side:

- When `deepen` is in the request, the server prefixes its `ACK/NAK/pack` response with `shallow <oid>` and/or `unshallow <oid>` pkt-lines, one per cut-point in the commit graph.
- These lines must be parsed BEFORE the `ACK` lines (the existing `splitMeta` would mis-interpret them as bad ack/nak lines and throw).
- The cut-point oids must be written to `.git/shallow` so subsequent fetches know they are operating against a shallow clone.
- A subsequent `git log` on a shallow clone must terminate at the shallow boundaries, which means `walkCommits` would also need to consult `.git/shallow` (currently it does not).

This is real implementation surface — at minimum a `parseShallowResponse` parser in `domain/protocol/upload-pack.ts`, a `.git/shallow` writer in `application/primitives/`, and a shallow-aware walker in `walkCommits`. ~150 LOC plus tests.

Phase 12.1's stated goal is "real pack-fetch end-to-end". Adding shallow doubles the size of the change and creates a parallel set of failure modes (server doesn't support `shallow` capability, server returns `shallow` lines but no `unshallow`, etc.) — each of which requires its own tests.

Phase 12.2 (`fetch`) already requires ls-refs + want/have negotiation and is the natural home for negotiation-flavored features. Bundling shallow there keeps the scope coherent.

## Decision

Phase 12.1 does NOT implement shallow clone. The `CloneOptions.depth` field stays on the public type — removing it would be a breaking change for callers that pass it (even though the current stub ignores it). Instead, `clone` raises `UNSUPPORTED_OPERATION` with a reason naming Phase 12.2 when `depth` is set.

Phase 12.2 implements:

1. `parseShallowResponse` in `domain/protocol/upload-pack.ts` — consumes `shallow <oid>` and `unshallow <oid>` pkt-lines before `splitMeta`.
2. A `.git/shallow` reader/writer in `application/primitives/`.
3. A shallow-aware termination condition in `walkCommits`.
4. The `clone` command opens `depth` again, removing the `UNSUPPORTED_OPERATION` guard.

## Consequences

### Positive

- Phase 12.1 scope stays tight (~350 LOC instead of ~500 LOC).
- The four parts of shallow handling (parse, store, walk, surface) land together in Phase 12.2 instead of being half-shipped here and half-shipped there.
- Callers who accidentally pass `depth: 1` get a clear error pointing to the future phase, instead of a silent-ignore that masquerades as a full clone.

### Negative

- Phase 12.1 cannot clone the linux kernel, openjdk, or any other "too-big-for-a-full-clone" repo. Mitigation: the v1 target user clones repos in the < 200 MiB range; the giant-repo case is explicitly Phase 15 work.
- The `CloneOptions.depth` field is now a type-level lie until Phase 12.2 — accepted but not honored. Mitigation: the runtime throw makes the situation discoverable on first call; the JSDoc on the field documents the deferral with a forward-link to Phase 12.2.

### Neutral

- The existing `buildUploadPackRequest.depth` path stays. It will be exercised by Phase 12.2's tests as soon as the parser counterpart lands. No code is removed.
- Phase 12.2's plan must explicitly list "implement shallow as part of fetch negotiation" so the deferral does not silently slip a third time.
