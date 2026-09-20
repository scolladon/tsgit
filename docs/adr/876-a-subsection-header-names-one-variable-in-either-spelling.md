---
subjects:
  - src/domain/config/config-ini.ts
  - src/application/primitives/update-config-sections.ts
  - src/application/primitives/config-read.ts
---
# 876 — A subsection header names one variable in either spelling

- **Status:** accepted
- **Date:** 2026-09-18
- **Design:** docs/design/char-wise-config-parser-parity.md (Addendum — subsection header spellings) · **Supersedes/Refines:** refines ADR-322/324/326 (section identity and raw-name section-op matching)

## Context

git's config parser holds ONE flat variable name per header. `get_base_var` reads every byte up to
the first GIT_SPACE or `]`, folding each to lower case and accepting dots as ordinary name bytes;
`get_extended_base_var` then appends `.` plus the quoted span **verbatim**. Every lookup, merge and
`--list` name is that flat string.

Measured against git 2.55.0 (`mktemp -d`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off):

| header | flat name | note |
| --- | --- | --- |
| `[a]` / `[A]` | `a` | the section half is case-insensitive |
| `[a.B]` | `a.b` | a **dotted** subsection folds to lower case |
| `[a "B"]` | `a.B` | a **quoted** subsection keeps its case |
| `[a "b.c"]` | `a.b.c` | a quoted subsection may hold dots |
| `[a.B "C"]` | `a.b.C` | both halves join; only the dotted half folds |
| `[a.]` and `[a ""]` | `a.` | one variable, written two ways |
| `[.a]` | `.a` | an empty section half |
| `[a "b\"c"]` / `[a "b\\c"]` | `a.b"c` / `a.b\c` | the quoted span takes `\"` and `\\` |
| `[a.b\c]` / `[a.b"c]` | — | `fatal: bad config line`; the unquoted grammar takes neither byte |

`[a.b] c = one` and `[a "b"] c = two` both feed `a.b.c`: `--get-all` yields both in **file** order
and `--get` takes the last, so the two spellings merge rather than shadow. A write through
`git config a.b.c <v>` edits whichever block is already there, in place.

tsgit's tokenizer kept the whole unquoted span as the section name (`[a.b]` → section `a.b`,
subsection `undefined`), so a dotted header matched nothing: `a.b.c` did not find `[a.b] c`, the
`[fsck …]` severity table came back empty for both subsection spellings, and every
subsection-keyed consumer (`remote.<n>.*`, `branch.<n>.*`, `gc.<pattern>.*`, `submodule.<n>.*`,
`url.<base>.*`) was blind to the dotted form.

One surface deliberately does **not** use the flat name: `--remove-section` / `--rename-section`
match the header's own bytes. `[s.X]` answers to `s.X` and refuses `s.x` (`fatal: no such section:
s.x`) — measured, both directions.

## Options considered

1. **Split git's flat name at its first dot inside the tokenizer, and carry the header's raw bytes
   alongside** (recommended, chosen) — pros: one fix serves every consumer; the token keeps the
   existing `(section, subsection)` shape, so no reader changes; the two names git itself keeps
   separate stay separate. Cons: the header parse gains a third field.
2. **Fold at comparison time in `matchesSection`** — cons: the comparison cannot tell a dotted
   subsection from a quoted one, and that distinction *is* the case rule; it would need the same
   extra field, only carried further.
3. **Classify the dotted form in the `fsck` reader alone** — cons: inconsistent by construction;
   every other subsection consumer stays broken, and the next one written inherits the gap.

## Decision

**Option 1.** `splitHeaderName(rawSection, quoted)` builds git's flat name and splits it at its
FIRST dot: the section half is the span before it, the subsection half everything after — the
dotted tail arriving already lower-cased, the quoted tail verbatim, joined by a dot when both are
present. `[a.b]`, `[a.B]` and `[a "b"]` therefore land on one `(a, b)` identity and `[a.]` and
`[a ""]` on one `(a, '')`, exactly as git merges them. The section half stays raw (`[A.b]` →
section `A`), which the readers already fold on compare and `qualifyKey` already folds on render.

The recognised-header parse gains `rawName`: the header's own bytes, section span and unescaped
subsection joined by a dot. `recognizeHeader` — the section-op matcher — reads that instead of
re-deriving a name from the folded identity, so `--remove-section` / `--rename-section` keep
matching bytes while every reader matches the variable.

`fsck`'s severity table follows from the same rule: its walk takes EVERY `[fsck …]` header and the
msg-id it grades is the whole variable name past `fsck.`, with the key half folded: `[fsck
"SubName"] BadTree` asks about `SubName.<key>`, `[fsck.Sub] badTree` about `sub.<key>`, `[fsck ""]
badTree` about `.<key>`, and `[fsck "x"] skipList` about `x.<key>`. None is a msg-id the catalogue
knows, so each refuses the audit — which is precisely what git does, and what tsgit previously
ignored in silence.
`fsck.skipList` itself stays subsectionless: only `[fsck] skipList` names a list file.

## Consequences

Dotted subsection headers become readable everywhere at once — `remote.<n>.*`, `branch.<n>.*`,
`gc.<pattern>.*`, `submodule.<n>.*`, `url.<base>.*` and `fsck.*` inherit it from the tokenizer with
no reader change. A repository whose `.git/config` carries `[remote.origin] url = …` now has a
remote, as it does under git.

Configuration that tsgit previously ignored can now refuse a command: a `[fsck "x"]` entry that was
silently dropped now kills the audit the way git's does. That is the fix, not a regression.

`parseIniSections` reports `[a.b]` as `{ section: 'a', subsection: 'b' }` rather than
`{ section: 'a.b', subsection: undefined }`; the one test pinning the old shape is re-aimed. The
section-op raw-name rows are unchanged in behaviour and now sourced from the header bytes rather
than from a reduction of the identity, so `rawSectionName` serves only the caller-supplied identity
it is given at the write sites.
