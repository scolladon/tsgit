# Design — `reflog` command malformed-line parity

> Brief: canonical git skips a malformed reflog line and keeps reading; the `reflog`
> command's read path throws on the first one. Align the command on the existing
> lenient primitives, reuse rather than duplicate, and pin the tolerated-vs-refused
> matrix against real git.
> Status: accepted — every load-bearing choice is settled and recorded as
> [ADR-737](../adr/737-reflog-lenient-read-is-a-ref-store-seam-verb.md) …
> [ADR-746](../adr/746-reflog-results-carry-no-skipped-line-count.md). Nine landed as
> recommended; **D8 was ratified against this document's own recommendation** and the
> body below is written against the outcome, not the alternative.

## Context

### What exists today

The domain already owns both tolerance shapes, in
`src/domain/reflog/reflog-format.ts`:

| symbol | lines | shape |
|---|---|---|
| `parseReflogLine(line, hexLength)` | 41–58 | one line → `ReflogEntry`, throws `INVALID_REFLOG_ENTRY` |
| `parseReflog(text, hexLength)` | 61–66 | `.split('\n').filter(≠'').map(parseReflogLine)` — **all-or-nothing**, the first bad line kills the file |
| `parseReflogLenient(text, hexLength)` | 80–92 | per-line `try`/`catch`, bad line skipped, rest survives |

`parseReflogLenient` was added during the 2026-08 perf-remediation review for gc's
retention-root walk only. Its doc comment says so explicitly, and pins it against
git 2.55.0. It carries a *proven-equivalent* Stryker suppression on its empty-line
guard (line 83) — **do not disturb that comment or the guard it anchors**; the
equivalence proof is structure-specific and would have to be re-proved if the loop
shape changed.

The read seam is a three-layer dispatch:

```
commands/reflog.ts ─┐
rev-parse.ts        ├→ primitives/reflog-store.ts::readReflog(ctx, ref)   (L25–27)
branch.ts           │       └→ getRefStore(ctx).readReflog(ref)
stash-ref.ts        │             ├→ files    ref-store.ts L611–619 → parseReflog  (STRICT)
snapshot-factory.ts │             └→ reftable reftable-ref-store.ts L275–290 → structural
fsck/roots.ts       ┘
```

The files backend's `readReflog` (`src/application/primitives/ref-store.ts` L611–619)
is: `exists` → `[]`; `stat().size > MAX_REFLOG_BYTES` (16 MiB,
`primitives/types.ts` L64) → throw `INVALID_REFLOG_ENTRY`; else strict `parseReflog`.

The lone lenient reader is **private and file-path-bound**:
`src/application/commands/internal/fsck/roots.ts` L177–185 re-implements the
exists/stat/cap preamble against `reflogPath(perWorktreeRefDir(ctx, ref), ref)` and
then calls `parseReflogLenient`. That is the second implementation the brief tells
us not to grow a third of.

### The command

`src/application/commands/reflog.ts` — every read is the strict dispatcher:

| function | lines | read | writes back? | index arithmetic |
|---|---|---|---|---|
| `runShow` | 76–88 | L78 | no | `stored[lastIndex - index]`, `selector = ref@{index}` |
| `runDelete` | 104–128 | L110 | yes — `applyRefUpdates [{kind:'reflogReplace'}]` | `target = length - 1 - index`, range guard on `length` |
| `runExpire` | 146–176 | L163 | yes, **only when `survivors.length !== stored.length`** (L169) | none |
| `runExists` | 100–102 | — (uses `getRefStore(ctx).hasReflog`) | no | none |

`repairChain` (L134–144) implements git's `--rewrite` chain repair over the parsed
array. `applyReflogReplace` (`ref-store.ts` L601–608) re-serializes every surviving
entry through `serializeReflogLine`.

### Constraints this design inherits

- **ADR-226 / prime directive** — observable behaviour byte-for-byte unless an ADR
  diverges. Here that binds *which lines survive a read*, *what the reflog file
  contains after a rewrite*, and *the refusal conditions*.
- **ADR-249 / structured data only** — the library returns fields, never a rendered
  reflog line. `ReflogShowEntry` already complies; the interop test reconstructs
  git's `reflog show` output from the structured fields rather than the library
  emitting one.
- **`readReflog` and `reflogExists` are published API** (`primitives/index.ts`
  L74–77; present in `reports/api.json` under `@scolladon/tsgit/application/primitives`,
  `index.default`, `index.browser`, `index.node`). Changing `readReflog`'s tolerance
  changes a published contract; *adding* an exported sibling gates on regenerating
  `reports/api.json` before push. **`ReflogResult` is published the same way** (nine
  occurrences in `reports/api.json`), and ADR-744 widens its `delete` arm — so the
  regeneration is mandatory in this change, not conditional.
- **The `MAX_REFLOG_BYTES` cap is never tolerated.** `roots.ts` L163–176 documents
  why: an over-cap reflog that silently rooted nothing is the exact silent-data-loss
  shape the strict mode exists to refuse. Git has no such cap (measured: it reads a
  27.7 MB / 200 000-entry reflog and resolves `main@{199999}` without complaint) —
  this is a deliberate, already-shipped divergence and it is carried unchanged.
- Prior docs: `docs/design/reflog.md` §5.1 (L240–258, the bounded-read rationale),
  `docs/design/abort-noop-reflog-skip.md`, `docs/design/abort-reflog-audit-followups.md`.

---

## Requirements

When this ships:

1. `reflog show` on a reflog file containing one malformed line returns the file's
   **other** entries — same set, same order, same `@{n}` numbering as `git reflog show`,
   for every corruption class the two per-line predicates agree on (§1a, the ✅ rows).
   Of the ❌ rows, row 25 (unterminated final line) closes via ADR-741 and row 23
   (timestamp `0`) via ADR-742; rows 19–22 and 24 stay divergent and each carries a
   live assertion of the difference rather than being left unpinned.
