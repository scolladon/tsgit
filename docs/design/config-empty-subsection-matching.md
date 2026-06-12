# Design — Section identity & addressing: `[s ""]` vs `[s]`, section-op grammar, the empty section name

## Goal

Close the section-identity faithfulness gap in the config writer's two section matchers (backlog 24.9k, surfaced by 24.9g; twin matcher noted by 24.9i), **and** — per ADR-323 — the two adjacent addressing gaps the first revision scoped out:

- git treats an explicitly empty subsection as a **distinct section**: `s.k` never matches `[s ""]`, and `s..k` (empty subsection in the dotted key) never matches `[s]` (pinned below).
- tsgit's line-based `matchesSection` and token-based `matchesTarget` both conflate the two — a query with `subsection === undefined` matches `[s]` **and** `[s ""]` — so writes targeting `s.k` can replace, insert into, or delete entries belonging to `[s ""]`.
- The read path is already exact (`matchesSectionHeader`, `qualifyKey`, `parseConfigKey`) — the fix realigns the write matchers with the identity rule the readers already apply, restoring one rule across the whole surface.
- **Folded in (ADR-323):** plain-name (`s`) and cross-family (`s → t`) section ops, which git supports and tsgit refuses — absorbing backlog 24.9n — and the **empty-section-name axis** (`..k`, `.x.k`, `[ ""]`, `[ "x"]`), which git represents and tsgit's key grammar refuses outright.
- **Addressing of the empty form (ADR-322):** the trailing-dot section name (`'s.'`) addresses `[s ""]` in rename/remove, exactly as git does.

Both matchers express one identity rule and are fixed together (the brief's requirement): line-based section ops (rename/remove-section) and token-based entry surgery (set/unset/append) share it.

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, no signing). Fixtures:

- `both.conf` = `[s]\n\tk = a\n[s ""]\n\tk = b\n`
- `rev.conf` = the same two blocks in reverse order
- `empty-only.conf` = `[s ""]\n\tk = b\n` ; `plain-only.conf` = `[s]\n\tk = a\n`
- `mix.conf` = `[s]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n`
- `name-mix.conf` = `[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n`

### Read identity

| Command | Result | Exit |
| --- | --- | --- |
| `git config --file both.conf s.k` | `a` | 0 |
| `git config --file both.conf s..k` | `b` | 0 |
| `git config --file rev.conf s.k` / `s..k` | `a` / `b` — order-independent | 0 |
| `git config --file empty-only.conf s.k` | no output — `s.k` does NOT match `[s ""]` | 1 |
| `git config --file plain-only.conf s..k` | no output — `s..k` does NOT match `[s]` (reverse identity) | 1 |
| `git config --file both.conf --get-all s.k` / `s..k` | `a` / `b` | 0 |
| `git config --file both.conf --list` | `s.k=a` and `s..k=b` — empty subsection renders as the double-dot key | 0 |
| `git config --file both.conf --list -z` | `s.k\na\0s..k\nb\0` | 0 |
| `git config --file both.conf --get-regexp '.*'` | `s.k a` and `s..k b` | 0 |
| `git config --file both.conf --get-regexp '^s\.k$'` / `'^s\.\.k$'` | `s.k a` only / `s..k b` only | 0 |
| `git config --file <[S ""] k=caps> s..k` | `caps` — section part case-insensitive, identity preserved | 0 |
| `git config --file <[s     ""] k=b> s..k` | `b` — header whitespace before the quote is not identity | 0 |

### Write identity (`set` / `--add`)

| Command | Resulting bytes | Note |
| --- | --- | --- |
| `git config --file both.conf s.k v` | `[s]\n\tk = v\n[s ""]\n\tk = b\n` | only `[s]` rewritten |
| `git config --file both.conf s..k v` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` | only `[s ""]` rewritten |
| `git config --file rev.conf s.k v` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` | first-in-file `[s ""]` never captures the write |
| `git config --file rev.conf s..k v` | `[s ""]\n\tk = v\n[s]\n\tk = a\n` | |
| `git config --file empty-only.conf s.k v` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` | a NEW `[s]` is appended — git does not reuse `[s ""]` |
| `git config --file plain-only.conf s..k v` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` | a NEW `[s ""]` is appended |
| `git config --file empty s..k v` | `[s ""]\n\tk = v\n` | from-scratch creation renders `[s ""]` |
| `git config --file <prev> --add s..k v2` | `[s ""]\n\tk = v\n\tk = v2\n` | append lands inside `[s ""]` |
| `git config --file empty-only.conf --add s.k x` | `[s ""]\n\tk = b\n[s]\n\tk = x\n` | `--add` appends a new `[s]` too |
| `git config --file <[S] k=a> s.k v` | `[S]\n\tk = v\n` | entry writes stay case-insensitive on the section — `[S]` is rewritten in place |

