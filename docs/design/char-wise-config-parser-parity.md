# Design — Char-wise config parser parity

> Brief: replace the line-wise INI classifier with char-wise entry-content parsing after a header token, unify the `=`/no-`=` key grammar, so same-line `[a] key = v` / `[a] key`, orphan (sectionless) keys, and the `=`-path key grammar all match git 2.54.x (backlog 24.9m).
> Status: draft → self-reviewed ×3 → accepted

## Context

The shared git-config tokenizer lives in `src/application/primitives/config-read.ts`. It is **line-anchored**: `tokenizeConfigLines` walks physical lines and classifies each as exactly one `ConfigToken` (`header` / `entry` / `comment` / `blank`). git's config parser (`config.c`, `get_value` / `get_base_var` / `parse_value`) is **char-wise**: a single physical line can carry a `[section]` header *and* an entry, and the key scanner is one grammar shared by the `=` and no-`=` paths.

Three prior items already migrated most of the surrounding grammar to char-wise faithfulness and built the machinery this item completes:

- **24.9c** (`config-quoted-values.md`, ADR-308) — `parseConfigValue` is already a faithful char-wise `parse_value` mirror (quotes, escapes, comments, backslash-newline continuations). The same-line entry-content after a header is exactly the value grammar that already exists.
- **24.9g** (`config-subsection-escaping.md`, ADR-312/313) — `parseSectionHeader` is char-wise three-state (`header`/`malformed`/`not-header`); the per-operation write-refusal map (set/unset translate to `CONFIG_INVALID_FILE`; rename/remove stay line-lenient) is established.
- **24.9h** (`config-valueless-keys.md`, ADR-314/315) — the **no-`=` half** of the key grammar (`VALUELESS_KEY_RE`, `value: string | null`, `CONFIG_PARSE_ERROR { line, source }`). Its decision **D2** and "Scope boundaries (out)" explicitly defer the same-line constructs and the `=`-path key grammar **to this item**.
- **24.9i** (`config-multiline-line-surgery.md`) — the writer was rebuilt on the **token stream**: `tokenizeConfigLines` → `findEntry` / `insertionLine` / `removeConfigEntry` operate on `ConfigToken` spans, not re-classified lines. This is load-bearing for the crux below: the writer already consumes tokens, so if the tokenizer learns to split a line into a `header` + an `entry`, the entry-write surgery inherits it. **24.9i kept rename/remove-section line-based** (`update-config-sections.ts`, `isSectionHeader = startsWith('[') && endsWith(']')`).
- **24.9k** (`config-empty-subsection-matching.md`, ADR-322/324/326) — section identity (`[s ""]` ≠ `[s]`), raw-name section-op matching (`rawSectionName`), and the empty-section-name family. Its `matchesTarget` strict-identity rule and `rawSectionName` reduction are the matchers this item reuses.

Constraints binding this design: the **prime directive** (ADR-226) — byte-for-byte faithfulness of data, on-disk state, and refusal conditions; **ADR-249** — the library emits structured fields, the *caller* reconstructs git's rendered stdout, so faithfulness is pinned by reconstructing `--list`/`--get` inside interop tests, not by emitting display strings.

## Requirements

When this ships:

1. `parseIniSections('[a] key = v\n')` records one entry `a.key = v`; `parseIniSections('[a] key\n')` records `a.key` valueless (`value: null`) — both keyed under the `[a]` section, not mis-keyed as `[a] key`.
2. The same-line entry content after a header obeys git's full value grammar (continuations, quotes, comments, CRLF) and the same key grammar as in-section entries.
3. Orphan (sectionless) keys before any header — `orphan = v`, `orphan` — are recorded under an empty section name and surface on the **token stream + porcelain `--list` / `--get-regexp`** (rendered as the bare key `orphan`, no dot), and on no typed `ParsedConfig` field. They are **not** addressable by `--get` / `set` (git refuses `key does not contain a section`).
4. The `=`-path key grammar refuses exactly what git refuses: `bad!key = v`, `9key = v`, `under_score = v`, `-key = v`, `key.dot = v`, `key@at = v`, `foo bar = v` all throw `CONFIG_PARSE_ERROR { line, source }` with git's 1-based line number; everything git accepts (`k = v`, `k  =  v`, `k\t= v`, `[a]key=v`) stays accepted.
5. The writer's full surgery (set / unset / unset-all / rename-section / remove-section) on hand-authored same-line and orphan files produces **git-byte-identical** output for every pinned row.
6. Every pinned behaviour has a cross-tool interop test in `test/integration/config-interop.test.ts`.
7. `npm run validate` green; 100% coverage on touched files; mutation budget met.

## Design

### git's exact behaviour (pinned against git 2.54.0)

