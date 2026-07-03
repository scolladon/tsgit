# Design — GPG signing (produce side)

> Brief (backlog 25.2): a signing capability for the **produce** side — signed
> commits (`commit -S` / `commit.gpgsign`), signed annotated tags (`tag -s` /
> `tag.gpgSign`), and signed pushes (`push --signed` / `push.gpgSign`). The read
> side (verification: `--verify`, `%G?`/`%GK`/`%GS`, `allowedSignersFile`) already
> partially exists on the object model and is **not** in this backlog. Signature
> transport is delegated to the system signing program (`gpg` / `ssh-keygen` /
> `gpgsm`), exactly as canonical git delegates it. Sibling 25.1 (SSH transport)
> just landed and is the structural precedent for a new external-program surface.
> Status: draft → self-reviewed ×3 → accepted

## Context

### What exists today (verified against the worktree)

**The commit seam is already signature-ready.** `createCommit`
(`src/application/primitives/create-commit.ts:22`) accepts an optional
`gpgSignature?: string` (`CreateCommitInput`, `types.ts:181`), validates it
(`create-commit.ts:32`), injects it into `CommitData.gpgSignature`
(`create-commit.ts:60`), and `writeObject` recomputes the SHA over the resulting
object. The domain serializer `serializeCommitContent`
(`src/domain/objects/commit.ts:120`) emits `gpgsig` as a **continuation header**
after `committer` (`commit.ts:131-133`) via `formatContinuationHeader`
(`src/domain/objects/encoding.ts:81`), and `parseCommitContent` round-trips it
(`commit.ts:50`). So the *object layer* for signed commits is present; what is
missing is the **signing invocation** that fills `gpgSignature`.

**The `CommandRunner` port is the established external-program seam.** ADR-407
(24.19, LFS filter-driver) extended it (`src/ports/command-runner.ts`):
`CommandRequest` carries `command` / `cwd` / `env` / optional `signal` / optional
`stdin?: Uint8Array`; `CommandResult` returns `exitCode` and optional captured
`stdout?: Uint8Array`. It is **optional** on `Context` (`ctx.command?`,
`src/ports/context.ts:130`). The **node** shim wires a real `NodeCommandRunner`
(`src/index.node.ts:73`); the **browser** shim wires none, so `ctx.command` is
`undefined` in-browser (confirmed: no browser command-runner adapter exists —
only `node-command-runner.ts` and the `MemoryCommandRunner` test double
`src/adapters/memory/memory-command-runner.ts`). Three precedent consumers
resolve a program name from config and invoke it through this port, each a
different execution contract:

| Precedent | File | Execution contract |
|---|---|---|
| clean/smudge filter | `primitives/run-filter-driver.ts` | payload on **stdin**, result on **stdout**, no temp file |
| textconv | `primitives/apply-textconv.ts` | payload to a **temp file under `gitDir`**, path as `argv[1]`, result on **stdout**, `finally` cleanup |
| merge driver | `primitives/run-merge-driver.ts` | three temp files, placeholder substitution, result read back from the `%A` file |

A GPG signer follows the **same resolve-program-from-config → invoke** shape. As
the pinned matrix (§Design) shows, signing spans **two** of these contracts at
once: `gpg`/`gpgsm` are stdin→stdout (like the filter driver); `ssh-keygen` is
temp-file-in → `<file>.sig`-out (a fourth contract, close to textconv/merge).

**The tag object carries a faithfulness trap.** `src/domain/objects/tag.ts`
models `gpgSignature` as a `gpgsig` **header** (`serializeTagContent`,
`tag.ts:143-145`) — the same shape as a commit. That is **wrong for tags** (pinned
below: git appends the signature to the tag *message body*, never as a header).
The field is effectively dead / actively misleading for signing (§Design, T-pins).

**Annotated tags are not created today.** `tagCreate`
(`src/application/commands/tag.ts:63`) only writes a **lightweight** tag —
`updateRef` pointing straight at the target OID. There is no `create-tag`
primitive, no tagger/message capture, no tag-object write anywhere in the
application tier (only `serializeTagContent` in the domain, reachable via reads).
Signed tags (`tag -s`) are inherently **annotated** — so 25.2 must build the
annotated-tag creation path before it can sign one (scope decision D8).

