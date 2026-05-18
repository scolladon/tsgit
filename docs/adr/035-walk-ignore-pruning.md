# ADR-035: `walkWorkingTree` accepts an async ignore predicate that prunes whole subtrees

## Status

Accepted (at `8cd131f`)

## Context

The §14.1 ignore stub returned `false` for everything. §14.3 makes
the predicate consult a real ruleset. There are two integration
choices:

1. **Leaf-only filter:** the walker yields every leaf, the caller
   discards ignored ones. `walkWorkingTree`'s signature stays
   identical; ignore lives in `addAll` / `status`.
2. **Walk-time pruning:** the walker accepts the predicate, applies
   it to directories BEFORE descent, and to leaves BEFORE yielding.
   Ignored subtrees are never entered → no `lstat` cost on
   `node_modules`, `dist`, etc.

Option 1 is simpler but pays the lstat tax on every leaf inside an
ignored subtree. A typical Node repo has tens of thousands of files
under `node_modules` — option 1 would do tens of thousands of lstats
just to discard them. Option 2 prunes at the directory boundary.

Predicate shape: the matcher stack grows during descent (nested
`.gitignore` files are loaded lazily), so the predicate must be
allowed to do I/O. We accept `boolean | Promise<boolean>` so synchronous
callers (the §14.1 stub, tests) don't pay a microtask overhead.

## Decision

`WalkWorkingTreeOptions` gains an optional
`ignore?: (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>`.
The walker calls it on directories (PRUNE on `true`) and on leaves
(DROP on `true`). Awaited via `await`, which is a no-op for sync
returns under V8 since Promise.resolve(boolean) short-circuits. The
§14.1 callers pass no `ignore` option — behaviour unchanged.

A `defaultIgnorePredicate = () => false` remains exported for tests
that want the §14.1 baseline. Application-layer factories
(`buildRepoIgnorePredicate`) own the matcher stack and lazy nested
loading.

## Consequences

### Positive

- O(non-ignored-files) lstats instead of O(working-tree-files). Large
  perf win on real repos.
- The walker stays oblivious to ignore semantics — it knows only
  "predicate said skip". `domain/ignore/` owns the rules; the walker
  just calls the predicate.
- §14.1 invocations are bit-identical (no behaviour change without
  the new option).

### Negative

- The walker is now (potentially) async at every iteration step.
  Sync callers pay a `await Promise.resolve(...)` microtask per call.
  Measured cost is negligible (<1µs/call); negligible compared to
  per-leaf lstat.
- Mutation testing surface grows slightly (more `await`s on the hot
  path).

### Neutral

- The §14.1 internal test seam (custom predicate injection into
  `addAll`) still works — the predicate type widens to accept
  `Promise<boolean>` but a sync function still satisfies it.