Pinned empirically via `git config --file <tmpfile>` in a `mktemp -d` throwaway: isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, never in the worktree. Notation: `⏎`=LF, `⇥`=TAB, `␣`=significant space, `\`=one literal backslash. Display reconstructed from `--list -z` (`<key>\n<value>\0`, no `\n` before an absent value) per ADR-249.

#### Bucket 1 — header + entry on the same physical line

The char-wise parser, after `get_base_var` consumes `[section]`, continues on the same line: skips GIT_SPACE, then runs `get_value` (key scan + value scan) on the remainder.

| # | input bytes | recorded | exit |
| --- | --- | --- | --- |
| B1a | `[a] key = v⏎` | `a.key = v` | 0 |
| B1b | `[a] key⏎` | `a.key` valueless (`--list`→`a.key`, `--get`→empty, `--type=bool`→`true`) | 0 |
| B1c | `[a]key=v⏎` | `a.key = v` (no space needed after `]`) | 0 |
| B1f | `[a]⇥key = v⏎` | `a.key = v` (any GIT_SPACE between `]` and key) | 0 |
| B1g | `[a "s"] key = v⏎` | `a.s.key = v` (subsectioned header + same-line entry) | 0 |
| B1k | `[a]key⏎` | `a.key` valueless | 0 |
| B1l | `[a] key=⏎` | `a.key = ''` (empty string — distinct from valueless) | 0 |
| B1m | `[a] key = v⏎⇥k2 = v2⏎` | `a.key = v`, `a.k2 = v2` (same-line entry + following normal entry) | 0 |
| B1n | `[a] key = a=b⏎` | `a.key = a=b` (first `=` splits key/value; rest is value) | 0 |
| B1o | `[a]  key  =  v⏎` | `a.key = v` (surrounding spaces trimmed) | 0 |
| B1p | `[a] key = one\⏎␣␣two⏎` | `a.key = one␣␣two` (continuation works on same-line entry) | 0 |
| B1q | `[a] key = v\r⏎` | `a.key = v` (CRLF) | 0 |
| B1e | `[a] # c⏎` | header only, no entry (same-line `#`/`;` starts a comment) | 0 |
| B1h | `[a] bad!key = v⏎` | **fatal: bad config line 1 in file F** (exit 128) | 128 |
| B1r | `[a] foo bar = v⏎` | **fatal line 1** (space inside key before `=`) | 128 |
| B1s | `[a] foo.dot = v⏎` | **fatal line 1** (`.` not a key char) | 128 |

The same-line key obeys the **identical** key grammar as Bucket 3 (B1h/B1r/B1s are the same refusals as B3a/B3j/B3f). The same-line value obeys the identical value grammar as 24.9c (B1n/B1p/B1q).

#### Bucket 2 — orphan / sectionless keys (before any header)

git's `get_value` builds the variable name with `baselen = 0` (no section, no dot) when no section has opened, and the **iterate/dump path does not re-run** the section-requiring key validator. So orphan keys are recorded and dumped, but the **lookup/write API** (`git_config_parse_key`) refuses a key with no section.

| # | input | `--list` | `--get-regexp '.*'` | `--get <key>` | `set <key> x` | exit (get/set) |
| --- | --- | --- | --- | --- | --- | --- |
| B2a | `orphan = v⏎` | `orphan=v` | `orphan v` | **`error: key does not contain a section: orphan`** | **`error: key does not contain a section`** | 1 / 2 |
| B2b | `orphan⏎` | `orphan` (valueless) | `orphan` | same refusal | same | 1 / 2 |
| B2c | `orphan = v⏎[a]⏎⇥k = w⏎` | `orphan=v` + `a.k=w` | both | a.k→`w` (0); orphan→refusal (1) | — | — |
| B2d | `bad!orphan = v⏎` | **fatal line 1** (exit 128) | — | — | — | 128 |
| B2e | `9orphan = v⏎` | **fatal line 1** (exit 128) | — | — | — | 128 |

Key facts: an orphan key **dumps** with no section prefix (just `orphan`), is **never addressable** by `--get`/`set` (exit 1/2, `key does not contain a section`), and the key **grammar still applies** to it (B2d/B2e refuse). A *valid* orphan key is recorded; a *malformed* one refuses the whole file.

#### Bucket 3 — the `=`-path key grammar (`get_value` key scan)

git's key scanner: first char must be alpha (caller guarantees via `iskeychar`/`isalpha`), then `[a-zA-Z0-9-]*`, then skips **space/TAB only**, then requires `=` or EOL. The same grammar already pinned for the no-`=` path in 24.9h; this closes the `=` half.

| # | input (in `[a]`, line 2) | result | exit |
| --- | --- | --- | --- |
| B3-ok1 | `⇥k = v` | `a.k = v` | 0 |
| B3-ok2 | `⇥k   = v` | `a.k = v` (spaces before `=` skipped) | 0 |
| B3-ok3 | `⇥k⇥= v` | `a.k = v` (TAB before `=` skipped) | 0 |
| B3a | `⇥bad!key = v` | **fatal: bad config line 2 in file F** | 128 |
| B3c | `⇥under_score = v` | **fatal line 2** (`_` not a key char) | 128 |
| B3d | `⇥9key = v` | **fatal line 2** (digit-first) | 128 |
| B3e | `⇥-key = v` | **fatal line 2** (dash-first) | 128 |
| B3f | `⇥key.dot = v` | **fatal line 2** (`.`) | 128 |
| B3g | `⇥key@at = v` | **fatal line 2** (`@`) | 128 |
| B3j | `⇥key x = v` | **fatal line 2** (space inside key, then non-`=`) | 128 |

Today tsgit's `=`-path takes `line.slice(0, eqAt).trim()` as the key with **no validation** — so `bad!key`, `9key`, `under_score`, `-key`, `key.dot`, `key@at`, `key x` are all silently **accepted** (probed: each yields an entry with the garbage key). These are the genuine new refusals. (Exception: `ab#cd = x` already refuses today — the `#` cuts via `effectiveEqualsIndex` and the raw line fails `VALUELESS_KEY_RE` — so it is a *preservation* case, not a new refusal; see D3.) All `=`-path bad keys must refuse.

#### Bucket 4 — writer surgery (the crux: same-line + orphan files)

git's `set`/`unset` use the **event-driven** `git_config_set_multivar_in_file` (byte offsets from the char-wise parser); `rename`/`remove-section` use `git_config_copy_section_in_file`, which is **also event-driven** (it relies on the char-wise parser's section/value events to find byte offsets — it is not line-based). Pinned bytes:

