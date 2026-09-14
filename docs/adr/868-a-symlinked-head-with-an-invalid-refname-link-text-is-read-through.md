---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal/repo-state.ts
  - src/adapters/memory/memory-file-system.ts
---
# 868 — A symlinked `HEAD` whose link text is not a valid refname is read through

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (F) · **Supersedes/Refines:** refines ADR-855

## Context

ADR-855 made the ref store the sole reader of `HEAD` and resolves a symlinked `HEAD` as symbolic.
Its symlink arm validates the link text as a refname and throws otherwise, so a link whose text is
`refs/`-prefixed but not a valid refname — `refs/heads/a..b` pointing at a file that holds an
object id — makes `resolveRef('HEAD')` and `status` refuse `INVALID_REF` (`ref name must not
contain ..`).

git's `read_ref_internal` (`refs/files-backend.c:516-570`) reads the link text and treats it as a
symref only when it starts with `refs/` **and** passes `check_refname_format`; any other text falls
through to an ordinary open of the path, which follows the link: `ENOENT` is a missing ref, and a
directory target fails the read. Discovery (`validate_headref`, `setup.c`) checks only the `refs/`
prefix, which tsgit's gate already matches. Pinned against git 2.55.0 (design matrix F1–F8, `side`
distinct from `main`):

- a link text that is not a valid refname, pointing at a file with an object id (F2, F4 `..` path,
  F5 `.lock`, F8 a space): `HEAD` resolves to that id and is detached; `commit` replaces the link
  with a regular `HEAD` file;
- the same link text pointing at a file holding `ref: refs/heads/side` (F3): `HEAD` is symbolic to
  `side`, and `commit` advances `side` and keeps the link;
- a target that is absent (F1) or a directory (F6): `rev-parse HEAD` fails; `status` reports a
  detached `(initial)` head; `commit` writes a detached `HEAD` file in F1 and refuses in F6;
- a valid link text whose branch does not exist (F7): symbolic, as tsgit already answers.

## Options considered

No decision candidate was tabled for this item; the design recorded one change and the
alternatives below were weighed in it.

1. **Read through, as `read_ref_internal` does** (chosen) — pros: F2–F5, F7 and F8 match git on
   `rev-parse`, `symbolic-ref`, the `status` branch and `commit`; no new state. Cons: F1 and F6
   still differ (below).
2. **Keep refusing `INVALID_REF`** — cons: refuses repositories git reads, on every row but F7.
3. **Read through and model a detached, unborn `HEAD`** so F1 and F6 also match — pros: closes the
   last rows. Cons: a new `HeadState` arm across every `readHeadRaw` consumer, for a state only a
   hand-planted symlink produces.

## Decision

**Option 1, adopted as designed.** In the symlink arm, a link text — separators normalised to `/`
— that starts with `refs/` and is a safe refname resolves symbolic, unchanged. Any other link text
is read through: the file the link points to is read fresh on every call and is never held in the
HEAD slot, because the slot's identity is the link's own `lstat`, which a rewrite of the target
does not change. A directory target or an absent target resolves `missing`; the content goes through
the loose-ref parse, so an object id resolves direct, `ref: …` resolves symbolic, and malformed
content refuses as that parse does (`INVALID_REF`, or `INVALID_OBJECT_ID` for content that is
neither an id nor `ref: …`). Other I/O failures propagate.

The HEAD slot and the gate are unchanged. The rule applies to primitive-only sessions too. HEAD
writes are unchanged: when the read-through reports direct, `commit` writes `HEAD` itself and the
lock-and-rename replaces the link with a regular file, as git's does; when it reports symbolic, the
branch advances and the link stays.

**The memory adapter follows symlinks on read** (decided with the user after the design,
2026-09-14). The read-through goes through `ctx.fs.stat` and `ctx.fs.readUtf8`. The Node adapter
follows a symlink leaf on both, resolving a relative link text against the link's own directory, as
POSIX does. The memory adapter did neither: its content reads never followed a link, and its `stat`
resolved a relative link text against the adapter root. Rather than exercising the read-through
through a test double, `MemoryFileSystem`'s reads (`read`, `readSlice`, `readUtf8`, `stat`,
`exists`, `readdir`) now follow a symlink leaf with the existing 40-hop loop limit, a relative link
text resolved against the link's directory, and its structural containment still refusing a target
outside its root. Its write surfaces keep their no-follow refusals, and `lstat`, `readlink`, `rm`,
`rename` and `openWithNoFollow` still act on the link itself. The read-through therefore behaves the
same on Node and on the memory adapter, and the `FileSystem` contract suite, which runs against both,
pins each followed read. The browser adapter is unaffected: OPFS has no symbolic links, and its
`symlink` and `readlink` refuse `UNSUPPORTED_OPERATION`.

## Consequences

`resolveRef('HEAD')`, `status` and `commit` stop refusing a symlinked `HEAD` git accepts, and match
git on F2–F5, F7 and F8. The head-symlink interop test gains those rows.

A memory-adapter caller now reads a symlink's target where it used to get `FILE_NOT_FOUND`, and
`exists` on a dangling link returns `false` where it returned `true` — the Node adapter's answers.

Residuals, recorded:

- **F1 and F6.** The read-through yields `missing`, and `readHeadRaw` turns a missing `HEAD` into
  `REF_NOT_FOUND`, so tsgit's `status` and `commit` refuse where git reports a detached `(initial)`
  head and, in F1, `commit` writes a detached `HEAD` file (F6's commit refuses in git too).
  `resolveRef('HEAD')` matches git: both fail. Reaching git's answer is option 3, not done.
- **Bidi code points.** tsgit's refname grammar refuses U+202A–U+202E and U+2066–U+2069, which
  `check_refname_format` accepts, so a link text carrying one is read through in tsgit and is a
  symref in git. The same difference applies to every ref name and is not changed here.

This refines ADR-855's "the sole reader resolves a symlinked `HEAD` as symbolic": that holds for a
`refs/`-prefixed valid refname only.