**Signing config is entirely unparsed.** `readConfig`
(`src/application/primitives/config-read.ts`) parses **only** `[user] name/email`
(`config-read.ts:1108` `mergeUser`) and `[remote]` url/pushUrl/fetch. None of
`user.signingkey`, `commit.gpgsign`, `tag.gpgSign`, `push.gpgSign`, `gpg.format`,
`gpg.program`, `gpg.ssh.program`, `gpg.x509.program` is parsed — all are new.

**Signed push does not exist.** `src/application/commands/push.ts` has no
`--signed` / push-certificate / nonce path (clean grep: zero hits for
`signed`/`push-cert`/`nonce`/`certificate`).

### Constraining decisions (FIXED — not re-litigated)

| Source | Binding constraint |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Object SHAs, ref/reflog contents, on-disk state, refusal conditions match canonical `git` **byte-for-byte**. Every pin below is against real `git 2.55.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, a throwaway `GNUPGHOME`, in a `mktemp -d`; each becomes a `test/integration/*-interop.test.ts` case. |
| ADR-249 (structured-data-only) | The signer yields the **armored signature bytes** and the surfaces yield structured results (`CommitResult`, a tag result, a push report); no rendered-text knobs, no pre-rendered `error: gpg failed…` string. git's stderr is reconstructed **in the interop test** from the structured error, not emitted by the library. |
| CLAUDE.md (hexagonal) | `repository → commands → primitives → domain`; the signing **port interface** lives in `src/ports`, process-spawn in `src/adapters/node`, the domain stays platform-free. Reuse `CommandRunner` (ADR-407) unless a dedicated port earns its place (D1). |
| ADR-407 / ADR-408 (driver ports) | An external program invoked from config is the same trust model as merge/textconv/filter drivers and hooks; off-node (no runner) **falls back inertly** — but for *signing* "inert" must be a faithful **refusal**, not a silent unsigned write (D5, pinned F-pins). |
| ADR-435–438 (SSH transport) | Precedent for a new-external-program surface: thin platform spawner in an adapter, all faithfulness logic pure and tested once, browser inert via an absent optional `Context` field, a typed refusal taxonomy. |

Prior-art docs mirrored for structure: `docs/design/ssh-transport.md` (new
external-program surface, browser-inert, pinned invocation matrix) and
`docs/design/lfs-filter-driver-port.md` (the `CommandRunner`-based driver port,
dual output conventions on one port, ADR-406–408).

## Requirements

When this ships, all of the following are verifiable:

1. `commit` with `-S` (or `commit.gpgsign=true`) produces a commit object
   **byte-identical** to canonical `git`: `gpgsig` continuation header placed
   immediately after `committer`, continuation lines space-prefixed, and the
   commit **SHA computed over the signed object** (R-C1/C2).
2. The **signed payload** git feeds the signer is the commit content **without**
   the `gpgsig` header — i.e. exactly `serializeCommitContent` of the unsigned
   `CommitData` (R-C3).
3. `tag` with `-s` (or `tag.gpgSign=true`) produces an **annotated** tag object
   whose armored signature is **appended to the message body** (never a header),
   byte-identical to git; the signed payload is the unsigned tag object ending in
   `<message>\n` (R-T1/T2). Building the annotated tag object (tagger, message,
   object/type) is included since it does not exist yet.
4. Signature **placement is format-independent**: OpenPGP and SSH (both pinned)
   use the `gpgsig` header for commits and the body-append for tags; only the
   armor block content differs (`-----BEGIN PGP SIGNATURE-----` vs
   `-----BEGIN SSH SIGNATURE-----`). x509/gpgsm is expected to follow the same
   placement, but its armor literal is **not pinned here** (deferred, D2).
5. Program **resolution honours git's order**: `gpg.format` selects the family
   (`openpgp`→`gpg.program`||`gpg`; `ssh`→`gpg.ssh.program`||`ssh-keygen`;
   `x509`→`gpg.x509.program`||`gpgsm`); `user.signingkey` selects the key; a
   per-invocation `-S<keyid>` overrides config (R-X).
6. The **execution contract per family is faithful**: `gpg`/`gpgsm` receive the
   payload on **stdin** and the armor on **stdout** (`--status-fd=2 -bsau <key>`);
   `ssh-keygen` receives the payload as a **temp-file argument** and the armor
   from `<file>.sig` (`-Y sign -n git -f <key> <file>`) (R-X, pinned X-matrix).
7. **Signing failure is fatal and atomic**: a signer that is absent, exits
   non-zero, or emits no valid signature **refuses the whole operation** — no
   object written, no ref moved, no reflog entry — reproducing git's
   `error: gpg failed to sign the data` / `fatal` (a **typed** structured error;
   no rendered string) (R-F1).
8. **Off-node (browser / no `ctx.command`) with signing requested refuses**
   faithfully (a typed error), and never silently produces an unsigned object
   (R-F2, D5).
9. The **default (unsigned) path is byte- and cost-identical to today**: no
   signer is resolved, no config beyond `[user]` is read, `commit`/`tag` behave
   exactly as before when signing is neither requested nor configured.
10. Signed push (`push --signed`) is **either** faithful to the pinned
    push-certificate wire format **or** explicitly deferred (D3); if deferred,
    requesting it refuses with a typed error rather than pushing unsigned.

## Design

### Pinned faithfulness matrix (canonical `git 2.55.0`)

Pinned in a `mktemp -d` throwaway: isolated `HOME`, throwaway `GNUPGHOME`,
`GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, fixed author/committer dates. A
recorder script installed via `gpg.program` / `gpg.ssh.program` /
`gpg.x509.program` (and a `--receive-pack` wrapper for push) captured the exact
argv, stdin payload, and object bytes. Every row becomes an interop assertion.

**C — signed commit object (all formats).** The signature is a `gpgsig`
continuation header after `committer`; the object SHA is computed over it.

```
tree <sha>
parent <sha>*
author  <ident> <ts> <tz>
committer <ident> <ts> <tz>
gpgsig -----BEGIN PGP SIGNATURE-----
 <blank>
 <base64…>
 -----END PGP SIGNATURE-----

<message>
```

- Continuation lines are space-prefixed (` `); the armor's interior blank line
  becomes a lone ` `. This is exactly `formatContinuationHeader`'s output.
- **Signed payload** = the object **without** `gpgsig` (pinned by capturing the
  stdin git fed to the signer):
  ```
  tree …\nparent …\nauthor …\ncommitter …\n\n<message>
  ```
  ≡ `serializeCommitContent(unsigned CommitData)`.
- SSH commits and x509 commits use the **same** `gpgsig` header placement — only
  the armor block header changes (`-----BEGIN SSH SIGNATURE-----`, etc.).

**T — signed annotated tag object (all formats). THE TRAP.** The signature is
**appended to the message body**, NOT a header:

```
object <sha>
type <type>
tag <name>
tagger <ident> <ts> <tz>

<message>
-----BEGIN PGP SIGNATURE-----

<base64…>
-----END PGP SIGNATURE-----
```

- **Signed payload** = the unsigned tag object, ending in `<message>\n` (pinned
  from captured stdin):
  ```
  object …\ntype …\ntag …\ntagger …\n\n<message>\n
  ```
- **Final object** = payload **concatenated** with the armor block; the armor
  ends with a single trailing `\n` and is the last thing in the object (pinned:
  final 30 bytes = `…-----END PGP SIGNATURE-----\n`).
- Format-independent: SSH/x509 tags append their armor to the body identically.
- **Consequence:** `serializeTagContent`'s `gpgsig`-header branch
  (`tag.ts:143-145`) is **not** git's tag encoding and must not be used for
  signing. D7 chooses how the domain model represents the body-appended armor.

**X — signer invocation and execution contract (per `gpg.format`).**

| `gpg.format` | program (config key ‖ default) | argv | payload in | armor out |
|---|---|---|---|---|
| `openpgp` (default) | `gpg.program` ‖ `gpg` | `--status-fd=2 -bsau <keyid>` | **stdin** | **stdout** |
| `x509` | `gpg.x509.program` ‖ `gpgsm` | `--status-fd=2 -bsau <keyid>` | **stdin** | **stdout** |
| `ssh` | `gpg.ssh.program` ‖ `ssh-keygen` | `-Y sign -n git -f <keyfile> <payload-tempfile>` | **temp-file arg** | **`<payload-tempfile>.sig`** |

- The `-u <selector>` for openpgp/x509 is `user.signingkey` when set, else the
  **committer identity string** `Name <email>` (pinned: with no `user.signingkey`,
  git's argv was `--status-fd=2 -bsau Test Signer <signer@example.com>` — it never
  omits `-u`, it falls back to the committer ident). A per-invocation `-S<keyid>`
  overrides `user.signingkey`.
- For ssh, `user.signingkey` is a **key file path** (or a literal key blob git
  writes to a temp file); the signer writes the payload to a buffer file
  (git uses `<tmp>/.git_signing_buffer_tmpXXXX`) and reads `<file>.sig` back.
- git detects success by parsing `[GNUPG:] SIG_CREATED` from the program's
  **status-fd (fd 2 / stderr)** *and* a zero exit. tsgit's minimal faithful
  detector is exit-0 **plus** a well-formed armor block on the output; whether to
  also parse the status line is D4.

**F — failure and off-node semantics.**

| # | Situation | git outcome |
|---|---|---|
| F1 | `gpg.program` fails / is absent, `commit -S` | stderr `error: gpg failed to sign the data:` then `fatal: failed to write commit object`; **exit 128**; **nothing committed** (HEAD unchanged) |
| F2 | same for `tag -s` | symmetric fatal; **no tag object, no ref** |
| F3 | off-node (no signer available) | tsgit-specific: must **refuse** with a typed error (git always has a signer; the faithful analog off-node is a refusal, not a silent unsigned write) |

**P — signed-push certificate wire format** (pinned by recording the
`receive-pack` stdin over the file transport, `receive.certNonceSeed` set on the
bare repo). Sent in place of the normal command list, framed in pkt-lines:

```
push-cert\0<capabilities>              ← opens the cert (NUL-separated caps)
certificate version 0.1
pusher <ident> <ts> <tz>
pushee <remote-url>
nonce <nonce-from-server-advertisement>
<blank>
<old-oid> <new-oid> <refname>          ← one line per pushed ref
-----BEGIN PGP SIGNATURE-----
<armor…>
-----END PGP SIGNATURE-----
push-cert-end
0000
```

- The **signed payload** = `certificate version 0.1` through the last ref-update
  line, inclusive of the trailing `\n` (everything before the armor and
  `push-cert-end`).
- The **nonce** is issued by the server in its receive-pack advertisement
  (`push-cert=<nonce>` capability, derived from `receive.certNonceSeed`) and must
  be echoed verbatim — a nonce handshake the current push path does not perform.
- This couples signing to push negotiation and the advertised-capability parse;
  see D3 for whether it ships in v1.

### Component shape

Faithfulness-bearing logic lives in the **pure application/domain tier** and is
tested once; the platform adapter is a dumb spawner (SSH-transport idiom).

**Domain (`src/domain/objects/`).** The signed-payload builders are pure:
- Commit: reuse `serializeCommitContent(unsigned CommitData)` verbatim as the
  payload; the existing `gpgsig` header path already renders the final object.
- Tag: a faithful `serializeTagContent` that **appends** the armor to the body
  (D7). Whichever representation D7 picks, the *unsigned payload* builder
  (object/type/tag/tagger/blank/`message\n`) is new and pure.

**Config (`src/application/primitives/config-read.ts`).** `ParsedConfig` gains:
```
user?:   { …, signingkey?: string }
commit?: { gpgsign?: boolean }
tag?:    { gpgSign?: boolean }
push?:   { gpgSign?: 'true' | 'false' | 'if-asked' }   // git's tri-state
gpg?:    { format?: 'openpgp' | 'ssh' | 'x509';
           program?: string; ssh?: { program?: string }; x509?: { program?: string } }
```
All boolean/enum keys are read local-only (repo memory: `readConfig` is
local-only). New `merge*` arms in `dispatchSection`, mirroring `mergeUser`.

**Port + adapter (D1).** The signer needs stdin, stdout capture, and — for the
ssh family — a temp-file + `.sig` read. `CommandRunner` already carries stdin and
stdout capture; the ssh temp-file dance is expressible in a primitive exactly as
`apply-textconv` does. So reuse is mechanically possible (D1=reuse). The
alternative is a dedicated `Signer` port (`sign(payload, keySpec) => armor`) whose
adapter hides the per-family mechanics (D1=new port). D1 is surfaced, not decided.

**Primitive (`src/application/primitives/sign-payload.ts`, new).** Resolves the
family from `gpg.format`, builds argv + key spec, runs via the chosen seam, and
returns the armor bytes or a typed failure:
```
signPayload(ctx, payload: Uint8Array, keyOverride?: string)
  => { ok: true; armor: string } | { ok: false; reason }   // CQS query; caller refuses
```
- openpgp/x509: `runner.run({ command: `${program} --status-fd=2 -bsau ${key}`,
  stdin: payload, … })`; armor = `result.stdout`; success = exit 0 ∧ well-formed
  armor (D4).
- ssh: write `payload` to a temp file under `gitDir` (mirroring `apply-textconv`),
  run `${program} -Y sign -n git -f ${key} ${tmp}`, read `${tmp}.sig` via
  `ctx.fs`, `finally`-cleanup both files.
- No signer (`ctx.command === undefined`) or failure → `{ ok: false }`; the
  **caller** turns that into the atomic refusal (F1/F3), so no partial write.

### Commit signing flow (and the validator conflict — D6)

`commit` (`commands/commit.ts:131`) builds `commitData` (unsigned) and calls
`createCommit`. Signing is on when the new `opts.sign` (`-S`) is set, **or**
`commit.gpgsign=true` and `opts.sign` is not explicitly `false` (git's
`--no-gpg-sign` overrides the config — a tri-state `undefined`/`true`/`false`, not
a bare boolean). When on, the signed flow inserts, **before** the `createCommit`
call:
1. `payload = serializeCommitContent({ …commitData, gpgSignature: undefined })`.
2. `sig = await signPayload(ctx, payload, opts.signKey)`; on `!sig.ok` → **throw**
   a typed `SIGNING_FAILED` error (nothing written — the SHA-bearing `writeObject`
   never runs).
3. `createCommit(ctx, { …commitData, gpgSignature: sig.armor })` — the header path
   at `commit.ts:131-133` renders the final object; `writeObject` computes the SHA
   over the signed bytes.

**D6 — validator conflict (load-bearing, discovered):** `createCommit` runs
`hasHeaderInjectionChars(input.gpgSignature)` (`create-commit.ts:32`;
predicate `validators.ts:61`). That guard returns `true` for any value containing
`\n\n`, or a leading/trailing `\n`. **A genuine OpenPGP armor contains both** — a
blank line after `-----BEGIN PGP SIGNATURE-----` (`\n\n`) and a trailing `\n`. So
`createCommit` **as written rejects every real signature** with
`REASON_GPG_SIGNATURE_INJECTION`. The guard's own comment concedes the
continuation encoder space-prefixes interior LFs (making them safe); the `\n\n`
and trailing-`\n` rejections are conservative defense-in-depth that, for a
**self-produced** signature routed through `formatContinuationHeader`, block a
legitimate value. D6 chooses the resolution (narrow the guard for signatures vs a
trusted internal write path vs normalise the armor); it must be resolved or the
implement phase cannot pass a real signature through `createCommit`.

### Tag signing flow (annotated creation + body-append — D7, D8)

Because annotated tags are not created today (D8), the signed-tag path is:
1. Resolve the tagged object (`tagCreate`'s target resolution already exists,
   `tag.ts:66-69`) and its `type`.
2. Build the **unsigned annotated tag payload**: `object`/`type`/`tag`/`tagger`
   (identity from `[user]`, timestamp), blank line, `<message>\n`.
3. `sig = signPayload(ctx, payload, key)`; `!sig.ok` → **throw** (no object, no
   ref).
4. **Append** the armor to the body per T-pins, serialize the final tag object,
   `writeObject`, then `updateRef` to the tag object OID (annotated), not the
   target (lightweight).

**D7 — how the domain models the body-appended armor:** (a) fold the armor into
`TagData.message` (`message = plainMessage + '\n' + armor`) and stop using the
`gpgSignature` header field; (b) redesign `serializeTagContent` so a set
`gpgSignature` is **appended to the body** (faithful placement) and make
`parseTagContent` peel a trailing armor back out; (c) a dedicated signed-tag
serializer in the primitive. D7 is surfaced. **D8 — scope of tag work:** signed
tags require the annotated-tag creation path; either build `tag -a` (annotated,
unsigned) + `-s` together in 25.2, or treat annotated creation as a prerequisite
carved out first. Surfaced, not decided.

### Signed push (D3)

The pinned P-matrix shows signed push needs: parse the server's advertised
`push-cert=<nonce>` capability; build the version-0.1 certificate body
(pusher/pushee/nonce/ref-updates); `signPayload` it; emit the
`push-cert\0<caps>` … `push-cert-end` pkt-line envelope in place of the command
list. This couples to `push.ts`'s negotiation and the advertisement parser — a
materially larger surface than commit/tag. D3 chooses: defer (recommended;
land commit+tag now, `push --signed` refuses with a typed error until a follow-up)
vs include in v1. The `signPayload` primitive is shaped so push can adopt it
unchanged when it lands.

### Failure and off-node semantics (D4, D5)

- A signing failure (`!sig.ok`: absent runner, non-zero exit, or malformed armor)
  makes the **caller** throw a typed `SIGNING_FAILED` structured error **before**
  any object/ref write — reproducing git's atomic refusal (F1/F2). No reflog, no
  `MERGE_HEAD` churn, no partial index.
- **D5 — off-node:** with `ctx.command === undefined` and signing requested, the
  recommended behaviour is the **same hard refusal** (a repo cannot be faithfully
  produced unsigned when the user asked for a signature); the alternative (silently
  skip signing) diverges from git and is called out as rejected. Surfaced.
- **D4 — success detection / stderr:** git parses `SIG_CREATED` from the signer's
  status-fd (fd 2). tsgit's `CommandRunner` captures stdout but not stderr.
  Option (a): rely on exit-0 + well-formed armor on stdout (no port change);
  option (b): extend `CommandRunner`/`CommandResult` with captured `stderr` and
  parse the status line for exact parity. Surfaced.

### Faithfulness scope note

Per ADR-249, faithfulness binds the **object bytes, SHAs, refs, and refusal
conditions** — all pinned above and interop-tested. The signer **argv** is a
delegation detail (not a git wire artifact) but is pinned and tested anyway
because a wrong argv changes *whether a valid signature is produced at all* and
*which key signs* — correctness- and security-load-bearing.

## Decision candidates

The user decides each in the ADR phase; the designer only recommends.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Signer abstraction | (a) **Reuse `CommandRunner`** — resolve program from config, invoke; ssh temp-file dance in the primitive (à la `apply-textconv`). (b) **New dedicated `Signer` port** (`sign(payload, keySpec) => armor`); adapter hides per-family mechanics. (c) Reuse `CommandRunner` but add a `stderr` capture field. | **(a)** | `CommandRunner` already carries stdin + stdout capture (ADR-407) and is the established filter-driver precedent that postdates the backlog's "new port" wording; the three execution contracts (gpg stdin/stdout, gpgsm stdin/stdout, ssh tempfile+`.sig`) are all expressible in a pure primitive. (b) is cleaner if D4=(b) or D2 grows many families; (c) is the middle path if only stderr parsing is missing. |
| D2 | Signing-format scope for v1 | (a) **OpenPGP only** (`gpg`). (b) **OpenPGP + SSH** (`gpg` + `ssh-keygen`). (c) All three (+ `x509`/`gpgsm`). | **(b)** | OpenPGP is the default and highest-value; SSH signing is topical now that SSH transport (25.1) just landed and its exec contract is fully pinned here. x509/gpgsm is niche and adds a third contract for little demand — best as a follow-up. The format is a pinned enum, so adding x509 later is additive. |
| D3 | Signed-push scope | (a) **Defer** push certificates to a follow-up; land commit+tag now; `push --signed` refuses with a typed error. (b) **Include** the push-cert nonce handshake + envelope in v1. | **(a)** | Push certs are wire-protocol-coupled (nonce advertisement parse, cert envelope, receive-pack coupling) — a materially larger surface than the object-local commit/tag signing. The P-matrix is pinned so the follow-up starts from a firm spec, and `signPayload` is shaped to be reused unchanged. |
| D4 | Signing success detection / `CommandRunner` stderr | (a) **exit-0 + well-formed armor** on stdout; no port change. (b) **Extend the port with captured `stderr`** and parse git's `SIG_CREATED` status line for exact parity. (c) exit-0 only (trust the program). | **(a)** | Exit code plus a validated armor block is a faithful, minimal detector that needs no port change; git's `SIG_CREATED` parse is belt-and-braces the armor check already approximates. (b) if a family emits exit-0 with no usable signature; (c) is too lax (an empty stdout would pass). |
| D5 | Off-node (browser / no `ctx.command`) when signing is requested | (a) **Hard-refuse** with a typed error (no unsigned write). (b) **Silently skip** signing and write unsigned. (c) Refuse only in-browser; elsewhere fall back. | **(a)** | git never silently drops a requested signature; producing an unsigned object when the user asked for a signed one is a faithfulness *and* security divergence. Mirrors ADR-438's typed-refusal taxonomy. (b) is explicitly rejected; (c) adds runtime-sniffing complexity for no faithful gain. |
| D6 | Let a genuine armor through `createCommit`'s injection guard | (a) **Narrow `hasHeaderInjectionChars` for the signature** to reject only NUL/CR (the continuation encoder space-prefixes interior/leading/trailing LFs, neutralising boundary smuggle). (b) **Trusted internal write path** for signed commits that bypasses the `gpgSignature` guard (build `Commit` + `writeObject` directly), keeping the guard for external `extraHeaders`. (c) **Normalise the armor** (strip the trailing `\n`, keep interior) before passing it. | **(a)** | The guard's own comment concedes interior LFs are made safe by `formatContinuationHeader`; for a self-produced, continuation-encoded signature the `\n\n`/trailing-`\n` rejections are false positives. Narrowing to NUL/CR is faithful and preserves the real defense. (b) is safest if the guard must stay untouched for `extraHeaders`; (c) risks a byte-mismatch vs git's stored armor. **Must** be resolved — otherwise no real signature can be stored. |
| D7 | Domain model for the body-appended tag signature | (a) **Fold the armor into `TagData.message`** (`message = plain + '\n' + armor`); deprecate the `gpgSignature` header field for tags. (b) **Redesign `serializeTagContent`** to append a set `gpgSignature` to the body (faithful placement) and teach `parseTagContent` to peel it. (c) **Dedicated signed-tag serializer** in the primitive; leave the domain object untouched. | **(b)** | The current `gpgsig`-header path (`tag.ts:143-145`) is a latent faithfulness bug — a tag with `gpgSignature` set serialises to bytes git never produces. (b) fixes the object model at its root and keeps parse/serialize a faithful round-trip pair (property-test lens). (a) conflates message and signature; (c) leaves the misleading header field live. |
| D8 | Scope of tag-object work in 25.2 | (a) **Build annotated tag creation (`tag -a`) + signing (`-s`) together** in 25.2. (b) **Carve annotated creation out first** as a prerequisite, then sign. (c) Sign only, assuming annotated creation lands elsewhere. | **(a)** | Signed tags are inherently annotated and no annotated-creation path exists (`tagCreate` is lightweight-only, `tag.ts:63`); the tagger/message/object-write machinery is a hard dependency of `-s`, so bundling them is the smallest coherent deliverable. (b) is fine if the plan prefers two commits; (c) is impossible today. |

## Test strategy

- **Unit (pure, 100% + mutation):**
  - `sign-payload` over a fake `CommandRunner`: openpgp/x509 stdin→stdout happy
    path (armor returned); ssh temp-file → `.sig` read path (assert temp file
    written, `.sig` read, both cleaned in `finally`); non-zero exit → `{ok:false}`;
    absent runner → `{ok:false}`; malformed/empty stdout → `{ok:false}` (D4). Abort
    threads through. Error/branch assertions specific (code + reason, per the
    mutation-resistant convention).
  - Config parse: each new key (`user.signingkey`, `commit.gpgsign`,
    `tag.gpgSign`, `push.gpgSign` tri-state, `gpg.format`, `gpg.program`,
    `gpg.ssh.program`, `gpg.x509.program`); default/absent → today's behaviour.
  - Tag payload builder + `serializeTagContent`/`parseTagContent` **round-trip**
    (property lens, per the parser/serializer rule): `parse(serialize(x)) ≡ x` for
    a signed tag (armor appended to body), and the count invariant (one appended
    armor ↔ one peeled signature). Example tests pin the literal git bytes from the
    T-matrix.
  - `hasHeaderInjectionChars` post-D6: a real armored signature passes; NUL/CR
    still rejected; isolated guard tests per rejected char class.
- **Integration (node):** a fake signer installed via `gpg.program` /
  `gpg.ssh.program` (a script that returns a canned armor / a failing script)
  drives `commit -S` and `tag -s`; assert object bytes, SHA, ref/reflog, and the
  atomic refusal on failure (nothing written). Reuses the interop env hardening
  (scrubbed `GIT_*`, isolated `HOME`).
- **Interop (`test/integration/*-interop.test.ts`, the faithfulness gate):**
  twin real-`git` vs tsgit in a `mktemp -d` with a throwaway `GNUPGHOME` + a
  generated unprotected key; **skipIf** signer unavailable; one shared `beforeAll`;
  60s timeout (interop load→validate flake note). Pin: C (signed commit object +
  SHA + no-gpgsig payload), T (signed tag body-append + payload), X (ssh vs gpg
  argv + contract), F1/F2 (failure refusal — reconstruct git's stderr from the
  structured error per ADR-249, do **not** byte-match stderr). Because signatures
  are non-deterministic, assert the **structural** object shape (header placement,
  SHA over reconstructed bytes with a fixed canned signature via the fake signer)
  rather than a frozen golden SHA for the real-gpg path.
- **Cross-adapter parity:** memory/browser (no `ctx.command`) with signing
  requested → the typed refusal (D5); parity is cross-adapter only and does **not**
  prove faithfulness (the interop files do).
- **Browser (playwright surface):** `commit -S` / `tag -s` raise the inert
  refusal; extend the browser-surface audit.

## Out of scope

- **Signature verification** — `--verify`, `%G?`/`%GK`/`%GS` pretty tokens,
  `gpg.ssh.allowedSignersFile`, trust evaluation. Read-side; a separate follow-up.
  This backlog is produce-side only.
- **Signed push / push certificates** — deferred per D3 (recommended); the
  P-matrix is pinned so the follow-up starts firm. If D3=(b) it moves in-scope.
- **x509 / `gpgsm`** — deferred per D2 (recommended); the enum + contract are
  pinned (same as `gpg`), so it is additive later.
- **`gpg-agent` / key management / passphrase prompting / pinentry** — fully
  delegated to the spawned signer (git's model); tsgit parses no keys and drives
  no agent, exactly as SSH transport delegates to `ssh`.
- **`ssh-keygen` allowed-signers / principals beyond `-n git`** — verification-side.
- **The unrelated housekeeping edit** moving backlog item 25.1a into the Parking
  lot section is a docs/backlog-only change handled at the implement/docs phase,
  not a design concern (noted, not designed).