| # | input | command | output bytes | rule |
| --- | --- | --- | --- | --- |
| W1 | `[a] key = v⏎` | `a.key x2` | `[a]⏎⇥key = x2⏎` | **set splits the header**: the matched same-line entry is rewritten as a canonical `⇥key = value` line, and `[a]` lands on its own line |
| W3 | `[a] key⏎` (valueless) | `a.key x2` | `[a]⏎⇥key = x2⏎` | same split for a valueless same-line entry |
| W5 | `[a] key = v⏎` | `a.other y` (NEW key) | `[a] key = v⏎⇥other = y⏎` | **new key does NOT split** — `[a] key = v` stays verbatim, the new entry appends at section end |
| W6 | `[a] key = v⏎⇥k2 = w⏎` | `a.key x2` | `[a]⏎⇥key = x2⏎⇥k2 = w⏎` | replace splits the head, body verbatim |
| W7 | `[a] key = v⏎⇥k2 = w⏎` | `--unset a.k2` | `[a] key = v⏎` | unsetting the *other* key leaves the same-line head verbatim; the emptied-body rule then keeps `[a] key = v` (it is still an entry) |
| W2 | `[a] key = v⏎` | `--unset a.key` | *(empty file)* | removing the only entry removes the header too (empty-block prune) |
| W4 | `[a] key⏎` | `--unset a.key` | *(empty)* | same for valueless |
| R6 | `[a] key = 1⏎[a] key = 2⏎` | `--unset-all a.key` | *(empty)* | every same-line occurrence + its block removed |
| W8 | `[a] key = v⏎` | `--rename-section a b` | `[b]⏎⇥key = v⏎` | **rename splits the header too** — event-driven, re-emits `[b]` then the entry on its own line |
| R1 | `[a] key = v⏎⇥k2 = w⏎` | `--rename-section a b` | `[b]⏎⇥key = v⏎⇥k2 = w⏎` | header split, rest verbatim |
| N3 | `[a] key⏎` | `--rename-section a b` | `[b]⏎⇥key⏎` | valueless same-line entry preserved verbatim after the split |
| N4 | `[a]  ⏎⇥k = v⏎` | `--rename-section a b` | `[b]⏎⇥k = v⏎` | trailing spaces after `]` dropped (re-emit from the section-name event end) |
| C1 | `[a]   key=v⏎` | `--rename-section a b` | `[b]⏎⇥key=v⏎` | the entry tail is copied **raw** (`key=v`, NOT re-rendered to `key = v`); only the `]`→key gap normalises to `⏎⇥` |
| C2 | `[a] key = v ; cmt⏎` | `--rename-section a b` | `[b]⏎⇥key = v ; cmt⏎` | trailing comment copied raw in the tail |
| C7 | `[a] key = one\⏎␣␣two⏎` | `--rename-section a b` | `[b]⏎⇥key = one\⏎␣␣two⏎` | continuation tail survives the split |
| W9 | `[a] key = v⏎` | `--remove-section a` | *(empty)* | whole same-line block removed |
| C3 | `[a] key = v⏎⇥k2=w⏎[c]⏎⇥k3=x⏎` | `--remove-section a` | `[c]⏎⇥k3 = x⏎` *(see note)* | same-line block + body removed; `[c]` block untouched |
| C5 | `[a] k1 = v1⏎[b] k2 = v2⏎` | `--remove-section a` | `[b] k2 = v2⏎` | only `[a]`'s same-line block removed; `[b]`'s same-line form kept verbatim (not rewritten) |
| W11 | `o = 1⏎[a]⏎⇥k = v⏎` | `a.k x2` | `o = 1⏎[a]⏎⇥k = x2⏎` | an orphan line above a section does not break entry surgery; the orphan line is preserved verbatim |
| N7 | `o = 1⏎[a]⏎⇥k = v⏎` | `--remove-section a` | `o = 1⏎` | orphan line preserved; `[a]` block removed |
| W7c | `[a] key = v⏎⇥# keep⏎` | `--unset a.key` | `[a]⏎⇥# keep⏎` | removing a **same-line** entry while a comment survives the block **splits** the header onto its own line (re-emit `[a]`, keep the comment) |
| W7d | `[a] key = v⏎⇥k2 = w⏎` | `--unset a.key` | `[a]⏎⇥k2 = w⏎` | same-line entry removed, surviving normal entry preserved, header split |

#### Bucket 5 — section ops (rename/remove) do NOT validate keys (D2 pin)

git's `git_config_copy_section_in_file` is event-driven (it needs section/value *events* to find byte offsets) but **does not run the key validator** — so it is lenient on files containing keys the read path refuses:

| # | input | command | output | exit |
| --- | --- | --- | --- | --- |
| D2a | `[a]⏎⇥bad!key = v⏎[b]⏎⇥k = w⏎` | `--rename-section b c` | `[a]⏎⇥bad!key = v⏎[c]⏎⇥k = w⏎` (bad-key block verbatim) | 0 |
| D2b | same | `--remove-section b` | `[a]⏎⇥bad!key = v⏎` | 0 |
| D2c | same | `--rename-section a c` (rename the bad-key block itself) | `[c]⏎⇥bad!key = v⏎[b]⏎⇥k = w⏎` | 0 |
| D2d | `[a]⏎⇥k = "unclosed⏎[b]⏎⇥k = w⏎` (malformed value) | `--remove-section b` | `[a]⏎⇥k = "unclosed⏎` (verbatim) | 0 |

