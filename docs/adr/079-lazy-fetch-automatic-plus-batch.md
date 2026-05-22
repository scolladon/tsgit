# ADR-079: Lazy-fetch is automatic in `readObject`, plus an explicit batch API

## Status

Accepted (at `aef8dc2`)

## Context

A partial clone omits objects; a later read may need one. The "lazy-fetch on
read" behaviour can be delivered three ways, and the choice was put to the
user:

1. **Automatic** — `readObject` transparently fetches a missing object and
   retries. Git-faithful; every command works on a partial clone unchanged.
   One network round-trip per missing object.
2. **Explicit only** — `readObject` keeps throwing `OBJECT_NOT_FOUND`; the
   caller must prefetch via an API. Keeps `readObject` free of network I/O,
   but is not git-faithful and breaks every existing command on a partial
   clone.
3. **Automatic + a batch API** — option 1 plus an explicit
   `repo.fetchMissing(oids)` so bulk readers fetch many objects in one
   round-trip.

The user chose option 3.

Forces:

- Git-faithfulness (a project memory): canonical git lazy-fetches
  transparently. Option 2 diverges.
- A blobless `checkout` reads hundreds of blobs. Pure option 1 is hundreds of
  sequential round-trips. A batch API lets a caller that knows its working
  set ahead of time collapse that to one fetch.
- `readObject` is the single object-read chokepoint; wiring lazy-fetch there
  covers `readBlob`, `walkTree`, `materializeTree`, `diff`, `merge`, … with no
  per-command change.

## Decision

Implement both:

- **Automatic** — `readObject` catches `OBJECT_NOT_FOUND` for the requested
  oid, triggers a single-object fetch through the `PromisorRemote` port
  (ADR-081), and retries once. A per-`Context` in-flight map de-dupes
  concurrent reads of the same missing oid.
- **Batch** — a Tier-1 `fetchMissing` command, surfaced as
  `repo.fetchMissing(oids)`, fetches a whole oid list in one `fetchPack`
  call. The automatic path and the batch command share one internal routine.

## Consequences

### Positive

- Every existing command works on a partial clone with zero per-command code
  change — the win of putting the hook at the `readObject` chokepoint.
- Git-faithful: transparent lazy-fetch matches canonical git.
- The batch API gives performance-sensitive callers an escape from the
  one-round-trip-per-object cost without making the common path more complex.

### Negative

- `readObject` can now perform network I/O — a primitive that was pure-I/O
  over the local filesystem now reaches the transport on a miss. Bounded:
  only on a genuine miss, only when a promisor remote is configured, only one
  retry.
- Two entry points (automatic, batch) over shared logic — slightly more
  surface than a single API.

### Neutral

- The batch API is advisory: callers that do not use it still work, just with
  more round-trips. No command is *required* to prefetch.
- A still-missing object after the retry surfaces `OBJECT_NOT_FOUND` exactly
  as before — the automatic path strictly widens what succeeds.
</content>
