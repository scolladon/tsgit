---
subjects:
  - src/domain/objects/file-mode.ts
---
# 766 — Mode matching canonicalises leading zeros

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** completes ADR-754's mode tier

## Context

The design doc recorded, under a heading reading *"Not a divergence, do not 'fix' it"*, that
git's read path and tsgit both accept a zero-padded mode. Review measured the tsgit half
false, and a follow-up probe measured how far git's tolerance actually goes.

git 2.55.0, `git ls-tree` over hand-built trees, every one accepted and canonicalised:

| stored mode | git renders |
|---|---|
| `100644`, `0100644`, `00100644` | `100644` |
| `40000`, `040000`, `0040000`, `000040000` | `040000` |

tsgit matches a fixed set: the five-byte directory mode, and six six-byte literals which
happen to include `040000`. So `040000` agrees by coincidence, and `0100644`, `0040000` and
any longer padding are refused with `INVALID_FILE_MODE` where git reads them fine. That is
not the recorded "octal-but-unrecognised" divergence — these modes are recognised; only
their padding is unusual.

`fsck` was already brought into line here: it strips all leading zeros before its lookup and
reports `zeroPaddedFilemode` exactly as git does. The object-parse path was left behind, so
the two disagree with each other as well as with git.

## Options considered

1. **Canonicalise leading zeros before matching** — pros: matches git's own `canon_mode`, and makes the parse path agree with the `fsck` path / cons: a refusal-set change; a mode that refused now resolves.
2. **Record the divergence and correct the doc** — pros: no behaviour change this late / cons: leaves `fsck` and the parse path disagreeing about the same bytes, and keeps a refusal git does not have.
3. **Refuse zero-padded modes everywhere, including fsck** — cons: git reads them; refusing would be strictly less faithful and would undo work already landed.

## Decision

**Option 1, on the standing rule that the git-faithful fix wins.** Byte-level mode matching
strips leading zeros before comparing, so any zero-padded spelling of a recognised mode
resolves to that mode, for arbitrary padding width. At least one digit always remains.

`fsck` continues to *report* `zeroPaddedFilemode` — git reads these modes and still flags
them, and those two facts are not in tension.

## Consequences

### Positive

- The parse path, the cursor path and `fsck` now agree with each other and with git about the same bytes.
- The design doc's claim of agreement becomes true rather than being deleted.

### Negative

- A refusal disappears: a zero-padded recognised mode now parses. It is git's behaviour, pinned against `ls-tree` in the interop suite rather than asserted.