So a token-stream rename/remove (D2) must locate headers + entry spans **without** running `scanKey`'s key validation — header recognition and value-span events only, matching 24.9g/ADR-313's established read-shape-vs-line-surgical split.

*Note on C3:* in the pinned run the surviving block printed as `[c]⏎⇥k3 = x⏎` because the original `[c]⏎⇥k3=x` is preserved verbatim — git copies non-matching blocks byte-for-byte, so the real output is `[c]⏎⇥k3=x⏎` (whatever the original bytes were). The interop test compares against git's actual output, not a re-rendered form.

**The crux resolved:** git's `set`/`unset`/`rename`/`remove` are **all event-driven**, so they uniformly *split a same-line header from the entry being rewritten* (W1/W8) while *leaving a same-line header verbatim when only a non-matching key or the section as a whole is touched* (W5/C5/W7). tsgit's writer is already token-driven for entry surgery (24.9i) — it inherits the split for free once the tokenizer emits separate `header` + `entry` tokens. **But rename/remove-section are still line-based** (`update-config-sections.ts`) and today no-op on `[a] key = v` (probed). They must move to the token stream too.

#### Current tsgit divergences (probed at branch tip)

| input / op | tsgit today | git | class |
| --- | --- | --- | --- |
| `parseIniSections('[a] key = v⏎')` | `[]` — tokenized as one entry keyed `[a] key`, dropped (no section open) | `a.key = v` | read bug |
| `parseIniSections('[a] key⏎')` | `[]` — valueless line `startsWith('[')` lenient-skip (24.9h) | `a.key` valueless | read bug |
| `parseIniSections('orphan = v⏎')` | `[]` — dropped (no section) | recorded `orphan` | read bug |
| `parseIniSections('[a]⏎⇥bad!key = v⏎')` | accepts `bad!key` | **fatal line 2** | refusal gap |
| `setConfigEntryInText('[a] key = v⏎','a',_,'key','x2')` | `[a] key = v⏎[a]⏎⇥key = x2⏎` (appends a NEW `[a]`) | `[a]⏎⇥key = x2⏎` | write bug |
| `removeConfigSectionInText('[a] key = v⏎','a')` | `[a] key = v⏎` (no-op — line doesn't `endsWith(']')`) | *(empty)* | write bug |
| `renameConfigSectionInText('[a] key = v⏎','a',{section:'b'})` | `[a] key = v⏎` (no-op) | `[b]⏎⇥key = v⏎` | write bug |

### The fix — char-wise tokenization after a header, one key scanner

#### 1. Tokenizer: split a physical line into a header token + a continuation entry/comment

`tokenizeConfigLines` changes from "classify each line as one token" to "scan a line char-wise; a header may be **followed on the same line** by entry content." The minimal change that produces git's tokens:

When `parseSectionHeader` (on the bracket-delimited prefix) returns `header`, the tokenizer must:
- determine the **byte offset where the header ends** (the position just past the closing `]` of the bracket span), then
- skip GIT_SPACE, and if any non-comment content remains on the line, run the **shared key scanner + `parseConfigValue`** on the remainder — emitting a *second* `entry` (or valueless `entry`) token with `startLine === header.line`. A same-line `#`/`;` after the header emits nothing (header carries `hasComment: true`).

This requires `parseSectionHeader` (or a sibling) to report **where the header ended** in the line, not just the parsed identity — today it consumes a *trimmed* line and returns identity only. The design adds a header-scan that returns `{ section, subsection, endOffset }` over the *raw* line (the bracket span ends at the `]` that closes it; for a quoted subsection that is the `]` immediately after the closing quote — 24.9g's `scanQuotedSpan` already finds it, it just discards the offset). Trailing content after the bracket span is fed to the shared entry scanner.

The header three-state contract (`header`/`malformed`/`not-header`) is preserved: only a successful bracket parse triggers same-line entry scanning. `not-header` lines (no `[`, or unquoted non-`]`-terminated) keep today's key/value or valueless path — **including** orphan key lines (next section).

Span/offset bookkeeping: the same-line entry's `startLine` is the header's line; its `endLine` follows `parseConfigValue`'s `nextLineIdx` (a same-line entry value may itself continue onto following physical lines — B1p). The header token keeps `line` and gains nothing; the writer reads the header line and the entry span separately.

#### 2. Orphan (sectionless) keys recorded under an empty section

Today `parseIniSections` drops entries when `current === undefined`. Change: maintain an implicit **orphan section** open from the file start — a `SectionBuilder` with `section: ''` (empty name) and `subsection: undefined` — into which key lines before the first header accumulate. This reuses 24.9k's empty-section-name representation (`section: ''` is already a first-class identity there; `dispatchSection` ignores it, so it flows only into the raw entry list — exactly git's "recorded but not typed").

But git's orphan keys are **not the same** as `[ ""]` (empty section *with* an empty subsection): an orphan is `('', undefined)`, `[ ""]` is `('', '')`. `qualifyKey` must render an orphan (`section: '', subsection: undefined`) as the **bare key with no leading dot** (`orphan`), whereas `[ ""]` renders as `.key` and `[ "x"]` as `.x.key` (24.9k, pinned). Today `qualifyKey('', name)` would produce `.name` — wrong for orphans. The fix: `qualifyKey` special-cases the orphan identity (`section === '' && subsection === undefined`) to emit just `name`.