### Unset identity

| Command | Resulting bytes | Exit |
| --- | --- | --- |
| `git config --file both.conf --unset s.k` | `[s ""]\n\tk = b\n` — `[s]` entry removed, emptied block pruned, `[s ""]` untouched | 0 |
| `git config --file both.conf --unset s..k` | `[s]\n\tk = a\n` | 0 |
| `git config --file empty-only.conf --unset s.k` | file unchanged — nothing matched | 5 |
| `git config --file <[s]k=a · [s ""]k=b · [s]k=c> --unset-all s.k` | `[s ""]\n\tk = b\n` — both `[s]` blocks cleared and pruned | 0 |
| `git config --file <[s ""]k=a · [s ""]k=b · [s]k=c> --unset-all s..k` | `[s]\n\tk = c\n` | 0 |

### Section ops — empty-subsection addressing (`s.`)

git addresses the empty subsection with a **trailing-dot name** `s.` (and only that — `s.""` is the two-quote-char subsection, "no such section"):

| Command | Result | Exit |
| --- | --- | --- |
| `--remove-section s` on `both.conf` | `[s ""]\n\tk = b\n` — only `[s]` removed | 0 |
| `--remove-section s.` on `both.conf` | `[s]\n\tk = a\n` — only `[s ""]` removed | 0 |
| `--remove-section 's.""'` on `both.conf` | `fatal: no such section: s.""` | 128 |
| `--remove-section s.` on `plain-only.conf` | `fatal: no such section: s.` | 128 |
| `--remove-section s` on `empty-only.conf` | `fatal: no such section: s` | 128 |
| `--rename-section s t` on `both.conf` | `[t]…[s ""]…` — plain form renamed, empty form untouched | 0 |
| `--rename-section s. t.` on `both.conf` | `[s]…[t ""]…` | 0 |
| `--rename-section s. t` on `both.conf` | `[s]…[t]…` — empty form renamed TO a plain section | 0 |
| `--rename-section s s.` on `both.conf` | `[s ""]…[s ""]…` — plain renamed TO the empty form (duplicate headers allowed) | 0 |
| `--rename-section s.x s.` on `[s "x"]k=a` | `[s ""]\n\tk = a\n` | 0 |

### Section ops — plain names and cross-family renames

| Command | Result | Exit |
| --- | --- | --- |
| `--rename-section s t` on `mix.conf` | `[t]…[s "x"]…[s ""]…` — only the plain block moves | 0 |
| `--remove-section s` on `mix.conf` | `[s "x"]…[s ""]…` — only the plain block removed | 0 |
| `--rename-section s.x t.y` on `mix.conf` | `[s]…[t "y"]…[s ""]…` — cross-family dotted rename | 0 |
| `--rename-section s.x t` on `mix.conf` | `[s]…[t]…[s ""]…` — dotted → plain | 0 |
| `--rename-section s t.y` on `mix.conf` | `[t "y"]…[s "x"]…[s ""]…` — plain → dotted | 0 |
| `--rename-section s t` on `[s]k=a · [s "x"]k=b · [s]k=c` | BOTH `[s]` blocks become `[t]` | 0 |
| `--remove-section s` on the same | BOTH `[s]` blocks removed, `[s "x"]` kept | 0 |
| `--rename-section t.y u` (old absent, valid) | `fatal: no such section: t.y` | 128 |

### Section ops — old-name matching is raw, byte-exact, case-sensitive

git never *parses* the old name: each header is reduced to its raw dotted name (`[s]` → `s`, `[s "x"]` → `s.x`, `[s ""]` → `s.`, `[ ""]` → `.`, `[ "x"]` → `.x`, deprecated `[s.X]` → `s.X`) and compared **byte-for-byte** with the input — even though *reads* are case-insensitive on the section part:

| Command | Result | Exit |
| --- | --- | --- |
| `--rename-section s t` on `[S]k=a` | `fatal: no such section: s` — despite `--list` showing `s.k=a` | 128 |
| `--rename-section S t` on `[S]k=a` | `[t]\n\tk = a\n` | 0 |
| `--rename-section s.x t` on `[s "X"]k=a` | `fatal: no such section: s.x` ; `s.X` succeeds | 128 / 0 |
| `--remove-section a.b` on `[A.B]k=p` | `fatal: no such section: a.b` | 128 |
| `--rename-section s.x t` on deprecated `[s.X]k=a` | `fatal: no such section: s.x` ; `s.X` succeeds — raw header bytes, though `--list` prints `s.x.k=a` | 128 / 0 |
| `--remove-section a.b` on `[a.b]k=p · [a "b"]k=q` | **both** blocks removed — `a.b` is the raw name of both | 0 |
| `--rename-section a.b t` on the same | both become `[t]` | 0 |
| `--rename-section a.b. t` on `[a "b."]k=p · [a.b ""]k=q` | both become `[t]` — the ambiguity generalizes | 0 |

