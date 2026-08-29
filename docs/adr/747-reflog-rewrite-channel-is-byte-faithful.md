# ADR-747: Reflog rewrite channel is byte-faithful

## Status

Accepted (at `fc54f8cd`) — ratified by the user

## Context

Reflog messages and identities are raw bytes in git; non-UTF-8 content (legacy
encodings in names, branch names, commit subjects) is routine and git's
expire/delete rewrite preserves it exactly (measured, git 2.55.0: a latin1
`0xE9` survives `reflog expire --expire=never` byte-for-byte). tsgit's rewrite
read the file with a UTF-8 decode — invalid sequences become U+FFFD — and
re-encoded, silently and irreversibly mangling those bytes. The always-rewrite
decision made that mangling routine rather than rare: every `expire` and every
out-of-range `delete` transcodes the whole file. Alternatives: refuse loudly on
invalid UTF-8 (safe, cheap, but diverges from git, which succeeds); or record
the divergence unchanged (silent data corruption).

## Decision

The files-backend rewrite channel (expire / delete / the rewrite half of
rename) carries raw bytes end-to-end: the read-for-rewrite parses from bytes,
entries carry the byte-verbatim identity and message slices alongside their
decoded display fields, and the rewrite serializer re-emits those slices
exactly as git's rewrite writer does. Display-oriented reads keep UTF-8
decoding for their string fields. Entries built programmatically (append path,
rename entry) serialize from their strings as before.

The reftable backend is out of this decision's scope: its log records live in
a binary block format with its own string encoding, a pre-existing boundary
recorded here rather than silently widened.

## Consequences

### Positive

- Any byte sequence a reflog file carries survives expire/delete/rename
  unchanged, matching git exactly.

### Negative

- The parse produces both display strings and raw slices — two views of the
  same fields to keep coherent, and a wider `ReflogEntry` surface.

### Neutral

- Recorded divergences over parsed VALUES (negative timestamps, NUL handling)
  are unaffected; this decision is about the bytes around them.