Orphan keys therefore surface on `configList` / `configGetRegexp` (which iterate `IniSection.entries` via `qualifyKey`) and on the token stream, and on **no** typed `ParsedConfig` field (`dispatchSection`'s literal section names never match `''`). They are **not** addressable by `configGet` / `setConfigEntry`: `parseConfigKey('orphan')` already throws `CONFIG_KEY_INVALID 'missing-name'` (no dot) — which is git's `key does not contain a section` refusal (the structured twin). So the read/write asymmetry falls out of the existing key parser with no change. The grammar still applies (a malformed orphan line refuses the whole file via the unified scanner).

#### 3. Unified char-wise key scanner shared by `=` and no-`=` paths

git uses one scanner for both. tsgit has two: `VALUELESS_KEY_RE` (no-`=`, 24.9h) and the unvalidated `line.slice(0, eqAt).trim()` (=-path). Replace both with **one** scanner over the raw remainder of a line (after leading whitespace / after a same-line header gap):

```
scanKey(s, start) →
  if s[start] is not [a-zA-Z]            → parse error
  consume [a-zA-Z0-9-]* into key
  skip space/TAB only
  then:
    EOL (or \r at EOL)  → valueless entry  (value: null)
    '='                 → value = parseConfigValue(after '=')
    anything else        → parse error      (incl. a mid-key # / ; — pinned fatal)
```

Note: a `#`/`;` after a key prefix is **not** a comment — it is "anything else" → parse error. The leading-`#` whole-line comment (`#whole = line`) never reaches `scanKey` because `stripInlineComment` removes it before the key path (it has no key prefix); a `#` in the *value* is handled by `parseConfigValue` after the `=`.

This subsumes `VALUELESS_KEY_RE` (the no-`=` arm) and replaces `effectiveEqualsIndex` + `line.slice(0,eqAt).trim()` (the `=` arm). **The genuine new refusals** are the `=`-path bad keys: probed at branch tip, today's `=`-path **accepts** `bad!key`, `9key`, `under_score`, `-key`, `key.dot`, `key@at`, `key x` (no validation — `line.slice(0,eqAt).trim()`); git refuses all of them (Bucket 3). `ab#cd = x` is **not** a new refusal — today's tsgit *already* refuses it (probed: `CONFIG_PARSE_ERROR line 2`, because `effectiveEqualsIndex` sees the `#` before `=`, routes to the valueless path, and `VALUELESS_KEY_RE` on the raw line fails the `#`), and git refuses it too. So `ab#cd` is a **preservation** case (D3): the unified scanner must keep refusing the mid-key `#`/`;`, not regress to lenient. The scanner's acceptance set equals git's for both the new-refusal forms and the preservation forms.

Everything the old paths accepted stays accepted: `k = v`, `k  =  v`, `k\t= v`, `[a]key=v`, valueless `key`, trailing-space `key   `, CRLF `key\r`. Everything git refuses now refuses with `CONFIG_PARSE_ERROR { line, source }`. The scanner is the single source of the key grammar; `parseConfigValue` (already char-wise) handles everything past the `=`.

#### 4. Writer: entry surgery inherits the split; section ops move to the token stream

- **Entry surgery** (`setConfigEntryInText`, `removeConfigEntry`, `appendConfigEntry`) is already token-driven (24.9i). Once the tokenizer emits a `header` token (line N) + an `entry` token (also startLine N) for `[a] key = v`:
  - **Replace** (`findEntry` matches the same-line entry) splices `[startLine, endLine)` — which is `[N, N+1)`, the header's own line — with `renderEntry(key, value)`. But that would delete the header. The fix: a same-line entry's span must **not** include the header line. The entry token's `startLine` for a same-line entry is the header line, yet the *header occupies bytes [0, endOffset)* of that line. So the writer needs the **column** where the same-line entry begins, or the tokenizer must model a same-line entry as a sub-line span. **This is the load-bearing modelling choice — Decision D1.** The recommended model: a same-line entry token carries `startLine === header.line` plus a flag/offset marking it as *sharing* the header line; the replace operation, seeing a shared line, rewrites that physical line to `renderSectionHeader(...)` (the header, re-rendered) followed by `⏎` + `renderEntry(...)` — producing W1's `[a]⏎⇥key = x2`. When the entry continues onto further lines (B1p), `endLine > startLine + 1` and those tail lines are spliced out too.
  - **New key** (`insertionLine`): W5 shows the same-line header line stays verbatim and the new entry appends at section end. `insertionLine` already returns the last entry's `endLine` (or `headerLine + 1`); for a same-line-only block the last entry's `endLine` is `headerLine + 1`, so the new entry lands right after the header line — matching W5 (`[a] key = v⏎⇥other = y`). No change needed beyond the tokenizer emitting the same-line entry.
  - **Unset** (`removeConfigEntry`): three pinned shapes. (i) Block empties → prune header (W2/W4). (ii) An *unrelated* key is unset, same-line entry stays → header line verbatim (W7). (iii) The same-line entry IS removed but the block survives via a comment or another entry → git **splits** the header onto its own line and re-emits the surviving content (W7c `[a]⏎⇥# keep`, W7d `[a]⏎⇥k2 = w`). So a shared-line removal whose block survives must re-emit `renderSectionHeader(...)` alone on its line, then the surviving body verbatim. The empty-block rule (24.9i) decides prune-vs-keep; the shared-line case adds the re-emit-header-alone branch when keeping. All three shapes are empirically pinned.
- **Section ops** (`renameConfigSectionInText`, `removeConfigSectionInText`): today line-based, no-op on `[a] key = v`. They must move to the **token stream** to find header tokens (which now recognise same-line headers) and split on rewrite — but **without running `scanKey`'s key validation** (Bucket 5 / D2a–D2d: git's `copy_or_rename` is lenient on bad keys and bad values). `removeConfigSectionInText` drops the matching header + its full body span (whole block). `renameConfigSectionInText` rewrites a matching header: for a same-line header it emits `renderSectionHeader(to)` + `⏎⇥` + the **raw remaining bytes of the original line from the entry start** (C1: tail copied raw, not re-rendered — only the `]`→key gap normalises to `⏎⇥`) + the body verbatim. This needs the header's `endOffset` over the raw line (D5) so the writer slices the raw tail; matching still uses `rawSectionName` (24.9k) over the token's parsed identity. Non-matching same-line blocks (C5's `[b] k2 = v2`) are copied byte-for-byte.

This is the larger-than-24.9i rewrite: section ops gain same-line awareness git has and tsgit lacks. The 24.9i justification ("git is line-based here, keep tsgit line-based") is **superseded** — the pins above (W8/R1/N3/N4/C1/C2/C7/C3/C5) prove git's section ops are event-driven and split same-line headers. 24.9i pinned only inputs its line surgery could express (it explicitly noted top-level `[a] key = v` renames were "git-only pins" outside tsgit's reach); this item brings them into reach.

