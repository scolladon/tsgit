# Design — `reflog` command malformed-line parity

> Brief: canonical git skips a malformed reflog line and keeps reading; the `reflog`
> command's read path throws on the first one. Align the command on the existing
> lenient primitives, reuse rather than duplicate, and pin the tolerated-vs-refused
> matrix against real git.
> Status: draft → self-reviewed ×3 → accepted

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
  `reports/api.json` before push.
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
   The ❌ rows are governed by **D5**/**D6** and, wherever they stay divergent, are
   asserted as such rather than left unpinned.
2. `reflog delete` and `reflog expire` operate over the surviving entries and leave a
   reflog file whose contents match what git leaves, including **purging the
   malformed line** (git's rewrite drops it; see the pinned matrix).
3. `reflog exists` is unchanged — a file-presence question, already faithful.
4. No second tolerance implementation is created. The command, and the gc retention
   walk that already needed leniency, read through **one** lenient seam.
5. The strict `parseReflog` remains available and remains the reader for every caller
   whose contract is strictness. No caller silently loses an error it relied on
   without that being an explicit, recorded decision.
6. The tolerated-vs-refused matrix in this document is pinned by a
   `test/integration/*-interop.test.ts` suite that spawns real git with `GIT_*`
   scrubbed and signing off. The matrix was measured against **git 2.55.0**; the
   suite compares against whatever git the runner has (guarded by `GIT_AVAILABLE`),
   so a future git that changes its tolerance surfaces as a red test rather than a
   silently stale claim in this document.
7. No rendered reflog line leaves the library. Display parity is proven by
   reconstructing git's stdout from the structured fields inside the interop test.
8. `npm run validate` green: 100 % line/branch/function/statement coverage on the
   touched domain/adapter code, 0 killable mutants, `reports/api.json` regenerated
   if the exported surface moves.

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

The mechanism is small; the surface it touches is not. The change has four parts.

**(a) One lenient read seam, promoted out of `fsck/roots.ts`.**
`roots.ts`'s private `readReflogLenient` (L177–185) is deleted and its behaviour —
`exists` → `[]`, `MAX_REFLOG_BYTES` cap → throw, `parseReflogLenient` — moves to the
`RefStore` layer, exposed through a `reflog-store.ts` dispatcher so callers stay
backend-neutral. `roots.ts` then consumes the dispatcher instead of building
`logs/**` paths itself. Placement is **D1**; the reftable half is **D2**.

> **A latent defect this closes.** `roots.ts`'s helper reads
> `reflogPath(perWorktreeRefDir(ctx, ref), ref)` off the filesystem directly. The
> reftable backend stores reflogs **in the reftable stack**, never under `.git/logs/`
> (`reftable-ref-store.ts` L275–290 reads `stack.logs(name)`; L328–335 enumerates
> from the stack). So under a reftable repo, gc's retention walk finds reflog *names*
> through the backend-aware `listReflogs`, then reads **zero entries** for every one
> of them — an object reachable only from a reflog is not rooted and `gc --prune`
> deletes it, silently. Routing through the store fixes this as a side effect.
> The implementation must add a reftable-backed regression test rather than assume
> the fix; if the maintainer would rather isolate that fix, it is **D3**'s business.

> **Derived-Context constraint.** `roots.ts` L406 reads HEAD's reflog on a
> *per-worktree derived* `Context`. `getRefStore` memoises per `Context` in a
> `WeakMap` (`ref-store.ts` L244–253), so the promoted read must be called as
> `getRefStore(derivedCtx).readReflogLenient(...)` — reading through the original
> `ctx` after deriving is the known fanout-cache trap that yields intermittent
> `OBJECT_NOT_FOUND`. The current helper sidesteps it only by taking the derived
> `ctx` straight to `perWorktreeRefDir`; the store route must keep the same
> derived Context all the way through.

**(b) `commands/reflog.ts` reads leniently.** `runShow` L78, `runDelete` L110 and
`runExpire` L163 switch to the lenient read. Nothing else in the command changes
shape: `runShow`'s newest-first mapping, `runDelete`'s `length - 1 - index`
arithmetic and `repairChain`, and `runExpire`'s filter all operate on the surviving
array exactly as they do today, which is precisely what git's numbering does
(§1b: `@{n}` counts only survivors).

**(c) The rewrite paths must purge, not preserve.** `runExpire`'s
`if (survivors.length !== stored.length)` guard (L169) compares two *parsed* counts.
Once the read is lenient, a file whose only defect is a malformed line yields
`survivors.length === stored.length` and **no write happens** — the malformed line
stays on disk where git purges it (§1b, `--expire=never` row). The guard has to
compare against what was on disk, not against what parsed. That is **D7**.
`runDelete` always writes, so it needs no guard change — but it inherits **D8**
(git's out-of-range delete is a silent no-op that *still* purges).

**(d) The pinned matrix becomes a test.** A new
`test/integration/reflog-interop.test.ts` with `bucket: cross-tool-interop` and
`interopSurface: reflog`. Claiming a surface a second time is safe: the audit's
`Coverage.coveredBy` is a list (`tooling/audit-write-surfaces/compute-gaps.ts`), so
`reflog-writers.test.ts` and the new suite aggregate rather than conflict.

### 3. Scope boundary — the other strict readers

Every one of these is strict today and every one of them diverges from a git
behaviour pinned above. Leaving one strict is a *choice*, not a silence; the
decision is **D3** (and **D4** for the odd one out).

| call site | lines | what it does with the array | git's pinned behaviour | effect of leaving it strict |
|---|---|---|---|---|
| `commands/rev-parse.ts::resolveReflogBase` | 78–90 (read L86), `pickByIndex` 150–155 | `entries[length - 1 - n]`; empty → `revparseUnresolved` | `ref@{n}` numbering counts survivors; resolves with a stderr gap warning | `HEAD@{1}` throws where git answers |
| `primitives/stash-ref.ts::readStashStack` | 43–50 (L44) | maps to `stash@{i}` selectors | `git stash list` skips the bad line | `stash list` throws where git lists |
| `primitives/stash-ref.ts::resolveStashEntry` | 53–58 (L54) | `stored[length - 1 - index]` | index counts survivors | `stash apply` throws |
| `primitives/stash-ref.ts::dropStashEntry` | 87+ (L88) | drop + chain repair + rewrite | `stash drop` succeeds **and purges** the bad line | `stash drop` throws, corruption persists |
| `primitives/snapshot/snapshot-factory.ts::stashEntry` | 165+ (L169) | `stored[length - 1 - stashIndex]` | same numbering | stash diff/show throws |
| `commands/branch.ts::branchRename` | 157+ (L167, L192) | reads `from`'s log, concatenates onto `to`, re-serializes | git **renames the file**; the malformed line survives verbatim under the new name | rename throws; and even leniently, tsgit's parse-and-rewrite would *drop* a line git keeps — **D4** |
| `fsck/roots.ts::addReflogRoots` non-strict arm | L207 | fsck's `collectRoots` | `git fsck` reports nothing about reflog corruption | already tolerated (the throw is caught upstream); leniency would change *which roots fsck sees*, not whether it errors |

`branch.ts` is the one that leniency alone does not fix: git's rename is a
byte-preserving `rename(2)` of the log file plus an appended entry, so *no* parse
tolerance reproduces it. It needs a different mechanism (a store-level "move this
reflog" verb) or an explicitly recorded divergence.

### 4. Error semantics after the change

- `INVALID_REFLOG_ENTRY` is **still thrown** by the lenient read for the
  `MAX_REFLOG_BYTES` cap. Only per-line faults become silent.
- `parseReflog` (strict) keeps its callers and its published domain export
  (`src/domain/reflog/index.ts`); it is not weakened.
- Every I/O fault (`EACCES`, `EIO`, `EMFILE`) still propagates — the lenient parser's
  `catch` wraps `parseReflogLine` only, never the read.
- `runDelete`'s `reflogNotFound` precondition (L109, via `hasReflog`) is unchanged and
  already matches git's `error: no reflog for '<ref>@{0}'`.

### 5. Reftable

"Malformed line" has no reftable analogue: log records are length-prefixed binary
inside a block, so a damaged record damages the block, not one entry. The reftable
backend's `readReflog` already skips non-`entry` records (L279). What the lenient
verb *means* there is **D2**.

---

## Decision candidates

The item is small in mechanism and wide in pinned surface. Ten choices below;
D1/D2/D3 set the shape, D5–D9 set how much of the pinned divergence this PR closes.
A convenient cut line is noted after the table.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1** | Where the lenient read lives | **(a)** new `RefStore.readReflogLenient(name)` interface method + `reflog-store.ts` dispatcher `readReflogLenient(ctx, ref)`; `roots.ts` consumes it. **(b)** dispatcher-level sibling in `reflog-store.ts` only, files-path-bound like `roots.ts` today — no interface change, stays reftable-blind. **(c)** option object on the existing `RefStore.readReflog(name, { lenient })`. | **(a)** | Only (a) satisfies "one implementation" *and* is backend-neutral; it closes the reftable gc gap in §2(a) for free. (b) preserves the defect. (c) is a boolean parameter on a seam verb — an Object-Calisthenics smell, and it makes every backend branch internally. Cost of (a): one new published export ⇒ `reports/api.json` must be regenerated before push. |
| **D2** | What the reftable backend does for the lenient verb | **(a)** alias it to `readReflog` — the structural read is already the faithful shape. **(b)** per-record tolerance: skip a log record that fails to decode, keep the rest of the block. **(c)** throw `unsupported` for the lenient verb on reftable. | **(a)**, with the reasoning in the method's doc comment | There is no text line to be malformed. (b) invents a tolerance git has no counterpart for and would need its own pin against a reftable-format oracle. (c) breaks gc under reftable, which is the defect being fixed. |
| **D3** | Which strict readers move to lenient now | **(a)** `commands/reflog.ts` only (the literal brief). **(b)** the command **+** every reader whose divergence is pinned above and is fixed by leniency alone: `rev-parse` `@{n}`/`@{date}`, `stash-ref` ×3, `snapshot-factory` — leaving `branch.ts` to D4. **(c)** everything including `fsck`'s non-strict arm. | **(b)** | The pins show git is lenient on all of them; (a) ships a repo where `reflog show` works and `stash list` throws on the same file, which is a worse contract than either end. (b) is still one seam and one behaviour. (c) changes *which roots fsck reports*, an independent question with its own oracle — keep it out. Note the standing preference for no follow-up items: whatever is excluded here is a recorded divergence, not a ticket. |
| **D4** | `branch -m`'s reflog move | **(a)** add a store-level `moveReflog(from, to)` verb — files backend renames the file, reftable re-keys the log records — and drop `branch.ts`'s read-concat-rewrite. **(b)** make the read lenient and accept that the rename drops the malformed line git preserves; record the divergence. **(c)** leave `branch.ts` strict; rename refuses on a corrupt log; record the divergence. | **(a)** if D3 = (b) or (c); otherwise **(c)** | (a) is the only faithful answer (§1b: git preserves the line byte-for-byte) but it is a new seam verb with a reftable half — real scope. (b) is half-faithful and hides the loss. (c) at least fails loudly. This is the single biggest scope lever after D3. |
| **D5** | Unterminated final line (row 25) — git drops the entry, tsgit keeps it | **(a)** drop it in **both** `parseReflog` and `parseReflogLenient` (file-level check: the text must end `\n`). **(b)** drop it in the lenient parser only. **(c)** leave as-is, record the divergence. | **(a)** | A torn write is the *likeliest* real corruption, and it is a file-level rule — no per-line predicate changes. (b) makes the two parsers disagree about the same bytes, which is exactly the class of trap this backlog item exists to remove. Note (a) changes a **published** domain export's behaviour (`parseReflog`). |
| **D6** | Per-line predicate divergences (rows 20–23: `>`-only identity, `>` in name, no space after `>`, timestamp `0`) | **(a)** align `parseReflogLine`/`parseIdentity` on git's whole predicate (first `>`, `email_end[1] == ' '`, non-zero timestamp). **(b)** align **row 23 only** — refuse a zero timestamp — in `reflog-format.ts`, without touching `parseIdentity`; record 20–22. **(c)** align none; record all four. | **(b)** | Rows 20–22 are hand-corruption shapes no writer emits, and (a) reaches `parseIdentity`, which is shared with **commit and tag object parsing** — a far larger blast radius than a reflog PR should carry (git's commit parser is not its reflog parser, so "align on git" does not even mean one thing there). Row 23 is different in kind: it is the only member that breaks a **round trip through tsgit's own writer** — `serializeReflogLine` will happily emit `… <e@x> 0 +0000` for an entry whose timestamp is 0, and canonical git then reads that line as corrupt and silently drops the entry. That is tsgit writing a file git cannot fully read, which the prime directive does bind. Whether to also add a writer-side refusal is the sub-question (b) opens. |
| **D7** | `runExpire`'s rewrite-suppression guard (L169) | **(a)** have the lenient read return `{ entries, skippedLines }` and rewrite when `skippedLines > 0 \|\| survivors.length !== entries.length`. **(b)** always rewrite unconditionally, matching git (a clean file rewrites byte-identically, so it is unobservable in content). **(c)** compare `survivors.length` against the raw `\n`-delimited line count read from disk. | **(b)** | git always rewrites and a clean rewrite is byte-identical (measured), so (b) is both the simplest and the most faithful. Costs: one write per target, i.e. one per reflog on `expire --all`; and `applyReflogReplace` uses `ctx.fs.writeUtf8` where git locks and renames — the implementation must confirm that write is atomic (or make it so) before turning it into an unconditional every-run write. (a) needs a richer return type on the new seam verb — reasonable if D10 = (c). (c) re-reads or re-splits the file just to count. |
| **D8** | `reflog delete` with an out-of-range index — pre-existing on clean files (`main@{99}`: git exits 0 silently, tsgit throws); the lenient read *moves the boundary* on corrupt ones, since fewer surviving entries turn previously-valid indexes out-of-range | **(a)** keep throwing `REFLOG_ENTRY_OUT_OF_RANGE`; record the divergence (git: silent exit 0). **(b)** match git — no-op, which forces `ReflogResult.delete` to admit an absent `removed`. **(c)** purge corruption first (rewrite), then throw. | **(a)** | A typed library error beats git's silent exit 0 for a *library*, and (b) degrades the result type for every caller. (c) writes and then throws — a CQS violation, and it makes the error non-idempotent. This one genuinely needs the maintainer's call because it is a knowing divergence from the prime directive; if faithfulness wins, it is (b). |
| **D9** | Empty-message TAB on the rewrite path (§1d) | **(a)** give `applyReflogReplace` a rewrite-specific serializer that always emits the TAB, leaving `serializeReflogLine` (append) as is. **(b)** change `serializeReflogLine` to always emit the TAB — wrong for append, breaks the writer pins. **(c)** leave it; record the divergence. | **(a)** | Two git writers, two rules; (a) encodes that honestly and is ~3 lines. (b) would regress `reflog-writers.test.ts`'s pinned append bytes. (c) is not available on reachability grounds: **measured**, `git update-ref refs/heads/probe <oid>` with no `-m` writes a tab-less line (`…+0200`), and a later `reflog expire` rewrites it to `…+0200\t`. (`git update-ref -m ''` is separately refused — `fatal: Refusing to perform update with empty message` — so the no-`-m` route is the one that reaches it.) |
| **D10** | Does the result surface report skipped lines? | **(a)** no — git is silent; `ReflogResult` shape unchanged. **(b)** add `skippedLines: number` to the `show` result. **(c)** add it to the new seam verb's return only (internal), not to `ReflogResult`. | **(a)** if D7 = (b); **(c)** if D7 = (a) | A count is structured data, so ADR-249 permits it, but nothing consumes it and git offers no equivalent. (c) is the shape D7(a) needs internally without widening the public result. |

**Suggested cut line.** D1(a) + D2(a) + D3(b) + D5(a) + D6(b) + D7(b) + D9(a) is one
coherent change: one seam, one tolerance, faithful reads, faithful rewrite bytes, and
no file tsgit writes that git would silently thin — all without touching
`parseIdentity`. D4 and D8 are the two that need an explicit
faithful-vs-typed-error ruling; rows 20–22 and D10 stay recorded-not-fixed.

---

## Test strategy

### Unit

- `test/unit/domain/reflog/reflog-format.test.ts` — extend with the §1a rows for
  `parseReflogLenient`: one malformed line mid-file, at the head, at the tail, and
  every-line-malformed → `[]`. Each row asserts the **surviving entries**, not just a
  count, so a `StringLiteral`/`ArrayDeclaration` mutant cannot pass on length alone.
  If **D5** lands, add the unterminated-final-line rows to *both* parsers, and assert
  the strict parser's error `.data` (code + reason), never `toThrow(Class)`.
- `test/unit/application/primitives/reflog-store.test.ts` — the new dispatcher:
  absent file → `[]`, over-cap → throws with the cap reason (isolated test, separate
  from the malformed-line test, so each guard is proven alone), malformed line →
  survivors.
- If **D6(b)** lands: `parseReflogLine` refuses a zero timestamp, with an isolated
  test per guard (zero timestamp alone; non-numeric alone) so neither proves the
  other, plus a round-trip test showing `serializeReflogLine` no longer produces a
  line the strict parser rejects.
- `test/unit/application/commands/reflog.test.ts` — `runShow` numbering over a
  corrupted log (`@{n}` skips the bad line); `runDelete` index arithmetic against the
  *surviving* array; `runExpire` writes even when nothing expires (**D7**) — spy the
  `applyRefUpdates` call and assert the `entries` payload, since `toEqual` on the
  result cannot see a suppressed write.
- Reftable: a `readReflogLenient` case through the reftable backend, plus the gc
  retention-root regression from §2(a) (an object reachable only from a reftable
  reflog survives `gc --prune=now`).

### Property tests

Apply the four lenses to what actually changes. If **D5** lands, the file-level
parsers change and two lenses fire — ship a `reflog-format.properties.test.ts`
sibling (there is none today) with per-family arbitraries in a local
`arbitraries.ts`:

- **Lens 3 — total function over a grammar.** `parseReflogLenient(anyText, 40)` never
  throws for any ASCII-no-NUL text. `numRuns: 100`.
- **Lens 4 — counting invariant.** For a generated file of mixed valid/invalid lines,
  `parseReflogLenient(text).length` equals the number of lines `parseReflogLine`
  accepts individually — an invariant, not a re-implementation of the loop.
  `numRuns: 100`.
- **Lens 1 — round trip.** `parseReflog(entries.map(serializeReflogLine).join(''))`
  ≡ `entries`, which also pins D9's serializer split if it lands. `numRuns: 200`.

If the design lands **without** D5, the parsers are untouched and none of the four
lenses fire on the diff — say so in the review pass rather than adding a property for
virtue.

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
2. **Recorded-divergence rows — the ❌ rows.** Rows 19–25 are asserted **as they
   actually resolve**, not skipped: whichever of D5/D6 lands flips a row from
   "divergent, pinned" to "agreeing, pinned", and the row that does not land keeps a
   live assertion of the difference (git keeps / tsgit drops, or the reverse). A
   divergence with no test is the failure mode this backlog item exists to remove;
   writing case 1 to sweep "every refusing class" would make the suite red unless
   both D5 and D6 land, which is exactly the contradiction to avoid.
3. **Accepted-line parity.** Rows 16–18 (tab-less empty message, trailing blank,
   CRLF) survive on both sides with identical fields. Row 16 is not hypothetical:
   git's own `update-ref` with no `-m` writes it.
4. **Numbering.** `git rev-parse main@{n}` vs tsgit `revParse('main@{n}')` for
   `n = 0..3`, including git's `only has 3 entries` refusal at the boundary (exit 128
   via `tryRunGitWithExit`) against tsgit's typed `REFLOG_ENTRY_OUT_OF_RANGE`. The
   stderr `gap`/`only goes back to` warnings are git-side stdout decoration and are
   **not** matched — record that in the test comment.
5. **`delete` rewrite.** `git reflog delete main@{1}` vs tsgit's; compare the
   resulting `.git/logs/refs/heads/main` **bytes**, which proves both the surviving
   set and the §1d re-serialization (including D9's TAB if it lands).
6. **`expire` rewrite.** `--expire=never` (nothing expires, file still purged),
   `--expire=90.days.ago`, `--expire=now` (0 bytes, file present). Byte comparison
   again; this is the case D7 exists for.
7. **Degenerate files** (§1c): all-corrupt, 0-byte, absent-file, absent-ref — assert
   both the returned data and the refusal/exit shape, and note in-test every row
   where tsgit deliberately differs (`expire` on an absent reflog: git 255, tsgit
   treats as empty).
8. **`--all`** purges `.git/logs/HEAD` on both sides.
9. If **D3(b)** lands: `git stash list` / `stash drop` parity on a corrupted
   `refs/stash` log. If **D4(a)** lands: `git branch -m` preserves the malformed line
   byte-for-byte on both sides.

Every case asserts error `.data` (code + reason) via `try`/`catch`, never bare
`toThrow(TsgitError)`.

### Mutation

Scoped Stryker over `src/domain/reflog/`, `src/application/primitives/ref-store.ts`,
`src/application/primitives/reflog-store.ts` and `src/application/commands/reflog.ts`
per `.claude/workflow/mutation.md`. Watch for: the existing proven-equivalent
suppression on `parseReflogLenient` L83 (do not disturb — and if D5 reshapes that
loop, the equivalence proof is structure-specific and must be **re-proved**, not
carried forward); boundary mutants on `length - 1 - index`; and the D7 guard, whose
removal must be killed by interop case 6's `--expire=never` byte comparison — the
only assertion that sees a suppressed write.

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
  Pre-existing; recorded in §1c and asserted-as-divergent in interop case 7 rather
  than silently skipped.
- **`fsck`'s own reflog roots** (`roots.ts` L207, the non-strict arm). Making it
  lenient changes which roots fsck *reports*, which needs its own oracle — `git fsck`
  says nothing about reflog corruption at all (measured, exit 0).
- **`parseIdentity` alignment** — see **D6**. It is shared with commit and tag object
  parsing, where git uses a different parser; changing it from a reflog PR would
  reach far outside this surface.
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
