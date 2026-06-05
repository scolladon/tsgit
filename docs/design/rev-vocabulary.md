# Design — `rev` vocabulary

## Goal

An API **ergonomics** pass, surfaced by the 23.4 API review (finding **S3**). It
standardises the name of the "**which commit-ish**" parameter on a single word —
**`rev`** — across the command surface, and reserves **`from`/`to`** for genuine
two-endpoint **ranges**.

Today the same conceptual parameter wears five different names:

| Name      | Command(s) today                                   |
| --------- | -------------------------------------------------- |
| `rev`     | `blame` (`BlameOptions.rev`)                       |
| `from`    | `log` (`LogOptions.from`), `diff` (`DiffOptions.from`/`to`) |
| `target`  | `merge` (`MergeRunInput.target`), `reset` (`ResetOptions.target`) |
| `input`   | `describe` (positional), `show` (positional)       |
| `branch`  | `pull` (`PullOptions.branch`)                       |

A consumer learning the surface must memorise five spellings for one idea. After
this pass there is **one** spelling for a single commit-ish (`rev`) and **one**
spelling for a range (`from`/`to`).

After ADR-266 the vocabulary is **two precise words**, not one: **`rev`** for a
**commit-ish** (resolves to a commit — oid, `HEAD`, `~`/`^`, tag, branch, reflog
selector), **`from`/`to`** for a **range**, and **`ref`** for a **literal ref
name** (`pull`, whose input is a remote branch short-name, *not* a commit-ish).

This is a **pure parameter rename** — **behaviour-preserving**. No object SHA,
ref, reflog, on-disk state file, refusal condition, or structured result shape
changes. Only the *spelling of an input field / positional parameter* on the
public surface moves. It is a **breaking** change to callers (a renamed field),
which the 23.4 window permits unconstrained (no release-bundling) — consistent
with the clean breaks 23.4a and 23.4d already took (no compat aliases).

## Faithfulness anchors (git)

Git-faithfulness binds **observable behaviour** — SHAs, refs, reflogs, state
files, refusals — none of which this pass touches. The only git-adjacent
artefact in scope is a **reflog message**: `reset` records
`reset: moving to <arg>` where `<arg>` is the literal revision the caller passed.
Renaming the field that *carries* that string (`target` → `rev`) does not change
the string's **value**, so the reflog stays byte-identical. The existing
`reset-interop` cross-tool parity (which reconstructs `git reflog` from the
result) keeps it pinned and must stay green unchanged.

No new interop golden is required: there is no new observable behaviour to pin.
The whole pass is verified by the **type-checker** (renamed fields flow through
`BindCtx<…>`), the **unchanged** unit/interop/parity suites (mechanically
updated to the new spelling), and `reports/api.json` regenerating to the new
parameter names.

## The rename table (the contract)

| Command    | Surface today                          | After          | Kind       |
| ---------- | -------------------------------------- | -------------- | ---------- |
| `blame`    | `BlameOptions.rev`                     | `rev` (no-op)  | option     |
| `log`      | `LogOptions.from`                      | `rev`          | option     |
| `merge`    | `MergeRunInput.target`                 | `rev`          | option     |
| `reset`    | `ResetOptions.target`                  | `rev`          | option     |
| `describe` | positional `input?: string`            | `rev?`         | positional |
| `show`     | positional `input?: ShowInput`         | `rev?`         | positional |
| `checkout` | `CheckoutSwitchOptions.target`         | `rev`          | option     |
| `pull`     | `PullOptions.branch`                   | `ref` (ADR-266)| option     |

`blame` is already canonical (it defines the target word) — listed for
completeness, no change. The `MergeRunInput` / `ResetOptions` *type names* are
**unchanged**; only their `target` field is renamed (the `*RunInput` naming
convention for namespace input bags stays intact).

`checkout` was **folded in during implementation** (a user directive: handle the
remaining commit-ish params here rather than spinning a follow-up). Its
**switch** option (`CheckoutSwitchOptions.target` → `rev`) is a clean commit-ish
— the destination to switch HEAD to; the **path-restore** variant
(`CheckoutPathsOptions.paths`) is a separate, untouched option shape. The
`isSwitch` discriminator (`'rev' in opts`) and the
`invalidOption('rev', 'either rev or paths must be provided')` refusal move with
it. `tag` is deliberately **left** as `target` (see scope boundaries).

### `log`: a single start, not a range

`log`'s `from` is the **single starting commit-ish** of a first-parent walk
(`from ?? 'HEAD'`); the walk's other bound is `excluding` (oid stops), not a
symmetric `to`. So `from` here is *not* a range endpoint — it is the one
commit-ish the walk starts at, which is exactly `rev`. Reserving `from`/`to` for
ranges (below) makes `log`'s `from` a misnomer; `rev` is the faithful name.

