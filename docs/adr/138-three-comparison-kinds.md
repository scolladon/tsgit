# ADR-138: Interop comparison has three kinds

## Status

Accepted (at `69fb435`)

## Context

The naïve framing of "interop" is binary: tsgit's output either
matches canonical `git`'s output or it doesn't. In practice, Git's
formats split into three regimes:

1. **Fully specified**: object encodings (blob/tree/commit/tag),
   loose ref files, packed-refs, the symbolic-ref `ref: …` line,
   the index DIRC format, the reflog line grammar, the
   sparse-checkout file, the shallow file. For these, two
   conforming implementations writing the same logical content
   produce bit-identical bytes.
2. **Implementation-defined choices**: the packfile. Delta base
   selection is a heuristic with no spec; deflate compression
   level is implementation-defined. Two conforming Git
   implementations can produce bit-different packfiles for the
   same input. The only contract is that any conforming reader
   accepts the file.
3. **Wider input grammar than output**: git-config text. Git
   accepts wide whitespace variation, inline comments, and
   ordering flexibility; its own writer produces a canonical form
   that is one valid serialisation among many. Comparing bytes
   would either flag both tsgit and `git config --add` as
   "wrong" on minor differences, or require us to replicate `git`'s
   exact whitespace rules in tsgit. Neither is the contract we
   actually care about.

A single comparison strategy for all three regimes either
over-constrains the loose ones (false failures) or under-constrains
the strict ones (passes that shouldn't).

## Decision

The `@writes` tag declares one of three `kind` values, and the
interop test's comparison code enforces the matching contract:

- **`byte-identical`** — write with tsgit, write equivalent state
  with canonical `git` in a peer tmpdir, diff the files. Any byte
  difference fails the test.
- **`equivalent-under-readback`** — write with tsgit; run `git fsck
  --strict` (must accept); enumerate objects via `git cat-file
  --batch-all-objects`; compare to a peer tmpdir packed by
  canonical `git`. Object set + per-object content must match;
  packfile bytes are not compared.
- **`readback-only`** — write with tsgit; read via canonical
  `git`'s reader (`git config --list`, etc.); compare the parsed
  semantic content. File bytes are not compared.

Each surface gets exactly one kind. If a surface's kind needs to
tighten later (e.g. config promoted to byte-identical to lock
section ordering), redeclare the kind and tighten the test.

## Consequences

### Positive

- Each interop test makes its contract explicit at the surface
  level: a reviewer reading the `@writes kind: byte-identical`
  knows what failure the test will catch.
- `equivalent-under-readback` doesn't degrade the strict surfaces.
  A pack-writer bug that ships bit-incorrect delta selection
  isn't caught by byte equality (no such promise), but is caught
  by `git fsck` (reject) or by the object-set / content
  comparison (drift). The strict surfaces still demand the bytes.
- `readback-only` doesn't require a sweeping decision about
  whether config interop is "real" — it acknowledges Git's own
  writer is non-canonical and lets the test prove the only
  property we can.

### Negative

- Three kinds is more conceptual surface than one. Mitigated by
  the `@writes kind:` declaration being one line, and the audit
  validating the enum value.
- A surface that genuinely needs two kinds (e.g. an encoding
  that is byte-identical for v2 but equivalent-under-readback for
  v3) forces a writer split. We don't have any such surface today
  and would handle it via two `@writes`-tagged files if it arose.

### Neutral

- The three kinds are not mutually compatible: a single surface
  can't be both `byte-identical` and `readback-only`. The
  promotion path is one-directional: looser kinds can tighten;
  tighter kinds can loosen only by explicit ADR.
- A fourth kind (e.g. "byte-identical modulo specific fields")
  may emerge later (index stat-cache excluded fields are already
  a borderline case). Today we handle exclusions inside the
  byte-identical comparison; if the exclusion list grows, a
  fourth kind is the natural extension.
