# 637 — The tree-depth cap is `core.maxTreeDepth`, honoured unclamped

- **Status:** accepted
- **Date:** 2026-08-15
- **Design:** docs/design/depth-caps-and-node-aliases.md · **Supersedes/Refines:** refines ADR-226 (git-faithfulness prime directive); depends on ADR-636; refines ADR-024

## Context

`synthesize-tree-from-index.ts` documented its cap as "4096, matching git's canonical limit". The claim was never pinned. Pinned now against `git version 2.55.0` in a `mktemp -d` throwaway (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, signing off), with deep paths fed to git as **data** via `update-index --add --cacheinfo` so the OS `PATH_MAX` cannot mask git's own behaviour:

- **Git's limit is `core.maxTreeDepth`** — documented default **2048**, **512** under MSVC. `4096` appears nowhere in `git-config(1)` and equals no git default. It most likely leaked from `MAX_PATH_BYTES = 4096` in `src/domain/working-tree-path.ts`, a *byte-length* cap, into a *component-count* cap.
- **The predicate is `slashCount > cap`.** Calibrated across `core.maxTreeDepth` 1–5 against depths 0–6, and re-verified at the default boundary: 2047 and 2048 accepted, 2049 refused. This is byte-for-byte tsgit's existing `assertDepthBounded` comparison — the comparison was right, the constant and the surface were wrong.
- **It binds traversal, not synthesis.** Refused at 2049: `ls-tree -r` (exit 1), `diff-tree -r`, `log --raw`, `rev-list --objects`, `archive --format=tar`, `read-tree`, `gc`, `repack` (all exit 128). Not enforced at any depth: `update-index`, `write-tree` (valid oid at 4097, 8000, 28000), `ls-files`, non-`-r` `ls-tree`, `cat-file -p`, and `fsck` — even `--strict` — which does not check depth at all.
- **Git has no write-side depth policy.** `write-tree`'s only failure is a **segmentation fault** (exit 139, stale 0-byte `index.lock`) that appears near 29000 at the default `ulimit -s` and disappears entirely at `ulimit -s 65520`, where 100000 succeeds. That is C-stack exhaustion moving with the process stack limit — not a constant, not a refusal, not something git reports.
- **The OS refuses first in any real scenario.** `PATH_MAX` = 1024 on darwin caps a checkout at real depth ~471 — four times below git's own 2048. A clone of a 2048-deep repo fails `cannot create directory … File name too long`; a clone of a 2049-deep one is refused by git itself.
- **`core.maxTreeDepth` is user-configurable and tsgit read it nowhere.** Git honours `-c core.maxTreeDepth=100000`, and rejects a non-numeric value with `fatal: bad numeric config value … invalid unit`.

So every one of tsgit's caps diverged from git, in both directions at once: 1024 on six traversal sites is **stricter** than git's 2048; 4096 on the synthesis sites and the disabled cap in `archive` are **looser**. ADR-226 binds a refusal condition as observable behaviour and binds both directions equally.

## Options considered

1. **Fixed constant, record the divergence (recommended)** — pros: bounded; keeps the change at "make the guard fire"; no new config surface / cons: a user who sets `core.maxTreeDepth` sees tsgit ignore it, which is the divergence ADR-226 exists to make expensive.
2. **Read it, clamped to an internal ceiling** — pros: looks faithful / cons: silently disagrees with git for exactly the users who set the config — the ones who noticed the limit.
3. **Read it, unclamped** — pros: the faithful answer; git accepts any value and so does tsgit / cons: adds a config-parse surface with scope precedence and invalid-value refusal; implementable only because ADR-636 removed the engine from the equation.

## Decision

**Option 3 (user-ratified).** tsgit's tree-depth cap **is** `core.maxTreeDepth`. It is read from config, defaults to **2048** when unset, and is honoured at any value the user configures — no internal ceiling, no clamp. An invalid value is refused the way git refuses it, as a typed error rather than a silent fallback to the default.

The predicate is `slashCount > cap` — `exceedsMaxTreeDepth`'s existing `>`, which the pin confirms. One shared source supplies the cap to every site; the three inlined `1024` constants that already meant "the same bound as `walk-tree`" stop restating it. `MAX_SUBMODULE_DEPTH` is excluded (ADR-636): it counts nested repositories, not tree levels.

Four boundaries this record's first draft left open, settled by the user after the design was revised against it:

