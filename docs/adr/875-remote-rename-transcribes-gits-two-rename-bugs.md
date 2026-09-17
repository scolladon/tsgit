---
subjects:
  - src/application/commands/remote.ts
---
# 875 — `remote.rename` transcribes git's two rename bugs

- **Status:** accepted
- **Date:** 2026-09-17
- **Design:** docs/design/session-caches-faithfulness-addendum.md (Ref write and delete semantics: the `remote.rename` rows) · **Supersedes/Refines:** refines ADR-226 and amends ADR-871's `remote.rename` decision

## Context

`git remote rename <old> <new>` carries two defects, both reproduced against git 2.55.0 on the files
**and** reftable backends, in a `mktemp -d` repository with `HOME` isolated, every `GIT_*` variable
unset, `GIT_CONFIG_NOSYSTEM=1` and signing off.

### Bug one — the symbolic target is spliced blind

git rewrites the tracking refs it moves by overwriting a **fixed slice** of each name: the bytes
starting at `strlen("refs/remotes/")` = 13, running for `strlen(<old>)` bytes, replaced by `<new>`.
For the ref's own name that is exact, because every name it moves begins `refs/remotes/<old>/`. git
applies the *same* splice to a symbolic ref's **target**, without checking the target lives under
that remote — or under `refs/remotes/` at all.

With `<old>` = `origin` (6 bytes) and `<new>` = `up2`, the slice is bytes 13..19:

| # | `refs/remotes/origin/HEAD` target | exit | resulting `refs/remotes/up2/HEAD` |
|---|---|---|---|
| 1 | `refs/remotes/other/main` | 0 | `refs/remotes/up2main` — dangling |
| 2 | `refs/heads/feature-long-name` | 0 | `refs/heads/feup2long-name` — dangling |
| 3 | `refs/remotes/originX/main` | 0 | `refs/remotes/up2X/main` |
| 4 | `refs/remotes/myorigin/main` | 0 | `refs/remotes/up2in/main` |
| 5 | `refs/remotes/origin` (exactly the slice) | 0 | `refs/remotes/up2` |
| 6 | `refs/remotes/originz` (one byte past the slice) | 0 | `refs/remotes/up2z` |
| 7 | `refs/remotes/origi` (one byte short) | 128 | none — `fatal: \`pos + len' is too far after the end of the buffer` |
| 8 | `refs/heads/main` (far short) | 128 | none — the same `fatal` |

Rows 7 and 8 are `strbuf_splice`'s own guard firing: the target has no bytes at the slice to
overwrite. The splice happens while the rename is *prepared*, so the refusal beats every name
conflict — planting a taken `refs/remotes/up2/main` or `refs/remotes/up2/HEAD` alongside row 8 still
reports the `fatal`, and no ref moves.

### Bug two — the config section is renamed before the refs, and never rolled back

git commits `remote.<old>` → `remote.<new>` as a config section rename **before** it prepares the ref
move, and writes the rewritten fetch refspecs and the `branch.<x>.remote` re-points only **after**
every ref has moved. A refusal in between therefore leaves a repository whose `[remote "<new>"]`
section still carries values naming `<old>`:

| Refusal | exit | config afterwards | refs afterwards |
|---|---|---|---|
| `rename nope up2`, source not configured | 2 | untouched | untouched |
| `rename origin up2`, `up2` already a remote | 3 | untouched | untouched |
| `rename origin 'ba..d'` / `'a b'`, invalid name | 128 | untouched | untouched |
| `refs/remotes/up2/main` already exists | 128 | `[remote "up2"]`, `fetch = +refs/heads/*:refs/remotes/origin/*`, `branch.main.remote=origin` | untouched |
| `refs/remotes/up2/HEAD` already exists | 128 | as above | untouched |
| a target too short to splice (bug one) | 128 | as above | untouched |

The last three rows are identical on both backends, and the `error: renaming remote references
failed: cannot lock ref '<new>': reference already exists` rows confirm the **ref** half is one
prepared transaction: nothing moves, not even a tracking ref sorted ahead of the conflicting one.

Both bugs matter to a caller: bug one produces a dangling `<new>/HEAD` a later `remote set-head` or
`fetch` will read, and bug two leaves a config a second `remote rename` cannot repair by name.

## Options considered

The user decided both, on the same terms.

1. **Copy git exactly (chosen).** Under the prime directive, faithfulness binds to git's *binary*
   behaviour, bugs included: tsgit reproduces the observable outcome — which refs, logs and config
   keys exist afterwards — and records the upstream defect here rather than in the code.
2. **Diverge — rewrite the target only when it lives under the renamed remote, and roll the config
   section back on refusal.** Rejected: it makes a tsgit repository and a git repository disagree
   after the same command, which is exactly what the prime directive forbids. A tool reading either
   repository afterwards would have to know which one wrote it.
3. **Refuse both shapes up front** — refuse a rename whose `<remote>/HEAD` points outside the remote,
   and refuse before any config write. Rejected for the same reason, and because it refuses inputs
   git accepts (rows 1–6 above are exit 0 for git).

For bug one's crash, a third sub-question: which refusal. Inventing a code was ruled out; the crash
is `strbuf_splice` refusing a value it cannot rewrite, so the rename raises the domain's existing
`INVALID_REF` (`src/domain/refs/error.ts`) with
`reason: symbolic ref target '<target>' is shorter than the renamed slice`. tsgit never aborts the
process: the refusal is a normal `TsgitError`, and the caller sees the same on-disk state git's
`fatal` leaves.

## Decision

**Transcribe both.**

- `spliceRemoteName` replaces the old prefix-substitution helper and is used for a moved ref's own
  name *and* for a symbolic ref's target: `value.slice(0, 13) + <new> + value.slice(13 + <old>.length)`.
  `rewriteSymbolicTarget` refuses `INVALID_REF` when `target.length < 13 + <old>.length`.
- Every symref's two spliced names are computed in `prepareSymrefs`, before `assertRenamedNamesFree`,
  so a target too short to splice refuses ahead of any name conflict and before any ref is written.
- `remoteRename` issues **two** config operations: `renameSectionOperations` (the section header
  alone) before `renameTrackingRefs`, and `renameValueOperations` (the fetch rewrite plus the
  `branch.<x>.remote` re-points) after it. The refusals that precede the section rename — unknown
  source, taken target, invalid name — still leave the config byte-for-byte as it was.

## Consequences

`remote.rename` leaves the same refs, logs and `.git/config` as `git remote rename` in every probed
shape, on both backends, including the two broken ones.

**Migration notes.** A `<remote>/HEAD` pointing outside the remote being renamed is no longer carried
over verbatim: it is spliced, usually into a dangling name. A caller that relied on the old
"rewrite only when the target lives under the remote" behaviour must re-point `<new>/HEAD` itself
after the rename. A rename refused by a taken tracking name, or by a target too short to splice, now
leaves `[remote "<new>"]` in the config with its values still naming `<old>`; a caller that retried
such a rename by the old name must now retry by the new one, and rewrite the values itself. The new
refusal code for the short target is `INVALID_REF`.

**Revisit trigger.** Either bug being fixed upstream — a released git that rewrites a symbolic target
only when it lies under the renamed remote (or refuses instead of dying), or one that rolls the
config section back when the rename refuses. At that point this ADR is superseded and the behaviour
follows the fixed git, gated on the version the repository's `git` reports in the interop harness.
