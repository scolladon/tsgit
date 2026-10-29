# Design — follow git 2.56 across the interop suite, pin CI's git, close 31.8

> Brief: one PR that (A) pins every git-spawning CI job to git 2.56.x, (B) follows git 2.56
> on every interop row that diverges from the 2.55 expectations (GitHub issue #311), and
> (C) closes backlog item 31.8 (fsck per-entry pack CRC).
> Status: draft → self-reviewed ×3 → ready for decisions (ADR phase)

## Context

- **Prime directive** (CLAUDE.md, ADR-226): replicate git's data, on-disk state, refusal
  conditions and exit status byte-for-byte unless an ADR diverges. **Structured output**
  (ADR-249): tsgit returns data and the interop test rebuilds git's stdout/stderr from it.
  A git *message* change is a test-reconstruction + docs change. An *exit bit, gating or
  algorithm* change is a code change.
- **The baseline.** On `main` at b105fcd0, the integration project run under git 2.56.0 has
  369 red rows across 21 suites. Five suites were re-run on their own: 107 red under 2.56.0
  and 0 red under 2.55.0, so the failures are deterministic. CI has stayed green only because
  the last `integration` run used image ubuntu-24.04 20261012.334.1, which ships git 2.55.0.
  The runner-images README for Ubuntu 24.04 already lists 2.56.0, so the next image rollout
  turns `integration` red with no code change.
- **Subsystems touched.** fsck (`src/application/commands/fsck.ts` and
  `src/application/commands/internal/fsck/*`), stash and the tests that cover it,
  gitlink/submodule checkout probing, gc/maintenance config reads, pack-registry midx
  lookup, merge-base paint, branch delete, the signing primitive, flat rebase replay, the
  closure engine's bitmap selection, and CI.
- **Governing docs and ADRs.** `docs/design/fsck.md`,
  `docs/design/fsck-pack-accessibility-reporting.md`, `docs/use/commands/fsck.md`; ADRs 586,
  592, 601, 602, 603, 607, 608, 840, 907, 919, 920, 1091, 1092, 1096, 1097, 1101.
- **Lessons that bind this change.** 015: a change on a shared command path runs the
  command's whole interop family at the gate. 017: a kill test never pins a crash git does
  not have. 018: a "writes nothing" pin drifts a stat before comparing. 022: seed every twin
  shape both first and last in index order.

### How the values below were pinned

Every value comes from a probe run in a `mktemp -d` throwaway with
`env -i PATH=… HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=<tmp>/gitconfig`. That
gitconfig holds only `[user]`. Each probe passes `-c commit.gpgsign=false`, and `-c gc.auto=0`
except in the F5 probes, which exercise `gc.*` themselves. Fixed author/committer dates.

- **"2.56"** is git 2.56.0, the local Homebrew build and the target version.
- **"2.55"** is git 2.55.0, the A/B build invoked by absolute path.
- `<B>` is the probe's throwaway root. `<oid>` and `pack-<P>` are normalised hashes.
- Source citations name files from git's v2.56.0 tag.

## Requirements

1. With git 2.56.x on PATH, the whole integration project is green. Every row that changes
   follows git 2.56. No row is deleted to get there: each one is re-pinned, re-judged with a
   written reason, or replaced by a row that pins the new behaviour.
2. Every git-spawning CI job (`integration`; `posix-integration` on Linux and macOS;
   `win-integration`) runs one shared step. That step makes git 2.56.x available and fails
   the job, printing the version it found, when `git --version` is not 2.56.x. The version
   lives in one constant.
3. These tsgit behaviours match the 2.56 matrices below:
   - fsck exit bits and per-mode gating (F1);
   - fsck `connectivityOnly` over an unreadable loose object (F12);
   - gc-config read timing (F5);
   - the midx owner-unavailable recovery (F6);
   - merge-base pop order and early exit (F7);
   - the branch-delete bisect hold (F8);
   - armor CR stripping (F9);
   - the rebase rewritten-list for a dropped pick (F10);
   - bitmap source order (F11);
   - the gitfile refusal data (F4).
4. 31.8 closes. The per-entry CRC pass that already exists is proven against a fresh fixture
   under 2.56. The stale "no per-entry CRC pass" prose is corrected. A divergence the fresh
   fixture exposed (bit 2 on a corrupt base entry) is fixed in this change.
5. `docs/use/commands/*.md` and the ADRs listed per family stop describing 2.55 behaviour as
   current. Where tsgit behaviour changes, the ADR is superseded, not edited in place.

## Design

Row counts come from the 2.56 run on b105fcd0. Each of the 369 red rows is attributed to
exactly one family:

| Family | Suites (rows) | Total |
|---|---|---|
| F1 | rev-bitmap-fsck 59, fsck-pack-accessibility 20, alternates-gc-fsck 19, midx-fsck 17, maintenance 2, delta-pack 1, fsck 1 | 119 |
| F2 | fsck-object-table 8 | 8 |
| F3 | stash-apply-index-judge 82, stash-apply-type-change 82, stash 32, stash-push-reset 8, gitlink-consumers 2 | 206 |
| F4 | add-gitlink 11, status-gitlink 3 | 14 |
| F5 | maintenance 9, alternates-gc-fsck 1 | 10 |
| F6 | midx 4 | 4 |
| F7 | merge-base 1 | 1 |
| F8 | branch-delete-worktree 1 | 1 |
| F9 | commit-signing 2 | 2 |
| F10 | rebase 1 | 1 |
| F11 | alternates-acceleration 1 | 1 |
| F12 | fsck-pack-accessibility 2 | 2 |
| **Total** | | **369** |

### F1 — fsck exit bits and per-mode gating

**git commits.** a51b77a ("odb: provide infrastructure for pluggable fsck checks"), then
6bc7780, 426d291, 1bbb92d, ae7a0ff and 0d5ebb3. These move pack, rev-index, bitmap, midx
and loose verification into `odb/source-*.c`. 485f5ae ("don't check alternates with
--no-full") adds the alternate gating.

Source facts, read from v2.56.0:

- `builtin/fsck.c` keeps only `ERROR_OBJECT 01`, `ERROR_REACHABLE 02`, `ERROR_REFS 010`
  and `ERROR_COMMIT_GRAPH 020`.
- `odb_fsck()` runs only in the non-`--connectivity-only` branch. When it returns `< 0`,
  fsck sets `ERROR_OBJECT`.
- `odb_source_files_fsck` returns 0 for a non-local source unless `ODB_FSCK_FULL` is set.
  Otherwise it checks loose objects, then packs.
- `odb_source_packed_fsck` runs `verify_packs` only under `ODB_FSCK_FULL`. It always runs
  `verify_reverse_indices`, `verify_bitmap_files` and `verify_midx`.

**Rows affected (119).**

- rev-bitmap-fsck: 59.
- fsck-pack-accessibility: 20 (22 red minus the 2 F12 rows).
- alternates-gc-fsck: 19 (20 red minus the F5 row).
- midx-fsck: 17.
- maintenance: 2 (the in-window rows: "fsck flags it", 4 → 1).
- delta-pack: 1 ("exits 6" → 3).
- fsck-interop: 1 ("both exit 4" → 1).

**Pinned matrix, local source.** The fixture has 3 commits and one pack, with reflogs
expired. Corruption methods:

- `idx-crc`: the first `.idx` CRC is flipped and the `.idx` trailer restamped.
- `pack-body`: the middle byte of `.pack` is flipped, with no restamp.
- `.rev`, `.bitmap` and midx bitmap: the middle byte is flipped.
- `midx checksum`: the last byte of `multi-pack-index` is flipped.

| Corruption | default 2.56 / 2.55 | `--connectivity-only` 2.56 / 2.55 | `--no-full` 2.56 / 2.55 |
|---|---|---|---|
| none (control) | 0 / 0 | 0 / 0 | 0 / 0 |
| idx-crc | **1** / 4 | 0 / 0 | 0 / 0 |
| pack-body | **3** / 6 | 0 / 0 | 0 / 0 |
| `.rev` | **1** / 64 | **0** / 64 | **1** / 64 |
| pack `.bitmap` | **1** / 128 | **0** / 128 | **1** / 128 |
| midx checksum | **1** / 32 | **0** / 32 | **1** / 32 |
| midx `.bitmap` | **1** / 128 | **0** / 128 | **1** / 128 |

Stderr lines are byte-identical across versions in every cell. Only the exit status changes.

- idx-crc prints:
  `error: index CRC mismatch for object <oid> from .git/objects/pack/pack-<P>.pack at offset 12`.
- `.rev` prints three lines: `error: invalid checksum`,
  `error: invalid rev-index position at 8: 1 != 4278190081` and
  `error: invalid rev-index for pack '.git/objects/pack/pack-<P>.pack'`.
- pack `.bitmap` prints:
  `error: bitmap file '.git/objects/pack/pack-<P>.bitmap' has invalid checksum`.
- midx checksum prints `incorrect checksum`.

**Pinned matrix, alternate donor.** The borrower is clean and its `objects/info/alternates`
names a corrupted donor.

| Donor corruption | default 2.56 / 2.55 | `--connectivity-only` | `--no-full` 2.56 / 2.55 |
|---|---|---|---|
| `.rev` | **1** / 64 | **0** / 64 | **0** / 64 |
| pack `.bitmap` | **1** / 128 | **0** / 128 | **0** / 128 |
| midx checksum | **1** / 32 | **0** / 32 | **0** / 32 |
| idx-crc ¹ | **1** / 4 | 0 / 0 | 2 / 2 |
| pack-body ¹ | **3** / 6 | 0 / 0 | 2 / 2 |
| loose commit body `garbage` ² | 1 / 1 | — | **2** / 1 |

¹ The borrower's reflogs were not expired in these two rows. Under `--no-full`, both
versions print `error: HEAD: invalid reflog entry <oid>` (bit 2), so those cells are noise
and unchanged.

² Under `--no-full`, 2.56 no longer reads the donor's loose store. The borrower's tip, a
**valid** commit that lives only as a donor loose object, is reported as
`missing commit <oid>` and the exit is 2. 2.55 audited the donor and reported the bad
object: `error: bogus commit object <oid>` plus `error: <oid>: object could not be parsed:
<donor path>`, exit 1. This reproduces the alternates-gc-fsck row "donor loose file … (no-full)",
which expected 1 and now gets 2. See D-F1b.

**The 2.56 model tsgit must follow:**

```
exit = 1  if any content/corrupt/hash finding, or any pack / midx / rev / bitmap finding
     | 2  if missing / unresolved-link
     | 8  refs
     | 16 commit-graph
gating:
  connectivityOnly → no pack, rev, bitmap or midx verification at all
  default (full)   → per source: loose, packs (verify_pack), rev, bitmap, midx
  --no-full        → local source only: loose, rev, bitmap, midx (no verify_pack);
                     a non-local source is skipped entirely, including its loose objects
```

**Decision:** follow. The constant shape is D-F1a. The `--no-full` alternate-loose "missing"
consequence is D-F1b, because it looks like a git defect.

**tsgit code to change.**

- `src/application/commands/internal/fsck/exit-codes.ts`:
  - delete `EXIT_PACK = 4`, `EXIT_MULTI_PACK_INDEX = 32`, `EXIT_PACK_REV_INDEX = 64` and
    `EXIT_BITMAP = 128` (D-F1a). Their findings now OR in `EXIT_CORRUPT` (1);
  - rewrite the header comment, which currently pins 2.54/2.55, to name 2.56.0.
- `src/application/commands/fsck.ts`, `fsck(ctx: Context, opts: FsckOptions = {}): Promise<FsckResult>`
  (L130). The exit fold is at L589–595. The mode gates are:
  - L112: `opts.full === false` → `'probe-packs'`;
  - L298: `includePacks: opts.full !== false`;
  - L332: content validation skipped under `connectivityOnly`.

  Add the 2.56 gates:
  - rev-index, bitmap and midx passes do not run under `connectivityOnly`;
  - under `full === false`, every non-local source is dropped from the audit universe,
    including its loose objects.
- Per-pass bit sources:
  - `src/application/commands/internal/fsck/pack-health.ts` (EXIT_PACK users);
  - `verify-pack.ts`: `verifyEntry` L78 `exitBit: (crc.length > 0 ? EXIT_PACK : 0) | …`;
  - `rev-index-health.ts`, `bitmap-health.ts`, `midx-health.ts`;
  - `content-validation.ts`, where `unparseable-object` with `pack` sets 1|4.

  Each "bit 4/32/64/128" becomes bit 1. Ungated rev-index findings (ADR-586) become gated.

**Tests to change.**

- Every exit literal and table in rev-bitmap-fsck, fsck-pack-accessibility, alternates-gc-fsck,
  midx-fsck, delta-pack (L719 "exits 6" → 3), fsck-interop ("both exit 4" → 1) and
  maintenance (in-window rows 4 → 1).
- Row titles that say "bit 32" or "exit 68" are renamed to the 2.56 value.
- The fsck-pack-accessibility "mode gating" table is re-pinned against the matrix above,
  e.g. "corrupt idx, `--connectivity-only`": 64 → 0.
- Unit tests in `test/unit/application/commands/internal/fsck/*` that assert 4/32/64/128 are
  updated.

**Docs and ADRs.**

- `docs/use/commands/fsck.md`: the exit-bit table and every "Exit bit 4/32/64/128" in the
  finding table.
- `docs/design/fsck.md` and `docs/design/fsck-pack-accessibility-reporting.md`: bit sections.
- Supersede ADR-586 ("exit bit 64 is modeled with an ungated finding": both halves change).
- Amend ADRs 601, 603, 607, 608 and 920 where they name bits.
- Supersede ADR-919 ("fsck audits every object source"), because `--no-full` now skips
  alternates.

### F2 — fsck loose unparseable-object wording

**git commit:** 301a1ce, "use fsck_obj_buffer() when checking loose objects".
**Rows affected:** fsck-object-table, 8.

| Fixture (local loose object, valid zlib, hash matches) | 2.56 stderr | 2.55 stderr | exit |
|---|---|---|---|
| `commit` body `garbage-not-a-commit` | `error: bogus commit object <oid>` + `error: <oid>: object corrupt or missing` | the same first line, then `error: <oid>: object could not be parsed: .git/objects/5c/3a4a…` | 1 / 1 |
| `tag` body `nonsense` | `error: <oid>: object corrupt or missing` | `error: <oid>: object could not be parsed: .git/objects/be/3559…` | 1 / 1 |
| `tree` body `xx` | unchanged (`too-short tree object`, `badTree`) | same | 1 / 1 |
| empty loose file (default mode) | `error: <oid>: object corrupt or missing: .git/objects/ab/ccc…` (**path kept**) | same | 1 / 1 |

The same bytes appear under `--no-full`.

**Decision:** follow. This is message-only and the finding data
(`unparseable-object { id, pack? }`) is unchanged. The empty-file row shows that the path
form survives for a different finding, the read failure. Only the parse-failure line loses
the path.

**Code:** none.

**Tests:** `test/integration/fsck-object-table-interop.test.ts` `errorLines` (L351–358). The
loose branch becomes `` `error: ${f.id}: object corrupt or missing` ``, the same line the
pack branch already uses. Drop `looseRelativePath` if it ends up unused.

**Docs:** `docs/use/commands/fsck.md` L175 (`unparseable-object` row). Git's line is now the
same for loose and packed copies.

### F3 — stash exit status: 1 only for conflicts, 128 for every other failure

**git commit:** 786fc39, "stash: reserve exit status 1 for conflicts". `cmd_stash()` maps a
negative return to 128 for every subcommand.

**Rows affected (206).** stash-apply-index-judge 82, stash-apply-type-change 82, stash 32,
stash-push-reset 8 and gitlink-consumers 2. In stash, the 32 rows split three ways: 22
occupant rows go through a `runGit` that throws on exit 128, 6 go through a helper that
tolerates only 1 (L624), and 4 compare against `toBe(1)`.

| Shape | 2.56 exit | 2.55 exit | stderr (identical) |
|---|---|---|---|
| apply with a merge conflict | 1 | 1 | — |
| pop with a merge conflict (stash kept) | 1 | 1 | — |
| apply refused: local changes would be overwritten | **128** | 1 | `error: Your local changes to the following files would be overwritten by merge:` … `Aborting` |
| `apply --index`: index conflict | **128** | 1 | `error: patch failed: f:1` / `error: f: patch does not apply` / `error: conflicts in index. Try without --index.` |
| apply `-u` stash: untracked occupant | **128** | 1 | `u already exists, no checkout` / `error: could not restore untracked files from stash` |
| apply/pop: merge conflict **and** untracked occupant | **128** | 1 | same two lines (the merge is written and `f` holds conflict markers; pop keeps the stash) |
| push on an unmerged index | **128** | 1 | `error: could not write index` |
| push: tracked path beyond a symlink | **128** | 1 | `error: 'd/x' is beyond a symbolic link` / `fatal: Unable to process path d/x` / `Cannot save the current worktree state` |
| push: `core.safecrlf=true` lossy file | **128** | 1 | `fatal: CRLF would be replaced by LF in f` / `Cannot save the current worktree state` |
| `stash branch <existing>` | **128** | 1 | `fatal: a branch named 'exists' already exists` |
| `apply stash@{3}` with no such entry | **128** | 1 | `error: stash@{3} is not a valid reference` |
| `drop` / `show` with no entries | **128** | 1 | `No stash entries found.` |

**Decision:** follow. tsgit carries no exit status on stash, so every row except one is a
test-constant change. The exception is the "conflict + unrestored untracked" shape. git 2.56
now classes it as a failure (128) and no longer as a conflict (1). tsgit returns
`{ kind: 'conflict', …reportOf(restore) }` from `reportApply`
(`src/application/commands/stash.ts` L1358–1373, `/** Leaving a stashed path unwritten is a
failure, as git exits 1 there. */`). Whether that shape keeps returning or starts throwing is
D-F3.

**Tests to change.**

- `stash-push-reset-interop.test.ts` L63: `GIT_REFUSAL_EXIT = 1` → 128.
- `stash-apply-index-judge-interop.test.ts`: L625/635 `refuses` and `unclean` rows → 128.
  L644 `merge-conflicts` stays 1.
- `stash-apply-type-change-interop.test.ts`:
  - L164, L210 (`REFUSED`), L254 and L259: `exit: 1` → 128;
  - L211 `CONFLICTED` stays 1;
  - L188 `RESTORE_STOPPED` → 128;
  - any `CONFLICTED` row that carries a `report` → 128, per D-F3.
- `stash-interop.test.ts`:
  - L337/397/426/671 → 128;
  - L624, the beyond-symlink tolerance, accepts 128;
  - the occupant rows (L500 onward) must not use a throwing `runGit` for the refused git
    run. Use `tryRunGitWithExit` and assert the exit.
- `gitlink-consumers-interop.test.ts` L289: `REFUSED_EXIT_STATUS = 1` is shared with
  non-stash commands at L316. Split out a stash-only constant (128) and leave the other
  users unchanged. L63 `CONFLICT_EXIT_STATUS` stays 1.

**Docs and ADRs.**

- `docs/use/commands/stash.md`: exit wording.
- Amend the "exits 1" prose in ADRs 1091, 1092, 1096, 1097 and 1101. tsgit behaviour is
  unchanged there apart from D-F3, so these are amendments, not supersessions.
- Fix the `reportApply` comment.

### F4 — gitfile names an invalid repository

**git commit:** 54a441b, "read_gitfile(): simplify NOT_A_REPO error message". From
`setup.c` v2.56.0 L946–948:
`die(_("gitfile does not point to a valid repository: %s"), path)`, where `path` is the
gitfile itself.

**Rows affected (14):** add-gitlink 11 (assertion L867) and status-gitlink 3 (L952).

| `sub/.git` | command | 2.56 stderr (exit 128) | 2.55 stderr (exit 128) |
|---|---|---|---|
| gitfile `gitdir: ../.git/modules/sub`, target missing | `status`, `add -- .` | `fatal: gitfile does not point to a valid repository: sub/.git` | `fatal: not a git repository: sub/../.git/modules/sub` |
| gitfile `gitdir: <B>/nothing` (absolute) | `status`, `add -- .` | `fatal: gitfile does not point to a valid repository: sub/.git` | `fatal: not a git repository: <B>/nothing` |
| gitfile → module dir whose HEAD is garbage | `status` | `…valid repository: sub/.git` | `fatal: not a git repository: sub/../.git/modules/sub` |
| gitfile → module dir whose `commondir` names nothing | `add -- .` | `…valid repository: sub/.git` | `fatal: not a git repository: sub/../.git/modules/sub` |
| `.git` **directory**, HEAD garbage | `add -- .` | `fatal: 'sub/.git' not recognized as a git repository` | same (unchanged) |
| `.git` **symlink** to a dir, HEAD garbage | `add -- .` | `fatal: 'sub/.git' not recognized as a git repository` | same (unchanged) |
| run *inside* `sub` (discovery) | `status` | `fatal: gitfile does not point to a valid repository: <B>/r/sub/.git` | `fatal: not a git repository: (null)` |

**Decision:** follow. git now names the gitfile, as the gitlink path joined with `.git`, for
every gitfile route regardless of where the pointer leads. The pointed-to path no longer
appears. tsgit's data today carries the **target**: `GitlinkCheckout` `{ kind: 'broken';
shown }`, with `shown` built from the pointer at
`src/application/primitives/internal/gitlink-head.ts` L335–343. It is thrown as
`notARepository(checkout.shown)`, code `NOT_A_REPOSITORY`, message built at
`src/domain/error.ts` L441–442.

Directory and symlink routes already use `dotGitShown(path)` with git's unchanged "not
recognized" wording. If both routes ended up with the same path, the test could no longer
tell which wording to rebuild. The data shape is D-F4.

**Code to change** (shape per D-F4):

- `gitlink-head.ts`: `broken(shown)` callers on the gitfile route (L97, L101, L161, L163,
  L334–343) carry the gitfile path.
- `gitlinkHeadOf` L73–83.
- `src/application/commands/internal/submodule-absorb.ts` L132 and
  `src/application/commands/internal/submodule-state.ts` L73, which throw the same error.

**Tests:**

- `add-gitlink-interop.test.ts` L867: `line(refusal.path…)` rebuilds the new wording.
- `status-gitlink-interop.test.ts` L952: `gitMessage`.
- Unit tests for `gitlink-head`.

**Docs:** `docs/use/commands/add.md` and `docs/use/commands/status.md` refusal sections,
plus the error-code doc entry.

**Out of scope:** the discovery row (`openRepository` inside a broken gitfile worktree).
tsgit's `find-layout.ts` L230 refusal is not exercised by any red row.

### F5 — gc config read lazily; gc's failure cascade lines

**git commits:** 57ca517, cc78c50 and 0a77889. The files-backend optimisation moved into
`odb/source-files.c`, and `cmd_gc` now calls `maintenance_task_odb()`.

**Rows affected (10):** maintenance 9 (4 config-first rows and 5 stderr rows) and
alternates-gc-fsck 1 (the `core.deltaBaseCacheLimit` row).

**(a) Config read timing.** Each malformed key below is passed as `-c <kv>`. Cells read
2.56 / 2.55.

| key | `gc --auto` | `maintenance run --task=commit-graph` | `maintenance run --task=gc` |
|---|---|---|---|
| `gc.auto=bogus` | 128 / 128 | **0** / 128 | **1** / 128 |
| `gc.autoPackLimit=3g` | 128 / 128 | **0** / 128 | **1** / 128 |
| `gc.bigPackThreshold=-0` | **0** / 128 | **0** / 128 | **1** / 128 |
| `gc.cruftPacks=maybe` | 128 / 128 | 128 / 128 | 128 / 128 |
| `gc.pruneExpire=all` | 128 / 128 | 128 / 128 | 128 / 128 |
| `gc.worktreePruneExpire=2099-01-01` | 128 / 128 | 128 / 128 | 128 / 128 |
| `gc.logExpiry=garbage` | 128 / 128 | 128 / 128 | 128 / 128 |

The refusal lines are unchanged, for example
`fatal: bad numeric config value 'bogus' for 'gc.auto': invalid unit`.

More 2.56 detail for the three lazy keys:

- `maintenance run --task=gc` prints the fatal line, then `error: task 'gc' failed`, and
  exits 1.
- `maintenance run --auto --task=gc` exits 128 for `gc.auto` and `gc.autoPackLimit`. For
  `gc.bigPackThreshold` it exits 0 and declines on the tiny repo.
- An explicit `gc` exits 128 for all three keys.
- With `gc.auto=bogus`, `--task=gc --task=commit-graph` and `--task=commit-graph --task=gc`
  both exit 1. Both write `commit-graphs/commit-graph-chain` plus one `graph-<hash>.graph`,
  so a failed gc task does not stop the commit-graph task.

So `gc.auto`, `gc.autoPackLimit` and `gc.bigPackThreshold` are read only once the gc step
needs them: the auto gate reads the first two, the pack step reads the third. The other
four keys are still read eagerly.

**(b) stderr when gc's pack step fails.** The fixtures are the maintenance suite's
bad-tree and size-lying-loose rows.

| run | 2.56 stderr tail | 2.55 stderr tail | exit |
|---|---|---|---|
| `git gc` | `…is corrupt\n` + `error: failed to run (null)\n` | `…is corrupt\n` + `fatal: failed to run repack\n` | 128 / 128 |
| `maintenance run --task=gc` | `…\nerror: failed to run (null)\nerror: task 'gc' failed\n` | `…\nfatal: failed to run repack\nerror: task 'gc' failed\n` | 1 / 1 |

Cause, from `odb/source-files.c` v2.56.0 L730–731:
`error("failed to run %s", repack_cmd.args.v[0])` reads argv **after** `run_command()`
cleared it, so it prints `(null)` on both glibc and macOS C library. `cmd_gc` then calls
`die(NULL)` (`builtin/gc.c` L725–726), which adds no line.

**(c) `gc` with `core.deltaBaseCacheLimit=bogus`, exit 128 on both versions.**

- 2.55 prints one line:
  `fatal: bad numeric config value 'bogus' for 'core.deltabasecachelimit' in file .git/config: invalid unit`.
- 2.56 prints four lines, in this order: that same line, `error: failed to run pack-refs`,
  the same line again, then `fatal: failed to run worktree`.
- With `-c` the bytes are the same minus ` in file .git/config`.

**Decision:** follow (a). Follow (b) and (c) in the test reconstruction, per D-F5b.

**Code to change.**

- `src/application/primitives/internal/gc-config-guard.ts`:
  - `assertValidLeadingGcConfig` (L37) loses `auto` and `autoPackLimit`;
  - `assertValidTrailingGcConfig` (L44) loses `bigPackThreshold`.
- `src/application/commands/internal/gc-pipeline.ts` `readGcSettings(ctx): Promise<GcSettings>`
  (L130):
  - stops validating the three lazy keys;
  - they are validated only when the gc step itself runs. `gc.auto` and then
    `gc.autoPackLimit` are validated at the step's start: before the auto gate under
    `auto`, or before the pack step otherwise. An explicit `gc` refuses all three (pinned:
    128).
  - `gc.bigPackThreshold` is validated only at the pack step, so a declining auto gate
    never reads it.
- `src/application/commands/maintenance.ts` `maintenance()` (L205–220): a lazy-key refusal
  inside the non-auto gc task becomes a `tasksFailed` entry and the loop continues, matching
  git's exit 1. Under `auto`, gc's in-process gate dies, so the refusal is thrown.
- The shape of that `tasksFailed` entry is D-F5a.

**Tests to change.**

- `maintenance-interop.test.ts` L838–883: re-pin the table. The commit-graph run expects 0
  for the three lazy keys and keeps 128 for the other four. Add `maintenance run --task=gc`
  as a third run with the 1 / `task 'gc' failed` expectation.
- L2326, L2427 and L2447 reconstructions.
- The alternates-gc-fsck `core.deltaBaseCacheLimit` reconstruction.

**Docs:** `docs/use/commands/maintenance.md` and `docs/use/commands/gc.md` (config-validation
sections). No ADR pins the eager read (`grep -l "gc.bigPackThreshold" docs/adr` → none).

### F6 — midx names a removed or unreadable owner pack

**git commit:** 8f909ff, "packfile: recover when a multi-pack-index names a removed pack".

From `odb/source-packed.c` v2.56.0 L22–68, `find_pack_entry`:

1. `midx_fill_entry` returns HIT, MISS or OWNER_UNAVAILABLE. OWNER_UNAVAILABLE means
   `prepare_midx_pack` failed or `!is_pack_valid(p)`.
2. The `!p->multi_pack_index` fallback runs next.
3. **Only when** the result is OWNER_UNAVAILABLE **and** `flags & OBJECT_INFO_SECOND_READ`,
   git scans every midx pack across all layers (`m->num_packs + m->num_packs_in_base`) and
   serves the first `packfile_fill_entry` hit.

QUICK callers skip the second read and keep the false negative.

**Rows affected (4):** midx-interop h2, h3, h4 and the chain row L1266. The "documented
divergence" row h5 (L821) is re-judged: under 2.56, plain git (no config) also reads the
object, so the row is rewritten to "both read".

Fixture: blob X sits in pack A (X only) and pack B (X and O, newer). The midx assigns X to B.

| Victim | 2.56: `batch-check` / `cat-file -p` / `cat-file -e` | 2.55 |
|---|---|---|
| B fully deleted (.pack, .idx, .rev) | `<X> blob 4` / 0 / 0 | `<X> missing` / 128 `fatal: Not a valid object name <X>` / 1 |
| B `.pack` deleted, `.idx` kept | `<X> blob 4` / 0 / 0 | `<X> missing` / 128 / 1 |
| B `.pack` chmod 000 | `<X> blob 4` / 0 / 0 | `<X> missing` / 128 / 1 |
| A (non-owner) deleted, any way | read / 0 / 0 | read / 0 / 0 |

**Decision:** follow. tsgit today:

- `findMidxHit(midx: LoadedMidx, id: ObjectId): PackLookupHit | undefined`
  (`src/application/primitives/internal/midx-binding.ts` L123) returns `undefined` when the
  owner never bound.
- `PackRegistry.lookup` (`src/application/primitives/pack-registry.ts` L1306–1317) falls
  through to `lookupViaIdxScan`, which skips claimed packs.
- The second read is `rescanOnFullMiss` (`src/application/primitives/internal/pack-miss-rescan.ts`)
  driving `store.reprepare()`.
- `hasObject` (`src/application/primitives/has-object.ts`) runs in `'quick'` mode by default
  (no retry) or `'recheck'`.

**Code to change** (placement per D-F6):

- `findMidxHit` returns a tri-state, `hit | miss | owner-unavailable`.
- The second-read path gets a registry operation that scans the midx's bound packs in
  `PNAM` order across layers, base layers first, matching git's
  `0 … num_packs + num_packs_in_base`. It is reached only after the reprepare retry missed.
  Quick `hasObject` never reaches it.
- Concurrency, parity and cost, as the memory note demands:
  - no registry teardown and no pack re-listing beyond what `reprepare()` already did;
  - the scan reads only `.idx` lookups of already-bound packs;
  - no name-keyed cache (packs are keyed by instance);
  - cost is O(packs) per miss, and only on the owner-unavailable second read.

**Tests:**

- `midx-interop.test.ts` L764–862 and L1266: `missing` → the read succeeds.
- Add a QUICK row through tsgit's `hasObject` default mode (false negative kept). git has no
  porcelain QUICK probe in these rows, so that row is unit-level only.

**ADRs:** supersede ADR-592 ("midx is authoritative for named packs") on the
owner-unavailable branch only.

### F7 — merge-base paint queue

**git commits:** 02d7ba0 ("terminate merge-base walk when one paint side is exhausted"),
a3e5bad (`paint_state` with per-side counters), 56c9056 ("remove commit-date ordering
fallback") and ae68032 (`!FIND_ALL` early exit guarded by `last_gen < topo_ceiling`).

From `commit-reach.c` v2.56.0 L79–275:

- The queue is always `compare_commits_by_gen_then_commit_date`. The date-only fallback is
  gone.
- `topo_ceiling = corrected_commit_dates_enabled ? GENERATION_NUMBER_INFINITY :
  GENERATION_NUMBER_V1_MAX`.
- `paint_queue_get` returns NULL when no merge-base candidate is queued and either side's
  count is 0 **and** `generation < topo_ceiling`, or both sides are empty. Each queued
  non-stale commit is counted in exactly one bucket: P1-only, P2-only or both.
- The single-result break fires when `state.last_gen < state.topo_ceiling`.

**Rows affected:** merge-base, 1. The fixture rebuilds the test's plumbed history (L618–664):
`deep@…103` sits at topological level 4, and `shallow@…500` is a root at level 1.

| graph | 2.56 `merge-base` / `--all` | 2.55 |
|---|---|---|
| none | `shallow` / `shallow deep` | same |
| `commitGraph.generationVersion=1` | **`deep`** / `shallow deep` | `shallow` / `shallow deep` |
| default (v2) | `shallow` / `shallow deep` | same |

**Decision:** follow. Port the 2.56 algorithm. The side-exhaustion exit is a termination
change, and the flag map it leaves feeds `removeRedundant`. Port it alongside so the flags
match git's, then prove result parity on every existing merge-base row (lesson 015).

**Code to change**, all in `src/application/primitives/merge-base.ts`:

- `comparatorFor` (around L295) always returns `byGenerationThenDate`; delete `byDate`'s
  sole use if it is left unused.
- `makePaintQueue` (L307) keeps P1, P2 and candidate counters updated on `mark`, removing
  the old bucket and adding the new one when an already-queued id changes bits, as
  `paint_queue_put` does. `pop` applies `paint_queue_get`'s exits in place of
  `hasNonStale` (L173), which goes away.
- `visit` (L336): the `!findAll` break condition becomes
  `entry.generation < topoCeiling`.
- `PaintOptions` gains `topoCeiling`, derived from `correctedCommitDates`.
- `GENERATION_NUMBER_V1_MAX = 0x3fffffff` currently lives privately in
  `src/application/commands/internal/fsck/commit-graph-verify.ts` L40. Move it to
  `src/application/primitives/internal/read-commit-meta.ts`, next to `GENERATION_INFINITY`,
  and import it from both places.

**Tests:**

- `merge-base-interop.test.ts` L655: `toEqual([ids.get('shallow')])` →
  `[ids.get('deep')]`, and retitle the row.
- Run the whole merge-base family, plus every command built on `mergeBase` (merge, rebase,
  `log A...B`), at the gate.
- Unit tests:
  - side-exhaustion exit;
  - the `topoCeiling` break under v1 and v2;
  - counter bucket moves on re-mark.

**ADRs:** supersede ADR-840 ("merge-base orders its paint by generation then date with or
without a graph"), because the date-only swap is removed.

### F8 — `branch -d/-D` on a branch a worktree is bisecting

**git commit:** 7780bff. From `builtin/branch.c` v2.56.0 L286–297, `branch_bisecting()` is
checked **before** `branch_checked_out()`. `branch.c` L488–498 returns the **first** bisect
registration in worktree order, whereas `branch_checked_out` keeps the last registration
for a branch.

**Rows affected:** branch-delete-worktree, 1 (L273).

| Holder of `sidecar` | 2.56 stderr (exit 1) | 2.55 |
|---|---|---|
| linked worktree, plain checkout | `error: cannot delete branch 'sidecar' used by worktree at '<B>/wt'` | same |
| linked worktree, `bisect start` (HEAD still on branch) | `… used by worktree at '<B>/wt' for bisect` | `… used by worktree at '<B>/wt'` |
| main worktree bisecting `sidecar`, HEAD detached | `… used by worktree at '<B>/r' for bisect` | `… used by worktree at '<B>/r'` |

**Decision:** follow. The data must let the test rebuild ` for bisect`; the shape is D-F8.

**Code to change.**

- `src/application/commands/branch.ts` `assertNoWorktreeHolds(ctx: Context, name: RefName): Promise<void>`
  (L186–189) checks the bisect hold first, then the checkout hold.
- `src/application/commands/internal/checked-out-branches.ts`:
  - `bisectingBranch` (L72) stays as is;
  - add an exported `worktreeBisecting(ctx, name): Promise<FilePath | undefined>`, which
    walks `listWorktrees` and returns the first worktree whose bisect claims `name`;
  - `heldBranches` (L103) is unchanged for its other caller, `fetch.ts`.
- Error: `branchCheckedOut(branch, path)` (`src/domain/worktree/error.ts` L24,
  `BRANCH_CHECKED_OUT`), extended per D-F8.

**Tests:**

- `branch-delete-worktree-interop.test.ts` L45–47 line builder and the L273 row.
- Add a row with two worktrees, one holding `sidecar` checked out and a later one bisecting
  it. It pins that the bisect path wins.

**Docs:** `docs/use/commands/branch.md` refusal list.

### F9 — signing: only a CR directly before LF is stripped

**git commit:** 5dea8b6. From `gpg-interface.c` v2.56.0 L994–1006,
`strip_cr_before_lf` removes a `\r` only when the next byte is `\n`. The openpgp path
(L1050) and the ssh path use the same function.

**Rows affected:** commit-signing, 2 (openpgp and ssh, L471).

The probe used a canned `gpg.program` that writes `SIG_CREATED` and this armor:
`-----BEGIN PGP SIGNATURE-----\r\n\r\nab\rcd\r\nef\r\r\n-----END PGP SIGNATURE-----\r\n`.

| Version | stored `gpgsig` continuation bytes |
|---|---|
| 2.56 | `\n \n ab\rcd\n ef\r\n -----END…` (a lone CR is kept; `\r\r\n` → `\r\n`) |
| 2.55 | `\n \n abcd\n ef\n -----END…` (every CR dropped) |

**Decision:** follow.

**Code:** `src/application/primitives/sign-payload.ts`:

- L57 `CARRIAGE_RETURNS = /\r/g` → `/\r(?=\n)/g`;
- L61 comment;
- L152 docblock.

**Tests:**

- The `commit-signing-interop.test.ts` rows already compare oids, so they go green once the
  code changes.
- Unit tests for the armor CR stripper:
  - a lone CR kept;
  - `\r\r\n` → `\r\n`;
  - a trailing `\r` at end of buffer kept. This expectation comes from the source
    (`i + 1 < buffer->len`), not a probe. The implementer pins it with a canned signer
    before writing the test.
- Add a property sibling (CR stripper idempotence, and no `\r\n` left in the output).

**Docs:** `docs/use/commands/commit.md` signing section, if it mentions CR stripping.

### F10 — rebase: a dropped pick is not recorded as rewritten

**git commit:** 42554b7, "sequencer: do not record dropped commits as rewritten".

**Rows affected:** rebase, 1 (L1626–1650).

The fixture is `buildOccupied(false)` with untracked `n` planted. The probe ran
`rebase --onto W base`, where W is already in the target.

| Version | outcome | `.git/rebase-merge` |
|---|---|---|
| 2.56 | `dropping <W> W -- patch contents already upstream`, then the refusal on X, exit 1 | no `rewritten-list` |
| 2.55 | same stdout and exit | `rewritten-list` = `<HEAD> <HEAD>` |

Control: `rebase -i --no-ff base`, whose first pick is a real fast-forward and is not
dropped, writes `rewritten-list` = `<HEAD> <HEAD>` on **both** versions.

**Decision:** follow.

**Code:** `src/application/commands/rebase.ts` `advanceFlat` (L761): `case 'empty'` (L774–778)
stops pushing `[pick, flat.cur]` into `flat.rewritten`. It still calls
`removeAutoMerge(ctx)`. Fix the comment at L774.

The interactive replay's equivalent drop arm gets the same change. It is located with
`grep -n "'empty'" src/application/commands/rebase.ts` at implementation time, and a row pins
it before the change (lesson 015).

**Not followed here:** "skipped commits" and "edit with dropped commit". git's own commit
message says those are still recorded and left for later. No row exercises them.

**Tests:** the L1648 snapshot goes green. Add an interactive drop row with a refused next line.

**Docs:** `docs/use/commands/rebase.md` state-file notes.

### F11 — bitmap opening is per source

**git commit:** eaa9807 ("pack-bitmap: iterate object sources when opening bitmaps"), with
8cd7ee7. From `pack-bitmap.c` v2.56.0 L712–735, `open_bitmap` walks the sources in order.
For each source, `open_bitmap_for_source` tries that source's midx bitmap and then its pack
bitmaps, and the loop stops at the first one found. 2.55 opened every source's midx first
(`open_midx_bitmap`), which loaded the donor midx and died on its signature.

**Rows affected:** alternates-acceleration, 1 (L496–526).

The fixture: the donor has 3 empty commits, `repack -ad` and `multi-pack-index write`. The
borrower is `clone --shared` plus one commit. The donor midx signature is smashed to `XXXX`.

| Borrower layout | command | 2.56 | 2.55 |
|---|---|---|---|
| `repack -ad --write-midx --write-bitmap-index` | `rev-list --objects --use-bitmap-index HEAD` | **0** | 128 `fatal: multi-pack-index signature 0x58585858 does not match signature 0x4d494458` |
| same | `rev-list --count --use-bitmap-index HEAD` | **0** | 128 (same line) |
| same | `rev-list --objects HEAD` (no bitmap) | 0 | 0 |
| same | `fsck --connectivity-only` | 128 (same line) | 128 |
| `repack -adl --write-bitmap-index` (no bitmap written: "disabling bitmap writing") | `rev-list --objects --use-bitmap-index HEAD` | 128 | 128 |

**Decision:** follow.

**Code:** `src/application/primitives/internal/closure-engine.ts` `tryBitmapClosure`
(L648–668). Replace the three loops (assert every source, then every source's midx bitmap,
then every pack bitmap) with one loop per source:

```
registry.assertLoadable()
midx bitmap → answer
else that source's pack bitmaps → answer
else next source
```

Fix the comment at L652–655.

**Tests:**

- L496 row: git exits 0, and tsgit's closure answers at the bitmap tier with git's ids.
- The L459 pack-bitmap row stays as it is: refuse.
- Unit tests:
  - the first source's midx bitmap answers before any later source is loaded;
  - a first source with only a pack bitmap answers before a later source's midx bitmap.

### F12 — fsck `--connectivity-only` dies on an unreadable loose object

**Rows affected:** fsck-pack-accessibility, 2 ("chmod-000 loose object", "empty loose
object", both `connectivityOnly`).

**git commit:** not attributed. The behaviour sits on the 2.56 `odb_for_each_object` path
that `mark_object_for_connectivity` now goes through. 204daf5 ("odb: introduce object
filters to `odb_for_each_object()`") is the candidate. The plan confirms it by reading
`odb/source-loose.c` v2.56.0 before the RED row.

| Unreferenced loose object | `fsck --connectivity-only` 2.56 | 2.55 |
|---|---|---|
| empty file `ab/ccc…` | exit **128**: `error: object file .git/objects/ab/ccc… is empty` ×3, then `fatal: loose object <oid> (stored in .git/objects/ab/ccc…) is corrupt` | exit 0: `dangling unknown <oid>` plus `error:` lines and `Unknown object type` |
| chmod 000 | exit **128**: `error: unable to open loose object <oid>: Permission denied` ×3, then `fatal: loose object <oid> (stored in …) is corrupt` | exit 0: `dangling unknown <oid>` … |
| empty file, **default** mode | exit 1, unchanged | exit 1 |

**Decision:** follow or diverge is D-F12. git has this die (lesson 017 is satisfied), but it
looks like a regression.

**Code if followed:** `src/application/commands/fsck.ts` L268,
`unreadable: UnreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip'`. Under
`connectivityOnly`, an unreadable loose object refuses with the existing
`LOOSE_OBJECT_CORRUPT` code (`src/domain/error.ts` L369–370) instead of the `classify` arm.
This applies only to an object the enumeration reaches.

**Tests:** the two rows assert `git.exitCode` 128 plus the fatal line, and tsgit's typed
refusal. Their "dangling unknown" findings assertions go away.

### 31.8 closure — fsck per-entry pack CRC

**What exists.** #313 already shipped the pass.

- `src/application/commands/internal/fsck/verify-pack.ts`:
  - `verifyEntry` (L78–99) computes `crc32(bytes)` against the `.idx` CRC at L86. On a
    mismatch it emits `pack-crc-mismatch` (`crcMismatch`, L168) with exit bit `EXIT_PACK`
    (L98);
  - `verifyEntriesInOrder` (L142) and `runVerifyPackPass` (L201) wire it into fsck.
- Interop pins:
  - `test/integration/fsck-pack-accessibility-interop.test.ts` L1540 and L1676;
  - `test/integration/alternates-gc-fsck-interop.test.ts` L622, L1024 and L1191;
  - `test/integration/delta-pack-interop.test.ts` L719;
  - `test/integration/fsck-interop.test.ts` L1738 onward.

**Fresh fixture.** 3 commits, one pack from `repack -ad`, reflogs expired. Columns are git
2.56 against tsgit on b105fcd0; the 2.55 git value is in brackets.

| Corruption | mode | git 2.56 [2.55] | tsgit (b105fcd0) |
|---|---|---|---|
| idx-crc (first `.idx` CRC flipped, trailer restamped) | default | 1 [4]: `error: index CRC mismatch for object <oid> from .git/objects/pack/pack-<P>.pack at offset 12` | 4: `pack-crc-mismatch { offset: 12 }` |
| idx-crc | `connectivityOnly` | 0 [0] | 0, no findings |
| idx-crc | `full: false` | 0 [0] | 0, no findings |
| pack-body (middle byte flipped) | default | **3** [6]: see the stderr list after this table, then `missing blob 5bd114…` | **4**: `pack-checksum-mismatch`, `pack-crc-mismatch@364`, `pack-entry-unpackable@364/1446/1464` (**no missing finding**) |
| pack-body | `connectivityOnly` / `full: false` | 0 [0] | 0 |

The pack-body default row's git stderr, in order:

- `error: …pack checksum mismatch`;
- `error: index CRC mismatch … at offset 364`;
- `error: inflate: data stream error (incorrect data check)`;
- `error: cannot unpack 5bd114… at offset 364`;
- `failed to read delta base object` ×2;
- `cannot unpack aa5e3f…@1446` and `cannot unpack 7b5d34…@1464`.

**What the matrix proves.**

- The idx-crc row agrees, apart from the bit value that F1 changes.
- The pack-body row exposes a **divergence on both git versions**: git 6 against tsgit 4 on
  2.55, and git 3 against tsgit 4, which F1 turns into 1, on 2.56.
- git also reports the reachable blob whose *own* entry failed to inflate as
  `missing blob <oid>` (bit 2). That blob is the delta base at 364. The two delta children
  at 1446 and 1464, which failed only through their base, are **not** reported missing.
- Proof: probe `f31b` (fixture above). `git fsck` prints `missing blob 5bd114…` and exits 3,
  while tsgit `fsck()` returns
  `{ exit: 4, findings: [... no 'missing' / 'unresolved-link' ...] }`.
- This sits inside 31.8's perimeter, the fsck verify-pack path, so it is **folded**:
  fixed here, not filed.

Root-cause hint, to be proved by the RED row before any change: in `builtin/fsck.c`,
`check_reachable_object` reports `missing` when `!(obj->flags & HAS_OBJ)` and the
`odb_has_object(... RECHECK_PACKED)` lookup fails. An entry that failed its own unpack is
likely placed in the pack's `bad_objects` set, which `midx_fill_entry` and
`packfile_fill_entry` skip (`midx.c` v2.56.0 L621–626), while children that failed through
their base are not. tsgit's `pack-entry-unpackable` must therefore mark only own-inflate
failures as absent for the reachability check.

**Remaining deliverables for 31.8.**

1. RED interop row in `fsck-pack-accessibility-interop.test.ts`, with this fixture and its
   twin ordering per lesson 022. The corrupt base is seeded both first and last in pack
   order. The row pins the `missing blob <base>` line and exit 3, then 1 after F1. Then the
   fix in `verify-pack.ts` or `reachability.ts`.
2. Keep the existing CRC pins listed above, updating only their exit literals (F1).
3. Prose fixes:
   - `docs/BACKLOG.md` L625: the row claims no pass exists. The docs phase ticks it,
     records the #313 provenance, and notes the bit-2 fold.
   - ADR-907 L78–81, the "Known gap" paragraph: amend to "closed: per-entry CRC pass in
     verify-pack".
   - `docs/use/commands/fsck.md` L222–224: replace the known-gap sentence with the
     `pack-crc-mismatch` behaviour and its 2.56 bit.

### CI pin

**Facts.**

| Job | Runner | git-spawning files |
|---|---|---|
| `integration` (`.github/workflows/ci.yml` L362) | `ubuntu-latest` | the integration project (`npm run test:integration`) |
| `posix-integration` (L388) | matrix `ubuntu-latest`, `macos-latest` | `test/integration/posix-only/status-refresh-readonly-interop.test.ts`, `test/integration/posix-only/checkout-umask-interop.test.ts` |
| `win-integration` (L417) | `windows-latest` | `test/integration/win-only/backslash-path-windows-interop.test.ts` |

- All three jobs use `./.github/actions/setup`, which runs `actions/setup-node@v7` and then
  `npm ci`. No workflow installs git, and none uses apt or brew.
- The git-core PPA for noble publishes exactly `1:2.56.0-0ppa1~ubuntu24.04.2`. This was
  queried through the Launchpad API `getPublishedSources` on 2026-10-29.
- The runner images ship:

  | Image | git |
  |---|---|
  | macos-15 (current `macos-latest`) | 2.55.0 |
  | macos-26 | 2.56.0 |
  | windows-2025 | 2.56.0.windows.2 |

- The newest upstream tag is v2.56.0.
- The macOS and Windows image versions and the ubuntu-24.04 rollout come from the
  orchestrator's reading of the runner-images READMEs and were not re-probed here. The CI
  part re-verifies them before it chooses D-CI2.

**Design.** Add a composite action, `.github/actions/setup-git`. Each of the three jobs
calls it right after `./.github/actions/setup`. It takes one input, `version`, whose default
is the single constant `"2.56"`. The action:

1. **Linux:** installs git per D-CI1.
2. **macOS and Windows:** per D-CI2.
3. **Every OS:** runs `git --version` and parses `major.minor`. If the result is not the
   constant, it fails with `::error::expected git <const>.x, found <full version string>`.
   The drift policy is D-CI3.
4. Echoes the resolved `git --version` into the job log.

The constant lives in one place: the action's `version` default. Jobs do not pass it.

**Docs:**

- `CONTRIBUTING.md` (or `docs/dev/` testing notes, wherever the interop prerequisites
  live): the pinned version and how to bump it.
- Issue #311 point 3 (keep a 2.55 lane?) is D-CI4.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D-F1a | Shape of the collapsed fsck exit bits | (a) delete `EXIT_PACK`, `EXIT_MULTI_PACK_INDEX`, `EXIT_PACK_REV_INDEX` and `EXIT_BITMAP`; those passes OR in `EXIT_CORRUPT` (1). (b) Keep the four names as aliases equal to 1. (c) Keep them, and map them to 1 in a final fold table in `fsck.ts`. | (a) | git deleted the bits. Aliases or a remap keep dead names that suggest distinct bits, which is a no-dead-code violation and invites a wrong reading of the exit. |
| D-F1b | `--no-full` skips every non-local source, so a valid tip living only in a donor's loose store is reported `missing commit` (exit 2) | (a) Follow byte-for-byte. (b) Diverge with an ADR: under `full: false`, keep reading alternates' loose objects for presence only, without auditing them. | (a) | The prime directive covers exit status, and 2.56 does this deterministically. A diverging ADR would need re-judging on every git bump. If git fixes it in 2.56.x, the CI pin flags the drift. |
| D-F3 | A stash apply/pop whose merge conflicted **and** whose untracked restore failed. git now exits 128, a failure, not 1, a conflict. tsgit returns `{ kind: 'conflict', untrackedNotRestored }`. | (a) Keep the return shape: the data already carries both facts, and the test rebuilds 128 from `untrackedNotRestored !== undefined`. (b) Throw `stashUntrackedNotRestored` carrying the conflicts, superseding ADR-1097, so throw/return mirrors git's failure/conflict split. (c) A new result kind `'conflict-unrestored'`. | (a) | Exit status is a property of the CLI layer. tsgit's result already holds every field git's two outcomes differ on. (b) breaks callers to encode a CLI number. |
| D-F4 | Data shape for "gitfile does not point to a valid repository" | (a) A new code `GITFILE_NOT_A_REPOSITORY { path }`, where `path` is the gitfile as git names it (`sub/.git`); `NOT_A_REPOSITORY` stays for discovery. (b) Keep `NOT_A_REPOSITORY`, set `path` to the gitfile, and add `via: 'gitfile' \| 'directory'`. (c) Keep `NOT_A_REPOSITORY` and change only `path`, so the test infers the route from the fixture. | (a) | git now emits three distinct refusals: the gitfile die, `'…' not recognized`, and discovery's `not a git repository`. One code per refusal keeps the data self-describing. (c) needs knowledge outside the data. |
| D-F5a | A lazily read gc key that is malformed inside a non-auto `maintenance` gc task (git: `error: task 'gc' failed`, exit 1, later tasks still run) | (a) Record it in `tasksFailed` as `{ task: 'gc', error: <TsgitError data> }` and continue. (b) Throw from the gc step and abort the remaining tasks. | (a) | Matches git's pinned behaviour: commit-graph still runs, in either order. `tasksFailed` already exists for exactly this. |
| D-F5b | Rebuilding git 2.56's gc failure stderr, which contains `error: failed to run (null)` (a git argv-after-clear bug) and the pack-refs/worktree cascade lines | (a) Rebuild the literal bytes, including `(null)` and the cascade, in the interop test. (b) Compare only the leading fatal lines tsgit's data names and ignore git's cascade tail. | (a) | It is faithful and costs nothing in the library, which emits no text. The `(null)` comes from C library's NULL `%s`, which is identical on glibc and macOS, and these rows do not run on the Windows lane. |
| D-F6 | Where the midx owner-unavailable recovery lives | (a) A registry operation called only on the second-read path, after the `rescanOnFullMiss` reprepare missed; quick `hasObject` never reaches it. (b) A `secondRead` flag on `PackRegistry.lookup`. (c) Scan on every owner-unavailable lookup. | (a) | Mirrors git's `OBJECT_INFO_SECOND_READ` gate without widening `lookup`'s hot signature. (c) diverges for QUICK callers and adds per-lookup cost. |
| D-F8 | Data for ` for bisect` | (a) Add `hold: 'checkout' \| 'bisect'` to `BRANCH_CHECKED_OUT`. (b) A new code `BRANCH_BISECTING { branch, path }`. | (a) | It is the same refusal family with one qualifier. An enum field avoids the boolean-param smell and keeps one code for callers. (b) is equally faithful but splits a single git refusal site in two. |
| D-F12 | fsck `connectivityOnly` over an empty or unreadable loose object: git 2.56 dies with 128 (`fatal: loose object … is corrupt`), where 2.55 printed `dangling unknown` and exited 0 | (a) Follow and refuse with `LOOSE_OBJECT_CORRUPT`. (b) Diverge with an ADR: keep the 2.55 `classify` behaviour, as git's die looks like a regression. | (a) | git has the crash, so lesson 017 holds. Following keeps one expectation set, and the CI pin catches a fix in 2.56.x. (b) needs a standing divergence ADR that a later git may invalidate either way. |
| D-CI1 | How to install git on Linux | (a) The git-core PPA, latest, then assert 2.56.x. (b) The PPA with an exact `apt-get install git=1:2.56.0-0ppa1~ubuntu24.04.2`. (c) Build from source at tag v2.56.0, cached with `actions/cache` keyed on the tag. | (a) | The PPA keeps only its latest build. An exact pin breaks when the PPA republishes (`…ubuntu24.04.3`) without git changing. The assert already enforces `2.56.x`. (c) is the fallback if the PPA moves to 2.57 before tsgit does. |
| D-CI2 | How the macOS and Windows legs get 2.56 | (a) Windows: assert only (windows-2025 ships 2.56.0.windows.2). macOS: move the `posix-integration` macOS leg to `macos-26` (ships 2.56.0) and assert only. (b) `brew install git` on macOS (latest formula) plus the assert; Windows assert only. (c) Assert only everywhere, leaving `macos-latest`, which fails today because macos-15 ships 2.55.0. | (a) | No install step means nothing to break. The image label is the pin, and the assert catches image drift. (b) adds brew's update time and floats with the formula. (c) is red on day one. |
| D-CI3 | A runner that resolves to git 2.57 | (a) Fail the job. (b) Warn and continue. | (a) | One pinned version, one expectation set. A silent 2.57 run is how #311 arose. |
| D-CI4 | Keep a git 2.55 lane (issue #311 point 3) | (a) No; one pinned version. (b) Yes, as a nightly with 2.55-only expectations. | (a) | Two expectation sets double every version-sensitive row. The prime directive targets one git. |

## Test strategy

- **Interop, per family.** Each family re-pins its rows to the matrices above (see
  "Tests to change" per section). New rows:
  - F3: stash conflict plus unrestored untracked (exit per D-F3);
  - F5: `maintenance run --task=gc`, in both task orders;
  - F6: the chmod and `.idx`-kept variants already exist; h5 is re-judged;
  - F8: two worktrees, bisect wins;
  - F10: interactive drop;
  - F11: per-source order;
  - 31.8: the corrupt base entry with `missing blob`, seeded first and last per lesson 022.
- **Lesson 015, whole-family runs at the gate.** Every family whose code changes runs its
  whole family at the gate:
  - fsck (F1, F12, 31.8): every `*fsck*-interop` suite, plus `midx-interop`,
    `delta-pack-interop` and `maintenance-interop`;
  - merge-base (F7): `merge-base-interop`, plus merge, rebase and log `A...B`;
  - pack-registry lookup (F6): `midx-interop`, `alternates-*-interop` and
    `fetch`/`clone` interop;
  - gc config (F5): `maintenance-interop`, `gc*-interop` and `alternates-gc-fsck-interop`;
  - gitlink probing (F4): `add-gitlink`, `status-gitlink`, `gitlink-consumers` and
    `submodule*` interop;
  - signing (F9): `commit-signing`, `tag` signing and `verify-*` interop;
  - closure engine (F11): `alternates-acceleration` and `rev-list`/`pack-objects` interop.
- **Lesson 018.** Every "writes nothing" assertion re-pinned at 128 (F3 push rows) keeps its
  stat-drift arrangement as it is.
- **Unit, at 100% coverage with 0 surviving mutants:**
  - exit fold and mode gates (`fsck.ts`), including one test per gate in isolation:
    `connectivityOnly` skips rev, bitmap and midx; `full: false` skips verify-pack and
    non-local sources;
  - the gc-config guard split;
  - `maintenance` `tasksFailed` on a lazy-key refusal;
  - the `findMidxHit` tri-state and the second-read scan;
  - paint-queue counters, side exhaustion and `topoCeiling`;
  - `worktreeBisecting` first-registration order;
  - the CR stripper;
  - rebase `advanceFlat` 'empty';
  - `tryBitmapClosure` per-source order;
  - gitlink-head refusal data.
- **Property tests.** A sibling `*.properties.test.ts` for the armor CR stripper, with
  idempotence and "no `\r\n` survives" as properties. The other changes touch no parser,
  matcher or serializer grammar.
- **CI.** A dry check of the setup-git action: a job-level run on each OS proves the assert
  passes on 2.56.x. A deliberate wrong-constant run in a scratch branch proves it fails
  loudly. Record that run, then revert it.

## Out of scope

- **A git 2.55 lane**: see D-CI4.
- **fsck stderr ORDER across sources.** 2.56 changed it from "loose of all sources, then
  packs" to per source. No red row pins cross-source order, and tsgit returns findings
  rather than ordered text.
- **2.56 sequencer changes no row exercises:** 18f5750 ("never reschedule on failed
  commit"), 2f5ff2c/4a3a8ee (fixup counting), and the "edit with a dropped commit" and
  "skipped commit" rewritten-list cases that git itself leaves unfixed.
- **Discovery inside a broken-gitfile worktree** (F4 table, last row). `find-layout.ts`
  refusal data is not exercised by any red row. Proof if raised later: probe `f4b` row 4
  against `openRepository(<sub>)`.
- **`core.multiPackIndex=false`**: the h5 row's config hatch. tsgit still has no such
  config; the row is re-judged only on the default path.
- **Trace2-dependent bitmap duplicate scanning (F11).** tsgit has no trace2.
- **Any other 2.56 change** with no red row: the 976-commit range beyond the attributed
  commits.
