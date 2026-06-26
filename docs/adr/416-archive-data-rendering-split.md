# 416 — archive: command emits data, serializers take caller rendering inputs

- **Status:** accepted
- **Date:** 2026-06-26
- **Design:** docs/design/archive.md · **Refines:** ADR-249 (structured data only)
- **Decision class:** D-SURFACE adopted-as-recommended (no user judgment)

## Context

tar/zip framing intrinsically needs a path prefix, an mtime, the commit-oid header, and
umask-masked mode bits. ADR-249 holds that prefix, compression level, and mtime
formatting are **caller (rendering) concerns** that must not sit on the data surface.
Where does the line between the command's *data* and the serializer's *rendering inputs*
fall?

## Options considered

1. **Command returns commit oid/time as data + raw git modes; serializers take
   caller-supplied `prefix` / `mtime` / `umask` / `level` (defaulting to git's values)**
   *(designer recommendation)* — pros: the direct application of ADR-249 and the
   `describe` precedent — the library ships oids/timestamps/entries (data), the consumer
   owns prefix/mtime/umask/level (rendering); cons: the caller must pass git's defaults to
   reproduce `git archive` byte-for-byte.
2. **Bake `prefix` / `mtime` / `umask` into command options / entries** — pros: one call
   reproduces git; cons: puts cosmetics on the data surface — an ADR-249 violation.
3. **Command computes nothing; caller supplies everything, including commit metadata** —
   pros: minimal command; cons: drops the faithful commit metadata the library *can*
   compute and the consumer cannot cheaply recover.

## Decision

**Option 1 — adopted as the design recommended.** It is the direct application of ADR-249,
carrying no user-judgment trade-off.

- `ArchiveEntry.mode` is the **raw git mode** (`100644` / `100755` / `120000` / `40000` /
  `160000`). Each serializer applies its own pinned mapping — tar masks with `tar.umask`
  (default `0o0002`), zip splits DOS / unix external attributes — so the raw mode is the
  one faithful datum both consume.
- The command returns `commit` / `commitTime` as **data**. The serializers take
  caller-supplied rendering inputs — `prefix` (default `''`), `mtime` (default
  `commitTime`), `umask` (default `0o0002`), `uname` / `gname` (default `root`),
  compression `level` — so git byte-parity is reproducible without the data surface
  carrying a single cosmetic option.

## Consequences

- `ArchiveOptions` carries only `treeish` — no prefix/mtime/umask/level on the command.
- The serializers own all rendering defaults; the interop test passes git's defaults and
  asserts byte-equality.
- Option 2 is foreclosed: a render-time projection is never encoded in the data shape.
