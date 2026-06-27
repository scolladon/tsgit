# `tarArchive` / `zipArchive`

Pure serializer functions that consume an `ArchiveResult` (from [`repo.archive`](../commands/archive.md)) and yield an `AsyncIterable<Uint8Array>` byte stream in tar or zip format. They are the swap point the design calls out: a consumer can replace them with any container framer without touching the data surface.

Both are exported directly from the package:

```ts
import { tarArchive, zipArchive } from '@scolladon/tsgit';
```

---

## `tarArchive`

```ts
function tarArchive(
  result: ArchiveResult,
  opts?: TarOptions,
): AsyncIterable<Uint8Array>;

interface TarOptions {
  readonly prefix?: string;   // Prepended to every entry path; synthesises a top-level `<prefix>` dir entry. Default: `''`.
  readonly mtime?: number;    // Epoch seconds stamped in every header. Default: `result.commitTime ?? 0`.
  readonly umask?: number;    // Mode mask applied to regular, exec, dir, and gitlink entries (NOT symlinks). Default: `0o0002`.
  readonly uname?: string;    // User name field. Default: `'root'`.
  readonly gname?: string;    // Group name field. Default: `'root'`.
}
```

Zero runtime dependencies. Produces ustar bytes byte-equal to `git archive --format=tar` when defaults are used against a commit-ish. For a bare-tree treeish (`result.commitTime` is `undefined`) supply `opts.mtime` explicitly to get a deterministic archive.

### Mode mapping (table M)

Tar applies `tar.umask` to a base mode derived from the raw git mode. The raw mode in the entry stream is **not** the tar mode.

| raw git mode | base | tar mode at default umask `0o0002` |
|---|---|---|
| `100644` regular | `0o0666` | `0o0664` |
| `100755` exec | `0o0777` | `0o0775` |
| `40000` directory | `0o0777` | `0o0775` |
| `160000` gitlink | `0o0777` | `0o0775` |
| `120000` symlink | `0o0777` | `0o0777` (umask not applied) |

### Commit metadata in the tar stream

When `result.commit` is defined the serializer emits a pax global header block carrying `52 comment=<40-hex-commit-oid>\n` as the first block. A bare-tree result has no pax global header.

### Path length limits (thrown, not silent)

- A path whose UTF-8 encoding exceeds 256 bytes throws — pax `x` extended headers are out of scope for v1.
- A path in the 101–256-byte range that cannot be split at a `/` into a non-empty name component of at most 100 bytes throws.
- A symlink target longer than 100 bytes throws (the `linkname` ustar field is 100 bytes).

### Usage

```ts
import { openRepository, tarArchive } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });
const result = await repo.archive({ treeish: 'HEAD' });

for await (const chunk of tarArchive(result)) {
  // write chunk to a file, pipe to gzip, etc.
  process.stdout.write(chunk);
}

// With options — prefix, custom mtime, custom umask
for await (const chunk of tarArchive(result, { prefix: 'project/', umask: 0o0022 })) {
  process.stdout.write(chunk);
}
```

---

## `zipArchive`

```ts
function zipArchive(
  result: ArchiveResult,
  deps: ZipDeps,
  opts?: ZipOptions,
): AsyncIterable<Uint8Array>;

interface ZipDeps {
  /**
   * Raw DEFLATE (RFC 1951) — no zlib header, no adler32 trailer.
   * Wire in `ctx.compressor.deflateRaw` for the active adapter.
   * The framer trusts the contract without verification; an invalid
   * implementation silently corrupts the zip.
   */
  readonly deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array>;
}

interface ZipOptions {
  readonly prefix?: string;          // Prepended to every entry path; synthesises a top-level `<prefix>` dir entry. Default: `''`.
  readonly mtime?: number;           // Epoch seconds stamped in every entry. Default: `result.commitTime ?? 0`.
  readonly tzOffsetMinutes?: number; // UTC offset in minutes for the DOS date/time fields. Default: `0` (UTC).
  readonly level?: number;           // Deflate compression level passed to `deflateRaw`. Default: adapter default.
}
```

Pure over an injected `deflateRaw` callback, reusing the in-tree `crc32`. For a bare-tree treeish supply `opts.mtime` explicitly.

### Wiring `deflateRaw`

The library exposes `deflateRaw` through `ctx.compressor`:

```ts
import { openRepository, zipArchive } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });
// ctx is accessible via repo internals — or pass it from your own platform context
const result = await repo.archive({ treeish: 'HEAD' });

// Wire the node adapter's deflateRaw:
for await (const chunk of zipArchive(result, { deflateRaw: ctx.compressor.deflateRaw })) {
  process.stdout.write(chunk);
}
```

### Byte-identity contract

- **Method-0 (stored) entries and all framing** — local and central headers, CRC-32, the uncompressed size, the `UT` extra field, external/internal attributes, the EOCD and its comment — are **byte-identical to `git archive --format=zip` on every adapter**, because none of it passes through DEFLATE.
- **Method-8 (deflate) entries are faithful by round-trip, not byte-identity**: the payload is valid raw DEFLATE that inflates to git's exact content; its compressed bytes match git's only incidentally (git's own zip is not stable across zlib/git versions). Do not rely on method-8 byte equality.
- git symlinks are always stored (method 0); only regular blobs (`100644`/`100755`) are candidates for deflation.

The store-vs-deflate decision mirrors git: a regular blob is deflated (method 8) only when the compressed result is strictly smaller than the raw content.

### DOS date/time note

git derives the DOS mod-time/date fields via `localtime`, making them machine-TZ-dependent. Pass `tzOffsetMinutes` to reproduce git's bytes at a known offset. The `UT` extra-field timestamp (`0x5455`) is always raw epoch and TZ-independent.

### Commit oid in the EOCD comment

The EOCD comment is the 40-hex peeled commit oid when `result.commit` is defined, empty for a bare-tree result — mirroring the tar pax global header.

### Usage

```ts
import { openRepository, zipArchive } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });
const result = await repo.archive({ treeish: 'v1.2.0' });

const chunks: Uint8Array[] = [];
for await (const chunk of zipArchive(result, { deflateRaw: ctx.compressor.deflateRaw }, { tzOffsetMinutes: 0 })) {
  chunks.push(chunk);
}
```

---

## See also

- Command: [`archive`](../commands/archive.md)
- Errors: [`../errors.md`](../errors.md)
- Design: `docs/design/archive.md`
