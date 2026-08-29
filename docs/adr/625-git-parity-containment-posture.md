# 625 — Relax path containment to git's security model

- **Status:** accepted (ratified by user) · **Refined by:** [ADR-721](721-first-party-read-containment-is-single-authority.md)
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md · **Supersedes/Refines:** supersedes the "every access is contained" invariant of `docs/understand/security.md` (Node read side); refines [ADR-042](042-canonical-root-lazy-realpath.md), [ADR-485](485-status-clean-containment-tax-amortisation.md), [ADR-541](541-raw-node-adapter-layout-root-set.md)

## Context

The Node adapter runs a realpath-based containment check on every filesystem access —
stricter than canonical git, whose model is: validate entry names once at the index-write
boundary (`verify_path`), defend symlink escapes only on the write path, and leave reads
unguarded (symlinked object dirs and alternates are supported features). The committed
CPU profile attributes 0.46 of `status` self-time to the check, and it is the root cause
of every benchmark loss vs isomorphic-git. The design pinned git 2.55.0's behaviour
empirically (verify_path matrix, read/write symlink matrix, object-store reach-outside
pins) — tsgit was stricter than the tool it replicates, which under the prime directive
(ADR-226) is itself a divergence.

## Options considered

1. **Adopt git's model wholesale — three pillars, one posture** (design recommendation):
   construction-time `verifyPath` validation at index-write boundaries; write-side-only
   symlink defense (lexical-only reads, zero syscalls); object-store reads exempt by
   construction. / cons: read escapes via symlink resolution are no longer refused.
2. Keep a reduced runtime check on reads (lstat leaf, escalate on symlink) — keeps one
   syscall per read; recovers CPU but not the syscall tax; partial guarantee only.
3. Keep the status quo and amortise further — ADR-485 already did; the residual is the
   check itself.

## Decision

Option 1, with each sub-choice settled as follows:

- **Reads are lexical-only** (user-ratified over their own original lstat-and-escalate
  wording): the containment gate on every read surface is `toAbsolute` + a non-allocating
  `..` prefilter + prefix comparison against the settled root set — zero syscalls, zero
  allocations on POSIX, no await. A lexically-outside path still throws
  `PERMISSION_DENIED` on every surface.
- **No runtime trusted-path channel** (adopted-as-recommended): the branded contained
  path stays a compile-time provenance device; the per-access check is made free rather
  than skippable. No parallel port methods, no second adapter instance.
- **`verifyPath` fires at index-write boundaries** (adopted-as-recommended): index file
  parse, tree→index, index→tree, plus the existing user-pathspec validator — git's own
  stage. Tree parse/inspection stays permissive like `git cat-file`.
- **Write side keeps and strengthens its guards**: leading-path containment via the
  cached parent realpath on every write surface; leaf no-follow (`O_NOFOLLOW` where the
  platform honours it) on every leaf-dereferencing write surface.
- **One ADR for the posture** (adopted-as-recommended): the three pillars are one
  security-model change; per-surface behavioural decisions are recorded in ADRs 626–634.

## Consequences

- The four losing benchmark scenarios (`status:clean`, `readBlob:cold` ×2,
  `delta-chain:cold`) are expected to move toward ≥1.0×; acceptance is read off the CI
  nightly.
- `docs/understand/security.md` §Path containment must be rewritten to the read/write
  asymmetry; `docs/use/errors.md`'s `PERMISSION_DENIED` triggers are narrowed to write
  and lexical escapes.
- The `.git`-alias/NTFS/HFS validation gap in `validateIndexPath` (pre-existing — the
  adapter never defended it either) is closed by pillar 1: a net security gain.
- Working-tree content readers must never dereference a symlink leaf (the R5 audit);
  this discipline is now load-bearing — see ADR-632.
- Memory and Browser/OPFS adapters are unchanged (lexical containment is their
  addressing model / origin sandbox).