### Section ops — new-name grammar and refusals

The new name **is** parsed: split at the **first** dot — section part before, subsection (raw, free-form) after. Validation applies only to the section part (alphanumeric or `-`; empty whole name refused; empty section part is allowed when a dot follows):

| Command | Result | Exit |
| --- | --- | --- |
| `--rename-section s t.a.b` | `[t "a.b"]` — first-dot split; renaming TO a plain dotted `[x.y]` header is impossible | 0 |
| `--rename-section s 1num` | `[1num]` — digit-leading section accepted | 0 |
| `--rename-section s t-x` | `[t-x]` | 0 |
| `--rename-section s t_x` | `error: invalid section name: t_x` | 255 |
| `--rename-section s 'bad!name'` | `error: invalid section name: bad!name` | 255 |
| `--rename-section s ''` | `error: invalid section name: ` | 255 |
| `--rename-section s 't.bad!sub'` | `[t "bad!sub"]` — subsection chars are free after the first dot | 0 |
| `--rename-section s 't.with"quote'` | `[t "with\"quote"]` — quote escaped in the rendered header | 0 |
| `--rename-section s T.Y` | `[T "Y"]` — case preserved | 0 |
| `--rename-section 'bad!name' t` | `fatal: no such section: bad!name` — the OLD name is never validated, only looked up | 128 |
| `--rename-section s "t.a\nb"` (literal newline) | git writes the newline **raw** inside the quotes — the resulting file is corrupt (no longer parseable) | 0 |

The last row is a git foot-gun, recorded for decision N2 below.

### The empty section name (`[ ""]`, `[ "x"]`)

An empty section name is representable whenever a subsection is present (`('', '')` and `('', x)`); it has **no** plain form:

| Command | Result | Exit |
| --- | --- | --- |
| `git config --file empty ..k v` | writes `[ ""]\n\tk = v\n` | 0 |
| `git config --file <prev> ..k` | `v` — GET works (corrects the earlier pin, which ran GET against an empty file) | 0 |
| GET `..k` on an empty file | silent | 1 |
| `--list` / `--list -z` / `--get-regexp '.*'` | `..k=v` / `..k\nv\0` / `..k v` | 0 |
| `--add ..k v2` then `--get-all ..k` | appends inside `[ ""]`; `v`, `v2` | 0 |
| `--unset ..k` (two values) | `warning: ..k has multiple values`, file unchanged | 5 |
| `--unset-all ..k` | block cleared and pruned — 0-byte file | 0 |
| `--unset ..k` (absent) | file unchanged | 5 |
| `git config --file empty .x.k v` | writes `[ "x"]\n\tk = v\n`; GET/`--list` (`.x.k=v`) work | 0 |
| `--unset .x.k` on `[ "x"]k=a · [ ""]k=e` | removes/prunes only `[ "x"]` — subsection identity holds inside the `''` family | 0 |
| GET `.k` | `error: key does not contain a section: .k` — empty section WITHOUT a subsection stays refused | 1 |
| SET `.k v` | same message | 2 |
| SET `..9k` | `error: invalid key: ..9k` — variable-name grammar still applies | 1 |
| `--list` on `name-mix.conf` | `..k=e`, `s.k=a`, `s..k=b` | 0 |
| SET `..k` on `plain-only.conf` | `[s]…` then a NEW `[ ""]` appended at the end | 0 |
| SET `s.k` on `[ ""]`-only | `[ ""]…` then a NEW `[s]` appended | 0 |
| `[ "X"]k=e` + GET `.X.k` / `.x.k` | `e` / silent — subsection stays case-sensitive | 0 / 1 |
| `["x"]k=a` (no space before the quote) + `--list` | `fatal: bad config line 1 in file f` | 128 |

Section ops on the empty-name family (`.` is the raw name of `[ ""]`, `.x` of `[ "x"]`):

