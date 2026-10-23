---
subjects:
  - src/domain/pathspec/compile-pathspec.ts
  - src/domain/pathspec/match-pathspec.ts
  - src/domain/refs/ref-glob.ts
supersedes:
  - adr: "040"
    scope: "compileGlob as the engine pathspec globs compile with"
  - adr: "980"
    scope: "wildcards matching one code unit of the escape view"
---
<!-- cspell:ignore wildmatch multibyte -->
# 1033 — Pathspecs match with git's default wildmatch over the escape view's bytes

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** supersedes ADR-040 (pathspec engine) and ADR-980 (wildcard width); refines ADR-077 (linearity carried)

## Context

`add`, `rm`, `checkout` and `grep` compile a pathspec glob with the gitignore rules: anchored only
when the body holds a `/`, `*` and `?` stopping at `/`, no `[…]`, no `\` escape. git's default
pathspec item is `match_pathspec_item`: the body is first tried verbatim as a path prefix, then
`wildmatch(body, path, 0)` — `*` and `?` cross `/`, `[…]` with `!`/`^`, ranges and the twelve POSIX
classes, `\x` escapes, anchored at both ends, abort cases match nothing. The pin matrix shows the
divergence is a wrong-result class: `foo*` stages `dir/foobar` (D3), `rm 'foo*'` deletes it (R2),
`checkout -- 'foo*'` discards its change (C6), `[a-c].txt` stages nothing (D5a). Rows D11 and L1–L6
pin that `?` and `[…]` consume one **byte**: `?.txt` does not match `é.txt`, and on a lossy index
entry `a?` reaches `a\377` but not `aé`. A matcher over JavaScript string units cannot give those
answers. `src/domain/refs/ref-glob.ts` already ports `wildmatch` over UTF-8 bytes with a linear
dynamic program and is in the browser bundle.

## Options considered

1. **Byte-level wildmatch shared from `ref-glob.ts`** (designer's recommendation) — the flags-0
   engine over `encodeEscaped(path)` (the ADR-980 escape view's exact bytes, lone surrogates kept),
   reached through a bytes-taking export, behind the verbatim-prefix check and two allocation-free
   fast paths whose result equals the dynamic program. Pros: every pinned row, one engine already
   mutation-tested and bundled. Cons: one `Uint8Array` per tested path on the slow path.
2. **A code-unit variant of the same tokenizer and dynamic program** — no encoding, but `?` and
   `[…]` match one UTF-16 unit, so D11/D11b/L1–L3/L5/L6 stay divergent and a second bracket parser
   enters the bundle.
3. **Extend `compileGlob`** with `[…]`, `\` and crossing stars — one glob file, the same
   multibyte divergence as option 2, and bundle growth.

## Decision

**User-ratified — option 1.** A pathspec entry whose body is not empty and does not end in `/`
selects a path when either holds:

1. **verbatim first** — the body equals the path, or the path starts with the body followed by
   `/` (git's `MATCHED_EXACTLY` / `MATCHED_RECURSIVELY`);
2. **wildcard** — the body holds a glob-special byte (ADR-1034) and `wildmatch(body, bytes, 0)`
   accepts the path's escape-view bytes from `encodeEscaped`, never `TextEncoder`.

The wildcard engine is the one `ref-glob.ts` already holds, exposed as a bytes-taking compile;
no second dynamic program is written. A fast path (the literal-prefix prefilter, the one-star
`<prefix>*<suffix>` compare) is admissible only while its result equals the dynamic program on
every input, which the property suite proves. The `PathspecEntry` shape (`pattern`, `body`,
`negated`, `isLiteral`, `compiled.test`) is unchanged, so the public `Pathspec` type is unchanged.
Gitignore, gitattributes and sparse rules keep their dialect.

Superseded from ADR-040: `compileGlob` as the engine a pathspec glob compiles with, and the
"single source of truth for glob compilation" across pathspecs and gitignore — the two are
different git dialects (`wildmatch` flags 0 against `WM_PATHNAME`) and now have one engine each.

Carried forward from ADR-040: one shared compiler for the gitignore-family dialect — `parseGitignore`,
`parseGitattributes` and the non-cone sparse rules keep importing `compileGlob` from
`src/domain/pathspec/compile-glob.ts`, and its mutation coverage keeps protecting all three.

Superseded from ADR-980: the width of a wildcard on the escape view — `?` and `[…]` matched one
code unit, and the consequence that left "valid multibyte `?`" as a separate, pre-existing gap.
They now match one byte, as git's do.

Carried forward from ADR-980: the surrogate-escape view itself as the data every pathspec matches
against (`matchesIndexPath` via `escapedPathOf`), internal only; the public `path` stays the
U+FFFD view; literals, `*`, `**` and directory prefixes keep giving git's answers at zero cost for
UTF-8 entries.

## Consequences

- `foo*` no longer reaches `dir/foobar` in any of the four commands; `[…]` and `\x` work; `?`
  stops matching a multibyte character.
- Every pinned row becomes a cross-tool interop test; the lossy worktree rows run on the Linux
  CI leg only (APFS refuses invalid UTF-8 names).
- The matcher stays linear (ADR-077); the per-path encoding is bounded by the one-star and prefix
  fast paths on the common shapes, measured by `bench:ab` on the `add` bench.
- `compileGlob`'s non-gitignore mode loses its last caller (ADR-1041).
