---
subjects:
  - src/domain/pretty
---
# 934 — `export-subst` transcodes through WHATWG decoders, falling back as git's failed iconv

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-21, G19) · **Supersedes/Refines:** refines ADR-933, ADR-226

## Context

When a commit carries a non-UTF-8 `encoding` header and an `export-subst` occurrence uses a
header-parsing placeholder, git transcodes the whole accumulated output with `iconv` (pins
S16–S16d). tsgit has no dependency and only the platform's decode-only `TextDecoder`.

## Options considered

1. **WHATWG-backed: decode with `TextDecoder(label, { fatal: true })`, encoders derived from the decoder and memoised per label; anything outside behaves as git's failed `iconv` (buffer unconverted)** (recommended).
2. **Byte-transparent** — cons: known-wrong bytes on S16c/S16d shapes.
3. **Refuse expansion** — cons: a refusal git does not have.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Matches git on every label both stacks
know; for labels WHATWG lacks, and forms outside the derived encoders (`gb18030` four-byte,
EUC-JP three-byte), the output equals git's own result when `iconv` fails — the residual
divergence, recorded here.

## Consequences

- The encoder table is built once per label, only when such a commit is archived.
- `UTF-16`, whose label names no byte order, is written big-endian behind a BOM: libiconv's
  output (git on macOS) and the form git writes itself when built with `ICONV_OMITS_BOM`
  (`utf8.c`, `reencode_string_len`). git otherwise defers to the platform iconv, and glibc's
  writes the BOM and code units in host order (`iconvdata/utf-16.c`), little-endian on
  x86_64 — so on glibc hosts tsgit's bytes differ from that host's git. The interop test pins
  each side per platform.