| Command | Result | Exit |
| --- | --- | --- |
| `--remove-section .` on `name-mix.conf` | only `[ ""]` removed | 0 |
| `--remove-section .` when absent | `fatal: no such section: .` | 128 |
| `--rename-section . t` on `name-mix.conf` | `[t]…` — empty-name form renamed to a plain section | 0 |
| `--rename-section . t.` | `[t ""]…` | 0 |
| `--rename-section . .x` | `[ "x"]…` — empty section part accepted in a dotted NEW name | 0 |
| `--rename-section . s.x` | `[s "x"]…` | 0 |
| `--rename-section s .` on `name-mix.conf` | `[s]` becomes a second `[ ""]` block | 0 |
| `--rename-section s.x .` on `[s "x"]k=a` | `[ ""]\n\tk = a\n` | 0 |
| `--rename-section .x t` / `--remove-section .x` on `[ "x"]k=e` | renamed to `[t]` / removed | 0 |
| `--remove-section ''` | `fatal: no such section: ` — the empty OLD name is a lookup miss, not a grammar error | 128 |

## Current state

One identity rule, three implementations — one exact, two conflating — plus an addressing surface that refuses most of git's name grammar:

| Site | File / symbol | Rule today |
| --- | --- | --- |
| Read matcher | `src/application/primitives/internal/config-key.ts` `matchesSectionHeader` (line 16) | **exact** — `undefined` matches only `undefined`, `''` only `''` |
| Line-based write matcher | `src/application/primitives/update-config.ts` `matchesSection` (line 41) | **conflating** — `undefined` matches `undefined` OR `''`; also lowercases the section (git's section ops are byte-exact) |
| Token-based write matcher | `src/application/primitives/update-config.ts` `matchesTarget` (line 140) | **conflating** — same arm, copied verbatim per ADR-316 ("preserved verbatim"); its case-insensitivity is correct for entry writes (pinned above) |
| Section-op name parsing | `update-config.ts` `parseSectionName` (line 822) | refuses plain `s`, trailing-dot `s.`, leading-dot `.x`, and `.` — requires an interior dot; its docstring (lines 818–820) falsely claims canonical git cannot rename top-level sections (pinned: it renames and removes them freely) |
| Family guard | `update-config.ts` `renameConfigSection` (lines 862–867) | refuses cross-family renames with `INVALID_OPTION` — git renames across families freely (pinned) |
| Key grammar | `src/domain/commands/config-key.ts` `parseConfigKey` (line 65) | refuses an empty section outright (`CONFIG_KEY_INVALID` reason `'empty-section'`) — `..k` and `.x.k` are unrepresentable, though git writes and reads them |

Call-site inventory (every place the identity/addressing rules reach):

- **Exact already (no change):**
  - `collectValues` / `collectScopedValues` (`internal/config-key.ts`) → `configGet`, `configGetAll`, `configUnset`/`configUnsetAll` existence + multiplicity checks, scoped reads. Section comparison is `toLowerCase()` against the parsed key's lowered section — `''` compares fine.
  - `qualifyKey` (`internal/config-key.ts` line 9) → `configList` / `configGetRegexp` key rendering: `[s ""]` qualifies as `s..k` and `[ ""]` as `..k`, byte-equal to git's `--list` rendering (pinned).
  - `parseSectionHeader` (`config-read.ts` line 493) already parses `[ ""]` / `[ "x"]` to `section: ''` (the quoted branch trims the pre-quote run), and refuses `["x"]` (quote with no preceding space) as malformed — matching git's `bad config line` fatal.
  - `dispatchSection` (`config-read.ts` line 581) → a `''` section hits no typed branch (`core`/`user`/`remote`/… literals), so empty-name sections flow only into the raw entry list — correct, no change.
  - `renderSectionHeader` (`update-config.ts` line 99) → `renderSectionHeader('', '')` emits `[ ""]`, byte-equal to git; `rejectSection('')` and `rejectSubsection('')` pass.
- **Conflating / refusing (the fix):**
  - `matchesSection` → `findSectionHeader` (existence checks in `renameConfigSection` / `removeConfigSection`), `removeConfigSectionInText` (line 450), `renameConfigSectionInText` (line 480). Today every porcelain caller passes a non-empty subsection, so the conflating arm is latent here — but the `InText` primitives are exported, and a direct caller passing `undefined` silently drops/renames `[s ""]` blocks too.
  - `matchesTarget` → `findEntry` (replace target selection), `insertionLine` (new-key placement, also used by `appendConfigEntry`), `removeConfigEntry` block matching, and the batch `applyConfigOpInText` — i.e. **every entry write**.
  - `parseSectionName` → both porcelain section ops; the family guard sits behind it in `renameConfigSection`.
  - `parseConfigKey` → every key-taking surface (`setConfigEntry` / `appendConfigEntry` / `removeConfigEntry` wrappers in `update-config.ts`, scoped reads in `config-scoped-read.ts`, command layer). The `'empty-section'` refusal is pinned by `test/unit/domain/commands/config-key.test.ts` (line 125, input `.name`) and the shape tests in `error.test.ts` — both **survive** (the subsection-less `.k` form stays refused); no unit or interop test pins the plain-name or cross-family refusals (checked — they are implementation-only today).

Observable divergences today (each is a pinned-matrix row tsgit gets wrong):

1. `setConfigEntry('s.k', v)` on `rev.conf` replaces the `k` inside `[s ""]` (first matching block in line order); git rewrites `[s]`.
2. New-key insertion targets the end of the **last** matching block (ADR-316), so with `both.conf` + a new key, the entry lands inside `[s ""]`; git puts it at the end of `[s]`.
3. `unsetConfigEntry('s.k')` on `both.conf`: the multiplicity guard (`collectValues`, exact) counts **1** match, but `removeConfigEntry` (conflating) deletes the `k` from **both** blocks and prunes both — silent data loss, and an internal contradiction between counter and surgery.
4. `setCoreConfigEntryInText` on a file holding only `[core ""]` edits that block in place; git appends a real `[core]`. The unit test at `test/unit/application/primitives/update-config.test.ts` ("Given an explicitly empty `[core ""]` header → Then it is treated as the [core] section") pins the divergence and flips with the fix.
5. `removeConfigSection` / `renameConfigSection` cannot address `[s ""]` at all: `parseSectionName` refuses the trailing-dot form git uses (`s.`).
6. Plain-name section ops (`--rename-section s t`, `--remove-section s`) are refused with `INVALID_OPTION`; git performs them, touching only plain blocks.
7. Cross-family renames (`s.x → t.y`, `s. → t`, `s → t.y`, …) are refused by the family guard; git performs all of them.
8. Section-op matching is case-insensitive (`Remote.origin` matches `[remote "origin"]`); git's is byte-exact (`fatal: no such section` for the case mismatch).
9. `..k` / `.x.k` keys are refused (`'empty-section'`); git writes `[ ""]` / `[ "x"]` and reads them back.
10. `.` / `.x` section names are refused by `parseSectionName`; git's section ops address the empty-name family with them.

## Design

### Matcher fix — one exact identity rule (forced by the pinned evidence)

Drop the conflation arm in both matchers; subsection identity becomes strict equality over `string | undefined`:

- `matchesTarget`: `header.subsection === target.subsection` after the (case-insensitive — pinned correct for entry writes) section check. `undefined === undefined` and `'' === ''` hold, cross-pairs do not.
- `matchesSection` is **replaced** by raw-name matching for section ops (next subsection); its conflation arm disappears with it.

Everything downstream inherits the fix with zero signature changes on the entry-write side: `findEntry`, `insertionLine`, `appendConfigEntry`, `removeConfigEntry`, `applyConfigOpInText`. The pinned write matrix (replace / insert / append / unset / unset-all / prune, both orders) falls out of ADR-316's existing span machinery once the block matcher is exact. Divergence 3's counter-vs-surgery contradiction closes for free because counter and surgery now share the rule.

`renderSectionHeader(section, '')` already emits `[s ""]` and `parseSectionHeader` round-trips it (24.9g), so from-scratch creation of the empty form needs no writer change.

### Section ops — raw old-name matching + first-dot new-name parsing (decision N1)

The pinned matrices show git's section ops are **asymmetric**: the old side is a raw byte-exact lookup, the new side a validated first-dot parse. The recommended design mirrors both halves and deletes `parseSectionName` and the family guard outright:

- **Old side — `rawSectionName(header)`**: plain header → `section`; subsectioned header → `` `${section}.${subsection}` `` (after subsection unescaping). A header matches when `rawSectionName === oldName`, byte-for-byte. This single rule yields, with no special cases: trailing-dot addressing of `[s ""]` (`'s.'`, ADR-322), plain names (`'s'`), `.`/`.x` for the empty-name family, case-sensitive matching (`[S]` only via `'S'`), deprecated `[s.x]` headers, the no-match of `'s.""'`, and the pinned ambiguity rows (`'a.b'` matching both `[a.b]` and `[a "b"]`).
- **New side — `parseNewSectionName(name)`**: refuse when the name is empty or any character before the first dot is not alphanumeric/`-` (pinned: `1num`, `t-x`, `.x`, `.` accepted; `t_x`, `bad!name`, `''` refused with `error: invalid section name: <name>`). Split at the **first** dot: no dot → `{section: name, subsection: undefined}`; dot → `{section: before, subsection: rest}` (rest may be `''` for `'t.'`, may contain dots/anything). `renderSectionHeader` already covers both shapes, escaping `"`/`\` in the subsection.
- **Surgery**: `removeConfigSectionInText(text, oldName: string)` removes **every** block whose raw name matches (multi-block pinned); `renameConfigSectionInText(text, oldName: string, to: {section, subsection?})` rewrites every matching header to `renderSectionHeader(to.section, to.subsection)`. The porcelain existence check becomes "any header with `rawSectionName === oldName`", else `CONFIG_SECTION_NOT_FOUND` carrying the raw input. The exported `InText` primitive signatures change (decision N3); `findSectionHeader`/`matchesSection` collapse into the raw-name predicate.
- The family guard, `parseSectionName`, and the false "git cannot rename top-level sections" docstring are deleted.

Bytes reaching the new subsection are constrained by `rejectSubsection` today (`\n`/`\0` refused); git instead writes a raw newline and corrupts its own file (pinned). Whether to replicate that is decision N2.

### Key grammar — the empty section name (`parseConfigKey`)

Move the empty-section refusal **after** subsection determination: an empty section part is refused only when no subsection is present.

- `'..k'` → `{section: '', subsection: '', name: 'k'}`; `'.x.k'` → `{section: '', subsection: 'x', name: 'k'}` — identifier validation over `''` passes vacuously; name-part validation is untouched (`'..9k'` still refused, pinned).
- `'.k'` keeps `CONFIG_KEY_INVALID` reason `'empty-section'` — the structured twin of git's `key does not contain a section` (pinned: the empty name has no plain form). The existing refusal pins (`config-key.test.ts` `.name`, `error.test.ts` shapes) survive unchanged.
- Downstream, nothing else moves (readiness pinned in Current state): `collectValues`/`matchesSectionHeader` compare `''` correctly, `qualifyKey` renders `..k`/`.x.k`, `dispatchSection` ignores the `''` family, the writers render `[ ""]`/`[ "x"]` and place new empty-name sections at end-of-file exactly as pinned.

### Error/refusal shapes

- `CONFIG_SECTION_NOT_FOUND` carries the raw old name exactly as given (`'s.'`, `'.'`, `'bad!name'`, `''`) — byte-equal to git's `no such section: <name>` rendering (ADR-249: the caller renders; the data is the name).
- Invalid NEW section names throw the existing `INVALID_OPTION` shape with reason `invalid section name: <name>` — byte-equal to git's message text; git's 255-vs-128 exit split is caller rendering (ADR-249) and is not modeled.
- `parseConfigKey` keeps its three reasons; no new error codes anywhere.

## Ripple inventory

| Site | Change |
| --- | --- |
| `update-config.ts` `matchesTarget` | drop the conflation arm + doc comment |
| `update-config.ts` `matchesSection` / `findSectionHeader` | replaced by the raw-name predicate (decision N1) |
| `update-config.ts` `parseSectionName` + family guard + docstring | deleted; `parseNewSectionName` added |
| `update-config.ts` `removeConfigSectionInText` / `renameConfigSectionInText` | re-signed to raw `oldName` (+ structured `to`) (decision N3) |
| `update-config.ts` `renameConfigSection` / `removeConfigSection` | existence check + plumbing over raw names; `CONFIG_SECTION_NOT_FOUND` carries the raw input |
| `src/domain/commands/config-key.ts` `parseConfigKey` | empty-section refusal narrowed to the subsection-less form |
| `test/unit/.../update-config.test.ts` `[core ""]` case | expectation flips to git's (new `[core]` appended) |
| `test/unit/.../update-config.test.ts` `InText` section-op tests | re-shaped to the new signatures |
| `reports/api.json` | **regenerated** — exported `InText` primitive signatures change (pre-push `check:doc-typedoc` gate) |

No domain-port or adapter changes; no new public types (the name forms flow through the existing `oldName`/`newName`/`sectionName`/`key` string inputs).

## Test plan

### Unit (`test/unit/application/primitives/update-config.test.ts`, `test/unit/domain/commands/config-key.test.ts`)

GWT/AAA with `sut`, byte-exact output assertions (mutation-resistant — full-string `toBe`, not `toContain`):

- **Replace**: `setConfigEntryInText` with `subsection: undefined` on both-form text, both orders → only `[s]` rewritten; with `subsection: ''` → only `[s ""]` rewritten. Separate tests per direction (guard isolation: `undefined`-query-vs-`''`-header and `''`-query-vs-`undefined`-header each get their own test so each side of the identity is independently proven).
- **Insert**: new key with both forms present → lands at end of the last `[s]` block, never inside `[s ""]`; only `[s ""]` present + `undefined` target → a new `[s]` section appended (and the mirror case).
- **Append** (`appendConfigEntry`): same placement matrix.
- **Unset** (`removeConfigEntry`): `undefined` target removes/prunes only `[s]` blocks across the three-block fixture; `''` target only `[s ""]` blocks; the flipped `[core ""]` case.
- **Section ops — addressing**: raw-name matching rows: trailing-dot, plain, `.`/`.x`, case mismatch (no match), deprecated `[s.x]` header, the `a.b` ambiguity (both blocks), multi-block plain rename/remove, `'s.""'` no-match. Porcelain rename/remove incl. `CONFIG_SECTION_NOT_FOUND` data assertions via try/catch (code + name + scope, not `toThrow(Class)`).
- **Section ops — new name**: `parseNewSectionName` grammar sweep — accepted (`t`, `1num`, `t-x`, `t.a.b` first-dot split, `t.`, `.x`, `.`, `T.Y` case) and refused (`''`, `t_x`, `bad!name`) with `INVALID_OPTION` data asserted; each refused character class gets its own test.
- **Key grammar**: `parseConfigKey('..k')` / `('.x.k')` structured results; `'.k'` still `'empty-section'` (existing pin survives); `'..9k'`-style name violations unchanged.
- **Empty-name writes**: set/add/unset through `..k`/`.x.k` → `[ ""]`/`[ "x"]` rendering, end-of-file placement, in-place rewrite, prune-to-empty.
- **Consistency**: `unsetConfigEntry('s.k')` on both-form text no longer throws/over-deletes — exactly the `[s]` entry goes, `CONFIG_MULTIPLE_VALUES` data asserted on the true-multi fixture.

### Interop (`test/integration/config-interop.test.ts`)

Twin git/tsgit over a shared scrubbed-env repo (one `beforeAll` repo, 60s timeout per the harness conventions): every row of the pinned matrices above —

- get/get-all on `both.conf`/`rev.conf`/single-form files (`s.k`, `s..k`), absence exits ↔ `value: undefined`;
- `--list` / `--get-regexp` reconstruction from structured entries (`s.k=a`, `s..k=b`, `..k=e` key shapes byte-equal);
- set/add matrix (write rows incl. the `[S]` in-place case row) → byte-identical files;
- unset/unset-all matrix → byte-identical files incl. pruning;
- rename/remove-section: trailing-dot, plain-name (with subsectioned siblings), cross-family (all four direction pairs + `s.x → t.y`), multi-block, case-mismatch refusal, ambiguity rows, `.`/`.x` rows, invalid-new-name refusals (`fatal`/`error` ↔ thrown error data);
- empty-name key matrix: from-scratch `..k`/`.x.k` writes, mixed-file reads, `--unset`/`--unset-all`, placement rows;
- from-scratch `s..k` set → `[s ""]` header bytes.

### Property (four-lens assessment per CLAUDE.md)

- **Lens 1 (round-trip)** — extended: `subsectionName()` in `test/unit/application/primitives/arbitraries.ts` already includes `''` and the 24.9g properties prove `parse(render(s)) ≡ s`. New round-trip over the **name grammar**: for arbitrary `(section, subsection?)` drawn from the header domain (section generator extended to include `''` when a subsection is present), `rawSectionName(parseSectionHeader(renderSectionHeader(section, subsection))) ≡` the dotted name — and addressing a two-block file by that name touches exactly that block. numRuns 200 (cheap).
- **Lens 2 (compositional matcher)** — fits: for an arbitrary identity pair drawn from `{undefined, '', <non-empty subsection>}` (now also with section `''` in the domain) with distinct values, `setConfigEntryInText` targeting identity A leaves every byte of the identity-B block unchanged (and modifies the A block). Existing config-file generators; numRuns 100. Invariant over the grammar, not a re-implementation — no tautology.
- **Lens 3 (totality)** — now fits: `parseNewSectionName` over ASCII no-NUL either returns a header-rendering-safe `{section, subsection?}` or throws exactly `INVALID_OPTION` — never anything else; partition property over the prefix-charset rule. numRuns 100. Same for the widened `parseConfigKey` domain (`''` section with subsection).
- **Lens 4 (idempotence/counting)** — n/a beyond existing writer properties.

### Mutation

The production diff *removes* the conflation arm and the family guard, so the prior surviving-mutant surface disappears. Remaining `===` comparisons are killed by the direction-isolated unit fixtures (each cross-pair has a test whose byte-exact expectation fails under `===`→`!==` or operand swaps). `parseNewSectionName`'s charset boundaries (alphanumeric ranges, `-`, first-dot index arithmetic) get per-boundary refusal/acceptance tests. No equivalent mutants anticipated beyond, possibly, search-offset mutants in homogeneous multi-block fixtures (documented inline if provably equivalent).

## Risks

- **Behaviour break by design (identity)**: files written by pre-fix tsgit that used `[s ""]` interchangeably with `[s]` (e.g. a `[core ""]` block edited in place) now read/write as distinct sections — exactly git's reading of those bytes, so the break converges with canonical git (ADR-226). The flipped unit test documents it.
- **Behaviour break by design (addressing)**: callers that today get `INVALID_OPTION` for plain-name or cross-family section ops will start mutating files; callers relying on case-insensitive section-op matching (`Remote.origin`) will start getting `CONFIG_SECTION_NOT_FOUND`. Both converge with pinned git behaviour.
- **Ambiguity rows are faithful but surprising**: `'a.b'` removes/renames both `[a.b]` and `[a "b"]`. Pinned, interop-twinned, and documented on the primitives.
- **Exported primitive signature break**: `removeConfigSectionInText`/`renameConfigSectionInText` change shape (decision N3); `reports/api.json` regenerates and the pre-push doc gate flags it.
- **Latent-arm exposure**: direct primitive callers passing `undefined` subsections — none in-tree beyond tests; covered by the unit matrix.
- **Order sensitivity**: `insertionLine`'s last-matching-block rule now sees fewer matching blocks; the both-order fixtures pin that no placement regression hides in block iteration.
- **Empty-name family flows through scoped reads/caches**: readiness inventory says zero changes needed; the interop matrix and lens-1/-3 properties guard it.

## Scope boundaries (out — pinned here, decided elsewhere)

- **`--unset` exit-code surface (5 vs 1)** — rendering of absence is the caller's concern (ADR-249); tsgit's no-op unset stays.
- **Exit-code split 255 vs 128 vs 1/2 on refusals** — same: refusal *conditions* and message *data* are bound, process exit codes are caller rendering.
- **Empty-value axis (24.9l) and refusal-shape sweep (24.9m)** — separate backlog items; this fold stops at addressing/identity (ADR-323, Neutral).
- *(Absorbed into scope by ADR-323 — no longer boundaries:* plain-name + cross-family section ops (backlog 24.9n) and the empty-section-name axis.*)*

## Open decisions

### Resolved (ADR phase complete for the original scope)

1. **Section-op addressing of the empty form** — **resolved by ADR-322** (accepted): the trailing-dot name `'s.'` addresses `[s ""]`; `'s.""'` keeps its natural no-match. Under the raw-matching design (N1) the substance is unchanged — `'s.'` is simply the raw name of `[s ""]` — and the trailing-dot grammar lives in the new-name parser; if N1 resolves to a parsed model instead, ADR-322's literal `parseSectionName` extension applies as written.
2. **Follow-up packaging** — **resolved by ADR-323** (accepted): both adjacent gaps are folded into this change; backlog 24.9n is absorbed and closed by the same PR (the backlog edit is owned by the session, not this doc).

### New (surfaced by the folded pinning — for the ADR phase)

- **N1 — old-name matching model.** The pinning shows git's section-op old side is a raw, byte-exact, case-sensitive name lookup (never parsed), producing the case rows and ambiguity rows above. Alternatives: **(a) raw byte-exact matching** via `rawSectionName` — fully faithful, one rule subsumes every pinned row, deletes `parseSectionName`; **(b)** parsed `{section, subsection}` matching made case-sensitive — misses the ambiguity and deprecated-header rows, needs a divergence ADR; **(c)** status quo parsed + case-insensitive — diverges on five pinned rows. Recommended: **(a)**.
- **N2 — newline/NUL bytes in the NEW subsection.** git writes a raw newline into the rewritten header, corrupting its own file (pinned). Alternatives: **(a)** replicate byte-for-byte (faithful, self-corrupting); **(b)** keep `rejectSubsection`'s `\n`/`\0` refusal — a deliberate, ADR-documented divergence on a git foot-gun (NUL cannot reach git via argv anyway, so the divergence is effectively LF-only); **(c)** refuse LF, allow NUL. Recommended: **(b)** with the divergence ADR.
- **N3 — exported `InText` primitive surface.** Cross-family renames don't fit `renameConfigSectionInText(text, section, fromSub, toSub)`. Alternatives: **(a)** re-shape both exported primitives to `(text, oldName, …)` — breaking, pre-1.0, no dead surface, api.json regenerates; **(b)** add new raw-name primitives and keep the old ones — additive but leaves a conflating-era surface alive; **(c)** keep old signatures as thin wrappers over the new core — dead weight with no in-tree callers. Recommended: **(a)**.
