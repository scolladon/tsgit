# Design — missing-value-refusal-parity

> Brief: refuse the valueless string-typed config case (`user.name`/`email`, `remote.*.url`) with a structured error that reconstructs git's two-line `missing value for '<key>'` / `bad config variable '<key>' … at line N` message, while leaving the absent case on its existing path.
> Status: draft → self-reviewed ×3 → accepted

## Context

git resolves a NULL (valueless) config value lazily, per typed accessor. A bool read of NULL is `true`; a **string-typed** read dies at **use** time with a two-line message, while `git config --list`/`--get`/`--type=bool` on the same file succeed. ADR-314 represents the valueless entry as `value: null` on the porcelain read surfaces. ADR-315 (decision D4) then scoped the eager merge into `ParsedConfig` to **skip** `null` string fields — treating valueless as absent — so a `commit` with a valueless `user.name` currently refuses through tsgit's generic `AUTHOR_UNCONFIGURED` path, not git's exact message. ADR-315 explicitly deferred per-use-site message parity as a backlog follow-up.

This is that follow-up (backlog 24.9l). It must produce git's exact two-line refusal for the **valueless** string case at the consuming commands, without regressing the **absent** case (which stays a pre-existing, out-of-scope divergence).

ADR-226 (prime directive) binds observable behaviour byte-for-byte; ADR-249 refines it: faithfulness binds DATA + on-disk state + refusal conditions, not rendered stdout — the library emits a structured error carrying the fields, and the interop test reconstructs git's two display lines from those fields.

### Code facts established by exploration (these constrain the design)