- **The configured value binds all ten sites uniformly**, synthesis included. One resolver, one number, no special case to explain, test twice or mutate around. It is an extension of git's config to a surface git's config never reaches — deliberate, and the mirror of the residual divergence below. The alternative, mirroring exactly which surfaces git binds, would let `core.maxTreeDepth = 4096` walk a tree with `ls-tree` that `commit` then refuses to write; a split that surprising is worse than either divergence.
- **The value is read through `readConfig`, which is local-only**, exactly as every other typed `core.*` key in the library is. Git's own precedence is system → global → local → worktree → `-c`/`GIT_CONFIG_*`, and a global-only value does change git's behaviour, so **a user who sets `core.maxTreeDepth` in `~/.gitconfig` will see git honour it and tsgit ignore it.** That divergence is inherited, not created — no typed key tsgit reads today consults global scope — but this key is likelier than most to be hit by it, because git documents it as a fail-safe knob and fail-safe knobs get set once, globally. It is written into the shipped docs rather than left implicit, and making `readConfig` scope-aware is the right end state and a different change.
- **An invalid value refuses repo-wide**, matching Pin 7 exactly: git parses `core.*` at startup and goes fatal on `write-tree`, `ls-files`, `cat-file -p`, `ls-tree` and `status` — commands with no depth surface at all. `readConfig` therefore fails on an invalid `core.maxTreeDepth` rather than merging it as absent. This **inverts the house convention** for this one key: `applyLooseCompressionEntry` documents *"valued-but-invalid int merges as absent (lenient)"*, and that leniency stands for every other numeric key. The inconsistency is deliberate and bounded — faithfulness to git's own blast radius was preferred to internal uniformity — and generalising strictness to the rest of `core.*` is a config-subsystem decision this record does not make.
- **The unclamped promise currently holds for four sites, not ten.** ADR-636 leaves six descents recursive on an input-bound premise that a user-controlled cap invalidates; those six are being measured before any decision to rewrite them. Until that lands, this record's contract reads: the cap is honoured unclamped where the descent is structurally bounded, and bounded by the engine where it is not. That qualification is temporary by intent and is the first thing the measurement retires.

`archive`'s `maxDepth: Number.MAX_SAFE_INTEGER` override is removed and `archive` takes the shared cap. Its `maxEntries` override is *correct* and stays: git caps archive's depth like every other traversal but does not cap its entry count. The comment claiming "git archive imposes no entry or depth cap" is split — the entry half is true and stays, the depth half is false and goes.

This is convergence on git, not divergence from it, with **one residual divergence that is recorded rather than fixed**: tsgit caps the *synthesis* surface (`synthesizeTreeFromIndex`, `writeNestedTree`) where git's `write-tree` is unlimited. Git's "unlimited" is a segfault whose threshold moves with `ulimit -s`; tsgit's is a typed `TREE_DEPTH_EXCEEDED`. Refusing where git segfaults is not a behaviour worth matching, and a typed refusal is strictly better than a crash. That is the divergence ADR-226 requires this record to argue, and this paragraph is the argument.

## Consequences

Every cap in the codebase now has one provenance and one number, and the number is git's. The six traversal sites that were stricter than git stop refusing trees `git diff`, `git rev-list --objects` and `git bundle create` handle. `archive` gains a depth refusal it did not have at any input — the one place where restoring a cap moves tsgit toward git and git supplies the value.

Reading a git config that no code path read before is a new surface: scope precedence, the numeric parse, and the invalid-value refusal all become tsgit's problem, and all are pinned by the matrix above rather than guessed.

`src/domain/fsck/validate-tree.ts` gains **no** depth check. `git fsck --strict` exits 0 on a repo containing a 2049-deep tree; adding one "for symmetry" would be a divergence in the strict direction. Recorded here so the absence is not read as an omission.

One divergence is named and explicitly **not** fixed: on a genuinely deep real worktree git warns `File name too long` and *silently stages nothing* at exit 0, where tsgit throws `TREE_DEPTH_EXCEEDED`. That predates this change, and matching it would mean adopting "silently see nothing" as a contract.

Three source comments and one published doc row asserted facts this matrix disproves and are repaired with it: `synthesize-tree-from-index.ts`'s "matching git's canonical limit" and its "a secondary guard would be dead code" (true at 4096, and precisely the bug); `merge.ts`'s claim to match `synthesizeTreeFromIndex`'s *contract* (it matched the number, and separately misnamed the breadth cap `MAX_FLAT_TREE_ENTRIES` as a depth cap); `archive.ts`'s depth claim; and `docs/use/errors.md`'s `TREE_DEPTH_EXCEEDED` row, which documents a `limit` field the error has never carried.

Every row of the pinned matrix becomes an assertion in a cross-tool interop test — parity tests are cross-adapter and prove nothing about git. Deep fixtures are driven through path-as-data plumbing and the memory adapter, never materialised on disk, because a real deep path measures `PATH_MAX` rather than the guard.
