---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
  - src/domain/objects/tree-cursor.ts
---
# 723 — Cursor descent keeps the duplicate-name refusal

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-11) · **Supersedes/Refines:** none

## Context

Rewriting the blame/path-descent onto the raw `TreeCursor` (no decode, no hex) would
silently drop `parseTreeContent`'s duplicate-entry-name refusal, today observable from
`blame`, `read-file-at` and `rev-parse <tree-ish>:<path>`. Whether git itself refuses
duplicate names outside `fsck`/`mktree` is unpinned — no probe was run.

## Options considered

1. **Re-implement the duplicate check in the cursor descent** (recommended, chosen) — pros: behaviour byte-identical; the saving comes from not decoding/hexing, not from dropping the check.
2. **Accept the divergence with an ADR** — cons: rests on an unpinned belief about git; the prime directive forbids silently dropping an observable refusal.
3. **Cursor for intermediate levels only** — cons: keeps the check where trees are narrowest and drops it where they are widest.

## Decision

**Adopted-as-recommended (no user judgment).** The cursor-based descent carries a
per-directory duplicate-name `Set` (names on the descended path only), preserving the
refusal and its error data byte-identically. Mode validation stays eager per visited
entry on the descended directory. If a future probe pins git's actual duplicate-name
behaviour on read surfaces, option 2 may be revisited with that pin.

## Consequences

The descent's win is allocation/decoding elimination only; refusal parity needs no
interop re-pin. A property test over the tree grammar (`resolve-tree-path`) accompanies
the rewrite.

### Addendum (2026-08-28): the invalid-entry-name shape check, and the mode-refusal shape

A follow-up review found the cursor descent was *also* missing `parseTreeContent`'s
name-**shape** refusal (`name === '.' || '..' || name.includes('/')`) — distinct from
the duplicate-name check this ADR covers. Fixed the same way: re-implemented per
consumer (`resolve-tree-path.ts`'s `scanEntry`, inherited by `blame.ts` once it moved
onto the shared descent), **not** inside `TreeCursor` itself — `raw-tree-diff.ts`'s
merge-join deliberately carries neither this check nor the duplicate-name one (its own
header comment: "no sort, no duplicate-name/order/name-shape validation", matching
git's own `diff-tree`, which does not validate name shape during a diff walk either).
Putting the shape check in the cursor's own unconditional scan would have forced it
onto that consumer too, refusing trees `diff-tree` diffs cleanly — pinned by
`test/integration/tree-diff-corrupt-interop.test.ts`'s embedded-`/`-name row, which
regressed against real git when this was tried.

A second, adjacent finding — that the cursor's `scanMode` throws `INVALID_TREE_ENTRY
'malformed mode'` for a non-octal-byte mode where `parseTreeContent` reaches
`normalizeFileMode` and throws `INVALID_FILE_MODE` with the full mode string, and in a
different check order — was investigated and **ruled out** as a fix target. Two
`mktemp`-sandboxed probes against git 2.55.0 (`git hash-object -w -t tree --stdin` over
hand-built entries):

- a non-octal mode byte (`10064a good`) → git itself refuses with the **literal text**
  `error: malformed mode in tree entry` before it ever reaches fsck's structural pass —
  the cursor's distinct "malformed mode" class matches git's own two-tier structure.
- an octal-but-unrecognised mode (`777777 good`) → git refuses only at the fsck layer,
  `error: object fails fsck: badFilemode: contains bad file modes` — a **different**
  message, confirming git treats "malformed" (unparseable) and "bad" (parseable but
  unrecognised) as genuinely distinct classes, matching the cursor's `scanMode` /
  `matchFileModeBytes` split, not `parseTreeContent`'s single `normalizeFileMode` check.

Changing `scanMode` to match `parseTreeContent` instead would also have been a real
regression: `raw-tree-diff.ts`'s `classifySamePathCursor` skips materialising a mode at
all when `cursorsSame` finds two sides byte-identical, relying entirely on the cursor's
own unconditional scan to catch a malformed mode on an otherwise-unchanged entry —
losing that eager, unconditional check would silently admit such a tree through an
unchanged-entry diff. `test/integration/tree-diff-corrupt-interop.test.ts`'s
`non-octal mode digit` / `leading space (empty mode)` rows already pin today's
`'malformed mode'` shape against real git (exit 128) and were left unchanged.
**Decision: no code change; `parseTreeContent` is the outlier here, not the cursor —
any unification is future work scoped to `tree.ts`, not this descent.**