2. `reflog delete` and `reflog expire` operate over the surviving entries and leave a
   reflog file whose contents match what git leaves, including **purging the
   malformed line** (git's rewrite drops it; see the pinned matrix). An out-of-range
   `delete` index removes nothing and reports nothing — and still leaves that purged
   file (ADR-744).
3. `reflog exists` is unchanged — a file-presence question, already faithful.
4. No second tolerance implementation is created. The command, and the gc retention
   walk that already needed leniency, read through **one** lenient seam.
5. The strict `parseReflog` remains available and remains the reader for every caller
   whose contract is strictness. Which readers leave it is enumerated by ADR-739 and
   ADR-740; the one error the strict parser itself stops raising — the unterminated
   final line — is ADR-741's recorded decision, not a silence. No caller loses an
   error it relied on outside those two ADRs.
6. The tolerated-vs-refused matrix in this document is pinned by a
   `test/integration/*-interop.test.ts` suite that spawns real git with `GIT_*`
   scrubbed and signing off. The matrix was measured against **git 2.55.0**; the
   suite compares against whatever git the runner has (guarded by `GIT_AVAILABLE`),
   so a future git that changes its tolerance surfaces as a red test rather than a
   silently stale claim in this document.
7. No rendered reflog line leaves the library. Display parity is proven by
   reconstructing git's stdout from the structured fields inside the interop test.
8. `npm run validate` green: 100 % line/branch/function/statement coverage on the
   touched domain/adapter code, 0 killable mutants, and `reports/api.json`
   regenerated — the exported surface moves twice here (the two new seam verbs of
   ADR-737/ADR-740, and `ReflogResult`'s `delete` arm under ADR-744).

---

## Design

### 1. The pinned matrix — this IS the parity contract

**Environment.** `git version 2.55.0`. Every probe ran in a `mktemp -d` throwaway
repository, never the worktree: all `GIT_*` unset, `HOME` pointed at a fresh
directory inside the tmp root, `GIT_CONFIG_NOSYSTEM=1`, `XDG_CONFIG_HOME` isolated,
`commit.gpgsign=false` / `tag.gpgsign=false`, `gc.auto=0`, `git init --ref-format=files`.
Fixture: four commits on `main`, so `.git/logs/refs/heads/main` holds four
LF-terminated lines; the corruption is applied to **line 3 of 4** (mid-file) unless a
row says otherwise.

**Hash width.** The matrix was re-run end to end on a `git init --object-format=sha256`
repository and is identical — same survivors, same `only has 3 entries` boundary, same
purge on `expire`. Both tsgit parsers already take `hexLength` from
`ctx.hashConfig`, so nothing here is SHA-1-specific; the interop suite still runs at
least one row under SHA-256 so that stays a measurement rather than an inference.

#### 1a. Per-line acceptance — does the line survive the read?

"tsgit" below is `parseReflogLine`'s verdict. Today a rejected line makes the *whole*
`parseReflog` throw; under `parseReflogLenient` it is skipped. The column records the
**per-line** verdict, which is what has to agree with git.

| # | corruption class | line shape | git | tsgit | agree |
|---|---|---|---|---|---|
| 1 | *(baseline)* | valid | keep | keep | ✅ |
| 2 | bad oid hex | old oid = 40 × `z` | skip | reject | ✅ |
| 3 | short oid | old oid = 39 hex chars | skip | reject | ✅ |
| 4 | long oid | old oid = 41 hex chars | skip | reject | ✅ |
| 5 | no separator after old oid | `<oid>X<oid> …` | skip | reject | ✅ |
| 6 | no separator after new oid | `<oid> <oid>XProbe …` | skip | reject | ✅ |
| 7 | garbage line | `this is not a reflog line at all` | skip | reject | ✅ |
| 8 | empty line mid-file | `` | skip | skip (filtered before the predicate, not rejected by it) | ✅ |
| 9 | identity without brackets | `Probe no-brackets 1764… +0200` | skip | reject | ✅ |
| 10 | no closing `>` | `Probe <probe@example.com 1764…` | skip | reject | ✅ |
| 11 | non-numeric timestamp | `> not-a-number +0200` | skip | reject | ✅ |
| 12 | no timezone field | `> 1764…\tcommit: c2` | skip | reject | ✅ |
| 13 | short timezone | `+00` | skip | reject | ✅ |
| 14 | non-numeric timezone | `+abcd` | skip | reject | ✅ |
| 15 | timezone without sign | `0200` | skip | reject | ✅ |
| 16 | no TAB / no message | line ends at the timezone | **keep**, message `""` | keep, message `''` | ✅ |
| 17 | trailing blank line | file ends `\n\n` | keep all 4 | keep all 4 | ✅ |
| 18 | CRLF line endings | every line `…\r\n` | keep all 4, `\r` trails the message | keep all 4, `\r` trails the message | ✅ |
| 19 | NUL inside the message | `…+0200\tA\0B…` (NUL mid-message) | **keep**; message truncates at the NUL (`%gs` = `A`) | keep; message keeps the NUL and everything after it | ❌ message bytes |
| 20 | no opening `<` | `Probe probe@example.com> 1764… +0200` | **keep** | **reject** | ❌ |
| 21 | `>` inside the name | `x>y <probe@example.com> 1764… +0200` | **skip** | **keep** (name `x>y`) | ❌ |
| 22 | no space after `>` | `<probe@example.com>1764… +0200` | **skip** | **keep** | ❌ |
| 23 | timestamp `0` | `> 0 +0200` | **skip** | **keep** (timestamp 0) | ❌ |
| 24 | negative timestamp | `> -5 +0200` | **keep**, value `18446744073709551611` | keep, value `-5` | ❌ value |
| 25 | unterminated final line | last line has no `\n` | **skip** — the newest entry is lost | **keep** | ❌ |

**Why git's predicate differs, mechanically.** git tests, in order: the buffer is
non-empty and ends `\n`; `parse_oid_hex` twice, each followed by a literal `SP`; the
**first** `>` in the remainder (a forward scan, not a reverse search) is followed by `SP`;
`parse_timestamp` returns non-zero; the next char is `+` or `-` followed by four
digits. tsgit's `parseIdentity` (`src/domain/objects/author-identity.ts` L10–42) uses
`lastIndexOf('>')` and `lastIndexOf('<', lastClose)`, requires **both** brackets,
splits the tail on `/\s+/`, and accepts any safe integer timestamp including `0` and
negatives. Rows 20–23 are exactly those four differences; row 25 is the LF-termination
check, which lives at the **file** level (`parseReflog`/`parseReflogLenient` split on
`\n`), not inside `parseReflogLine`.

#### 1b. Command-level behaviour, one malformed line mid-file

`ref` = `refs/heads/main`, four lines, line 3 corrupted with the garbage-line class.
Every other refusing class in §1a produced identical command-level results.

| command | git 2.55.0 | exit | tsgit today |
|---|---|---|---|
| `git reflog show main` | 3 entries, malformed line skipped, **no warning on stderr** | 0 | throws `INVALID_REFLOG_ENTRY` |
| `git log -g main` | same 3 entries | 0 | n/a |
| `git reflog exists refs/heads/main` | unaffected — file presence only | 0 | ✅ already faithful |
| `git rev-parse main@{0..2}` | resolves; numbering counts **only surviving** entries | 0 | throws |
| `git rev-parse main@{3}` | `fatal: log for 'main' only has 3 entries` | 128 | throws (different error) |
| `git rev-parse main@{1}` (chain broken) | resolves, **stderr** `warning: log for ref refs/heads/main has gap after <date>` | 0 | throws |
| `git rev-parse main@{1.hour.ago}` | resolves, stderr `warning: log for 'main' only goes back to <date>` | 0 | throws |
| `git reflog delete main@{1}` | removes that entry **and purges the malformed line** — file 4 → 2 lines | 0 | throws |
| `git reflog delete --rewrite main@{1}` | same, plus chain repair across survivors | 0 | throws |
| `git reflog delete main@{3}` / `main@{99}` (corrupt fixture) | **silent no-op**, no stderr — but the file is still rewritten and the malformed line still purged | 0 | throws `REFLOG_ENTRY_OUT_OF_RANGE` |
| `git reflog delete main@{4}` / `main@{99}` / `main@{-1}` (clean fixture) | silent no-op, file unchanged | 0 | throws `REFLOG_ENTRY_OUT_OF_RANGE` |
| `git reflog expire --expire=never main` | **nothing expires, file still rewritten**, malformed line purged (4 → 3) | 0 | throws |
| `git reflog expire --expire=90.days.ago main` | same (4 → 3) | 0 | throws |
| `git reflog expire --expire=now main` | file truncated to **0 bytes**, file kept | 0 | throws |
| `git reflog expire --expire=never --all` | same purge applied to `.git/logs/HEAD` | 0 | throws |
| `git branch -m main renamed` | reflog file **moved byte-for-byte**; the malformed line survives under the new name; the rename entry is appended (5 lines) | 0 | throws (`branch.ts` L167 read is strict) |
| `git stash list` | malformed line skipped (3 lines → 2 entries) | 0 | throws |
| `git stash drop stash@{1}` | drops the entry, rewrites, purges the malformed line; emits the gap warning 6× | 0 | throws |
| `git fsck` | reports **nothing** about reflog corruption | 0 | ✅ tolerates |
| `git gc --prune=now` | objects rooted by surviving entries are kept | 0 | ✅ already aligned |

**What the settled design closes.** The `tsgit today` column above is a measurement of
the shipped code. Every cell in it that names a tsgit behaviour becomes git's cell
(the `git log -g` row has no tsgit surface and stays n/a): the reads
(`reflog show`, `rev-parse @{n}` / `@{date}`, `stash list` / `drop`, the snapshot
stash reads) through ADR-737 + ADR-739; the rewrites (`delete`, `delete --rewrite`,
`expire` ×4) through ADR-743 + ADR-745; the two **out-of-range `delete`** rows through
ADR-744 — both become silent no-ops, the corrupt fixture still rewritten and purged,
the clean fixture left content-identical; `branch -m` through ADR-740's
byte-preserving move. Two things tsgit still does not reproduce, both by charter
rather than by omission:

- git's stderr **text** — `warning: … has gap after`, `only goes back to`,
  `fatal: log for 'main' only has 3 entries` — is rendering (ADR-249). The *refusal*
  at `main@{3}` is reproduced, as a typed `REFLOG_ENTRY_OUT_OF_RANGE` from
  `rev-parse`; the warnings have no structured counterpart because nothing about the
  returned data differs.
- the §1a rows that stay divergent (19–22, 24), which are message-byte and
  identity-predicate differences, not command-level ones.

#### 1c. Degenerate files

| file state | `reflog show` | `reflog exists` | `rev-parse ref@{0}` | `rev-parse ref@{1}` | `reflog expire --expire=never` |
|---|---|---|---|---|---|
| every line corrupt | empty, exit 0 | exit **0** | current ref value, exit 0 | `fatal: log for refs/heads/main is empty`, 128 | file truncated to 0 bytes |
| 0-byte file | empty, exit 0 | exit **0** | current ref value, exit 0 | — | exit 0 (already empty, so a rewrite is indistinguishable from a skip) |
| file absent, ref exists | empty, exit 0 | exit **1** | `fatal: ambiguous argument …`, 128 | — | `error: reflog could not be found: '<ref>'`, exit **255** |
| ref absent entirely | `fatal: ambiguous argument '<unknown-name>'…`, 128 | exit 1 | — | — | — |

#### 1d. The rewrite byte contract

`git reflog expire` / `git reflog delete` do **not** copy surviving lines verbatim.
Each survivor is re-emitted as:

```
hex(oldId) SP hex(newId) SP <identity bytes verbatim, from after the 2nd SP through the FIRST '>'>
  SP <timestamp, decimal, from the parsed unsigned value> SP <sign><4-digit zone>
  TAB <message bytes verbatim, INCLUDING its own trailing LF, with one leading TAB consumed>
```

Pinned consequences, each measured:

| input | after `git reflog expire --expire=never` |
|---|---|
| a clean file | **byte-identical** (content md5 unchanged; inode changes — atomic replace) |
| `Probe probe@example.com>` (row 20, accepted-but-odd) | **byte-identical** — the identity slice is verbatim |
| `… > -5 +0200` (row 24) | rewritten as `… > 18446744073709551611 +0200` |
| `… 1788014881 -0000` | rewritten as `… 1788014881 +0000` — sign is recomputed from the parsed int, so `-0000` normalises to `+0000` |
| `…+0200` (row 16, tab-less empty message) | rewritten as `…+0200\t` — git **always** emits the TAB on rewrite |
| `…+0200\tA\0B…` (row 19) | emitted as `…+0200\tA` **with no LF** — the next entry fuses onto the same line; git's rewrite corrupts the file further |

tsgit's `applyReflogReplace` re-serializes through `serializeReflogLine`
(`reflog-format.ts` L26–38), which deliberately **omits** the TAB when
`message === ''`. That is correct for the *append* surface — git's
`log_ref_write_fd` also omits it — but it disagrees with the *rewrite* surface,
which always emits it. Two different git writers, two different rules.

---

### 2. What changes

The mechanism is small; the surface it touches is not. The change has eight parts:
seven of mechanism, one per settled decision cluster, plus the test that pins them.
ADR-746 contributes a *non*-change — no skipped-line count anywhere, not on the seam
verb and not on `ReflogResult` — which is a constraint on parts (c) and (d) rather
than a part of its own.

**(a) One lenient read seam, promoted out of `fsck/roots.ts`.**
`roots.ts`'s private `readReflogLenient` (L177–185) is deleted and its behaviour —
`exists` → `[]`, `MAX_REFLOG_BYTES` cap → throw, `parseReflogLenient` — moves to the
`RefStore` layer, exposed through a `reflog-store.ts` dispatcher so callers stay
backend-neutral. `roots.ts` then consumes the dispatcher instead of building
`logs/**` paths itself (ADR-737). The reftable backend implements the verb as an
alias of its structural `readReflog` — a length-prefixed binary log record has no
malformed-line analogue, and inventing a per-record tolerance would need an oracle
that does not exist (ADR-738, §5). The `MAX_REFLOG_BYTES` cap still throws on the
lenient path; only per-line faults go silent.

> **A latent defect this closes.** `roots.ts`'s helper reads
> `reflogPath(perWorktreeRefDir(ctx, ref), ref)` off the filesystem directly. The
> reftable backend stores reflogs **in the reftable stack**, never under `.git/logs/`
> (`reftable-ref-store.ts` L275–290 reads `stack.logs(name)`; L328–335 enumerates
> from the stack). So under a reftable repo, gc's retention walk finds reflog *names*
> through the backend-aware `listReflogs`, then reads **zero entries** for every one
> of them — an object reachable only from a reflog is not rooted and `gc --prune`
> deletes it, silently. Routing through the store fixes this as a side effect.
> The implementation must add a reftable-backed regression test rather than assume
> the fix — ADR-737 counts this gap as part of the change, not as an adjacent item.

> **Derived-Context constraint.** `roots.ts` L406 reads HEAD's reflog on a
> *per-worktree derived* `Context`. `getRefStore` memoises per `Context` in a
> `WeakMap` (`ref-store.ts` L244–253), so the promoted read must be called as
> `getRefStore(derivedCtx).readReflogLenient(...)` — reading through the original
> `ctx` after deriving is the known fanout-cache trap that yields intermittent
> `OBJECT_NOT_FOUND`. The current helper sidesteps it only by taking the derived
> `ctx` straight to `perWorktreeRefDir`; the store route must keep the same
> derived Context all the way through.

**(b) Every pinned reader reads leniently.** ADR-739 takes the change past the
literal brief to the whole set git is lenient on: `commands/reflog.ts` (`runShow`
L78, `runDelete` L110, `runExpire` L163), `commands/rev-parse.ts::resolveReflogBase`
(L86), all three `primitives/stash-ref.ts` sites (L44, L54, L88) and
`primitives/snapshot/snapshot-factory.ts::stashEntry` (L169). `branch.ts` is not on
this list — it is part (e), and it loses its read entirely rather than converting it.
`fsck/roots.ts`'s arms keep their current strictness; only the *helper* they call
moves (part (a)).

Nothing in those readers changes shape: `runShow`'s newest-first mapping,
`runDelete`'s `length - 1 - index` arithmetic and `repairChain`, `runExpire`'s
filter, `pickByIndex`'s `entries[length - 1 - n]` and the stash selectors all operate
on the surviving array exactly as they do today, which is precisely what git's
numbering does (§1b: `@{n}` counts only survivors). The reason to move them together
is stated in ADR-739: leaving half strict ships a repo where `reflog show` works and
`stash list` throws on the same file.

**(c) The rewrite paths purge, not preserve — and they write unconditionally.**
`runExpire`'s `if (survivors.length !== stored.length)` guard (L169) compares two
*parsed* counts. Once the read is lenient, a file whose only defect is a malformed
line yields `survivors.length === stored.length` and **no write happens** — the
malformed line stays on disk where git purges it (§1b, `--expire=never` row). ADR-743
deletes the guard: `runExpire` rewrites every run, which is what git does, and a
clean rewrite is byte-identical in content (§1d, measured). Two obligations ride
with it — one write per target per run (one per reflog under `--all`), and the
implementation must **confirm `applyReflogReplace`'s write is atomic** (git locks and
renames; `ref-store.ts` L601–608 currently uses `ctx.fs.writeUtf8`) before turning it
into an every-run write.

`runDelete` already writes on every call, and under ADR-744 it keeps doing so on the
out-of-range path too — see part (d).

**(d) Out-of-range `delete` is a silent no-op (ADR-744 — the ratified deviation).**
This document recommended keeping the typed `REFLOG_ENTRY_OUT_OF_RANGE`; the user
ruled for faithfulness. Both throw sites in `runDelete` — the non-integer/negative
guard (L113–115) and the `target < 0` guard (L119–121) — stop throwing. Instead:

- nothing is removed, and the result is the `delete` arm with **`removed` absent**;
- the reflog file is **still rewritten** with the full surviving set, so a corrupt
  file is purged (§1b, corrupt-fixture row) and a clean one comes back
  content-identical (§1b, clean-fixture row; §1d's byte-identical measurement is what
  makes the write invisible there).

That unconditional write is also what keeps ADR-744 and ADR-746 consistent: knowing
*whether* to skip the write would require a skipped-line signal, and ADR-746 declines
to carry one. Writing always needs no signal at all.

`reflogNotFound` (L109, via `hasReflog`) is untouched — git errors there too
(§1c, exit 255).

**(e) `branch -m` moves the reflog instead of re-serializing it (ADR-740).** No parse
tolerance reproduces git here: git does a `rename(2)` of the log file, so a malformed
line survives verbatim under the new name (§1b). A second store-level verb,
`moveReflog(from, to)`, carries that — the files backend moves the file
byte-preserving, the reftable backend re-keys the log records — and `branch.ts`
L157+ drops its read-concat-rewrite in favour of it. The appended rename entry still
goes through the ordinary append serializer, so part (g) does not touch it. This
*removes* a strict read site rather than converting it, which is why `branch.ts` is
absent from part (b)'s list.

**(f) Two per-line/per-file predicate changes, and only two.** ADR-741:
**both** `parseReflog` and `parseReflogLenient` treat a final line with no
terminating LF as absent (§1a row 25) — a file-level rule on the split, not a
per-line predicate, so the two parsers keep agreeing about every file. This is a
behaviour change to a *published* domain export: the strict parser now silently drops
a torn final entry where it used to parse it; every other malformed line still throws
there. ADR-742: `parseReflogLine` refuses a **zero timestamp** (§1a row 23), in
`reflog-format.ts`, **without touching `parseIdentity`** — row 23 is the only one of
rows 20–23 that breaks a round trip through tsgit's own writer
(`serializeReflogLine` emits `… 0 +0000`; git reads that line as corrupt and drops
the entry). Rows 20–22 stay divergent by decision, asserted in the interop suite.
ADR-742's Neutral clause leaves the writer-side half open on purpose: **the
round-trip property test (below) forces a writer-side refusal only if it actually
fails**; the implementation does not add one speculatively.

**(g) The rewrite serializer always emits the message TAB (ADR-745).**
`applyReflogReplace` gets a rewrite-specific serialization that emits the TAB even
for an empty message, leaving `serializeReflogLine`'s append rule — and
`reflog-writers.test.ts`'s pinned append bytes — untouched. Two git writers, two
rules, both encoded (§1d). The cost is two serialization paths that must stay in
sync for every other field, which the byte-comparison interop cases police.

**(h) The pinned matrix becomes a test.** A new
`test/integration/reflog-interop.test.ts` with `bucket: cross-tool-interop` and
`interopSurface: reflog`. Claiming a surface a second time is safe: the audit's
`Coverage.coveredBy` is a list (`tooling/audit-write-surfaces/compute-gaps.ts`), so
`reflog-writers.test.ts` and the new suite aggregate rather than conflict.

### 3. Scope boundary — the other strict readers

Every one of these is strict today and every one of them diverges from a git
behaviour pinned above. Leaving one strict would have been a *choice*, not a silence,
so each one has a settled disposition: **ADR-739 moves the first five to the lenient
read**
(part (b)); **ADR-740 removes `branch.ts` from the list entirely** by replacing its
read-concat-rewrite with `moveReflog` (part (e)); **`fsck/roots.ts`'s arms stay as
they are** — leniency there would change which roots fsck *reports*, an independent
question with its own oracle. The last column below records what leaving each one
strict would have cost, which is why none of them stayed.

| call site | lines | what it does with the array | git's pinned behaviour | effect of leaving it strict |
|---|---|---|---|---|
| `commands/rev-parse.ts::resolveReflogBase` | 78–90 (read L86), `pickByIndex` 150–155 | `entries[length - 1 - n]`; empty → `revparseUnresolved` | `ref@{n}` numbering counts survivors; resolves with a stderr gap warning | `HEAD@{1}` throws where git answers |
| `primitives/stash-ref.ts::readStashStack` | 43–50 (L44) | maps to `stash@{i}` selectors | `git stash list` skips the bad line | `stash list` throws where git lists |
| `primitives/stash-ref.ts::resolveStashEntry` | 53–58 (L54) | `stored[length - 1 - index]` | index counts survivors | `stash apply` throws |
| `primitives/stash-ref.ts::dropStashEntry` | 87+ (L88) | drop + chain repair + rewrite | `stash drop` succeeds **and purges** the bad line | `stash drop` throws, corruption persists |
| `primitives/snapshot/snapshot-factory.ts::stashEntry` | 165+ (L169) | `stored[length - 1 - stashIndex]` | same numbering | stash diff/show throws |
| `commands/branch.ts::branchRename` | 157+ (L167, L192) | reads `from`'s log, concatenates onto `to`, re-serializes | git **renames the file**; the malformed line survives verbatim under the new name | rename throws; and even leniently, tsgit's parse-and-rewrite would *drop* a line git keeps — hence ADR-740 |
| `fsck/roots.ts::addReflogRoots` non-strict arm | L207 | fsck's `collectRoots` | `git fsck` reports nothing about reflog corruption | already tolerated (the throw is caught upstream); leniency would change *which roots fsck sees*, not whether it errors |

`branch.ts` is the one that leniency alone does not fix: git's rename is a
byte-preserving `rename(2)` of the log file plus an appended entry, so *no* parse
tolerance reproduces it — a strict read refuses a rename git performs, and a lenient
read silently drops a line git preserves. ADR-740 takes the only faithful answer, the
store-level `moveReflog(from, to)` verb, at the cost of a second new seam with a
reftable half. That is the largest scope add in this change and it is deliberate.

### 4. Error semantics after the change

- `INVALID_REFLOG_ENTRY` is **still thrown** by the lenient read for the
  `MAX_REFLOG_BYTES` cap. Only per-line faults become silent.
- `parseReflogLine` gains **one new refusal** — a zero timestamp (ADR-742). On the
  strict path that is a new `INVALID_REFLOG_ENTRY`; on the lenient path it is one
  more skipped line.
- `parseReflog` (strict) keeps its callers and its published domain export
  (`src/domain/reflog/index.ts`). It is weakened in exactly one place and by
  decision: ADR-741 makes it drop an unterminated final line instead of parsing it,
  so a torn write stops surfacing as data. Every other malformed line still throws
  there.
- **`REFLOG_ENTRY_OUT_OF_RANGE` is no longer thrown by `runDelete`** (ADR-744).
  Nothing replaces it — there is no new code, no warning channel and no counter. The
  observable outcome is a `delete` result whose `removed` is **absent**, plus the
  reflog rewrite described in §2(d): the malformed lines the lenient read skipped are
  purged from disk on that same call, exactly as git's out-of-range delete purges
  them. A caller that needs to know whether anything was deleted inspects `removed`.
- The `reflogEntryOutOfRange` factory (`src/domain/reflog/error.ts` L20–24) and its
  `REFLOG_ENTRY_OUT_OF_RANGE` code **stay live and exported**: `rev-parse`'s
  `pickByIndex` (`rev-parse.ts` L153) remains its caller, and git refuses there too
  (`fatal: log for 'main' only has 3 entries`, exit 128 — §1b). Only `reflog.ts`'s
  two throw sites go. This is not a dead-code removal.
- Every I/O fault (`EACCES`, `EIO`, `EMFILE`) still propagates — the lenient parser's
  `catch` wraps `parseReflogLine` only, never the read.
- `runDelete`'s `reflogNotFound` precondition (L109, via `hasReflog`) is unchanged and
  already matches git's `error: no reflog for '<ref>@{0}'`. ADR-744 narrows the
  no-op to the *index*; a missing reflog is still an error on both sides.

### 5. Reftable

"Malformed line" has no reftable analogue: log records are length-prefixed binary
inside a block, so a damaged record damages the block, not one entry. The reftable
backend's `readReflog` already skips non-`entry` records (L279). ADR-738 therefore
makes `readReflogLenient` an **alias of the structural read** on this backend, with
that reasoning in the method's doc comment — no invented tolerance, and gc's
retention walk behaves identically on both backends. The second new verb does have
real reftable work: `moveReflog` (ADR-740) re-keys the log records in the stack,
since there is no file to rename.

---

## Settled decisions

The ten load-bearing choices this design raised are settled and recorded as ADRs.
The ADRs are the authority; this table is the index, and the body above is written
against these outcomes rather than against the alternatives. Nine were adopted as
recommended. **D8 was ratified against this document's recommendation** and is marked
⚑ — it is the one that reshaped the design.

| # | Settled decision | ADR |
|---|---|---|
| D1 | The lenient read is a `RefStore.readReflogLenient(name)` seam verb with a `reflog-store.ts` dispatcher; `fsck/roots.ts` deletes its private helper and consumes it. The `MAX_REFLOG_BYTES` cap still throws | [737](../adr/737-reflog-lenient-read-is-a-ref-store-seam-verb.md) |
| D2 | The reftable backend implements the lenient verb as an **alias of its structural `readReflog`** — no invented per-record tolerance, no oracle to invent one against | [738](../adr/738-reftable-lenient-reflog-read-aliases-the-structural-read.md) |
| D3 | The lenient read replaces the strict one in **every pinned reader**: `commands/reflog.ts`, `commands/rev-parse.ts`, all three `stash-ref.ts` sites, `snapshot-factory.ts`. fsck's arms are untouched | [739](../adr/739-lenient-reflog-reads-extend-to-every-pinned-reader.md) |
| D4 | `branch -m` moves the reflog through a store-level **`moveReflog(from, to)`** verb (files: byte-preserving move; reftable: re-key the log records); `branch.ts` drops its read-concat-rewrite | [740](../adr/740-branch-rename-moves-the-reflog-through-a-move-reflog-verb.md) |
| D5 | **Both** parsers treat an unterminated final line as absent — a file-level rule, so strict and lenient keep agreeing about every file. Changes published `parseReflog` behaviour | [741](../adr/741-reflog-parsers-drop-an-unterminated-final-line.md) |
| D6 | `parseReflogLine` refuses a **zero timestamp** only; `parseIdentity` is untouched and §1a rows 20–22 stay recorded-and-asserted divergences | [742](../adr/742-reflog-line-parser-refuses-a-zero-timestamp.md) |
| D7 | `runExpire` **rewrites unconditionally**, matching git; the implementation must first confirm the reflog replace write is atomic | [743](../adr/743-reflog-expire-always-rewrites.md) |
| D8 ⚑ | Out-of-range `reflog delete` is a **silent no-op matching git** — no typed error, and the file is still rewritten and purged. `ReflogResult`'s `delete` arm admits an absent `removed` | [744](../adr/744-reflog-delete-out-of-range-is-a-silent-no-op.md) |
| D9 | `applyReflogReplace` uses a **rewrite-specific serialization that always emits the message TAB**; `serializeReflogLine`'s append rule is untouched | [745](../adr/745-reflog-rewrite-serializer-always-emits-the-message-tab.md) |
| D10 | **No skipped-line count anywhere** — not on the seam verb's return, not on `ReflogResult` | [746](../adr/746-reflog-results-carry-no-skipped-line-count.md) |

**Where D8 landed differently.** The recommendation was to keep the typed
`REFLOG_ENTRY_OUT_OF_RANGE`, arguing that a library error beats git's silent exit 0
and that admitting an absent `removed` degrades the result type for every caller. The
ruling was faithfulness, consistent with the standing always-choose-the-git-faithful-fix
principle. Three consequences run through the body: §2(d) replaces both `runDelete`
throw sites with a no-op that still writes; §4 states that nothing replaces the
error on that path while the error code itself stays live for `rev-parse`; and the
`ReflogResult` change puts `reports/api.json` regeneration on the critical path. It
also forces the D8 × D10 interaction to be resolved deliberately — writing
unconditionally is what lets the purge happen without the skipped-line count D10
declines to carry.

**Shape of the resulting change.** One tolerance implementation, two new seam verbs,
two parser predicate changes, two write-path changes, and one published type change —
with `parseIdentity` and fsck's root set untouched. §1a rows 19–22 and 24 remain
knowing divergences, asserted rather than fixed.

---

## Test strategy

### Unit

- `test/unit/domain/reflog/reflog-format.test.ts` — extend with the §1a rows for
  `parseReflogLenient`: one malformed line mid-file, at the head, at the tail, and
  every-line-malformed → `[]`. Each row asserts the **surviving entries**, not just a
  count, so a `StringLiteral`/`ArrayDeclaration` mutant cannot pass on length alone.
  The unterminated-final-line rows (ADR-741) go to *both* parsers — the lenient one
  drops the entry, the strict one drops it too rather than throwing — and every
  remaining strict refusal asserts the error `.data` (code + reason), never
  `toThrow(Class)`.
- `test/unit/application/primitives/reflog-store.test.ts` — the new dispatcher:
  absent file → `[]`, over-cap → throws with the cap reason (isolated test, separate
  from the malformed-line test, so each guard is proven alone), malformed line →
  survivors.
- `parseReflogLine` refuses a zero timestamp (ADR-742), with an isolated test per
  guard (zero timestamp alone; non-numeric timestamp alone) so neither proves the
  other, plus a round-trip test showing `serializeReflogLine` no longer produces a
  line the strict parser rejects. **That round-trip is the arbiter of ADR-742's open
  writer-side half**: if it can be made to fail — an entry whose timestamp is 0
  reaching the append serializer — the writer gains a refusal; if it cannot, no
  writer-side change ships. The decision is the test's, not the implementer's taste.
- `test/unit/application/commands/reflog.test.ts` — `runShow` numbering over a
  corrupted log (`@{n}` skips the bad line); `runDelete` index arithmetic against the
  *surviving* array; `runExpire` writes even when nothing expires (ADR-743) — spy the
  `applyRefUpdates` call and assert the `entries` payload, since `toEqual` on the
  result cannot see a suppressed write.
- **Out-of-range `delete` (ADR-744) needs two unit assertions that do not overlap**,
  because the throw they replace used to prove both at once:
  1. *the result* — `runDelete` at an index past the oldest entry, at a negative
     index, and at a non-integer index each resolve to a `delete` result with
     `removed` **absent**, and none of them throws. Three isolated tests, one per
     guard the old code had, so removing one guard cannot be covered by another.
  2. *the write* — on a corrupted log, an out-of-range `runDelete` still calls
     `applyRefUpdates` with a `reflogReplace` whose `entries` are the survivors.
     Spy the call and assert the payload: the returned result is identical whether
     or not the write happened, so it is the **only** observation that kills a
     mutant deleting the write. Pair it with the clean-log case, where the same spy
     shows the full stored set going back unchanged.
- Both new seam verbs get a case **per backend**, not just on the files side:
  `readReflogLenient` (files: skips the bad line; reftable: aliases the structural
  read, ADR-738) and `moveReflog` (files: the file arrives byte-identical under the
  new name; reftable: the log records are re-keyed, not re-serialized, ADR-740).
- Reftable also carries the gc retention-root regression from §2(a) — an object
  reachable only from a reftable reflog survives `gc --prune=now`. This is the latent
  defect ADR-737 closes, so it is a regression test with a failing baseline, not a
  confirmation test.

### Property tests

Apply the four lenses to what actually changes. ADR-741 changes the file-level
parsers and ADR-742 the per-line predicate, so the lenses fire — a
`reflog-format.properties.test.ts` sibling ships (there is none today) with
per-family arbitraries in a local `arbitraries.ts`:

- **Lens 3 — total function over a grammar.** `parseReflogLenient(anyText, 40)` never
  throws for any ASCII-no-NUL text. `numRuns: 100`.
- **Lens 4 — counting invariant.** For a generated file of mixed valid/invalid lines,
  `parseReflogLenient(text).length` equals the number of lines `parseReflogLine`
  accepts individually — an invariant, not a re-implementation of the loop.
  `numRuns: 100`.
- **Lens 1 — round trip.** `parseReflog(entries.map(serializeReflogLine).join(''))`
  ≡ `entries`, over an arbitrary that can generate a **zero timestamp**. This is the
  property that decides ADR-742's writer-side half (see Unit above): if it finds a
  counterexample, the append writer gains a timestamp refusal. It also pins ADR-745's
  serializer split — the rewrite path's always-TAB output must round-trip through the
  same strict parser. `numRuns: 200`.

The unterminated-final-line rule is covered by lens 3's arbitrary, which generates
text with and without a terminating LF; a property asserting only "the last line is
dropped" would re-implement the production rule as its own oracle and prove nothing.

### Interop — `test/integration/reflog-interop.test.ts` (new)

Header carries `bucket: cross-tool-interop` and `interopSurface: reflog`. Uses
`test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `git(dir, …)`, `runGit`,
`tryRunGitWithExit`, `disableAutoMaintenance`) — all `GIT_*` already scrubbed, `HOME`
and XDG isolated, `GIT_CONFIG_NOSYSTEM=1`. Signing is disabled per repo. `merge.conflictStyle`
is irrelevant here and is **not** pinned.

Shape: one shared `beforeAll` that builds the four-commit base repo with real git
(**60 s hook timeout** — the 10 s default flakes under full-`validate` concurrency),
then per-case twins copied from it, corrupted identically on both sides, and driven
through `git` on one and tsgit on the other.

Cases, one per pinned row:

1. **Read parity — the ✅ rows.** For each agreeing class in §1a (rows 1–18),
   `git reflog show` and tsgit `reflog({action:'show'})` agree on the surviving
   entries. Display parity is proven by *reconstructing* git's
   `<abbrev> <ref>@{n}: <message>` lines from `ReflogShowEntry` fields — the library
   emits no line (ADR-249).
2. **The ❌ rows, split by the settled decisions.** Rows 19–25 are all asserted, none
   skipped, but in two groups. **Rows 23 and 25 join case 1's parity assertions** —
   ADR-742 makes tsgit reject a zero timestamp as git does, ADR-741 makes both
   parsers drop an unterminated final line as git does. **Rows 19–22 and 24 keep a
   live assertion of the difference** (git keeps / tsgit rejects for 20; git rejects /
   tsgit keeps for 21–22; message bytes for 19; timestamp value for 24). A divergence
   with no test is the failure mode this backlog item exists to remove — and writing
   case 1 to sweep "every refusing class" blindly would make the suite red on those
   five, which is exactly the contradiction to avoid.
3. **Accepted-line parity.** Rows 16–18 (tab-less empty message, trailing blank,
   CRLF) survive on both sides with identical fields. Row 16 is not hypothetical:
   git's own `update-ref` with no `-m` writes it.
4. **Numbering.** `git rev-parse main@{n}` vs tsgit `revParse('main@{n}')` for
   `n = 0..3`, including git's `only has 3 entries` refusal at the boundary (exit 128
   via `tryRunGitWithExit`) against tsgit's typed `REFLOG_ENTRY_OUT_OF_RANGE`. ADR-744
   does **not** reach here — `rev-parse` refuses out-of-range on both sides, and only
   the message text differs (rendering, ADR-249). The stderr `gap` / `only goes back
   to` warnings are likewise not matched — record both facts in the test comment so a
   later reader does not "fix" this case into a no-op.
5. **`delete` rewrite.** `git reflog delete main@{1}` vs tsgit's; compare the
   resulting `.git/logs/refs/heads/main` **bytes**, which proves both the surviving
   set and the §1d re-serialization, ADR-745's always-TAB included.
6. **Out-of-range `delete` — a parity case, not a divergence case (ADR-744).** Both
   fixtures, both sides:
   - *corrupt fixture* — `git reflog delete main@{3}` (and `main@{99}`) exits **0**
     with empty stderr and leaves a file purged of the malformed line; tsgit's
     `reflog({action:'delete', index: 3})` **resolves** — no throw — with `removed`
     absent, and leaves the same bytes. Assert the exit code, the empty stderr, the
     resolved result shape, and a byte comparison of the two files.
   - *clean fixture* — `main@{4}`, `main@{99}` and a negative index exit 0 on both
     sides and leave the file **content-identical** to its pre-command bytes.
     Compare content, not `stat` — §1d measured that git's own clean rewrite changes
     the inode, so an mtime/inode assertion would pin noise.

   This case is the one that would have been written as an asserted divergence under
   the original recommendation. It is now the direct oracle for §2(d), and the only
   interop assertion that catches a regression back to the typed throw.
7. **`expire` rewrite.** `--expire=never` (nothing expires, file still purged),
   `--expire=90.days.ago`, `--expire=now` (0 bytes, file present). Byte comparison
   again; this is the case ADR-743 exists for.
8. **Degenerate files** (§1c): all-corrupt, 0-byte, absent-file, absent-ref — assert
   both the returned data and the refusal/exit shape, and note in-test every row
   where tsgit deliberately differs (`expire` on an absent reflog: git 255, tsgit
   treats as empty).
9. **`--all`** purges `.git/logs/HEAD` on both sides.
10. **`stash` and `branch -m`, both in scope.** ADR-739: `git stash list` /
    `stash drop` parity on a corrupted `refs/stash` log — `drop` compares the
    rewritten bytes, and git's six repeated gap warnings on stderr are rendering and
    are not matched. ADR-740: `git branch -m` preserves the malformed line
    byte-for-byte on both sides, and the appended rename entry matches — the
    assertion that distinguishes a real move from a lenient parse-and-rewrite, which
    would drop that line.

Every case that expects a refusal asserts the error `.data` (code + reason) via
`try`/`catch`, never bare `toThrow(TsgitError)`. Case 6 is the mirror image: it
asserts a call **resolves**, and asserts the resolved shape and the file bytes —
an "it did not throw" assertion alone would survive a mutant that returns the wrong
result or skips the write.

### Mutation

Scoped Stryker over `src/domain/reflog/`, `src/application/primitives/ref-store.ts`,
`src/application/primitives/reflog-store.ts`, `src/application/primitives/stash-ref.ts`,
`src/application/commands/reflog.ts`, `src/application/commands/rev-parse.ts` and
`src/application/commands/branch.ts` per `.claude/workflow/mutation.md` — ADR-739 and
ADR-740 widen the diff past the command. Watch for:

- the existing proven-equivalent suppression on `parseReflogLenient` L83 — **do not
  disturb it**, and note that ADR-741 reshapes that loop's file-level split, so the
  equivalence proof is structure-specific and must be **re-proved against the new
  shape**, never carried forward;
- boundary mutants on `length - 1 - index` in `runDelete`, `pickByIndex` and the
  stash selectors;
- ADR-743's deleted guard: a mutant reinstating a conditional write is killed only by
  interop case 7's `--expire=never` byte comparison, the one assertion that sees a
  suppressed write;
- ADR-744's two removed throw sites, where the risk runs the other way. A mutant that
  deletes `runDelete`'s write on the out-of-range path is invisible to the result, so
  the `applyRefUpdates` spy is its only killer; and a mutant flipping the range
  comparison changes *which* entry is removed, which only the per-guard trio of unit
  tests separates.

---

## Out of scope

- **`MAX_REFLOG_BYTES`.** git has no read cap (measured: 27.7 MB / 200 000 entries
  read fine). tsgit's 16 MiB refusal is a deliberate, already-documented divergence
  (`docs/design/reflog.md` §5.1) and is carried unchanged, including on the new
  lenient seam — `roots.ts` L163–176 already argues why tolerating it would be the
  silent-data-loss shape leniency must not create.
- **git's NUL-truncating rewrite** (§1d, row 19). Replicating it means emitting a
  self-corrupting file — two entries fused on one line. tsgit's
  `serializeReflogLine` produces a well-formed line instead. Recorded as a knowing
  divergence; the only open sub-question is whether the *writer* should refuse a NUL
  in a message the way it already refuses `\n`/`\r`, which is a separate writer-side
  change.
- **`reflog show` on a name with no ref at all.** git refuses with
  `fatal: ambiguous argument` and exit 128; tsgit returns an empty result.
  Pre-existing, unrelated to corruption, and a ref-resolution question.
- **`git reflog HEAD` falling back to the branch log.** With `.git/logs/HEAD`
  deleted, git still lists three entries — it resolves the symref and reads
  `refs/heads/main`'s log. tsgit reads `logs/HEAD` only and returns empty.
  Pre-existing `dwim_log` behaviour, a resolution question, not a tolerance one.
- **`reflog expire` on a ref with no reflog.** git refuses with
  `error: reflog could not be found: '<ref>'` (exit 255); tsgit treats it as empty.
  Pre-existing; recorded in §1c and asserted-as-divergent in interop case 8 rather
  than silently skipped.
- **`fsck`'s own reflog roots** (`roots.ts` L207, the non-strict arm). Making it
  lenient changes which roots fsck *reports*, which needs its own oracle — `git fsck`
  says nothing about reflog corruption at all (measured, exit 0).
- **`parseIdentity` alignment**, and with it §1a rows 20–22 — settled out by ADR-742.
  It is shared with commit and tag object parsing, where git uses a different parser;
  changing it from a reflog PR would reach far outside this surface. Row 23 is in
  scope precisely because it is fixable *without* touching `parseIdentity`.
- **Any skipped-line count or corruption diagnostic** — settled out by ADR-746. The
  seam verb returns entries only and `ReflogResult` grows no counter; a caller that
  wants the count diffs a strict parse against a lenient one itself. This is what
  makes §2(c)/§2(d)'s unconditional writes necessary rather than merely simplest.
- **`writeReflog`** (`reflog-store.ts` L35–44). Exported publicly but has no `src`
  caller; the command writes through `applyRefUpdates`/`reflogReplace`. Untouched.
- **`reflogExists`'s reftable blindness** (`reflog-store.ts` L30–32). The published
  primitive answers with a raw `ctx.fs.exists` on the files path, so it reports
  `false` for every ref in a reftable repo — the same path-bound blindness §2(a)
  fixes for the lenient read. The `reflog` command itself is unaffected (it uses the
  backend-aware `getRefStore(ctx).hasReflog`, `reflog.ts` L97–98). Adjacent, real,
  and a different verb; noted here so a reviewer does not read the silence as
  ignorance.
- **`ReflogShowEntry.selector`** is a pre-rendered `"<ref>@{n}"` string, which is in
  tension with ADR-249 (the caller should compose it from `ref` and `index`, both of
  which the result already carries). Pre-existing, and the sweep of
  rendering-bearing command surfaces is backlog 23.2a's job, not this item's.
