# Phase 13.7 — Defensive path validation at the index parser

## 1. Goal

Hoist the path-segment safety check from
`synthesizeTreeFromIndex` (Phase 13.6's defensive layer) into
`parseIndex` itself, so every downstream consumer (`materializeTree`,
`checkout`, `reset`, `synthesizeTreeFromIndex`, etc.) inherits the
guarantee. The branded `FilePath` type then carries its invariant:
every `FilePath` value passed through `parseIndex` is free of `..`,
`.`, empty segments, and leading `/`.

BACKLOG §13.7 acceptance:

> `parseIndex` (in `src/domain/git-index/index-parser.ts`) throws
> `INVALID_INDEX_ENTRY` for any entry whose path contains `..`,
> `.`, empty segments, or starts with `/`. Remove `assertSafePath`
> from `synthesize-tree-from-index.ts` once the parser is
> authoritative.

## 2. Surface

No public change. `parseIndex(bytes)` keeps its signature; an
adversarial input that previously slipped through now throws.

## 3. Behaviour

### 3.1 Validation rules

A path is rejected if ANY of these hold:

- Starts with `/` (absolute path).
- Contains a segment equal to `''` (empty — e.g., `foo//bar`).
- Contains a segment equal to `.` (current-directory marker).
- Contains a segment equal to `..` (parent-directory traversal).
- Contains a NUL byte. (Already enforced by parser's NUL-terminator
  scan, but re-asserted at validation time as belt-and-suspenders.)

These match what `assertSafePath` already enforces in
`src/application/primitives/synthesize-tree-from-index.ts`.

### 3.2 Where validation runs

Inside `parseIndex`, just before the `FilePathFactory.from(path)`
call (line 91). The check has access to `entryStart` (the offset
of the failing entry's header), so the thrown
`invalidIndexEntry(entryStart, reason)` carries a precise offset.

### 3.3 Error shape

Use the existing `invalidIndexEntry(offset, reason)` factory. Error
code is `INVALID_INDEX_ENTRY`; the `reason` string identifies the
specific violation:

- `unsafe path '<path>': absolute paths rejected`
- `unsafe path '<path>': empty segment rejected`
- `unsafe path '<path>': '.' segment rejected`
- `unsafe path '<path>': '..' segment rejected`

Matches the existing error vocabulary the parser uses.

### 3.4 Cleanup in synthesise primitive

Once the parser is authoritative, `assertSafePath` in
`src/application/primitives/synthesize-tree-from-index.ts` becomes
redundant. Two options:

- **Keep as defensive layer** — preserves robustness if someone
  constructs an `IndexEntry` outside the parser (e.g., test fixture).
- **Remove** — matches BACKLOG §13.7's "Remove the duplicate
  defensive check" and avoids double-validation cost.

**Decision**: remove. Per CLAUDE.md "trust internal code and
framework guarantees" — the branded `FilePath` type carries the
invariant after this PR. Test fixtures that need to inject unsafe
paths can do so via `as FilePath` (escape hatch), but the
production path through `parseIndex` is the only realistic
consumer of `synthesizeTreeFromIndex`.

The `MAX_TREE_DEPTH` check (capping depth at the segment count)
STAYS in the synthesis primitive — that's a different invariant
(recursion-depth bound, not path-safety) and the parser doesn't
naturally enforce it.

## 4. Module layout

```
src/domain/git-index/
├── index-parser.ts                     # extended: validate path before FilePath.from
└── path-validator.ts                    # NEW — exports validateIndexPath
src/application/primitives/
└── synthesize-tree-from-index.ts       # remove assertSafePath; keep depth cap
test/unit/domain/git-index/
└── index-parser.test.ts                 # extended: unsafe-path cases
test/unit/application/primitives/
└── synthesize-tree-from-index.test.ts  # the `..` and leading-slash tests
                                         # move to parser-level; the synthesis
                                         # tests no longer need them
```

### 4.1 Why a separate `path-validator.ts`?

Two reasons:

- Reuse: `synthesizeTreeFromIndex`'s defensive layer could call it
  if we ever decide to keep dual validation.
- Testability: a pure helper is easier to unit-test in isolation
  than a closure inside the parser loop.

## 5. Testing strategy

### 5.1 Unit — `index-parser.test.ts` extension

For each unsafe pattern, hand-craft an index byte sequence with
exactly one entry containing the bad path, then `parseIndex(bytes)`
and assert it throws `INVALID_INDEX_ENTRY`. Cases:

- `..` segment (`foo/../bar`)
- `.` segment (`foo/./bar`)
- Empty segment (`foo//bar`)
- Leading slash (`/etc/passwd`)
- A single `..` (just the parent ref)
- A single `.` (just the current-dir ref)

Each test exercises a different rejection branch.

### 5.2 Unit — `synthesize-tree-from-index.test.ts` cleanup

Remove the `..`-rejection and leading-slash-rejection tests added
in Phase 13.6 — the parser is now authoritative. Or convert them
to assertions on the parser's behaviour. The MAX_TREE_DEPTH test
stays.

### 5.3 Mutation

Stryker on `src/domain/git-index/path-validator.ts` and the
relevant lines of `index-parser.ts`. Target: 0 new survivors.

## 6. Out of scope

- Validation in `FilePath.from` directly. The branded-type factory
  could carry the invariant globally, but tightening it touches
  every caller in the codebase (some tests construct FilePaths
  via the factory with simple names that are safe). Phase 13.7's
  scope is the index-parser entry point; future hardening can
  extend the factory if needed.
- Normalisation. We reject unsafe paths; we don't canonicalise
  them (e.g., collapse `foo/./bar` to `foo/bar`). Normalisation
  would mask the bug rather than expose it.

## 7. Open questions

- **Q1: Should the validator also reject Windows reserved names**
  (CON, AUX, NUL device names) or Unicode normalisation tricks?
  No — out of scope. Phase 14.4 (full Windows support) will add
  platform-specific rejections at the filesystem boundary, not
  at parse time.
- **Q2: What about paths that are technically safe but unusual,
  like `:invalid` or names with non-printable bytes?** Out of
  scope — git itself accepts these, and changing parser semantics
  beyond the §3.1 rules risks rejecting valid repos.

## 8. Self-review log

### Pass 1 → Pass 2

- Originally proposed extending `FilePath.from` to validate.
  Rejected at design time (§6): broader blast radius, every
  FilePath caller becomes a potential break point.
- Added §3.4 explicitly stating the "remove vs keep" decision for
  the synthesis primitive. Reviewers will ask; explicit answer
  saves a review round.

### Pass 2 → Pass 3

- §4.1 added — pass-3 reviewers tend to question why a one-purpose
  file exists. Document the reuse-and-testability rationale once.
- §5.2 added — without it, the existing `..`-rejection tests in
  `synthesize-tree-from-index.test.ts` would still pass (because
  the parser now rejects), but they'd be testing parser behaviour
  via a primitive call. Confusing for future readers. Remove
  them so the test-of-record for each invariant lives in the
  right file.