### Error semantics

All refusals reuse the existing `CONFIG_PARSE_ERROR { line, source }` (24.9h/ADR-308) — git's `bad config line N in file F`, 1-based physical line, reconstructed in interop. Same-line-header malformations: a malformed *quoted subsection* in the bracket span keeps 24.9g's `malformed`→`partialSectionName`→`CONFIG_INVALID_FILE` write path; a malformed *same-line key* (`[a] bad!key = v`) is a key-grammar refusal → plain `CONFIG_PARSE_ERROR` (B1h, exit 128, read-shape). No new error codes.

### Refusal blast radius (read-path inventory)

Newly refusing the `=`-path bad keys means any tokenizing read of such a file now throws where it previously limped (accepting a garbage key). Per-path faithfulness:

| read path | today | after | git |
| --- | --- | --- | --- |
| `readConfig` → `parseIniSections` | accepts garbage `=`-key | throws `CONFIG_PARSE_ERROR` | git refuses (lazy, but the file is unreadable) — faithful |
| scoped reads (`config-scoped-read`) | accepts | throws | faithful |
| `config` porcelain `--list`/`--get`/`--get-regexp` | accepts | throws | git refuses the file — faithful |
| `.gitmodules` (`parseGitmodules`) | accepts | throws | git's submodule config uses the same parser — faithful |
| sequencer `opts` (`readSequencerOpts`) | n/a (tsgit-written, never malformed) | n/a | n/a |
| writer `set`/`unset` (parse-first via `parseIniSectionsForWrite`) | accepts | throws (value-shape) | git's set/unset parse first and refuse — faithful (24.9g/ADR-313) |
| writer rename/remove-section | line-lenient (no parse) | **stays lenient** — token-stream header/offset finding without `scanKey` validation (D2a–D2d pinned: git's `copy_or_rename` does NOT validate keys/values) | git limps too — faithful |

The rename/remove leniency is now pinned (Bucket 5, D2a–D2d): git's `copy_or_rename` is event-driven for *offsets* but does **not** run the key validator, so it succeeds on files with bad `=`-keys and malformed values — consistent with 24.9g/ADR-313. The token-stream port therefore must find headers and entry spans **without** the `scanKey` refusal path; it gains same-line splitting (the byte-faithfulness fix) without gaining the read path's refusals.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | **Same-line entry token model** — how does a `ConfigToken` represent an entry that shares the header's physical line, so the writer can split on replace (W1) and prune correctly (W2/W7)? | (a) Add an optional `startCol`/`sharesHeaderLine` field to the `entry` token; a shared-line entry's `[startLine, endLine)` still names physical lines, and the writer rewrites a shared first line as `header⏎⇥entry`. (b) **Normalise on tokenize**: emit the header token at line N and a *synthetic* entry whose `startLine` is treated as a half-open sub-line; keep a parallel "header endOffset" map. (c) Pre-split the input text: when a header has same-line content, the tokenizer rewrites the in-memory `lines` array to put the entry on its own line *before* surgery, so every entry token owns a whole line again. | **(a)** | Smallest change to the established `ConfigToken`/span model (24.9i); the writer's existing span splice gains one branch ("if the entry shares its header's line, re-emit the header before the rendered entry"). (c) corrupts byte-offset fidelity for the verbatim-copy paths (C1's raw tail); (b) leaks offset state outside the token. This is the load-bearing choice the user must ratify — it defines the writer's surgery unit. |
| D2 | **Section ops (rename/remove): token-stream vs keep line-based** — the Bucket-4 pins prove git splits same-line headers on rename (W8/R1/N3/N4/C1/C2/C7) and removes same-line blocks (W9/C3/C5), and Bucket 5 (D2a–D2d) proves it stays lenient on bad keys/values. Do tsgit's `renameConfigSectionInText`/`removeConfigSectionInText` move to the token stream, or keep line surgery (no-op on `[a] key = v`)? | (a) Move both to the token stream: same-line headers recognised via the new tokenizer, rename splits + copies the raw tail (C1), remove drops the block; matching uses `rawSectionName`; **no** key/value validation (stays lenient, D2a–D2d). (b) Keep line-based; document the same-line no-op divergence as a backlog follow-up. (c) Hybrid: token-find for *matching* headers, raw line-copy for *non-matching* blocks (verbatim bytes). | **(a)** | Faithfulness (ADR-226) requires matching the pinned split bytes; (b) leaves a byte divergence the brief asks to close; the 24.9i "keep line-based" rationale is superseded by the pins (it pinned only inputs its line surgery could express). The leniency question is resolved (git limps too), so the blast radius does **not** grow on the write side. (a) subsumes (c)'s verbatim-copy concern because non-matching blocks are copied byte-for-byte already. |
| D3 | **Mid-key `#`/`;` under the unified scanner** — today's two paths *already* refuse `ab#cd = x` (probed: `CONFIG_PARSE_ERROR`, both tsgit and git refuse). The unified scanner must **preserve** that refusal, not regress to lenient, while keeping leading-`#` whole-line comments and value-side `#` working. This is a preservation constraint, not a behaviour change. | (a) Scanner refuses a mid-key `#`/`;` (after a key prefix, before `=`) — matches git and today's tsgit. (b) Scanner treats any pre-`=` `#`/`;` as a comment (would *regress* tsgit to lenient, diverging from git). | **(a)** — preserve the existing+git-faithful refusal | The risk is a *regression* during unification (collapsing `effectiveEqualsIndex` + `VALUELESS_KEY_RE` into one scanner could accidentally make `ab#cd = x` lenient). The decision is to keep the pinned refusal set: `ab#cd`/`ab;cd`/`ab # cd`/`key#=v` fatal; `#whole = line` whole-comment; `k = v # trailing` value-comment. Listed so the user ratifies that the unification does not silently widen acceptance. |
| D4 | **Orphan-key recording scope** — record orphan keys (read on `--list`/`--get-regexp`, token stream) per the pins, or keep dropping them and limit this item to same-line + `=`-grammar? | (a) Record them (this design): empty-section builder, `qualifyKey` orphan special-case; no typed-consumer impact. (b) Defer orphans to a separate backlog item; ship same-line + key-grammar only. | **(a)** | The root cause is shared (line-classification vs char-wise) and the brief groups all three buckets; recording is small (one builder + one `qualifyKey` branch) and changes nothing for typed `ParsedConfig` consumers (`dispatchSection` ignores `''`). Splitting would re-open the same parser twice. |
| D5 | **`parseSectionHeader` signature** — to scan same-line content the tokenizer needs the header's end-offset over the *raw* line. Extend `parseSectionHeader` to return an offset, or add a sibling raw-line header scanner? | (a) Add an offset to the `header` arm of `SectionHeaderParse` (`endOffset`), computed over the raw line; `parseIniSections`/writer ignore it. (b) New `scanHeaderPrefix(rawLine)` sibling that returns `{ parse, endOffset }`, leaving `parseSectionHeader` (trimmed-input) untouched. (c) Re-derive the offset in the tokenizer by re-finding the closing `]`/quote span. | **(b)** | `parseSectionHeader` today takes a *trimmed* line and is shared with the writer's matcher; threading a raw-line offset through it muddies both callers. A dedicated raw-line scanner localises the new concern and keeps the trimmed-input contract for matchers. (a) is acceptable if the offset is documented as raw-line-relative; (c) re-implements the quote-span scan (DRY violation vs 24.9g's `scanQuotedSpan`). |

## Ripple inventory

| Site | Change |
| --- | --- |
| `config-read.ts` `tokenizeConfigLines` | after a `header`, scan same-line GIT_SPACE + remainder via the unified key scanner + `parseConfigValue`; emit a second `entry`/valueless `entry` token (or none on same-line comment) |
| `config-read.ts` key scanning | replace `VALUELESS_KEY_RE` + `effectiveEqualsIndex` + `line.slice(0,eqAt).trim()` with one `scanKey` (D3); `classifyValuelessLine` folds into it |
| `config-read.ts` `parseSectionHeader` / new `scanHeaderPrefix` | expose header end-offset over the raw line (D5) |
| `config-read.ts` `parseIniSections` | open an implicit orphan `SectionBuilder` (`section: ''`, `subsection: undefined`) from file start (D4); keep the `token.key !== ''` guard |
| `config-read.ts` `ConfigToken` `entry` arm | same-line marker/offset per D1 |
| `internal/config-key.ts` `qualifyKey` | orphan special-case: `('', undefined)` → bare `name` (no dot), distinct from `[ ""]`→`.name` |
| `update-config.ts` `setConfigEntryInText` / `removeConfigEntry` | shared-line split on replace (W1); shared-line prune (W2/W7) per D1 |
| `update-config-sections.ts` `renameConfigSectionInText` / `removeConfigSectionInText` / `findSectionHeader` / `isSectionHeader` | move to token stream (D2): same-line header recognition, rename raw-tail copy (C1), parse-first refusal |
| `commands/config.ts` `configList` / `configGetRegexp` | inherit orphan keys via `qualifyKey` (no code change beyond `qualifyKey`) |
| `parse-gitmodules.ts` | inherits same-line + grammar via `parseIniSections` (no change; `.gitmodules` rarely has same-line forms but must parse them identically) |
| `commands/internal/sequencer-state.ts` | no change (tsgit-written, never same-line/orphan/malformed) |
| `test/unit/.../config-read.test.ts` + `.properties.test.ts` | same-line + orphan + key-grammar tokenizer cases |
| `test/unit/.../update-config.test.ts` + section-op tests | same-line writer surgery, split bytes |
| `test/integration/config-interop.test.ts` | every pinned Bucket-1/2/3/4 row as twin git/tsgit |
| `reports/api.json` | regenerate iff any exported signature changes (D1/D5 may touch `ConfigToken`/`SectionHeaderParse`, both exported) |

## Test strategy

### Unit (`config-read.test.ts`)
- **Tokenizer same-line**: B1a/B1c/B1f/B1g/B1k/B1l/B1m/B1n/B1o/B1p/B1q/B1e → token streams with a `header` token + same-line `entry`/valueless `entry`/none; span (`startLine`/`endLine`) for same-line + continuation (B1p) cases.
- **Key grammar (`=` and no-`=` unified)**: each refused form (B1h/B1r/B1s, B3a/B3c/B3d/B3e/B3f/B3g/B3j) asserts `CONFIG_PARSE_ERROR` `.data.line` + `.data.source` **individually** via try/catch (mutation-resistant, per CLAUDE.md); each accepted form (B3-ok1/2/3, `[a]key=v`, valueless) asserts the recorded key/value. Guard-isolation: first-char-alpha, key-char set, post-key space-skip, `=`-vs-EOL-vs-other each get a dedicated refusal test.
- **Orphan**: B2a/B2b recorded under `('', undefined)`; B2c orphan + section; `qualifyKey` orphan→bare-key vs `[ ""]`→`.key` vs `[ "x"]`→`.x.key` (24.9k regression guard); B2d/B2e malformed orphan refuses.
- **D3 forms** (each its own test, mutation-resistant): `ab#cd = x`, `ab;cd = x`, `ab # cd = x`, `key#=v` refuse; `#whole = line` is a comment token (no entry); `k = v # trailing` records `a.k = v`.

### Unit (`update-config.test.ts`, `update-config-sections` tests)
- Writer same-line set/unset: W1/W3/W5/W6/W7 + the split-on-removal W7c (comment survives) and W7d (entry survives); prune W2/W4/R6 — all byte-exact full-string `toBe`.
- Section ops: W8/R1/N3/N4/C1/C2/C7/W9/C3/C5 byte-exact; W11/N7 orphan-preservation; D2a–D2d leniency (bad-key/bad-value files rename/remove succeed unchanged).
- Error-shape via try/catch `.data`.

### Interop (`test/integration/config-interop.test.ts`)
- Twin git/tsgit (one shared `beforeAll` scrubbed-env repo, 60s timeout per the `interop load → validate flake` memory). Every pinned Bucket-1 through Bucket-5 row: read parity via `--list -z` reconstruction (ADR-249) for same-line/orphan; refusal parity (same 1-based line, both non-zero) for the key-grammar matrix (Bucket 3 + B1h/B1r/B1s + B2d/B2e); write parity (byte-identical files) for the full Bucket-4 surgery matrix incl. W7c/W7d split and the Bucket-5 leniency rows; orphan `--get`/`set` refusal (exit 1/2) ↔ tsgit `parseConfigKey` `CONFIG_KEY_INVALID`.

### Property (`config-read.properties.test.ts`, `update-config.properties.test.ts`)
The tokenizer is a parser → all four CLAUDE.md lenses apply:
- **Lens 1 (round-trip / grammar)** — for an arbitrary valid key under an arbitrary header, `parseIniSections('${header} ${key} = ${value}\n')` (same-line) records `header.key = value`; for the no-`=` form, `value: null`. Reuse `arbHeaderIdentity` / `arbConfigKey` from `arbitraries.ts`. numRuns 200.
- **Lens 2 (compositional matcher)** — surgery preservation: setting/unsetting a same-line key leaves every other entry's parsed value unchanged (oracle = `parseIniSections`, independently tested). Extend `configFileWithTarget` to emit same-line and orphan blocks. numRuns 100.
- **Lens 3 (totality)** — `scanKey` over ASCII-no-NUL either returns a `{key, value}`/valueless or throws exactly `CONFIG_PARSE_ERROR` — never anything else; partition over the key-char set boundary. numRuns 100.
- **Lens 4 (idempotence / counting)** — `parseIniSections(rerender(parseIniSections(x)))` stable across same-line/orphan inputs; `#`-line-count↔comment-token-count invariant unaffected.

New generators (`configFileWithSameLineBlock`, orphan-prefix option) join `arbitraries.ts` per ADR-134/136.

### Mutation
Standard target (0 killable survivors). The `scanKey` char-class boundaries (first-char-alpha vs alnum-dash, `=`-vs-EOL-vs-`#`/`;` branch), the same-line `endOffset` arithmetic, and the writer's shared-line split branch are the mutation hotspots — each gets a per-boundary kill test. Loop-bound and homogeneous-search equivalents documented inline per CLAUDE.md.

## Out of scope

- **`[section.subsection]` legacy dotted-header same-line content** — git lowercases the dotted subsection; tsgit parses the whole inner as section. Pre-existing (24.9g out-of-scope), unchanged.
- **Whole unquoted-header refusal parity** (`[foo`, `[]`, `[s ]`) — 24.9g out-of-scope; tsgit keeps lenient skip for unquoted-header malformations. Same-line scanning only triggers on a *successful* bracket parse.
- **Per-use-site lazy `missing value` refusal** for string-typed internal reads — 24.9h/ADR-315 divergence, unchanged; orphan/valueless string fields stay treated as absent.
- **Writing orphan or same-line entries** — git's CLI cannot write an orphan (`set orphan x` → exit 2) nor a same-line entry; the writer gains no such surface. The writer always emits canonical `[s]⏎⇥key = value`.
- **`[a]key=v` write-canonicalisation subtleties beyond the pinned rows** — git's set always emits canonical `⏎⇥key = value` at the split position; whether it preserves any subtler original-indentation detail elsewhere is untested and unchanged (same boundary 24.9i drew).