### `diff`: a genuine range — `from`/`to` **kept**

`diff(opts)` takes **two** tree-ish endpoints, `from` (default `HEAD`) and `to`
(optional; when omitted the other endpoint is the empty tree), and reports the
changes *between* them. This is the textbook two-endpoint range, so `from`/`to`
is the **correct** vocabulary and is **deliberately retained**. `diff` appears in
S3's list only because it is the canonical owner of the `from`/`to` range words
this pass is reserving — not because it renames.

### `describe` / `show`: positional renames

Both take their commit-ish as a **positional** argument named `input`. Renaming
the parameter to `rev` changes the published signature and JSDoc (and
`api.json`) but touches **no call site** — every caller passes the argument
positionally (`show(ctx, 'HEAD')`, `repo.describe()`), so the spelling of the
parameter is invisible at the call. `show`'s parameter type stays `ShowInput`
(`string | ReadonlyArray<string>`) — the type name describes *what show accepts*
(one rev or many), orthogonal to the parameter's name. The hand-written `show`
binding in `repository.ts` (which spells the positional `input` in its overload
set) is updated to `rev` to match.

## Scope boundaries (deliberately out)

The blast radius covers the eight commands S3 enumerates **plus `checkout`**
(folded in by user directive — its switch `target` is a clean commit-ish). The
following are **left untouched on purpose**:

- **`tag`'s `target`** — the **object the tag points at** (git's `<object>`,
  default HEAD), which may be a tree or blob, *not only* a commit-ish. `rev`
  would narrow its meaning incorrectly, so `target` stays — it is correct as-is,
  **not** a deferred follow-up.
- **`diff`'s `from`/`to`** — the two endpoints of a genuine range; this is the
  vocabulary the pass *reserves*, so it is the intended end state, not a deferral.
- **`branch.rename`'s `from`/`to`** — a *rename pair* (old name → new name), not
  a commit-ish and not a commit range; the `from`/`to` reservation is about
  commit ranges, and `branch.rename`'s pair reads naturally. Untouched.
- **`revert` / `cherryPick` / `rebase`** — these take a `revisions` **array**
  (multiple commit-ish, each possibly an `A..B` range) inside a `*RunInput` bag;
  that is a different parameter (`revisions`, plural ranges) from the single
  "which commit-ish" S3 targets. The `input` *parameter name* on their namespace
  functions is the input-bag convention, not a commit-ish. Untouched.

## Surface-gate impact

- **`reports/api.json`** regenerates — renamed positional/field names are
  captured by typedoc; the diff is the rename, committed in-PR (the
  `check:doc-typedoc` prepush gate).
- **Docs** — `docs/use/commands/{log,merge,reset,pull}.md` and
  `docs/get-started/migrate-from-isomorphic-git.md` carry the old spellings in
  examples; updated mechanically. `describe`/`show` doc pages use positional
  examples — no change needed unless a field spelling appears.
- **Tests** — unit (`log`, `reset`, `merge`, `continue-merge`, `pull`,
  `repository`), integration/interop (`reset-interop`, `merge-*`,
  `sparse-reset-merge`), and parity scenarios (`merge-*`, `reset-rm-reflog`) that
  pass the renamed **option fields** are updated to the new spelling.
  Positional callers (`describe`, `show`) are unaffected.

## Test strategy

No new tests — this is a rename, and the existing suites already cover the
behaviour. The discipline is:

1. Rename the surface (command files + `repository.ts` types/bindings).
2. `npm run check:types` proves every internal consumer compiles against the new
   names (the type-checker is the rename's completeness oracle).
3. Mechanically update test call sites + docs to the new spelling.
4. `npm run validate` (full suite + interop + parity) stays green — proving the
   behaviour is byte-for-byte unchanged.
5. Regenerate `reports/api.json`.

Mutation testing re-runs against the renamed shape (Step 8); since logic is
untouched, scores must hold — any new survivor signals a mechanical edit slip,
not a real gap.

## `pull`: a `ref`, not a `rev` (ADR-266)

**`pull`'s `branch`** was the one genuine judgment call. Unlike the other seven,
`pull`'s parameter is a **remote branch short-name** resolved as
`refs/remotes/<remote>/<branch>` — it is *not* a general commit-ish (no oid, no
`HEAD~3`, no arbitrary rev). ADR-266 settles it: rename to **`ref`**, a
deliberate second vocabulary word whose contract is "a literal ref name, looked
up — not commit-ish resolution". `pull` is the only `ref` consumer. Internally,
the resolved `Upstream.branch` field and the `noUpstreamConfigured(branch)` error
keep their `branch` spelling (they hold a genuine branch name, off the public
options surface) — only `PullOptions.branch` → `PullOptions.ref` moves.
