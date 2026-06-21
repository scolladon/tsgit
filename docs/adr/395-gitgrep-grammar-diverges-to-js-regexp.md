# ADR-395: gitGrep pattern grammar diverges to JavaScript RegExp

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/gitgrep-pattern-grammar.md](../design/gitgrep-pattern-grammar.md)
- **Diverges from:** [ADR-226](226-git-faithfulness-prime-directive.md) (grammar dimension only)
- **Template for divergence:** [ADR-206](206-log-message-returns-raw-body-with-trailing-newline.md)
- **Refines:** [ADR-249](249-describe-structured-data-only.md) (output shape unaffected)

## Context

A new Tier-1 `grep` command needs a pattern grammar. Real `git grep`'s grammar is
POSIX **Basic** Regular Expressions by default (`+ ? { } ( ) |` literal unless
backslash-escaped; `\( \)` group, `\{m,n\}` interval; GNU `\b \w \s \< \>` honoured),
with `-E` (POSIX ERE), `-F` (fixed strings), and `-P` (PCRE) variants. Pinned against
real `git 2.54.0`, the dialects also carry a load-bearing asymmetry: the GNU word
escapes `\b \w \s \< \>` are honoured in BRE but **not** in ERE.

A byte-faithful implementation therefore requires either a per-dialect transpiler
(BRE/ERE → matcher, with POSIX-class tables and dialect-gated GNU-escape handling) or a
purpose-built regex engine — a large body of net-new code carrying a permanent
faithfulness liability (tracking glibc/git semantics across versions) and, for the
transpiler route, a ReDoS fence on the patterns it emits.

Three forces argue against paying that cost now:

1. **The consumers are JavaScript developers.** tsgit is a pure-TS, browser+Node,
   zero-dependency library. Its callers write JS and already know JS `RegExp`.
2. **No consumer has asked for POSIX-grammar parity.** The downstream spike (sgd
   GitAdapter) that surfaced 24.16 needed a *working content search*, not BRE
   semantics. Building a faithful BRE/ERE engine speculatively is over-engineering
   (YAGNI).
3. **The backlog invites this resolution.** 24.16 says *"Decide the faithful grammar
   (or expose a mode enum) **per ADR**"* — a deliberate-divergence ADR is an allowed
   resolution under ADR-226's escape hatch.

## Options considered

1. **Faithful POSIX translation layer** (BRE/ERE → JS `RegExp` + fixed-string) —
   pros: byte-faithful to `git grep`, interop-pinnable / cons: a large transpiler with
   POSIX-class tables and the dialect-gated GNU-escape asymmetry; a permanent ReDoS
   fence on emitted patterns; an ongoing faithfulness liability across git versions;
   speculative — solves a parity problem no consumer has.
2. **Purpose-built NFA/Thompson engine** over bytes — pros: guaranteed linear,
   ReDoS-impossible, fully owned / cons: a from-scratch regex engine for two POSIX
   dialects; backreferences (`\1`, which git BRE/ERE support) are not regular and
   cannot be matched by a pure NFA without forfeiting the linearity that justified it;
   the single largest net-new surface in the feature.
3. **(chosen) Diverge to JavaScript `RegExp`** — the search pattern *is* a JS `RegExp`
   (flags ride on it), with a fixed-string form for literal search; idiomatic, minimal
   code, smallest bundle, near-zero grammar maintenance; not a drop-in `git grep`; the
   door stays open to add POSIX modes later if a consumer ever needs them.

## Decision

`grep`'s pattern grammar is **JavaScript `RegExp`**, a conscious divergence from
`git grep`'s POSIX grammar, scoped to the **grammar dimension only**.

- **Input is typed as a `RegExp`** for regex search, with a **fixed-string** form for
  literal substring search (the `-F` case). The exact option shape is the design's to
  finalize; the binding decision is that JS `RegExp` is the engine and the **input type
  makes the JS-ness explicit** — a caller passing `/a+/` cannot be silently misled into
  expecting BRE's "literal `a+`". Case-insensitivity (`-i`), dotall, multiline, and
  unicode ride on the `RegExp`'s own flags rather than being re-exposed as options.
- **Everything outside the grammar stays byte-faithful to git** and remains
  interop-pinned: target resolution (working tree / `--cached` / `<tree-ish>`),
  binary-blob handling ([ADR-396](396-gitgrep-v1-command-surface.md)), 1-based line
  numbering, and structured output ([ADR-249](249-describe-structured-data-only.md)).
- **The cross-tool interop test pins the git-faithful half** (which blobs/lines a
  target exposes, binary skip, line numbering). Grammar is **not** pinned against real
  `git grep` — doing so would test V8 against V8.
- **Reversible by extension:** a future `patternType` enum (`'js' | 'basic' | …`) can
  add faithful POSIX modes without breaking the v1 surface, if a consumer needs git
  grammar parity. Until then, JS `RegExp` is the only mode.

## Consequences

### Positive

- Minimal code, smallest bundle, idiomatic for JS consumers; the matcher is essentially
  `regexp.exec(line)` rather than a transpiler or engine.
- Near-zero grammar maintenance — V8 owns the regex engine; the BRE/ERE asymmetry and
  POSIX-class edge cases never enter the codebase.
- Lookahead, backreferences, and Unicode come for free from `RegExp`.
- The decision is reversible: POSIX modes can be added later as enum values.

### Negative

- `grep` is **not a drop-in `git grep`**. A consumer wanting POSIX-BRE parity (e.g. a
  faithful CLI emulation or a git-viz mirroring `git grep`) must translate POSIX → JS
  themselves, or instruct their users to write JS regex. This is the **first** tsgit
  command to consciously diverge from real git's observable behaviour.

### Neutral

- ReDoS is the **caller's** concern — they supply their own `RegExp`; the library bounds
  input via existing caps (`MAX_LINE_BYTES`, binary detection) rather than fencing a
  pattern it compiled.
- `-i` and other regex flags are no longer command options — they are properties of the
  `RegExp` the caller already constructs.
