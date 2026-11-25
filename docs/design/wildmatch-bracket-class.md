<!-- cspell:ignore dowild wildmatch casefold ignorecase alnum cntrl xdigit fspathncmp nowildcardlen nodir endswith mustbedir ctype isupper islower toupper strncasecmp patternlen pyc pyo pyd pyx abX bX pathspecs -->
# Design — wildmatch-bracket-class

> Brief: backlog 32.91. `compileGlob` reads `[…]` and `\` as literal text. git's `wildmatch`
> reads a bracket expression as a character class and `\` as an escape. All three consumers
> diverge: `.gitignore`, `.gitattributes` and non-cone sparse. The re-pin confirms the brief and
> widens the perimeter. The same seam has five more proven gaps, folded under D-2/D-5:
> - `.gitignore` and sparse unescape a pattern before the matcher sees it;
> - `IgnoreRule.pattern` drops the escapes `git check-ignore -v` keeps;
> - ignore and attributes never fold case under `core.ignorecase`;
> - `?` matches a UTF-16 unit where git matches a byte;
> - `.gitattributes` applies a `!`-led pattern that git skips.
>
> Status: draft → self-reviewed ×3 → decided (ADRs 1248–1258)

## Context

### The backlog statement, re-pinned

Re-pinned on main f77dbbaa (2026-11-23) against git 2.56.1: the local binary moved from 2.56.0
to 2.56.1 during the run, before any probe ran. `wildmatch.c`, `dir.c` and `attr.c` are
byte-identical in v2.56.0 and v2.56.1, so every rule below holds for both. Probes ran on macOS
with `GIT_*` scrubbed, an isolated `HOME` and `GIT_CONFIG_NOSYSTEM=1`. `core.ignorecase` was set
to `false` and to `true` explicitly in every probe repository (lesson 042). Verdicts come from
`git check-ignore -q --no-index`, `git check-attr` and `git sparse-checkout set --no-cone` (files
present afterwards). The tsgit verdicts come from `isIgnored`,
`buildAttributeProvider`+`resolveAttribute` and `sparseCheckoutSet` on main. Rows marked † are
the designer's supplementary probes, same binary and isolation.

- **Confirmed:** every row of the backlog entry (`*.py[cod]`, `br[a]/` sparse, `br[a]/*`
  attributes).
- **Widened:** escapes, case folding, byte semantics and attribute negation diverge in the same
  seam (G-a…G-e below).
- **Probe artefacts (not git behaviour):**
  1. `git check-ignore -- ':x'` parses a leading `:` as pathspec magic. On those rows only the
     `check-attr` bit is the matcher's verdict.
  2. `git check-ignore` reports a path under an ignored directory as ignored. tsgit's `isIgnored`
     does not walk ancestors. That gap is deferred and not designed here.
  3. The path `.` names the work-tree root, so the matrix row `[--0]` vs `.` = 0 is the root, not
     a file. Re-pinned with `x[--0]` vs `x.` = 1 †.
  Interop rows avoid all three shapes.

### git's rule (`wildmatch.c` `dowild`; `dir.c`; `attr.c` — identical in v2.56.0 and v2.56.1)

#### Around wildmatch (`dir.c`, `attr.c`)

- `parse_path_pattern`:
  - strips a leading `!` (`PATTERN_FLAG_NEGATIVE`) and a trailing `/` (`MUSTBEDIR`);
  - sets `NODIR` when no raw `/` remains;
  - takes `nowildcardlen = simple_length(p)`, the run before the first `* ? [ \`;
  - sets `ENDSWITH` when `p` is `*` followed by no special character.
- `match_basename` serves a `NODIR` pattern and runs on the basename:
  1. `prefix == patternlen` → `fspathncmp` equality.
  2. `ENDSWITH` → `fspathncmp` of the tail.
  3. Otherwise `wildmatch(pattern, basename, 0)`. Flags 0 means `*`/`?`/sets may match `/`, but
     a basename holds none. So the result equals tsgit's unanchored `(.*/)?` + WM_PATHNAME body
     (argued in §5).
- `match_pathname` serves every other pattern:
  1. It strips a leading `/` and compares the base directory with `fspathncmp`.
  2. It compares the literal prefix with `fspathncmp`.
  3. A pure literal returns at that point.
  4. Otherwise it keeps **one** prefix character and calls `wildmatch(…, WM_PATHNAME)`.
     Keeping that character lets a `**` right after the prefix (`ab**/c`) be judged
     not-whole-component, as the whole pattern would be. The probes `ab**/c`, `a/b**/c` and
     `d/ab**` confirm there is no prefix-strip quirk.
- `fnmatch_icase_mem` adds `WM_CASEFOLD` when `core.ignorecase`. `fspathncmp` is
  `strncasecmp` under `core.ignorecase`. All three fast paths are observably equal to wildmatch
  over the whole pattern.
- `attr.c` uses the same two matchers (`path_matches`). `parse_attr_line` unquotes a `"…"`
  pattern, then runs `parse_path_pattern`. A `NEGATIVE` pattern is skipped with a warning
  ("Negative patterns are ignored in git attributes / Use '\!' for literal leading
  exclamation.").
- The base directory of every ignore/attribute level is spelled from the queried path's own
  directories, so its `fspathncmp` never differs from tsgit's case-exact `startsWith` (§7.3).

#### `dowild` — the ordered list, top level

For each pattern byte `p_ch`, with `t_ch` the current text byte:

| # | Branch (source order) | Rule | Rows |
|---|---|---|---|
| T0 | text exhausted and `p_ch != '*'` | no match | base of the DP |
| T1 | `WM_CASEFOLD` | lower `t_ch` if ASCII upper, and lower `p_ch` if ASCII upper. This applies to the byte read at the loop top only: never to the byte after `\`, never to a set member | L1–L4, E12, E13 |
| T2 | `\` | the next byte is a literal, compared **without lowering**. A trailing lone `\` never matches (the pattern matches nothing) | E1–E11 (E6 trailing), E12/E13 (fold) |
| T3 | default | `t_ch == p_ch` | L1–L4 |
| T4 | `?` | one **byte**, not `/` under WM_PATHNAME | Q1–Q3 |
| T5a | `*` run ≥ 2, whole component, then `/` | zero directories, or a run crossing `/` (`**/`) | existing `glob-double-star` suite |
| T5b | `*` run ≥ 2, whole component, at end | any run | existing suite |
| T5c | `*` run ≥ 2, whole component, then `\/` | a run crossing `/`, **without** the zero-directory shortcut | S1, S2 |
| T5d | any other `*` run | a run of non-`/` bytes | existing suite; S3–S5 |
| T6 | `[` | a bracket expression (B-list). Under WM_PATHNAME it never matches `/` | C*, F*, Y* |
| T7 | pattern end | the text must be exhausted | all |

#### `dowild` — the ordered list, inside `[`

| # | Branch (source order) | Rule | Rows |
|---|---|---|---|
| B1 | first byte `!` or `^` | negate. Anywhere else, `!`/`^` are plain members | C1–C4 |
| B2 | do/while | the first member (after any negation) may be `]` | C5–C9 |
| B3 | end of pattern before the closing `]` | `WM_ABORT_ALL`: the **whole pattern** matches nothing, including the file named like the pattern | C24–C32 |
| B4 | `\x` | the literal `x`, never lowered. It seeds a following range (`prev_ch`). `\` at the end → B3 | C18–C24 |
| B5 | `-` with a previous member and a next byte that is not `]` | range `prev_ch..hi`. `hi` may be `\x`. Under fold it also tries `toupper(t_ch)` when `t_ch` is lower. Then `prev_ch` resets. The low bound was already tested as its own member (`[c-a]` = `c`) | C10–C17, C9, C15, F3–F5, F12 |
| B6a | `[:` with no `]` after it | B3 | C32 |
| B6b | `[:` whose first following `]` has no `:` right before it (or an empty span `[:]`) | `[` is a plain member, and scanning resumes right after that `[` | C51–C53 |
| B6c | `[:name:]` with one of the twelve names | git's `sane_ctype` test. `[:upper:]` also matches lower case under fold. `prev_ch` resets | C36–C50, F8, F9 |
| B6d | `[:name:]` with any other name (`foo`, empty, `DIGIT`) | B3 | C33–C35 |
| B7 | any other byte | plain member, compared with the (lowered) `t_ch`, never lowered itself | C56–C60, F1, F2, F10, F11 |
| B8 | `]` after the first member | closes the set | all |
| B9 | verdict | `matched XOR negated`. Under WM_PATHNAME a `/` never matches, even negated or named | C61–C63 |

The `[.a.]`/`[=a=]` forms are not special (C54, C55). Sets and `?` consume one byte, so a
2-byte `é` needs two of them (Y1–Y4, Q2, Q3). Class tables (git's `sane_ctype`, ASCII only):
`space` = SP HT LF CR (not VT/FF); `punct` holds `_` and `~`; `cntrl` = 0x00–0x1F and 0x7F.

### Pinned matrix (git 2.56.1, † = supplementary probe; tsgit main f77dbbaa)

`1` = the pattern matches the path. "main differs" lists the cells where tsgit main gives the
other verdict, for ignore (I) and attributes (A). Rows show `ic=false` unless marked. An `ic=true`
line appears only where it differs.

**Escapes (T2) and literal folding (T1/T3)**

| ID | Pattern | Paths → git | main differs |
|---|---|---|---|
| E1 | `\[a]` | `[a]`=1 `a`=0 | A `[a]` |
| E2 | `\*` | `*`=1 `x`=0 | A `*`; I `x` |
| E3 | `\?` | `?`=1 `x`=0 | A `?`; I `x` |
| E4 | `\\` | `\`=1 `\\`=0 | A both |
| E5 | `a\b` | `ab`=1 `a\b`=0 | A both |
| E6 | `a\` | `a`=0 `a\`=0 | I, A `a\` |
| E7 | `\!a` | `!a`=1 `a`=0 | A `!a` |
| E8 | `\#a` | `#a`=1 `a`=0 | A `#a` |
| E9 | `x\[a\]` | `x[a]`=1 `xa`=0 | A `x[a]` |
| E10 | `d/\*` | `d/*`=1 `d/x`=0 | A `d/*`; I `d/x` |
| E11 | `a\/b` | `a/b`=1 | A |
| E12 | `\a` | `a`=1 `A`=0; ic=true `a`=1 `A`=1 | A `a`; ic=true I, A `A` |
| E13 | `\A` | `a`=0 `A`=1; ic=true `a`=0 `A`=0 | A `A`; ic=true I `A` |
| L1 | `A` | ic=true `a`=1 `A`=1 | ic=true I, A `a` |
| L2 | `a*B` | ic=true `axb`=1 `AXB`=1 `axB`=1 | ic=true I, A `axb` `AXB` |
| L3 | `*.LOG` | ic=true `x.log`=1 `x.LOG`=1 | ic=true I, A `x.log` |
| L4 | `Dir/f` | ic=true `dir/f`=1 `Dir/f`=1 `DIR/F`=1 | ic=true I, A `dir/f` `DIR/F` |

**`?` and star runs (T4, T5)**

| ID | Pattern | Paths → git | main differs |
|---|---|---|---|
| Q1 | `x/?` | `x/b`=1 | — |
| Q2 | `?` | `é`=0 `e`=1 | I, A `é` |
| Q3 | `??` | `é`=1 `ee`=1 | I, A `é` |
| S1 | `**\/b` | `b`=0 `x/b`=1 `x/y/b`=1 | I `b`; A `x/b` `x/y/b` |
| S2 | `a/**\/b` | `a/b`=0 `a/x/b`=1 `a/x/y/b`=1 | I `a/b`; A `a/x/b` `a/x/y/b` |
| S3 | `ab**/c` | `abc`=0 `ab/x/c`=0 `abX/c`=1 `ab/c`=1 | — |
| S4 | `a/b**/c` | `a/bc`=0 `a/b/x/c`=0 `a/bX/c`=1 `a/b/c`=1 | — |
| S5 | `a/[b]**/c` | `a/bc`=0 `a/b/x/c`=0 `a/bX/c`=1 `a/b/c`=1 | I, A `a/bX/c` `a/b/c` |

**Bracket expressions (B1–B9).** On main every bracket row reads `[…]` literally. Every git `1`
below is a main `0`, and the path spelled like the pattern (`[ab]`, `[a`, …) is a main `1`
where git says `0`.

| ID | Pattern | Paths → git |
|---|---|---|
| C1 | `[!a]` | `a`=0 `b`=1 `!`=1 |
| C2 | `[^a]` | `a`=0 `b`=1 `^`=1 |
| C3 | `[a!]` | `a`=1 `!`=1 `b`=0 |
| C4 | `[a^]` | `a`=1 `^`=1 `b`=0 |
| C5 | `[]a]` | `]`=1 `a`=1 `b`=0 |
| C6 | `[!]a]` | `]`=0 `a`=0 `b`=1 |
| C7 | `[]]` | `]`=1 `a`=0 |
| C8 | `[!]]` | `]`=0 `a`=1 |
| C9 | `[]-a]` | `]`=1 `^`=1 `a`=1 `-`=0 `b`=0 |
| C10 | `[a-c]` | `a` `b` `c`=1 `d`=0 `-`=0 |
| C11 | `[c-a]` | `c`=1 `a`=0 `b`=0 |
| C12 | `[a-]` | `a`=1 `-`=1 `b`=0 |
| C13 | `[-a]` | `-`=1 `a`=1 `b`=0 |
| C14 | `[a-c-e]` | `b`=1 `-`=1 `e`=1 `d`=0 |
| C15 | `x[--0]` † | `x.`=1 `x-`=1 `x,`=0 `x1`=0 |
| C16 | `[a-a]` | `a`=1 `b`=0 |
| C17 | `[!a-c]` | `b`=0 `d`=1 |
| C18 | `[\]]` | `]`=1 `\`=0 `a`=0 |
| C19 | `[\\]` | `\`=1 `a`=0 |
| C20 | `[a\-c]` | `a` `-` `c`=1 `b`=0 |
| C21 | `[a-\c]` | `b` `c`=1 `\`=0 `d`=0 |
| C22 | `[\a-c]` | `a` `b` `c`=1 `\`=0 `d`=0 |
| C23 | `[\!a]` | `!`=1 `a`=1 `b`=0 |
| C24 | `[a\]` | `a` `\` `a]` `[a\]` all 0 |
| C25 | `[a` | `[a`=0 `a`=0 |
| C26 | `a[` | `a[`=0 `a`=0 |
| C27 | `[` | `[`=0 |
| C28 | `[!` | `[!`=0 `a`=0 |
| C29 | `[]` | `[]`=0 `]`=0 |
| C30 | `[!]` | `[!]`=0 `a`=0 |
| C31 | `*[` | `a[`=0 `[`=0 `x`=0 |
| C32 | `[[:digit:]` | `5`=0 `[[:digit:]`=0 |
| C33 | `[[:foo:]]` | `a` `f` `[[:foo:]]` all 0 |
| C34 | `[[::]]` | `:` `[` `[[::]]` all 0 |
| C35 | `[[:DIGIT:]]` | `5`=0 `D`=0 |
| C35b | `[[:constructor:]]`, `[[:toString:]]`, `[[:valueOf:]]`, `[[:hasOwnProperty:]]`, `[[:__proto__:]]` † | `a`=0 for each (attributes pin). On main's `ref-glob` the first three match every byte and `[[:__proto__:]]` throws `TypeError` (G-f) |
| C36 | `[[:digit:]]` | `5`=1 `a`=0 `[`=0 |
| C37 | `[[:alpha:]]` | `a`=1 `Z`=1 `5`=0 `_`=0 |
| C38 | `[[:alnum:]]` | `a`=1 `5`=1 `_`=0 |
| C39 | `[[:upper:]]` / `[[:lower:]]` | `A`=1 `a`=0 / `a`=1 `A`=0 (ic=true: F8, F9) |
| C40 | `[[:space:]]` | SP=1 HT=1 VT=0 FF=0 `a`=0 |
| C41 | `[[:blank:]]` | SP=1 HT=1 `a`=0 |
| C42 | `[[:punct:]]` | `!`=1 `_`=1 `~`=1 `a`=0 `5`=0 |
| C43 | `[[:xdigit:]]` | `f` `F` `9`=1 `g`=0 |
| C44 | `[[:graph:]]` | `a`=1 `!`=1 SP=0 |
| C45 | `[[:print:]]` | `a`=1 SP=1 0x01=0 |
| C46 | `[[:cntrl:]]` | 0x01=1 0x7F=1 `a`=0 |
| C47 | `[[:alpha:][:digit:]]` | `a`=1 `5`=1 `_`=0 |
| C48 | `[![:digit:]]` | `5`=0 `a`=1 |
| C49 | `[[:digit:]-z]` | `5`=1 `-`=1 `z`=1 `a`=0 |
| C50 | `[a-[:digit:]]` | `a]`=1 `d]`=1 `5`=0 `5]`=0 (attr: `:]`=1) |
| C51 | `[[:alpha]` | `[`=1 `a`=1 `p`=1 `x`=0 (attr: `:`=1) |
| C52 | `[[:]` | `[`=1 `x`=0 (attr: `:`=1) |
| C53 | `[[:]]` | `[]`=1 `[`=0 `]`=0 (attr: `:]`=1) |
| C54 | `[[.a.]]` | `a]`=1 `.]`=1 `a`=0 `[`=0 |
| C55 | `[[=a=]]` | `a]`=1 `=]`=1 `a`=0 |
| C56 | `*.py[cod]` | `m.pyc` `m.pyo` `m.pyd` `d/m.pyc`=1 `m.py` `m.pyx` `m.py[cod]`=0 |
| C57 | `br[a]/*` | `bra/i`=1 `br[a]/h`=0 |
| C58 | `[ab]` | `a` `b` `d/a`=1 `c` `[ab]`=0 |
| C59 | `x[ab]y` | `xay` `xby`=1 `xcy` `x[ab]y`=0 |
| C60 | `*[ab]`, `[ab]*`, `[ab]c`, `d/[ab]c`, `**/[ab]`, `[ab]/**` | `xa`=1 `xc`=0; `ax`=1 `cx`=0; `x/ac`=1 `cc`=0; `d/ac`=1 `x/d/ac`=0; `x/b`=1 `x/c`=0; `b/x/y`=1 `c/x`=0 |
| C61 | `a[/]b` | `a/b`=0 |
| C62 | `x/a[!b]c` | `x/a/c`=0 `x/adc`=1 `x/abc`=0 |
| C63 | `a[b/c]d` | `abd`=1 `acd`=1 `a/d`=0 |

**Case folding inside a set (`ic=true`; the `ic=false` verdict is in brackets where it differs)**

| ID | Pattern | Paths → git |
|---|---|---|
| F1 | `[A]` | `a`=0 `A`=0 [`A`=1] |
| F2 | `[a]` | `a`=1 `A`=1 [`A`=0] |
| F3 | `[A-Z]` | `a`=1 `A`=1 `5`=0 [`a`=0] |
| F4 | `[a-z]` | `a`=1 `A`=1 [`A`=0] |
| F5 | `[X-c]` | `a` `A` `Y` `y`=1 `d`=0 [`A`=0 `y`=0] |
| F6 | `[!A]` | `a` `A` `b`=1 [`A`=0] |
| F7 | `[!b]` | `B`=0 `b`=0 `c`=1 [`B`=1] |
| F8 | `[[:upper:]]` | `A`=1 `a`=1 `5`=0 |
| F9 | `[[:lower:]]` | `A`=1 `a`=1 `5`=0 |
| F10 | `x[A]` | `xa` `xA` `Xa` all 0 [`xA`=1] |
| F11 | `*.PY[CO]` | `m.pyc` `m.PYC` `m.pyC` all 0 [`m.PYC`=1] |
| F12 | `[A-A]` † | `a`=1 `A`=1 [`a`=0] |

**Bytes (T4/B-list over UTF-8)**

| ID | Pattern | Paths → git | main differs |
|---|---|---|---|
| Y1 | `[é]` | `é`=0 `e`=0 | — (literal on main, still 0) |
| Y2 | `[à-ÿ]` | `é`=0 `à`=0 | — |
| Y3 | `[!a][!a]` | `é`=1 `bb`=1 | I, A both |
| Y4 | `x[é]` | `xé`=0 | — |
| Y5 | `é`, `*é` | `é`=1; `xé`=1 `é`=1 | — |

**Non-cone sparse (`git sparse-checkout set --no-cone`; files on disk afterwards; both `ic`
values identical unless shown)**

| ID | Patterns over paths | git | main |
|---|---|---|---|
| SP1 | `/t`, `br[a]/` over `t` `bra/i` `br[a]/h` | `t` `bra/i` | `t` `br[a]/h` |
| SP2 | `[ab]` over `a` `b` `c` | `a` `b` | none |
| SP3 | `d/[!a]` over `d/a` `d/b` | `d/b` | none |
| SP4 | `[A]x` over `Ax` `bx` | ic=false `Ax`; ic=true none | none |
| SP5 | `[a]x` over `Ax` `bx` | ic=false none; ic=true `Ax` | none |
| SP6 | `[A-Z]x` over `ax` `bx` `5x` | ic=false none; ic=true `ax` `bx` | none |
| SP7 | `\[a]` over `[a]` `a` | `[a]` | `[a]` (via the unescape, see G-a) |
| SP8 | `\*` over `*` `x` | `*` | `*` `x` |
| SP9 | `x[[:digit:]]` over `x5` `xa` | `x5` | none |
| SP10 | `[a` over `[a` `a` | none | `[a` |
| SP11 | `?` over `é` `e` | `e` | `é` `e` |
| SP12 | `a\` over `a\` `a` | none | `a\` |
| SP13 | `*.LOG` over `x.log` `y.txt` | ic=true `x.log` | ic=true `x.log` (already folded) |

**Attribute negation and ignore pattern text (†)**

| ID | Input | git | main |
|---|---|---|---|
| N1 | `.gitattributes` `!a foo`; `check-attr foo -- '!a' a` | warning, `!a: foo: unspecified`, `a: unspecified` | `!a` → `true` |
| N2 | `.gitattributes` `\!b foo`; `check-attr foo -- '!b'` | `set` | `unspecified` |
| P1 | `.gitignore` lines `!e\[x]`, `f\[ab]/`, `/g[h]`; `check-ignore -v` | `.gitignore:1:!e\[x]`, `.gitignore:2:f\[ab]/`, `.gitignore:3:/g[h]` | `IgnoreRule.pattern` `!e[x]`, `f[ab]/` |
| P2 | `\#a`, `c\ `, `d\*`, `g\\h   ` (from the orchestrator's pin) | `\#a`, `c\ `, `d\*`, `g\\h` | `#a`, `c `, `d*`, `g\h` |

### Gaps in the same seam (verdicts under Doctrine)

| Gap | Proof | Locus | Verdict |
|---|---|---|---|
| G-a `tokenizeIgnoreLine` runs `unescapePattern` before `compileGlob`. In `.gitignore` and sparse, `\*`/`\?` become wildcards and `a\` stays a literal. `.gitattributes` passes `\` through as a literal | E2, E3, E6, E10, S1, S2, SP8, SP12 (ignore); E1–E13 (attributes). Once classes exist, `\[a]` would turn into a class (E1, SP7 go red) | `src/domain/ignore/parse-gitignore.ts` `unescapePattern`, `tokenizeIgnoreLine`; `compile-glob.ts` | **Fold** (D-2: the class rows reach it; D-5: an edited seam). The escape moves into the matcher for all three consumers |
| G-b `IgnoreRule.pattern` = `unescapePattern(stripTrailingSpaces(raw))`. git prints the pattern as written after the trailing-space trim | P1, P2 | `parseGitignore` | **Fold** (D-5). Exposed as `IsIgnoredMatchSource.pattern` (structured data, ADR-249) |
| G-c ignore/attributes never fold case. Only sparse passes `caseFold` | L1–L4, E12, E13, F1–F12 under ic=true | `parseGitignore`, `parseGitattributes`, `read-gitignore.ts`, `read-gitattributes.ts`, `ignore-evaluator.ts` | **Fold** (D-2: the brief's ic=true class rows cannot go green without it) |
| G-d `?` matches one UTF-16 unit; git matches one byte | Q2, Q3, Y3, SP11 | the `single` token of `compileGlob` | **Fold** (D-5: same matcher) |
| G-e `parseGitattributes` applies a `!`-led pattern; git skips the line | N1 | `parseGitattributes` (`buildRule`) | **Fold** (D-5: the function this change edits). The warning is a DC (DC-F) |
| G-f the `[:name:]` lookup reads a plain object, so a name inherited from `Object.prototype` resolves: three names match every byte and `__proto__` throws. Found during implementation | C35b | the class table of the shared core (main: `ref-glob.ts` `CLASS_TESTS`) | **Fold** (D-5: the seam the change moves; reachable from a cloned `.gitignore` once `compileGlob` runs on the core). An own-key `Map` lookup: B6d already says any other name aborts |
| today's `caseFold` lowers the whole pattern | E13 (ic=true `\A` vs `A`), F1, F7, F10, F11 | `compileGlob` | replaced by the fold model of §3 |

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/domain/pathspec/compile-glob.ts` | `compileGlob(pattern: string, options: CompileGlobOptions): GlobMatcher`; `CompileGlobOptions { anchored; caseFold? }`; `GlobToken` (`literal`/`single`/`star`/`star-star`/`star-slash`), `tokenize`, `scanPathnameStar`, `step*`, `matchTokens`, `literalPrefixOf`, `carriesPrefix`, `matchesLiteral`, `matcherFor` | the gitignore-family matcher over UTF-16 units. A DP layer is allocated per token per `test`. `caseFold` = `asciiLower` on both sides |
| `src/domain/refs/ref-glob.ts` | `RefGlobToken`, `BracketAtom`, `CLASS_TESTS`, `bracketTest`, `parseClassAttempt`, `parseMember`, `parseBracket`, `Dialect`/`REF_DIALECT`/`PATHNAME_DIALECT`, `isWholeSegmentRun`, `pathnameStarRun`, `scanEscape`, `tokenize`, `stepStar`/`stepSegment`/`stepDirs`/`stepMatch`, `matchTokens` (two swapping rows, early exit), `compileRefGlobBytes`, `compileRefGlob`, `compilePathnameGlob`, `matchRefGlob` | git's full `dowild` over UTF-8 bytes (T2, T5c and the B-list already faithful). No fold, no anchoring, no fast path. Importers: `domain/pathspec/wildcard.ts`, `domain/reflog/expire-policy.ts`, `domain/describe/match.ts`, `domain/name-rev/ref-pattern.ts`, `application/commands/internal/merge-message.ts` |
| `src/domain/ignore/parse-gitignore.ts` | `IgnoreRule { pattern; negated; directoryOnly; anchored; lineNumber; compiled }`, `TokenizedIgnoreLine { …; cleanPattern }`, `stripTrailingSpaces`, `unescapePattern`, `tokenizeIgnoreLine(rawLine)`, `parseGitignore(text)` | G-a, G-b, G-c |
| `src/domain/attributes/parse-gitattributes.ts` | `AttributeRule`, `readPattern`, `derivePattern`, `buildRule`, `parseGitattributes(text)` | G-a, G-c, G-e |
| `src/domain/sparse/non-cone.ts`, `parse-sparse-checkout.ts` | `compileSparseRule(tokenized, source, { caseFold })`, `parseNonCone`, `buildSparseMatcher` (re-parses folded) | inherits G-a and G-d through `tokenizeIgnoreLine`/`compileGlob` |
| `src/domain/ignore/match.ts`, `matcher-stack.ts`; `src/domain/attributes/resolve-attribute.ts` | `lastMatch`, `relativize`, `ruleMatches` (unanchored → `test(basename)`), `relativeTo` | callers of `compiled.test`. Unchanged |
| `src/application/primitives/internal/read-gitignore.ts` | `readGitignore`, `readInfoExclude`, `readGlobalExcludes`, `loadAndParse` | the only `parseGitignore` caller (G-c wiring) |
| `src/application/primitives/internal/ignore-evaluator.ts` | `buildIgnoreEvaluator`, `buildRepoIgnorePredicate` | builds levels once per walk or query, so it reads `core.ignoreCase` once |
| `src/application/primitives/internal/read-gitattributes.ts` | `loadAndParse`, `parseBlobAttributes`, `DirReader`, `workTreeDirReader`, `treeDirReader`, `indexDirReader`, `readInfo`, `readGlobal`, `buildAttributeProviderFrom` | every `parseGitattributes` call (G-c wiring) |
| `src/application/primitives/is-ignored.ts` | `IsIgnoredMatchSource.pattern` (public, in `reports/api.json`) | carries G-b |
| `src/domain/objects/encoding.ts` | `encode`, `encodeEscaped` (a lone U+DC80..U+DCFF is its raw byte) | path → bytes |
| `src/domain/pretty/ascii.ts` | `asciiLower` | folds `A`–`Z` only |

Tests to extend: `test/unit/domain/pathspec/compile-glob.test.ts` (the `[abc]` literal row flips),
`compile-glob.properties.test.ts`, `arbitraries.ts`. `test/unit/domain/ignore/parse-gitignore.test.ts`
has three `\#literal` rows that assert the unescape and flip. Also
`test/unit/domain/attributes/parse-gitattributes.test.ts`, `test/unit/domain/sparse/non-cone.test.ts`,
`test/unit/domain/refs/ref-glob.test.ts` (+ properties), and
`test/perf/domain/pathspec/compile-glob.perf.test.ts`. Model interop:
`test/integration/glob-double-star-interop.test.ts`. Ignorecase twin precedent:
`checkout-file-directory-swap-interop.test.ts` (`describe.each(['false','true'])('Given
core.ignorecase is %s')`).

### Constraining ADRs, doctrine, lessons

- ADR-226 (prime directive). ADR-249: `IsIgnoredMatchSource.pattern` is data. git's attribute
  warning is stderr text. ADR-1170 (filing bar, net-zero cap of one).
- ADR-077 (linear matcher, `O(tokens × path)`) binds the new tokens. ADR-040 (one extracted
  `compileGlob`). `docs/design/compile-glob-redos.md` §1/§4 ("character classes are literal in
  v1") is superseded here.
- DOCTRINE D-2 (the class rows reach G-a/G-c → fold whole, per consumer, interop pin per
  consumer). D-5 (G-b, G-d, G-e are proven in edited seams → fold). D-3 (no returning→throwing
  change here, see §8). D-4 is not triggered: no data-destroying arm.
- Lessons: 033 (re-pinned), 042/045 (both `core.ignorecase` values, twin in the Given slot), 046
  (one interop row per branch of the ordered list), 050 (perf gate against a floor, DC-E), 051
  (the lists above come from `wildmatch.c`; the probes confirm them).

## Requirements

- **R1** The three consumers return git's verdict for every row of the pinned matrix, under both
  `core.ignorecase` values, except the artefact cells listed in Context.
- **R2** `compileGlob` implements T0–T7 and B1–B9 with WM_PATHNAME, and `WM_CASEFOLD` exactly as
  T1/B5/B6c/B7 state. That means no lowering of escaped bytes or set members, and a range that
  retries the upper-cased text byte.
- **R3** Matching is over bytes. `?` and a set consume one byte of the path's UTF-8, and a lone
  U+DC80..U+DCFF in a path is its raw byte (`encodeEscaped`).
- **R4** A pattern `dowild` would abort on (B3, B6a, B6d, trailing `\`) compiles to a matcher
  that accepts nothing, the path spelled like the pattern included.
- **R5** Matching stays `O(tokens × path bytes)` with no backtracking. A set costs O(1) per cell.
  **Compilation is `O(pattern bytes)`**: the `[:` lookahead never scans the same bytes twice. Measured on main's
  `ref-glob.ts` `parseClassAttempt`, `'[' + '[:'.repeat(n) + 'x]'` compiles in 21/70/281 ms
  for n = 5k/10k/20k, a factor of 4 per doubling. A 1 MiB `.gitignore` line (`MAX_GITIGNORE_BYTES`)
  would take minutes.
- **R6** `.gitignore` and sparse keep `\` escapes in `cleanPattern`. The matcher resolves them.
  `.gitattributes` does the same after its C-unquote.
- **R7** `IgnoreRule.pattern`, and so `IsIgnoredMatchSource.pattern`, is the line after the
  trailing-space trim, escapes and `!`/`/` kept (P1, P2).
- **R8** `.gitignore` (all four sources) and `.gitattributes` (work tree, index, tree,
  `info/attributes`, `core.attributesFile`) fold case when `core.ignoreCase` is true. The config
  is read once per evaluator or provider build.
- **R9** `parseGitattributes` drops a pattern whose first byte after unquoting is `!` (N1).
  `\!b` matches `!b` (N2).
- **R10** The fast paths agree with wildmatch on every input. They are a pure literal, an
  unanchored `*literal`, and a literal prefix, each taken over the folded string.
- **R11** Interop: one row per T/B branch per consumer (ignore, attributes) under both
  `core.ignorecase` twins, plus the SP rows for sparse.
- **R12** No regression on rule sets main already matches faithfully, within the DC-E gate.

## Design

### 1. One `dowild` core (DC-A)

Recommended shape: move `ref-glob.ts`'s tokenizer and DP into `src/domain/glob/wildmatch.ts`.
`ref-glob.ts` keeps its four exports as dialect wrappers, and `compileGlob` becomes the
gitignore-family wrapper.

```
domain/glob/wildmatch.ts      tokenizeWildmatch(bytes, flags) → tokens | undefined   (undefined = abort)
                               matchWildmatch(tokens, text: Uint8Array) → boolean
                               LEADING_DIRECTORIES  — the `(.*/)?` token (today's `dirs` / `star-slash`)
domain/refs/ref-glob.ts       compileRefGlob / compileRefGlobBytes  { pathname: false, caseFold: false }
                               compilePathnameGlob                 { pathname: true,  caseFold: false }
domain/pathspec/compile-glob.ts compileGlob(pattern, { anchored, caseFold })  { pathname: true, caseFold }
                               + anchoring + fast paths (§5)
```

`interface WildmatchFlags { readonly pathname: boolean; readonly caseFold: boolean }`. Dependency
direction: `refs → glob` and `pathspec → glob`. The `pathspec → refs` edge in `wildcard.ts` stays
as it is. Nothing in `glob/` imports outward except `objects/encoding.js`. Bundle: the
`compileGlob` DP and its token kinds are deleted and replaced by imports of code the bundle
already ships (`ref-glob` is reached from pathspec). `check:size` should shrink. If a cap still
trips, raise it in a `chore(size)` commit (house rule).

### 2. Token model

| Token | Matches (one DP cell rule) | Source |
|---|---|---|
| `byte b` | `text[j] === b` (T2 escaped: `b` raw; T3 plain: `b` lowered at compile time under fold) | T2, T3 |
| `set table` | `table[text[j]] === 1`, with `table` a 256-entry `Uint8Array` built at compile time (DC-D) | T4 (`?` = all but `/`), T6/B* |
| `segment` | run of non-`/` bytes | T5d |
| `star` | run of any bytes | T5b, T5c (followed by a `byte '/'` from the `\/`) |
| `dirs` | empty, or any run ending on `/` | T5a, `LEADING_DIRECTORIES` |

The `byte` and `set` tokens are `ref-glob`'s `match` token, made concrete so the hot loop indexes
a table instead of calling a closure. Under `pathname`, `table['/'] = 0` for every set and for
`?` (B9).

**Set table construction** (B-list, with the text byte already lowered under fold): for each
`x` in 0..255:

```
member(x)  = any plain/escaped member m with m === x
range(x)   = lo <= x <= hi  ||  (fold && isLower(x) && lo <= upper(x) <= hi)
class(x)   = CLASS_TESTS[name](x)  ||  (fold && name === 'upper' && isLower(x))
table[x]   = (member || range || class) !== negated   &&   !(pathname && x === '/')
```

Under fold the text never holds `A`–`Z`, so those entries are never read. A set's build cost is
O(members + 256), bounded per set and paid once at compile time.

**Linear `[:` lookahead (R5).** One pass over the pattern bytes fills `closeAfter[i]`, the index
of the first `]` at or after `i`. `parseClassAttempt` reads `closeAfter[i + 2]` instead of
scanning. The verdict is git's: `p_ch` is the first `]` after `[:`, so B6a, B6b and B6c/d are
decided from that index alone. Whole-pattern compilation is O(n).

### 3. Case-fold model (`WM_CASEFOLD`, not "lower both sides")

- Runtime: the path is folded once (`asciiLower`, which touches single-byte `A`–`Z` only, so
  folding the string equals folding its bytes), then encoded.
- Compile time, under `caseFold`:
  - a plain literal byte is lowered (T1);
  - an escaped byte is **not** lowered (`\A` matches nothing, E13; `\a` matches `a`/`A`, E12);
  - set members are not lowered (`[A]` matches nothing, F1);
  - a range retries `upper(x)` (F3, F5, F12);
  - `[:upper:]` admits lower (F8);
  - negation is applied after all of these (F6, F7).
- `asciiLower` on the pattern disappears from `compileGlob`.

### 4. Text representation (DC-B)

Recommended: `encodeEscaped(foldedPath)` once per `test` call that reaches the DP, after the
string fast paths of §5. Literal and star tokens give the same answer over UTF-16 units and
over bytes for canonical path strings. Paths come out of `decodeEscapingInvalid`, which escapes
only invalid sequences, so a string prefix or suffix test equals the byte test. Only `?` and
set tokens need bytes. The DP uses `ref-glob`'s two swapping rows with an early exit. Main's
`compileGlob` allocates one row per token, so the encode is offset by fewer allocations. DC-E
measures that.

### 5. `compileGlob`: anchoring and fast paths (DC-C)

```ts
export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  const tokens = tokenizeWildmatch(encode(pattern), { pathname: true, caseFold })
  if (tokens === undefined) return NEVER                       // R4: abort beats every fast path
  const program = anchored ? tokens : [LEADING_DIRECTORIES, ...tokens]
  const shortcut = shortcutOf(pattern, anchored, fold)          // decided on the pattern TEXT
  return { test: (path) => { const text = fold(path); return shortcut(text) ?? matchWildmatch(program, encodeEscaped(text)) } }
}
```

`shortcutOf` mirrors `dir.c`. It works on the pattern **text**, with git's `simple_length`
(the run before the first `* ? [ \`):

| Shape (git) | Condition | Shortcut on the folded path `t` | Today |
|---|---|---|---|
| pure literal (`prefix == patternlen`) | `simple_length == length` | `t === lit` or (unanchored) `t.endsWith('/' + lit)`. The verdict is final | `matchesLiteral`, but it counts `[`/`\` as literal |
| `ENDSWITH` (`*` + no special) | unanchored and `pattern[0] === '*'` and no special in the rest | `t.endsWith(rest)`. Final. `rest` has no `/` (otherwise the pattern would be anchored), so it sits inside the last segment | absent |
| literal prefix | `simple_length > 0` | reject (`false`) unless `t` starts with the prefix or (unanchored) contains `'/' + prefix`. Otherwise defer to the DP | `literalPrefixOf` + `carriesPrefix`, but the run counts `[`/`\` |

`lit`, `rest` and the prefix are folded under `caseFold`. They hold no escape, so this matches
`fspathncmp` and T1 exactly. An escape or a set always stops the prefix (git's `simple_length`
does the same), so a pattern led by `\*x` or `[ab]c` has no prefix and goes straight to the DP.
Unanchored ≡ `NODIR`: a `NODIR` pattern holds no `/`, so its `*`, `?` and sets meet no `/` in
the basename git tests. The WM_PATHNAME body behind `(.*/)?` therefore admits the same paths
(C58 `d/a`, C60 `x/ac`). That is why one dialect serves both of git's matchers.

### 6. Complexity (ADR-077 preserved)

- Compile: one pass to build `closeAfter`, one pass over the pattern bytes, O(256) per set. O(n).
- Match: tokens ≤ pattern bytes + 1. Each step fills one row of `path bytes + 1` cells in O(1)
  per cell (`dirs` uses a constant number of passes). It never backtracks.
- An aborting pattern is the constant-false matcher.
- The bound is O(tokens × path bytes), and path bytes ≤ 3 × UTF-16 units.

### 7. Consumers

1. **`.gitignore` / sparse (`parse-gitignore.ts`).** Delete `unescapePattern`.
   `tokenizeIgnoreLine` returns `cleanPattern` with escapes kept. `!`, `#` and trailing `/`
   detection stay on raw bytes, as `parse_path_pattern` does: `\!a`, `\#a` and `a\/` reach the
   matcher. `parseGitignore(text, options: { caseFold?: boolean } = {})` passes `caseFold`.
   `pattern: stripTrailingSpaces(rawLine)` (R7).
   `compileSparseRule`/`buildSparseMatcher` need no change beyond inheriting the matcher.
2. **`.gitattributes` (`parse-gitattributes.ts`).**
   `parseGitattributes(text, options: { caseFold?: boolean } = {})`. The pattern after
   `readPattern` (C-unquoted) goes to `compileGlob` with escapes intact. `buildRule` is skipped
   when that pattern starts with `!` (R9, DC-F). `AttributeRule.pattern` keeps today's meaning.
3. **Wiring (`read-gitignore.ts`, `ignore-evaluator.ts`, `read-gitattributes.ts`).**
   `buildIgnoreEvaluator` and `buildAttributeProviderFrom` read
   `(await readConfig(ctx)).core?.ignoreCase === true` once (DC-I). They pass `{ caseFold }` to
   `readGitignore`/`readInfoExclude`/`readGlobalExcludes`, the `DirReader`s, `readInfo`,
   `readGlobal` and `parseBlobAttributes`. Base-directory comparison (`relativize`,
   `relativeTo`) needs no fold: `isIgnored` stacks the ancestors of the queried path,
   `buildRepoIgnorePredicate` stacks the walked directories, and `sourcesForPath` stacks the
   path's own directories. Every base is spelled from the path it is compared with, as in git.

### 8. Public API and breaking classification

| Surface | Change | Kind |
|---|---|---|
| `IsIgnoredMatchSource.pattern` (public) | value keeps escapes (P1/P2). Type unchanged | value fix |
| `isIgnored`, `status` (ignored and untracked), `add` (ignore refusal), every attribute consumer (`eol`, `diff`/`merge` drivers, `export-ignore`, `grep` binary), `sparseCheckout*`, sparse checkout writes | verdicts follow git for `[…]`, `\`, `core.ignorecase`, multi-byte `?` and attribute `!` patterns | behaviour fix |
| internal `parseGitignore`, `parseGitattributes` | optional `{ caseFold }` argument; `cleanPattern` keeps escapes; negative attribute lines dropped | internal |
| internal `compileGlob` | `caseFold` semantics refined; signature unchanged | internal |
| internal `ref-glob.ts` | same exports, same behaviour; body moved | internal |

No method starts throwing, so D-3 does not apply. Proposed squash title: `fix(ignore): match
bracket expressions, escapes and core.ignorecase as git's wildmatch does`. With `!` if DC-G
says breaking.

### 9. Docs to update (documentation phase)

- `docs/design/compile-glob-redos.md`: §1 "Out of scope" bullet and §4 "character classes are
  literal in v1" get a superseded note pointing here. The module header in `compile-glob.ts`
  loses "`[…]` and `\` are matched verbatim".
- `docs/use/commands/add.md` (pathspec syntax, "gitignore, gitattributes and sparse patterns
  keep their own dialect"): name that dialect. It is wildmatch with WM_PATHNAME: `[…]` classes,
  `\` escapes, byte-wise `?`, and folding under `core.ignorecase`.
- `docs/use/commands/sparse-checkout.md` (non-cone bullets): the same dialect line.
- `docs/use/primitives/is-ignored.md`: `pattern` is the line as written (escapes kept), and
  matching honours `core.ignorecase`.
- `docs/BACKLOG.md` 32.91 closed. `docs/known-divergences.md`: nothing to remove; no entry
  covers these gaps.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-A | Where the class grammar lives | A: move `ref-glob`'s tokenizer and DP into `src/domain/glob/wildmatch.ts`; `ref-glob.ts` and `compile-glob.ts` become wrappers · B: extend `ref-glob.ts` in place with a `{ pathname, caseFold }` entry that `compileGlob` imports · C: a `class` token written into `compile-glob.ts` over UTF-16 units | A | One bracket grammar: jscpd stays quiet and the two parsers cannot drift. Bytes come free for G-d. The linear `[:` lookahead (R5) fixes `ref-glob`'s measured quadratic compile too, so nothing needs filing. B gives `.gitignore` a dependency on a module named for refs. C duplicates about 150 lines, still needs bytes for `?`/sets (R3), and leaves the `ref-glob` quadratic as an out-of-perimeter finding to file |
| DC-B | Text the DP reads per `test` | A: `encodeEscaped(foldedPath)` per DP call, after the string fast paths · B: widen `GlobMatcher` with a bytes entry so `lastMatch`/`ruleMatches`/`verdictOf` encode once per path · C: DP over UTF-16 units for an ASCII path, bytes otherwise | A, gated by DC-E | Smallest seam. Fast paths settle most (rule, path) pairs before any encode. B touches three consumers and the pathspec `GlobMatcher` type. Take B only if the gate fails. C needs two copies of the DP |
| DC-C | Fast paths | A: git's three (`prefix == patternlen`, `ENDSWITH`, literal prefix), each on `simple_length` and folded · B: today's two (pure literal, prefix), redefined on `simple_length` · C: none, DP only | A | All three are git's own and observably equal to wildmatch (R10). `ENDSWITH` covers the commonest `.gitignore` shape (`*.log`), which has no prefix and would otherwise always pay the encode and the DP |
| DC-D | Set evaluation | A: 256-entry table per set, fold/negation/`/` baked in at compile · B: member list scanned per cell (`ref-glob` today) | A | O(1) per cell keeps ADR-077's bound independent of set size. Fold and negation are settled once. It is 256 B per set |
| DC-E | Perf gate (lesson 050) | A: new `test/bench/ignore-match.bench.ts`: 20k walked paths × a 40-rule `.gitignore`. Class-free rows ≤ 10 % over main (main is faithful there). Class rows ≤ 25 % over a floor twin where each set is replaced by `?` (same token count, one-byte test). Plus the bound rows in the perf test · B: perf-test bound rows only · C: add a `.gitignore` to `status.bench.ts` (shifts that series' history) | A | Main is no yardstick for class rows (it reads them as literals). The `?` twin is the floor git itself pays: one wildmatch step per byte. B proves the bound but not the hot path |
| DC-F | git's negative-attribute warning (G-e fold itself is D-5) | A: drop the line silently · B: drop it and `ctx.logger?.warn` git's text · C: drop it and record the dropped line on `ParsedAttributes` | A | The warning is stderr text (ADR-249) and no command result carries parse diagnostics. B puts display text in the library. C adds a field nobody reads |
| DC-G | Breaking mark | A: `fix(ignore): …` · B: `fix(ignore)!: …` | A | No signature change, and no returning→throwing change (D-3's trigger). Precedent: #326 changed the pathspec glob dialect as `fix(pathspec)`. B's case: existing repos see different ignore/attribute verdicts, and `IsIgnoredMatchSource.pattern` values change |
| DC-H | Property oracle for the class grammar | A: a test-side reference port of git's recursive `dowild` (an independent algorithm, run on short patterns over a small alphabet), plus invariants · B: invariants only · C: agreement with `compilePathnameGlob` | A | The DP and git's backtracking recursion are different algorithms, so agreement is a real oracle, not a tautology. C is circular under DC-A A. B alone misses cross-branch grammar bugs (`[]-a]`, `[[:]]`) |
| DC-I | Where ignore/attributes learn `core.ignoreCase` | A: read once per `buildIgnoreEvaluator`/`buildAttributeProviderFrom`, passed down · B: each loader calls `readConfig` · C: parse case-exact, re-parse folded on demand (`buildSparseMatcher`'s way) | A | One cached read per walk or query. B adds a config stat per directory loaded during the walk. C parses twice and needs `source` lines on every rule |

### Settled (2026-11-23)

Every candidate was settled as recommended, so the design stands as written.

| Candidate / gap | Outcome | Record |
|---|---|---|
| DC-A | user-ratified, option A | ADR-1248 |
| G-a | folded (D-2, D-5) | ADR-1249 |
| G-b | folded (D-5) | ADR-1250 |
| G-c, DC-I | folded (D-2); option A adopted | ADR-1251 |
| G-d, DC-B | folded (D-5); option A adopted | ADR-1252 |
| DC-C | option A adopted | ADR-1253 |
| DC-D | option A adopted | ADR-1254 |
| DC-E | user-ratified, option A | ADR-1255 |
| G-e, DC-F | folded (D-5); option A adopted (ADR-249) | ADR-1256 |
| DC-G | user-ratified, option A | ADR-1257, DOCTRINE D-6 |
| DC-H | option A adopted | ADR-1258 |

## Test strategy

- **Unit, `compile-glob.test.ts`:** one `describe` per ordered-list branch, using the matrix IDs
  as data (T1–T7, B1–B9), each under `caseFold` false and true where the verdict depends on it.
  Specific rows:
  - abort rows assert that the path spelled like the pattern is refused (C25–C35, E6), which
    kills an "abort → literal" mutant;
  - fast-path rows: pure literal under fold (L1, L4); `ENDSWITH` (`*.log` vs `x.log`, `x.log/y`,
    and `*.LOG` folded); a prefix reject when the prefix is absent; no prefix when the pattern
    starts with `\*x`, `[ab]c` or `?x`;
  - an unanchored prefix after `/`;
  - `ENDSWITH` must not fire on `*a[b]`, `*a\b` or `*a?`;
  - multi-byte rows Q2, Q3, Y1–Y4, and a lone U+DC80..U+DCFF path byte against `?` and `[!a]`.
  The `[abc]` literal row flips.
- **Unit, `src/domain/glob/wildmatch.ts`** (new eponymous suite):
  - set-table construction per B-branch;
  - fold table rows F1–F12, where F12 `[A-A]` vs `a` kills the range low-bound mutant that
    `ref-glob`'s inline comment calls equivalent: under fold it is not, so drop that note;
  - `closeAfter` on `[[:a]b:]]`;
  - abort on each B3/B6a/B6d shape.
  `ref-glob.test.ts` and its properties stay green unchanged, since the move preserves behaviour.
- **Unit, consumers:**
  - `parse-gitignore.test.ts`: `cleanPattern` keeps `\#`, `\!`, `\*`, `\ `; `pattern` is the
    trimmed line (P1, P2); `caseFold` reaches `compiled`. The three `\#literal` rows flip.
  - `parse-gitattributes.test.ts`: `!a` dropped and `\!b` kept (N1, N2); escapes reach the
    matcher; `caseFold`.
  - `non-cone.test.ts`: `\*` (SP8), `a\` (SP12).
  - application: `buildIgnoreEvaluator`/`buildAttributeProvider` with `core.ignoreCase` true and
    false on the memory adapter (L3 row), and one config read per build.
- **Properties, extend `compile-glob.properties.test.ts`** (+ generators in `arbitraries.ts`):
  - lens 3, total function: any printable-ASCII pattern over `[]!^-:\\*?/aAbB` compiles and
    returns a boolean (100 runs);
  - lens 1, round trip: escaping every byte of a literal `p` gives a pattern that matches `p`
    and rejects `p` + suffix (200);
  - lens 2/4, invariants:
    - `x[S]y` and `x[!S]y` disagree on every one-byte non-`/` middle when `S` is well-formed (100);
    - appending an unterminated `[` makes any pattern match nothing (50);
    - under fold, flipping the path's ASCII case never changes the verdict (kept);
    - "exact accepts ⇒ fold accepts" (kept) still holds on the existing `[aAbB/*?]` alphabet. It
      is false once `[`/`\` join it (F1, E13), so the generator must stay as is;
  - DC-H oracle: agreement with the test-side `dowild` reference over patterns ≤ 8 bytes and
    paths ≤ 6 bytes, both flags (100).
- **Interop, new `test/integration/glob-bracket-class-interop.test.ts`**, modelled on
  `glob-double-star-interop.test.ts` (same helpers `isIgnored`,
  `buildAttributeProvider`+`resolveAttribute`, `sparseCheckoutSet`, `git check-ignore -q
  --no-index`, `git check-attr`). `describe.each(['false', 'true'])('Given core.ignorecase is
  %s')` is the outer Given (lesson 045). Each repo runs `git config core.ignorecase <v>` before
  either tool reads it, and sparse sets it in both peer and ours.
  - **Attributes and ignore rows**, one per branch (lesson 046): T2 E1, E2, E6, E7, E11, E12,
    E13; T3 L1, L3, L4; T4 Q2, Q3; T5c S1, S2; T5d S5; B1 C1, C2, C3; B2 C5, C6, C9; B3 C25, C31,
    C24; B4 C18, C20, C21; B5 C10, C11, C12, C14, C15; B6a C32; B6b C51, C53; B6c C36, C40, C42,
    C49, C50; B6d C33, C34; B7 C56, C58, C60 (`[ab]c` vs `x/ac`); B9 C61, C62, C63; fold F1, F3,
    F5, F6, F7, F8, F10, F12; bytes Y1, Y3; G-e N1, N2 (attributes only); G-b P1 and P2 on their non-negated lines (ignore only,
    reconstructing `check-ignore -v`'s `<source>:<line>:<pattern>` from `source` and comparing
    the bytes, ADR-249).
  - **Sparse rows:** SP1–SP12 (SP13 as a fold regression row). Paths never need two case
    variants on disk, so APFS case-insensitivity cannot merge them.
  - **Row constraints:** no ignore path starting with `:`; no path under a directory the
    pattern matches; no `.`/`..` path; control-character paths only through `check-attr`/
    `check-ignore` arguments, never as files.
- **Perf:** `compile-glob.perf.test.ts` gets two rows:
  - match bound: `'[a-z]*'.repeat(64) + 'b'` against 10 000 `a`, under 1000 ms;
  - compile bound: `'[' + '[:'.repeat(100_000) + 'x]'` compiles under 1000 ms (main's shape
    takes several seconds by the measured ×4 per doubling).
  Bench per DC-E.
- **Mutation:** scoped Stryker on `compile-glob.ts`, `wildmatch.ts`, `ref-glob.ts`,
  `parse-gitignore.ts`, `parse-gitattributes.ts` with their eponymous suites
  (`.claude/workflow/mutation.md`). Error/abort assertions check the verdict for the literal
  name. Guard conditions get isolated rows (`ENDSWITH` needs unanchored *and* a leading `*` *and*
  no special). The `ref-glob` equivalence notes moved into `wildmatch.ts` are re-checked against
  the fold rows.

## After the settled design

Implementation and review changed the points below. The sections above stand as decided; where
a line here contradicts one of them, this section wins.

| Change | Measured | Record |
|---|---|---|
| The case fold and the byte encoding of a path are each remembered for the last two paths. The rules of one source test the same path in turn, and an attribute rule set tests a path and then its basename | folded ignore matching 19.9 / 19.5 ms against 17.6 / 18.2 ms case-exact; attribute-shaped loop 12.9 / 13.0 ms against 8.0 ms | ADR-1259, then ADR-1260 |
| The tokens after a pattern's last star each consume one byte. A path whose last bytes fail them is refused before any table is filled | ignore-match bench 21.0 / 60.4 / 62.8 ms → 15.1 / 19.4 / 19.5 ms (no sets, sets, one-byte twin) | ADR-1260 |
| A set holding one plain byte compiles to a byte token, never for `/` under `WM_PATHNAME`. Equal set tables are shared within one compile, keyed by the table packed sixteen slots to a UTF-16 unit | retained heap for a 1 MiB hostile file, branch against main: one line of `[ab]` 5.3 MB against 83 MB; 262 144 lines of `[a]` 163.6 against 161.5 MB. Compile of 262 144 × `[ab]`: 154 ms | review, security |
| `asciiLower` lowers text that is ASCII throughout natively | identical output on every code unit, alone and embedded (362 162 comparisons) | ADR-1260 |
| The compile bound of the perf suite gates compile time against filling one 256-slot table per set, measured in the same process (ratio 1.28, gate 4). It replaces the "under 1000 ms" row of the test strategy, which failed under load | 3 / 3 green at load 9–14 | review, tests |

**Accepted residual.** A rule set where every line holds its own multi-member set keeps one
256-byte table per rule: 209 715 lines of `[ab]` retain 212.7 MB against 131.0 MB on main. The
growth is linear. A pool across rules is defeated by distinct sets, and a 32-byte bit set costs
a shift and a mask per byte on the hot path.

**Out-of-scope hunch, now proven.** A pattern holding bytes that are not valid UTF-8 never
matches the path holding those bytes: the file is decoded as UTF-8 before parsing. It is left
out of this change and recorded as a discovered impact.

**Size caps.** Raised once, after review, on a clean build: browser bundle 374 → 374.4 kB
(measured 374.32), full library 433.6 → 434.1 kB (434.02), domain chunk 130.4 → 130.8 kB
(130.78), tarball 1551 → 1553 KiB (1 589 340 B). The attribution is the comment above
`SIZE_CAP` in `tooling/verify-tarball.sh`.

**Mutation.** One narrowed bucket, 773 mutants: 404 killed, 30 timed out, 35 survived. Every
survivor is an equivalent, and none is suppressed:

- 22 in `compile-glob.ts`. The fast paths, the prefix reject and the fixed-tail refusal each
  answer what the wildmatch program would, or leave it the verdict: a mutant there changes
  cost and never a verdict. The proof is the comment above each group. No call-count test
  pins them (lesson 011);
- 13 in `wildmatch.ts`: loop bounds that write past a typed array, a pool-key bit that
  `String.fromCharCode` drops, a closer index no reader asks for, an early return that only
  saves steps. Each proof is on its line.

Triage pinned one row the matrix lacked, git 2.56.1, both `core.ignorecase` values: in
`[[a:]` the inner `[` is not followed by `:`, so it is a plain member although a `:]` comes
later. The set matches `a` and `[`, and not `b`. `simpleLength` became one regex search,
which removed a loop-bound equivalent.

## Out of scope

- Cone-mode patterns: `parseCone` and the cone matcher never call `compileGlob`.
- The pathspec dialect (`wildcard.ts`): it is already wildmatch with flags 0, and only its import
  of `compileRefGlobBytes` is touched (same export).
- `core.ignorecase` from global or system config: `readConfig` is local-only by ADR-182, as for
  sparse today.
- Looking up `.gitignore`/`.gitattributes` files under a case-variant directory name (a file
  system lookup, not the matcher).
- Pattern bytes that are not valid UTF-8 inside `.gitignore`/`.gitattributes`. The files are
  decoded as UTF-8 before parsing. A hunch only, and how to prove it: write `\xff` into a
  `.gitignore` line and compare `check-ignore` with `isIgnored` for a path holding that byte.
- git's attribute warning text (DC-F).
