---
subjects:
  - src/application/primitives/internal/repo-settings-gate.ts
  - src/application/primitives/internal/repo-state.ts
  - src/application/primitives/pack-registry.ts
supersedes:
  - adr: "637"
    scope: "the placement of the invalid-value refusal at the eager operational gate, and the claim that the key is reported first regardless of line order"
---
# 859 — Repo settings are validated at their own tier, not at the operational gate

- **Status:** accepted
- **Date:** 2026-09-12
- **Design:** docs/spike/config-validation-tier.md · **Supersedes/Refines:** supersedes ADR-637 in scope; refines ADR-226

## Context

Honouring `core.deltaBaseCacheLimit` (ADR-852) forced an unasked question: where is a malformed
value refused? The design proposed the eager operational gate, copying what `core.maxTreeDepth`
does, and accepted that tsgit would then refuse verbs git runs.

Measured against git 2.55.0, that shape does not hold, and neither does the pattern it copies.

**Git has no die-set.** The 46-of-60 split is emergent: `prepare_repo_settings()` is reached by
commands that touch the object store, the index or a derived structure, plus four builtins that
call it in their own prologue. Two rows the design recorded as "git runs" are fixture-conditional
— `notes list` and `pack-refs --all` run only with nothing to read, and die as soon as one note
or one loose ref exists. The genuine over-refusal is three verbs: `branch.list`, `tag.list`,
`branch.rename`.

**Both keys are one class.** Git reads `core.maxTreeDepth` and `core.deltaBaseCacheLimit` in the
same function (`repo-settings.c:103` and `:142`) and nowhere else, and their outcomes agree in
all 86 probed command cells.

**The house pattern is already drifted, on both axes.** `core.maxTreeDepth`'s eager gate refuses
those same three verbs where git runs, and ADR-637's claim that the key is "reported first
regardless of line order" is true in 5 of 24 probed commands and false in 19 — git names the
streaming class first in the majority. The measurement behind that claim was taken on `status` or
`commit`, both in the minority set, and generalised.

## Options considered

1. **The class declares its tier** (recommended, chosen) — one validator at the object-store,
   index and commit-graph boundaries, plus explicit calls transcribing git's own per-builtin
   `prepare_repo_settings` sites. Pros: the die-set becomes a function of the same thing git's is,
   so the fixture-conditional rows come out right with no per-verb code. Cons: the transcribed
   calls must be re-verified if git's builtins change.
2. **Eager at the operational gate** — the design's proposal and today's `core.maxTreeDepth`
   shape. Cons: doubles an already-measured drift on tier and on order.
3. **Lazy only, at the consumer** — cons: this is option 1 without the transcription, so thirteen
   verbs run where git dies, and the refusal surfaces mid-command after the gate has passed.

## Decision

**Option 1.** A repo-settings class — `{ core.maxTreeDepth, core.deltaBaseCacheLimit }`, extensible
as further keys are honoured — is validated by one `assertRepoSettingsValid(ctx)`, memoised per
session beside the gate verdict so `invalidateConfigCache` drops both. It is called from the
object-store entry (inside the async pack-registry construction, covering loose and packed alike),
from `readIndex`, from the commit-graph loader, and from explicit per-verb calls transcribing
git's four whole-command `prepare_repo_settings` sites (`rev-parse`, `worktree`, `sparse-checkout`,
`stash`) and the seven verbs where git reaches the store for a check tsgit performs differently.

**`core.maxTreeDepth` moves with it.** It is the same class by git's own source, and leaving it
behind would validate two members of one class in two places with two different orderings. Its
lazy twin keeps its refusal on the primitive path, as today.

**The transcribed calls are not an exemption list.** They are the same shape as the existing
work-tree requirement transcribing git's `NEED_WORK_TREE` — a per-command declaration that git
itself makes per-builtin. An exemption list, which enumerates an emergent property by hand, was
considered and is dominated by this on every axis.

**Scope boundary:** only the class moves between tiers; no verb moves between gates. Every other
refusal each verb makes — discovery, ownership, format, the five streaming classes, work-tree,
pending-operation — is byte-identical before and after.

## Consequences

The residual divergence after this record is the ordering split alone: when two `[core]` classes
are malformed at once, tsgit names the repo-settings class where git names the streaming class
first in 19 of 24 commands. No single eager order can match both sets, and only boundary placement
reproduces the 19 without a table; the five are recorded as the known residual and pinned as such.

The three over-refused verbs (`branch.list`, `tag.list`, `branch.rename`) now run, matching git.
`notes list` and `pack-refs --all` match git in *both* fixtures with no per-verb code, which is the
clearest evidence the placement is the right one.

`branch.create` appears in the transcribed set only until ADR-860 lands its start-point
verification; once it types the start point through the object store it reaches the boundary for
the same reason git does, and its explicit call is dropped rather than kept as redundancy.

ADR-355's eager full validation of the `core.compression` family is untouched — those keys stay on
the operational gate, which is where git validates them. Only the repo-settings class leaves it.

Carried forward from ADR-637: `core.maxTreeDepth` as the cap's identity, honoured unclamped with a
2048 default, the `slashCount > cap` predicate, one shared source feeding every site, the reuse of
`CONFIG_BAD_NUMERIC_VALUE` with no new public surface, the local-only `readConfig` scope divergence
and its documentation, and the lazy twin at the tree-walk boundary. Superseded from ADR-637: the
refusal's placement at the eager operational gate, and the ordering claim — with the unit tests
that pinned the minority-set measurement rewritten against the probed majority.
