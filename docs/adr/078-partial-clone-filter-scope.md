# ADR-078: Partial clone supports `blob:none`, `blob:limit`, and `tree:<depth>`

## Status

Accepted (at `aef8dc2`)

## Context

Backlog 17.4 names `--filter=blob:none` explicitly but partial clone's wire
protocol carries an open-ended `filter <spec>` line. git defines several
filter specs: `blob:none`, `blob:limit=<n>`, `tree:<depth>`, `sparse:oid=<ref>`,
and `combine:<f1>+<f2>`. The scope question — which to support — was put to
the user, who chose the widest of the offered options: `blob:none` +
`blob:limit=<n>` + `tree:<depth>`.

Forces:

- `blob:none` and `blob:limit` are the same mechanism — a one-line wire spec
  the server interprets. tsgit never evaluates the filter itself; it forwards
  the spec and the server omits objects. Supporting both costs only a parser
  branch.
- `tree:<depth>` is also forwarded verbatim, but it changes which object
  *kinds* become absent: trees, not just blobs. That ripples into lazy-fetch
  (a tree read can now miss) — see ADR-080.
- `sparse:oid` and `combine:` are materially larger: `sparse:oid` references
  another object as the filter definition; `combine:` is recursive. Neither
  was requested.

## Decision

Support exactly three filter specs: `blob:none`, `blob:limit=<n>[kmg]`, and
`tree:<depth>`. Model them as a closed domain ADT `ObjectFilter`
(`src/domain/protocol/object-filter.ts`) with a total `parseObjectFilter`
(validates, throws `INVALID_FILTER_SPEC`) and `formatObjectFilter` (canonical
wire form). `sparse:oid` and `combine:` are rejected as `INVALID_FILTER_SPEC`.

## Consequences

### Positive

- Covers the common partial-clone use cases — blobless clones and size-capped
  clones are by far the most deployed; `tree:0` blobless+treeless clones are
  the third.
- A closed ADT keeps the surface auditable: three variants, exhaustively
  switched, no open-ended string passed around the codebase.
- `blob:limit` is nearly free given `blob:none` — one extra parser arm.

### Negative

- `tree:<depth>` admits lazy-fetching of trees, which over-fetches their
  closure (ADR-080). Accepted as a documented limitation.
- `sparse:oid` / `combine:` users get a clean rejection, not support. They
  were out of the requested scope; revisiting means a new ADT variant.

### Neutral

- The parsed `ObjectFilter` is used for validation and canonicalisation only;
  tsgit forwards the canonical string to the server and never applies the
  filter locally. The ADT could carry more semantics later without a wire
  change.
</content>
