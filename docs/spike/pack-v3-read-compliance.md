# Spike — Pack format v3 read compliance

**Date:** 2026-08-07
**Backlog:** `docs/BACKLOG.md` — "Pack format v3 read compliance" (surfaced 2026-06-29, 24.7 notes run)
**Status:** findings complete, ready for design/ADR

## Question

Canonical git accepts pack header version **2 or 3** on read (v3 is reserved; the
on-disk format is byte-identical to v2) while generating v2 only. tsgit's reader
refuses anything but 2. How large is the faithfulness gap, exactly where does it
bite, and what does the lift look like?

## Method

Built a 5-object pack with real git 2.55.0 (scrubbed env, signing off), then
produced two mutants by rewriting the version field (u32 BE at offset 4) and
recomputing the SHA-1 trailer:

- `v3.pack` — version stamped 3 (reserved, format-identical)
- `v99.pack` — version stamped 99 (genuinely unsupported)

Ran both through every read surface of canonical git and tsgit (source, via
`openRepository` + `catFile`, and `parsePackHeader` directly).

## Results

| Surface | git 2.55.0 | tsgit today |
|---|---|---|
| Ingest v3 (`index-pack`, `verify-pack`, `unpack-objects`) | **accepts** (exit 0, idx built, `ok`) | **refuses** — `INVALID_PACK_HEADER: unsupported version: expected 2, got 3` |
| Ingest v99 | refuses — `fatal: pack version 99 unsupported` | refuses (same guard, different wording) |
| In-place local read of v3 pack (`cat-file`, `fsck`) | **accepts** (validates header on first pack open; 2\|3 ok) | accepts — but only because the local path never parses the header |
| In-place local read of v99 pack | **refuses** — `error: packfile … is version 99 and not supported (try upgrading GIT …)` | **accepts** — reads the blob happily |
| Generation | v2 only (`PACK_VERSION 2` in `pack.h`) | v2 only (`pack-writer.ts` hardcodes 2) — faithful |

Upstream authority: `pack_version_ok(v)` in git's `packfile.h` is
`(v) == htonl(2) || (v) == htonl(3)`; `index-pack.c` and `open_packed_git_1`
(`packfile.c`) both gate on it. Observed messages match both call sites.

## Findings

Two divergences, in **opposite directions**:

1. **Ingest too strict** (the backlog item as written). `parsePackHeader`
   (`src/domain/storage/pack-entry.ts:70`) hard-refuses version 3. Its only
   production caller is the network-ingest path
   (`src/application/primitives/fetch-pack.ts:307`), so a v3-stamped pack
   arriving over fetch/clone is refused where git would index it.

2. **Local open too lax** (new finding, beyond the backlog note). The local
   pack read path is idx-driven and never inspects the pack header at all, so
   tsgit silently reads packs of *any* version (v99 verified) that git refuses
   at open time. Same root cause — version validation lives only in
   `parsePackHeader`, which the local path never calls.

Generation is already faithful (v2 only); no write-side change.

## Proposed lift

- **Widen the guard**: `parsePackHeader` accepts 2 **and** 3, treated
  identically; keep the refusal (with the actual version in the error data) for
  everything else. Fixes divergence 1 for ingest.
- **Validate on local pack open**: read the 12-byte header when the pack
  registry first opens a `.pack` and run it through the same guard, mirroring
  git's `open_packed_git_1` check (signature + version 2|3). Fixes
  divergence 2. Cost: one 12-byte read per pack open — negligible against the
  existing idx/fanout work.
- **Keep generating v2** (`serializePackHeader(2, …)` unchanged).
- **Interop pins** (twin git/tsgit, per the faithfulness harness):
  - v3-stamped pack (header flip + trailer re-hash in the test): both tools
    ingest it and read objects through it.
  - v99 pack: both tools refuse, on ingest *and* on local open.

## Decisions left for the ADR

- Whether the local-open validation is eager (registry open) or on first entry
  read — git checks on first `use_pack`/open of the file, before any entry is
  served.
- Error-shape parity for the local-open refusal (git degrades per-pack with an
  `error:` and fails object lookup; tsgit will surface a typed
  `INVALID_PACK_HEADER` — refusal condition matches, transcript wording is
  ours per ADR-249's data-not-rendering split).

## Repro

Scratch artefacts (not committed): build any small pack with git, then

```js
buf.writeUInt32BE(3, 4);                       // version field, offset 4, BE
sha1(buf.subarray(0, len - 20)).copy(buf, len - 20); // re-fix trailer
```

`git index-pack` the result to confirm acceptance; feed the same bytes to
`parsePackHeader` to reproduce the refusal.