- `src/application/primitives/config-read.ts`
  - The tokenizer (`tokenizeConfig` → `classifyValuelessLine`) already produces an `entry` token carrying `value: null` **and** `startLine`/`endLine` (0-based) for a valueless line. The grammar refusal for malformed valueless lines (`CONFIG_PARSE_ERROR`) already lands here (ADR-308/314).
  - `parseIniSections` (L275) assembles tokens into `IniSection`, pushing only `{ key: token.key, value: token.value }` — **the line number is discarded at section assembly.** `IniSection.entries` is `{ key; value: string | null }`; no line, no source provenance.
  - `mergeUser` (L656), `applyRemoteEntry` (L677), and the sibling merges all carry one pattern from ADR-315 D4: `if (value === null) continue/skip` — the field stays unset. So `ParsedConfig.user` is `{ name: string; email: string } | undefined` and `remote.<n>.url` is `string | undefined`; the valueless state is **erased** before any consumer sees it, with zero line/source provenance retained.
  - `loadConfig` (L83) reads `${commonGitDir(ctx)}/config` — an **absolute** path — and passes it as the `source` arg through `parseConfigText` → `parseIniSections`. git, by contrast, prints the path it resolved relative to CWD (repo-relative `.git/config` in the matrix). This is the path-token divergence (pinned conclusion #5).
- Identity consumers: `commit.ts` (L92–95) reads `config.user` → `toAuthor` → `resolveAuthor`/`resolveCommitter`; `resolveCurrentIdentity` (`internal/current-identity.ts`) is the shared resolver used by `cherry-pick`, `rebase`, `revert`, `merge`. The `AUTHOR_UNCONFIGURED` throw lives in `resolveCommitter`/`resolveAuthor` (`internal/commit-message.ts`) when no identity source is present.
- Remote-URL consumers: `fetch.ts` L141 throws `remoteNotConfigured(remoteName)` when `remote?.url === undefined || remote.url === ''`; `push.ts` L152–154 resolves `remote?.pushUrl ?? remote?.url`. A valueless `remote.origin.url` lands here today as `undefined` → `REMOTE_NOT_CONFIGURED`, a different message than git's `missing value for 'remote.origin.url'`.
- Error model: `CommandError` is a discriminated union in `src/domain/commands/error.ts`; each variant is `{ code, …data }` wrapped by `new TsgitError({...})`. `configParseError(line, source?, partialSectionName?)` → `CONFIG_PARSE_ERROR { code, line, source? }` is the structured precedent to mirror (1-based line; optional source label supplied by the caller). `authorUnconfigured()` → `AUTHOR_UNCONFIGURED` (no data).

## Requirements

1. A valueless string-typed config key, read by a command that needs it for a real purpose, refuses with a **new structured error** carrying `{ key, source, line }` — enough for an interop test to reconstruct both of git's lines (`error: missing value for '<key>'` and `fatal: bad config variable '<key>' in file '<F>' at line <N>`). The library emits no rendered string (ADR-249).
2. **Identity ordering is file-position, not name-before-email** (pinned — see the discriminator row in the matrix). git's `git_ident_config` callback fires per-entry during the in-order config scan, so the refusal trips on the **first valueless `user.*` entry by config-file line order**, reporting that key + line. With both valueless, refuse on whichever of `user.name`/`user.email` appears first in the file; with one valued, refuse on the valueless one at its line.
3. **Absent ≠ valueless.** Both identity fields absent (no `[user]` section / no key lines) keeps the existing `AUTHOR_UNCONFIGURED` path (a pre-existing divergence — tsgit can't portably probe GECOS; out of scope). Only the valueless case gets the new shape. No `AUTHOR_UNCONFIGURED` regression.
4. The porcelain surfaces (`config --get`/`--list`/`--type=bool`) are **unchanged** — they already succeed on valueless keys via ADR-314. The refusal lives at the command consumers, not the read primitive.
5. `line` is 1-based; `source` is the config file the key was read from (decision required on its exact contents — see candidate table — given the absolute-vs-repo-relative divergence).
6. Scope decision (see candidate table): identity-only vs. also remote-URL on fetch/push. Deferrals listed as backlog candidates in dependency order.

## Design

### Pinned git behaviour (git 2.54.0; scrubbed env, isolated HOME, `GIT_CONFIG_NOSYSTEM=1`, signing off) — authoritative

| Config (in `.git/config`) | Command | git stderr | exit |
|---|---|---|---|
| `[user]` / `name` valueless (line 2) / `email = a@b.c` | `git commit` | `error: missing value for 'user.name'`<br>`fatal: bad config variable 'user.name' in file '.git/config' at line 2` | 128 |
| `[user]` / `name = X` / `email` valueless (line 3) | `git commit` | `error: missing value for 'user.email'`<br>`fatal: bad config variable 'user.email' in file '.git/config' at line 3` | 128 |
| `[user]` / `name` valueless (line 2) / `email` valueless (line 3) | `git commit` | dies on **`user.name`** at line 2 | 128 |
| `[user]` / `email` valueless (line 2) / `name` valueless (line 3) — **discriminator** | `git commit` | dies on **`user.email`** at line 2 — proves **file-position order**, not name-first | 128 |
| no `[user]` section (absent) | `git commit` | NO die — auto-detects GECOS+hostname, commits with "configured automatically" warning | 0 |
| `[remote "origin"]` / `url` valueless (line 2) / `fetch = …` | `git fetch origin` AND `git push origin main` | `error: missing value for 'remote.origin.url'`<br>`fatal: bad config variable 'remote.origin.url' in file '.git/config' at line 2` | 128 |
| any valueless key | `git config --list` / `--get <k>` / `--type=bool <k>` | succeed: `--list` renders bare key; `--get` prints empty line (exit 0); `--type=bool` → `true` | 0 |
| `[gc]` / `auto` valueless (int-typed) | `git config --type=int gc.auto` | `fatal: bad numeric config value '' for 'gc.auto' in file .git/config: invalid unit` — **single fatal line, no `error:` prefix, no line N** | 128 |

Conclusions honoured: (1) die at command use-sites that read a typed string for a real purpose, not at porcelain reads. (2) two-line message ⇒ structured error carries `{ key, source, line }`. (3) **file-position order** — refuse on the first valueless `user.*` entry by config-file line (the discriminator row pins this; git's per-entry config callback decides it, not a fixed name-first read). (4) absent ≠ valueless. (5) the `file '<F>'` token differs between tsgit (absolute path) and git (repo-relative) — interop must normalize (candidate #2 / test strategy). (6) int-typed shape differs and no int key is merged today ⇒ out of scope.

### Core problem: the valueless state and its line/source are erased before consumers see it

The decisive constraint is the `parseIniSections`/merge pipeline. The tokenizer knows the line and the NULL-ness; both are thrown away when:
- `parseIniSections` drops `startLine` building `IniSection.entries`, and
- the merge functions (`mergeUser`, `applyRemoteEntry`) drop the entry entirely on `value === null` (ADR-315 D4).

So a command reading `config.user` cannot today tell "absent" from "valueless", and even if it could, it has no line number to report. **The fix must restore enough provenance to the consumer to build `{ key, source, line }`.** The two ways to do that are candidate #1 (re-read raw tokens at the consumer vs. thread a present-but-null marker through `ParsedConfig`).

### Detection semantics (independent of candidate #1 mechanism)

At each in-scope consumer, the resolution order is: **the new valueless refusal fires before the existing absent path.** Concretely for identity, scan the `user.*` entries in **config-file (token) order** and refuse on the first present-but-null one:

1. Walk the `user.name`/`user.email` entries in the order they appear in the config source. The **first** present-but-null one → refuse `{ key, source, line }` (`key` ∈ {`user.name`, `user.email`}, `line` = that entry's 1-based line).
2. Else fall through to the existing pipeline: both valued → succeed; both absent → `AUTHOR_UNCONFIGURED` (unchanged).

This file-position rule reproduces every pinned row: `name`@2 + `email`@3 both valueless ⇒ dies on `user.name`@2; `email`@2 + `name`@3 both valueless ⇒ dies on `user.email`@2 (the discriminator); one valued + one valueless ⇒ dies on the valueless one at its line; both absent ⇒ unchanged. The same shape applies to `remote.<n>.url` at `fetch`/`push` if candidate #3 selects breadth: present-but-null url → refuse `{ key: 'remote.<n>.url', source, line }` before the `REMOTE_NOT_CONFIGURED` (= url absent) path.

**Ordering basis — pinned (was an open probe; now resolved).** The discriminator row settles it: git refuses on the first valueless `user.*` entry **by config-file line**, not by a fixed name-before-email read order. Mechanically, git's `git_ident_config` callback runs per config entry during the in-order scan and trips `config_error_nonbool` on the first NULL it hits. So the detection must iterate entries in token/file order (which tsgit's tokenizer already yields) and refuse on the first valueless identity key — naturally giving both the correct key and its line. This slightly favours detection mechanism (a) (re-read raw tokens), which provides file order + line directly.

### Error shape

A new `CommandError` variant, mirroring `CONFIG_PARSE_ERROR`'s precedent:

```
{ readonly code: 'CONFIG_MISSING_VALUE'; readonly key: string; readonly source: string; readonly line: number }
```

with a factory `configMissingValue(key, source, line)` in `src/domain/commands/error.ts`. `key` is the fully-qualified config key (`'user.name'`, `'remote.origin.url'`); `line` is 1-based; `source` is the resolved config file path token (exact contents per candidate #2). This is distinct from `CONFIG_PARSE_ERROR` (which is the `bad config line N` *parse-time* malformation, a different git message and a different cause) and from `AUTHOR_UNCONFIGURED`. Int-typed (`bad numeric config value '' … invalid unit`, single line, no line N) is a different message shape with no `key`-at-`line` framing; it is **not** this variant and is out of scope (no int key merged today).

### Hexagonal placement

The error factory is domain (`domain/commands/error.ts`), consistent with every other `CommandError`. The detection (reading provenance, choosing name-vs-email, throwing) is application-layer: either in `internal/current-identity.ts` + `commit.ts`'s inline `configUser` build (and `fetch.ts`/`push.ts` if breadth), or pushed into the config-read merge layer depending on candidate #1. The read primitive (`config-read.ts` porcelain path) stays untouched in behaviour — porcelain reads keep succeeding.

### Source-path token (pinned conclusion #5)

git prints the path it resolved against CWD — repo-relative `.git/config` in the matrix, even when run from a subdir. tsgit's `loadConfig` resolves an **absolute** `${commonGitDir}/config`. The library is a structured-data emitter (ADR-249): it should put into `source` the path it actually has (the absolute resolved config path — the same value already fed to `CONFIG_PARSE_ERROR`'s `source`, so the two config errors stay consistent). Reconstructing git's *exact* repo-relative token is a rendering concern for the caller, and the byte-for-byte path string is **not** part of the faithfulness contract (ADR-249 binds data, not display). The interop test therefore normalizes the path token (compare on the `config` basename / suffix, or reconstruct the repo-relative form from the known tmpdir) rather than asserting the absolute path equals git's relative one. This is called out as the one genuine interop-comparison subtlety; it does not change the library's emitted field.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Detection mechanism** — how the consumer learns a string key is present-but-null and at which line | (a) **Re-read raw tokens** at the consumer: call a small `findValuelessEntry(ctx, section, subsection, key)` that re-tokenizes (or reuses cached `IniSection` widened with line) to locate the NULL entry + its 1-based line; merge layer unchanged. (b) **Thread a present-but-null marker through `ParsedConfig`**: widen `IniSection.entries` to carry `line`, and widen the merged string fields to a `{ value: string } | { missing: true; line: number }`-style provenance so `mergeUser`/`applyRemoteEntry` keep the null with its line instead of dropping it; consumers branch on it. (c) **Hybrid**: keep `ParsedConfig` as-is (absent), but have it expose a sibling `missingStringKeys: ReadonlyArray<{ key; line }>` collected during merge, consulted only on the refusal path. | **(a)** for an identity-first scope; revisit toward (c) if breadth is chosen | (a) is the smallest diff and keeps ADR-315 D4 (`ParsedConfig` stays "valueless = absent") fully intact — the merged shape never changes, so no public-type ripple and no consumer outside the refusal path is touched. The line provenance the tokenizer already computes (`startLine`) is recoverable by re-tokenizing the same file (cheap; `readRawConfig` is cached per-Context). (b) is the "feature-sized thread-through" ADR-315 flagged; even now-scoped it widens `IniSection` + every merged string field + every consumer's type — a public-type change (`ParsedConfig`) and the largest blast radius, disproportionate to a refusal-only need. (c) bounds the blast radius better than (b) but still adds a parallel structure to `ParsedConfig` and couples merge to refusal concerns (CQS smell: the merge now also collects diagnostics). Verdict: ADR-315's "thread-through is feature-sized" **still holds** for (b); (a) sidesteps it. **User decides** the mechanism. |
| 2 | **Error code + field shape**, incl. what `source` holds | (a) `CONFIG_MISSING_VALUE { key, source, line }` where `source` = tsgit's resolved **absolute** config path (same value `CONFIG_PARSE_ERROR` carries); interop normalizes the path token. (b) Same code/fields but `source` = a **repo-relative** path (`.git/config`) computed to match git's token byte-for-byte. (c) Reuse/extend `CONFIG_PARSE_ERROR` with an extra `key?` rather than a new code. | **(a)** | (a) keeps the two config errors' `source` semantics identical (consistency, no second path-resolution rule) and respects ADR-249 (the path string is display, not contract). (b) chases byte-parity on a token ADR-249 says is the caller's to render, and would force a CWD-relative resolver the library doesn't otherwise need — fragile (depends on caller CWD, which the library doesn't track). (c) conflates a *parse-time line malformation* (`bad config line N`) with a *use-time typed-read failure* (`missing value for K` + `bad config variable K … at line N`) — different git messages, different causes; overloading one code loses the discriminated-union clarity every other `CommandError` has. Int-typed (future) gets its **own** code if ever added (different message: no `key`-at-`line`, single fatal line) — do not pre-shape this variant for it. **User decides** the exact name/fields. |
| 3 | **Scope of this PR** | (a) **Identity-only**: `commit` + the `resolveCurrentIdentity` consumers (cherry-pick, rebase, revert, merge). Remote-URL on fetch/push deferred. (b) **Identity + remote-URL**: also `fetch`/`push` valueless `remote.*.url`. (c) **Full string-typed surface**: also `branch.*.merge`, `merge.*.driver`, `submodule.*.url`, etc. wherever a string field is consumed. | **(a)** identity-first, with (b) as the immediate tracked follow-up | git dies on `remote.origin.url` too (pinned), so "faithful everywhere" argues for breadth; but bounded-diff + the candidate-#1 mechanism choice argue for landing identity first, proving the error shape + interop normalization end-to-end, then replicating the now-proven pattern to remote-URL. (a) covers the highest-traffic case (commit identity) and all four shared-resolver consumers in one well-understood detection site. (c) sprawls across many low-traffic consumers with diminishing faithfulness value per diff. **Deferrals, in dependency order:** (i) remote-URL valueless refusal on `fetch`/`push` (reuses the same error + detection pattern) — backlog candidate; (ii) other string-typed fields (`branch.*.merge`, `merge.*.driver`, `submodule.*.url`, `core` path-likes) — backlog candidate, lower priority; (iii) int-typed valueless shape if/when an int key is ever merged into `ParsedConfig` (own error code) — backlog candidate, blocked on such a key existing. **User decides** the scope. |

## Test strategy

### Unit (`current-identity` / `commit` area; `commit-message` resolver)
Drive through whichever detection site candidate #1 selects. Assert `.data` fields **individually** (code, key, source, line) via try/catch — never bare `toThrow(Class)` (mutation-resistant; per project conventions). One test per guard:
- valueless `user.name` (email valued) → refuse `CONFIG_MISSING_VALUE` with `{ key: 'user.name', line: <its 1-based line>, source }`.
- valued `user.name` + valueless `user.email` → `{ key: 'user.email', line: <its line> }`.
- both valueless, `name` on the earlier line (`[user]\n\tname\n\temail`) → `{ key: 'user.name', line: 2 }` (a **separate** test from the single-valueless cases, isolating the ordering guard).
- both valueless, `email` on the earlier line (`[user]\n\temail\n\tname`) → `{ key: 'user.email', line: 2 }` — the **discriminator** test: pins file-position order and kills a "fixed name-first" mutant. This pair (name-earlier vs email-earlier) is what proves the ordering is by file line, not by key name.
- both absent → still `AUTHOR_UNCONFIGURED` (regression guard for requirement 3; assert the code, not the type alone).
- both valued → succeeds (identity resolves; no throw).
If candidate #3 picks breadth: sibling `fetch`/`push` unit tests — valueless `remote.<n>.url` → `{ key: 'remote.<n>.url', line, source }`; absent url → still `REMOTE_NOT_CONFIGURED`.

### Interop (`test/integration/config-interop.test.ts`, or a new `missing-value-refusal-interop.test.ts`)
Twin git/tsgit via `interop-helpers.ts` (`tryRunGit` for co-refusal, `git -C <tmp>` into a tmpdir's `.git/config` — never the worktree). Write the valueless line by **file write** into `<dir>/.git/config` (git's CLI cannot emit a valueless entry), then:
- run real `git commit` via `tryRunGit` → capture exit 128 + the two stderr lines; run tsgit `commit` on the same repo → catch `CONFIG_MISSING_VALUE`; reconstruct git's two lines from `{ key, source, line }` and assert equality of `error: missing value for '<key>'` and `fatal: bad config variable '<key>' in file '<F>' at line <N>` — applying the **path-token normalization** (conclusion #5: normalize tsgit's absolute `source` to git's repo-relative token before comparing the `file '<F>'` segment; the `key` and `line` segments compare verbatim).
- `git config --list` on the same file **succeeds** in both (distinct outcome from the refusal — proves requirement 4).
- absent identity is a **distinct** outcome: real git auto-commits (exit 0); tsgit refuses `AUTHOR_UNCONFIGURED` — assert this is *not* `CONFIG_MISSING_VALUE` (documents the pre-existing absent-case divergence without regressing it).
- (if breadth) `git fetch origin` / `git push origin main` with valueless `remote.origin.url` → same two-line reconstruction for `remote.origin.url`.

### Property tests — DO NOT APPLY
Per the project's four-lens rule: this is a **command-surface refusal**, not a parser/round-trip, matcher/aggregator, total-function-over-grammar, or idempotence/counting invariant. The detection is a small fixed decision (name-vs-email-vs-absent), not an algebraic grammar; the parser/round-trip property already lives with the ADR-314 valueless-key work. No `*.properties.test.ts` sibling is warranted; example + interop tests document the literal behaviour exactly.

## Out of scope

- **Absent-identity parity.** git auto-detects GECOS + hostname and commits with a "configured automatically" warning; tsgit can't portably probe GECOS and refuses `AUTHOR_UNCONFIGURED`. Pre-existing divergence, untouched here, no regression.
- **Int-typed valueless shape.** git's `fatal: bad numeric config value '' for '<key>' … invalid unit` is a single fatal line (no `error:` prefix, no `at line N`) — a different message shape. No int-typed key is merged into `ParsedConfig` today (ADR-315 §Neutral). If one is ever added it needs its **own** error code/shape, not `CONFIG_MISSING_VALUE`. Backlog candidate, blocked on such a key existing.
- **Remote-URL (and other string-typed) refusal** — in scope only if candidate #3 selects breadth; otherwise a tracked follow-up in dependency order (remote-URL first, then `branch.*.merge` / `merge.*.driver` / `submodule.*.url` / `core` path-likes).
- **Porcelain read surfaces** (`config --get`/`--list`/`--type=bool`) — already faithful via ADR-314; unchanged.
- **Writing valueless entries** — git's CLI cannot; not a surface (ADR-314/315 D5).
- **The byte-exact repo-relative `file '<F>'` path token** — a caller-side rendering concern (ADR-249); the library emits its resolved path in `source`, and the interop test normalizes for comparison.
