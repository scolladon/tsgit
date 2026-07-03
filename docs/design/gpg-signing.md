# Design — GPG signing (produce side)

> Brief (backlog 25.2): a signing capability for the **produce** side — signed
> commits (`commit -S` / `commit.gpgsign`), signed annotated tags (`tag -s` /
> `tag.gpgSign`), and signed pushes (`push --signed` / `push.gpgSign`). The read
> side (verification: `--verify`, `%G?`/`%GK`/`%GS`, `allowedSignersFile`) already
> partially exists on the object model and is **not** in this backlog. Signature
> transport is delegated to the system signing program (`gpg` / `ssh-keygen`),
> exactly as canonical git delegates it. Sibling 25.1 (SSH transport) just landed
> and is the structural precedent for a new external-program surface.
> Status: draft → self-reviewed ×3 → accepted → **revised against ADRs 442–449**.

> **Revision note.** The eight load-bearing choices below were ratified as
> **ADR-442…449** and are no longer open candidates. Seven adopted the design's
> recommendation; **ADR-444 deviates** — signed push (push certificates) is now
> **in scope for v1**, not deferred. This revision folds that expansion in: the
> signed-push section is a full design (not a deferral), and every other section
> is reconciled to its ADR. The ratified decisions are summarised in
> §Ratified decisions.

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

A GPG signer follows the **same resolve-program-from-config → invoke** shape, and
**ADR-442 ratifies reusing `CommandRunner`** rather than adding a `Signer` port. As
the pinned matrix (§Design) shows, signing spans **two** of these contracts at
once: `gpg` is stdin→stdout (like the filter driver); `ssh-keygen` is
temp-file-in → `<file>.sig`-out (close to textconv/merge).

**The tag object carries a faithfulness trap.** `src/domain/objects/tag.ts`
models `gpgSignature` as a `gpgsig` **header** (`serializeTagContent`,
`tag.ts:143-145`) — the same shape as a commit. That is **wrong for tags** (pinned
below: git appends the signature to the tag *message body*, never as a header).
**ADR-448** removes that header path and redesigns serialize/parse as a
body-append round-trip pair.

**Annotated tags are not created today.** `tagCreate`
(`src/application/commands/tag.ts:63`) only writes a **lightweight** tag —
`updateRef` pointing straight at the target OID. There is no `create-tag`
primitive, no tagger/message capture, no tag-object write anywhere in the
application tier (only `serializeTagContent` in the domain, reachable via reads).
Signed tags (`tag -s`) are inherently **annotated** — **ADR-449** builds the
annotated-tag creation path in this item, sequenced as its own part(s) before the
signing part.

**Signing config is entirely unparsed.** `readConfig`
(`src/application/primitives/config-read.ts`) parses **only** `[user] name/email`
(`config-read.ts:1108` `mergeUser`) and `[remote]` url/pushUrl/fetch. None of
`user.signingkey`, `commit.gpgsign`, `tag.gpgSign`, `push.gpgSign`, `gpg.format`,
`gpg.program`, `gpg.ssh.program` is parsed — all are new.

**Signed push does not exist, but the seam is precise.**
`src/application/commands/push.ts` has no `--signed` / push-certificate / nonce
path (clean grep: zero hits for `signed`/`push-cert`/`nonce`/`certificate`). The
exact injection points are identified in §Signed push: the advertisement parse
(`push.ts:115`), capability selection (`selectPushCapabilities`,
`receive-pack-client.ts:33`), and request construction (`sendUpdates`,
`push.ts:296` → `buildReceivePackRequest`, `receive-pack.ts:37`).

### Constraining decisions (FIXED — not re-litigated)

| Source | Binding constraint |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Object SHAs, ref/reflog contents, on-disk state, refusal conditions, **and the push-cert wire bytes** match canonical `git` **byte-for-byte**. Every pin below is against real `git 2.55.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, a throwaway `GNUPGHOME`, in a `mktemp -d`; each becomes a `test/integration/*-interop.test.ts` case. |
| ADR-249 (structured-data-only) | The signer yields the **armored signature bytes** and the surfaces yield structured results (`CommitResult`, a tag result, a `PushResult`); no rendered-text knobs, no pre-rendered `error: gpg failed…` string. git's stderr is reconstructed **in the interop test** from the structured error, not emitted by the library. |
| CLAUDE.md (hexagonal) | `repository → commands → primitives → domain`; process-spawn stays in `src/adapters/node`, the domain stays platform-free. |
| **ADR-442** (signer = CommandRunner) | The signer is a **pure application primitive** over the existing `CommandRunner` port — **no new port**. Off-node behaviour is governed by ADR-447. |
| **ADR-443** (formats) | v1 = `gpg.format` ∈ {`openpgp`, `ssh`}. `x509`/`gpgsm` is out; requesting it yields a **typed unsupported-format error**, never a silent fallback. `gpg.format` defaults to `openpgp`. |
| **ADR-444** (signed push in scope) | Push certificates ship in v1. The nonce handshake, envelope construction, and `push-cert` capability negotiation are all designed here and pinned below. |
| **ADR-445** (commit guard) | The `gpgSignature` injection guard is narrowed to reject **only NUL/CR**; the blank line + trailing newline that valid armor requires are permitted (the continuation encoder neutralises interior LFs). |
| **ADR-446** (success detection) | Signing success = **exit-0 ∧ well-formed armor block** on stdout. `CommandRunner` is **not** widened for stderr/`SIG_CREATED`. |
| **ADR-447** (off-node) | Signing requested with no `ctx.command` **hard-refuses** with a typed error; never a silent unsigned write. |
| **ADR-448** (tag body-append) | A tag's `gpgSignature` is **appended to the body** on serialize and **peeled** on parse — a round-trip pair; the `gpgsig`-header path is removed. |
| **ADR-449** (annotated creation) | Annotated-tag creation (`tag -a`) is a hard prerequisite delivered in this item, as its own TDD part(s) before signing. |
| ADR-434–441 (SSH transport) | Precedent for a new-external-program surface + the transport the push cert rides over `ssh://`; thin platform spawner in an adapter, faithfulness logic pure and tested once, browser inert via an absent optional `Context` field, a typed refusal taxonomy. |

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
   object/type) is included (ADR-449).
4. Signature **placement is format-independent**: OpenPGP and SSH (both pinned)
   use the `gpgsig` header for commits and the body-append for tags; only the
   armor block content differs (`-----BEGIN PGP SIGNATURE-----` vs
   `-----BEGIN SSH SIGNATURE-----`). `gpg.format=x509` is **rejected with a typed
   unsupported-format error** (ADR-443), not signed.
5. Program **resolution honours git's order**: `gpg.format` selects the family
   (`openpgp`→`gpg.program`‖`gpg`; `ssh`→`gpg.ssh.program`‖`ssh-keygen`);
   `user.signingkey` selects the key; a per-invocation `-S<keyid>` overrides
   config (R-X).
6. The **execution contract per family is faithful**: `gpg` receives the payload
   on **stdin** and the armor on **stdout** (`--status-fd=2 -bsau <key>`);
   `ssh-keygen` receives the payload as a **temp-file argument** and the armor
   from `<file>.sig` (`-Y sign -n git -f <key> <file>`) (R-X, pinned X-matrix).
7. **Signing failure is fatal and atomic**: a signer that is absent, exits
   non-zero, or emits no valid armor **refuses the whole operation** — no object
   written, no ref moved, no reflog entry — reproducing git's
   `error: gpg failed to sign the data` / `fatal` (a **typed** structured error;
   no rendered string) (R-F1, ADR-446).
8. **Off-node (browser / no `ctx.command`) with signing requested refuses**
   faithfully (a typed error), and never silently produces an unsigned object
   (R-F2, ADR-447).
9. The **default (unsigned) path is byte- and cost-identical to today**: no
   signer is resolved, no config beyond `[user]` is read, `commit`/`tag`/`push`
   behave exactly as before when signing is neither requested nor configured.
10. `push --signed` (or `push.gpgSign=true`) sends a **push certificate**
    byte-faithful to git's version-0.1 wire format (R-P1): the client parses the
    server-advertised `push-cert=<nonce>` capability, echoes the nonce verbatim,
    frames the pinned envelope in pkt-lines, and signs the pinned payload via the
    same `signPayload` primitive (ADR-442/444).
11. Push **negotiation is faithful** (R-P2): the client adds a bare `push-cert`
    token to the receive-pack capability list only when signing; the ref-update
    lines inside a signed cert carry **no** capability tail (caps ride the
    `push-cert\0…` opener instead). `--signed` against a server that does **not**
    advertise `push-cert` **refuses** (`the receiving end does not support
    --signed push`; nothing sent); `--signed=if-asked` / `push.gpgSign=if-asked`
    falls back to a normal **unsigned** push instead of refusing (R-P3, pinned).

## Design

### Pinned faithfulness matrix (canonical `git 2.55.0`)

Pinned in a `mktemp -d` throwaway: isolated `HOME`, throwaway `GNUPGHOME`,
`GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, fixed author/committer dates. A
recorder script installed via `gpg.program` / `gpg.ssh.program` captured the exact
argv + stdin; a `--receive-pack` wrapper `tee`d the receive-pack stdin to capture
the certificate bytes; `receive.certNonceSeed` on the bare server made it
advertise a nonce. Every row becomes an interop assertion.

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
- SSH commits use the **same** `gpgsig` header placement — only the armor block
  header changes (`-----BEGIN SSH SIGNATURE-----`).

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
- Format-independent: SSH tags append their armor to the body identically.
- **Consequence (ADR-448):** `serializeTagContent`'s `gpgsig`-header branch
  (`tag.ts:143-145`) is **not** git's tag encoding and is removed; serialize
  **appends** and parse **peels**.

**X — signer invocation and execution contract (per `gpg.format`).**

| `gpg.format` | program (config key ‖ default) | argv | payload in | armor out |
|---|---|---|---|---|
| `openpgp` (default) | `gpg.program` ‖ `gpg` | `--status-fd=2 -bsau <keyid>` | **stdin** | **stdout** |
| `ssh` | `gpg.ssh.program` ‖ `ssh-keygen` | `-Y sign -n git -f <keyfile> <payload-tempfile>` | **temp-file arg** | **`<payload-tempfile>.sig`** |
| `x509` | — (ADR-443: out of scope) | — | typed `UNSUPPORTED_SIGNING_FORMAT` refusal, no spawn | — |

- The `-u <selector>` for openpgp is `user.signingkey` when set, else the
  **committer identity string** `Name <email>` (pinned: with no `user.signingkey`,
  git's argv was `--status-fd=2 -bsau Test Signer <signer@example.com>` — it never
  omits `-u`, it falls back to the committer ident). A per-invocation `-S<keyid>`
  overrides `user.signingkey`.
- For ssh, `user.signingkey` is a **key file path** (or a literal key blob git
  writes to a temp file); the signer writes the payload to a buffer file
  (git uses `<tmp>/.git_signing_buffer_tmpXXXX`) and reads `<file>.sig` back.
- **Success detection (ADR-446):** exit 0 **and** a well-formed armor block
  (`-----BEGIN … SIGNATURE-----` … `-----END … SIGNATURE-----`) on the output.
  tsgit does **not** parse the `[GNUPG:] SIG_CREATED` status line; `CommandRunner`
  is left unwidened.

**F — failure and off-node semantics.**

| # | Situation | git outcome / tsgit-faithful analog |
|---|---|---|
| F1 | `gpg.program` fails / is absent, `commit -S` | git: stderr `error: gpg failed to sign the data:` then `fatal: failed to write commit object`; **exit 128**; **nothing committed** (HEAD unchanged). tsgit: typed `SIGNING_FAILED`, no object/ref/reflog write (ADR-446). |
| F2 | same for `tag -s` | symmetric fatal; **no tag object, no ref**. |
| F3 | off-node (no signer available), signing requested | tsgit-specific: **refuse** with a typed off-node error (ADR-447) — git always has a signer; the faithful analog off-node is a refusal, not a silent unsigned write. |

**P — signed-push certificate wire format (ADR-444, pinned byte-for-byte).**
Pinned by `tee`-capturing the `receive-pack` stdin over the local transport with
`receive.certNonceSeed` set. Sent in place of the normal command list.

*P.0 — nonce advertisement (server → client).* When `receive.certNonceSeed` is
set, the receive-pack ref advertisement's first-ref capability list carries
`push-cert=<nonce>` where `nonce = <unix-ts>-<40-hex-hmac>`, e.g.
`push-cert=1783074740-93c86f6a5e26b7182145edeab182347ba36c39ee`. Observed
alongside `atomic report-status-v2 side-band-64k quiet object-format=sha1
agent=git/2.55.0-Darwin`. Absent when the seed is unset (⇒ signed push refuses).

*P.1 — certificate envelope (client → server), each line its own pkt-line.*
Pinned example (`<len-prefix>` `payload`):

```
005e  push-cert\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.55.0-Darwin
001c  certificate version 0.1\n
002d  pusher 5763ECD93FFE5F79 1783074575 +0200\n
0056  pushee <anonymized-remote-url>\n
003e  nonce 1783074575-95af4e9c6ffb06f947a839725a37638bb13f649f\n
0005  \n                                              ← LF-only pkt = blank line
0066  <old-oid> <new-oid> refs/heads/main\n           ← one per ref; NO caps tail
0022  -----BEGIN PGP SIGNATURE-----\n
0005  \n
0045  <base64 armor line>\n                           ← armor body, one pkt per line
 …
0020  -----END PGP SIGNATURE-----\n
0012  push-cert-end\n
0000                                                  ← flush-pkt
PACK…                                                 ← packfile bytes follow
```

Load-bearing framing facts (all byte-verified):
- The **opener** `push-cert\0<caps>` has **NO trailing LF**; the capabilities
  follow the NUL with a **leading space** and are the *negotiated* caps (server ∩
  client), including a bare `push-cert` token (the nonce value is stripped — the
  opener sends `push-cert`, not `push-cert=<nonce>`).
- The **ref-update lines inside the cert carry NO capability tail** — unlike a
  normal push where the first ref-update line carries `\0<caps>`. In a signed
  push the caps ride the opener instead.
- The **blank line** and the armor's interior blank line are each an `0005`
  LF-only pkt-line.
- The cert is terminated by a `push-cert-end\n` pkt-line, then a flush-pkt
  `0000`, then the packfile bytes.

*P.2 — signed payload (fed to the signer on stdin, `-bsau <key>`)* = certificate
lines P.1#2–#7 as **raw text, no pkt framing**, inclusive of every trailing `\n`:

```
certificate version 0.1\n
pusher <selector> <ts> <tz>\n
pushee <anonymized-remote-url>\n
nonce <nonce>\n
\n
<old-oid> <new-oid> <refname>\n
```

- **`pusher` selector rule (pinned both cases):** `<selector>` =
  `get_signing_key()` = `user.signingkey` when set (e.g. the key id
  `5763ECD93FFE5F79`), else the committer identity string `Name <email>` (pinned:
  unset ⇒ `pusher Bob NoKey <bob@example.com> …`). **Identical fallback to the
  commit `-u` selector** in the X-matrix — one rule, two call sites.
- **`pushee`** = the remote URL after git's `transport_anonymize_url` (strips any
  `user:pass@` userinfo); for a plain path/https URL it is verbatim.
- The armor and the `push-cert\0…` opener are **not** in the signed payload.

*P.3 — negotiation refusal / if-asked (pinned).*

| Config / argv | Server advertises `push-cert`? | git outcome |
|---|---|---|
| `--signed` / `push.gpgSign=true` (required) | **yes** | build + send the cert (P.1) |
| `--signed` / `push.gpgSign=true` (required) | **no** | `fatal: the receiving end does not support --signed push` + `fatal: the remote end hung up unexpectedly`; **exit ≠ 0; nothing sent** |
| `--signed=if-asked` / `push.gpgSign=if-asked` | yes | build + send the cert |
| `--signed=if-asked` / `push.gpgSign=if-asked` | **no** | fall back to a **normal unsigned push**; exit 0; ref updated |
| `--no-signed` / `push.gpgSign=false` (default) | either | normal unsigned push |

### Component shape

Faithfulness-bearing logic lives in the **pure application/domain tier** and is
tested once; the platform adapter is a dumb spawner (SSH-transport idiom). No new
port (ADR-442).

**Domain (`src/domain/objects/`).** The signed-payload builders are pure:
- Commit: reuse `serializeCommitContent(unsigned CommitData)` verbatim as the
  payload; the existing `gpgsig` header path already renders the final object.
- Tag (ADR-448): `serializeTagContent` **appends** a set `gpgSignature` to the
  body and `parseTagContent` **peels** a trailing armor block back into
  `gpgSignature` — a round-trip pair, property-tested. The *unsigned payload*
  builder (object/type/tag/tagger/blank/`message\n`) is new and pure.

**Domain (`src/domain/protocol/`).** A new `buildSignedReceivePackRequest`
sibling to `buildReceivePackRequest` (`receive-pack.ts:37`) frames the P.1
envelope in pkt-lines and — crucially — routes ref-updates through a **no-caps**
variant of `updateLine` (`receive-pack.ts:32`), because the caps ride the opener.
A pure `buildPushCertPayload({ pusher, pushee, nonce, updates })` yields the P.2
bytes for the signer.

**Config (`src/application/primitives/config-read.ts`).** `ParsedConfig` gains:
```
user?:   { …, signingkey?: string }
commit?: { gpgsign?: boolean }
tag?:    { gpgSign?: boolean }
push?:   { gpgSign?: 'true' | 'false' | 'if-asked' }   // git's tri-state
gpg?:    { format?: 'openpgp' | 'ssh' | 'x509';        // x509 parsed, refused at use (ADR-443)
           program?: string; ssh?: { program?: string } }
```
All boolean/enum keys are read local-only (repo memory: `readConfig` is
local-only). New `merge*` arms in `dispatchSection`, mirroring `mergeUser`.

**Signer primitive (`src/application/primitives/sign-payload.ts`, new).** Resolves
the family from `gpg.format`, builds argv + key spec, invokes `ctx.command`
(`CommandRunner`, ADR-442), and returns the armor or a typed failure:
```
signPayload(ctx, payload: Uint8Array, keyOverride?: string)
  => { ok: true; armor: string } | { ok: false; reason }   // CQS query; caller refuses
```
- openpgp: `runner.run({ command: `${program} --status-fd=2 -bsau ${key}`,
  stdin: payload, … })`; armor = `result.stdout`; success = exit 0 ∧ well-formed
  armor (ADR-446).
- ssh: write `payload` to a temp file under `gitDir` (mirroring `apply-textconv`),
  run `${program} -Y sign -n git -f ${key} ${tmp}`, read `${tmp}.sig` via
  `ctx.fs`, `finally`-cleanup both files.
- `gpg.format=x509` → `{ ok: false, reason: UNSUPPORTED_SIGNING_FORMAT }` with no
  spawn (ADR-443).
- No signer (`ctx.command === undefined`) → `{ ok: false, reason: OFF_NODE }`
  (ADR-447). Non-zero exit / malformed armor → `{ ok: false }`. The **caller**
  turns any `!ok` into the atomic refusal, so no partial write.

### Commit signing flow (ADR-445)

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

**The injection-guard resolution (ADR-445):** `createCommit` runs
`hasHeaderInjectionChars(input.gpgSignature)` (`create-commit.ts:32`; predicate
`validators.ts:61`). As written it returns `true` for any value containing `\n\n`,
a leading `\n`, or a trailing `\n` — and **a genuine OpenPGP armor contains both**
(a blank line after `-----BEGIN PGP SIGNATURE-----` and a trailing `\n`), so it
rejects every real signature with `REASON_GPG_SIGNATURE_INJECTION`. ADR-445
**narrows the `gpgSignature` check to reject only NUL/CR** — the only characters
that can inject a spurious header once `formatContinuationHeader` space-prefixes
interior LFs. The narrowing is scoped to the `gpgSignature` field; author /
committer / message / `extraHeaders` keep their existing validation. Guard tests
per condition: NUL rejected, CR rejected, a real armor accepted.

### Tag signing flow (ADR-448 body-append + ADR-449 annotated creation)

Because annotated tags are not created today, the tag work is sequenced as
annotated-creation part(s) **before** the signing part (ADR-449). The signed-tag
path is:
1. Resolve the tagged object (`tagCreate`'s target resolution already exists,
   `tag.ts:66-69`) and its `type`.
2. Build the **unsigned annotated tag payload**: `object`/`type`/`tag`/`tagger`
   (identity from `[user]`, timestamp), blank line, `<message>\n`.
3. `sig = signPayload(ctx, payload, key)`; `!sig.ok` → **throw** (no object, no
   ref).
4. **Append** the armor to the body per T-pins (ADR-448), serialize the final tag
   object, `writeObject`, then `updateRef` to the tag object OID (annotated), not
   the target (lightweight).

The tag command exposes structured fields only (ADR-249) — no render options. The
`serializeTagContent`/`parseTagContent` redesign is a round-trip pair with a
`*.properties.test.ts` sibling (`parse(serialize(x)) ≡ x`; one appended armor ↔
one peeled signature).

### Signed push (ADR-444) — full design

Signed push is object-external: it couples signing to push negotiation and the
receive-pack wire. The signer (`signPayload`) is **reused unchanged** — the push
path adds only envelope construction + capability wiring. The certificate is a
plain request-body byte string, so it is **transport-agnostic**: it rides
smart-HTTP (`createHttpSession`) and `ssh://` (`SshGitServiceSession`, ADR-434)
identically through `session.exchange` (`git-service-session.ts:157/104`).

**Surface.** `PushOptions` (`push.ts:50`) gains
`readonly signed?: 'yes' | 'no' | 'if-asked'` (git's `--signed` /
`--no-signed` / `--signed=if-asked`). Effective mode = `opts.signed` when set,
else `push.gpgSign` from config (tri-state, §Config), else `'no'`.

**Wiring seam (exact).**
1. **Advertisement + nonce parse** — `negotiateAndSend` (`push.ts:107`) already
   fetches `adv` via `discoverReceivePackRefs(session)` (`push.ts:115`);
   `adv.capabilities` (`parseAdvertisedRefs`, `upload-pack.ts:247` →
   `parseCapabilities`, `capabilities.ts:37`) now also carries `push-cert=<nonce>`
   when advertised. Extract the nonce (the token after `push-cert=`) in
   `sendUpdates` (`push.ts:296`).
2. **Mode resolution / refusal (P.3)** — before building the request: if mode is
   `yes` (required) and no `push-cert` cap is advertised → **throw** a typed
   `SIGNED_PUSH_UNSUPPORTED` error (git's `the receiving end does not support
   --signed push`), nothing sent. If mode is `if-asked` and unadvertised → fall
   through to the existing **unsigned** path (`buildReceivePackRequest`). Off-node
   with mode ≠ `no` → ADR-447 hard-refuse.
3. **Capability selection** — `selectPushCapabilities` (`receive-pack-client.ts:33`,
   intersecting `CLIENT_CAPABILITIES_PUSH` `capabilities.ts:17`) gains a bare
   `push-cert` in `clientWants` **only when signing** and only when the server
   advertised it; the opener sends the bare token (nonce stripped).
4. **Envelope + payload construction** — `buildPushCertPayload` yields the P.2
   bytes; `signPayload(ctx, payload)` (ADR-442) signs them; the pusher selector is
   `user.signingkey ?? committerIdent` (P.2 rule); `pushee` is the anonymized
   remote URL. `buildSignedReceivePackRequest` frames the P.1 pkt-lines (opener
   with negotiated caps, no-caps ref-update lines, armor lines, `push-cert-end`,
   flush) and appends the packfile — replacing the `buildReceivePackRequest` call
   at `push.ts:312` when signing.
5. **Send / report** — unchanged: `session.exchange(requestBody)` (`push.ts:317`)
   and `parseReceivePackResponse` (`receive-pack.ts:83`); `report-status` /
   side-band handling is untouched.

**Config `push.gpgSign` semantics (git tri-state).** `true` ⇒ required (refuse if
unadvertised); `false` ⇒ never sign (default); `if-asked` ⇒ sign iff the server
advertises `push-cert`, else unsigned. `--signed`/`--no-signed`/`--signed=if-asked`
override the config per-invocation.

### Failure and off-node semantics (ADR-446, ADR-447)

- A signing failure (`!sig.ok`: absent runner, non-zero exit, malformed armor,
  unsupported format) makes the **caller** throw a typed `SIGNING_FAILED`
  structured error **before** any object/ref write — reproducing git's atomic
  refusal (F1/F2). No reflog, no `MERGE_HEAD` churn, no partial index; for push,
  nothing is sent.
- **Off-node (ADR-447):** with `ctx.command === undefined` and signing requested,
  the operation **hard-refuses** with a typed error; a repo cannot be faithfully
  produced unsigned when the user asked for a signature. Silent-skip is rejected.
- **Success detection (ADR-446):** exit-0 + a well-formed armor block on stdout;
  `CommandRunner` is not widened for stderr / `SIG_CREATED`.

### Faithfulness scope note

Per ADR-249, faithfulness binds the **object bytes, SHAs, refs, refusal
conditions, and the push-cert wire bytes** — all pinned above and interop-tested.
The signer **argv** is a delegation detail (not a git wire artifact) but is pinned
and tested anyway because a wrong argv changes *whether a valid signature is
produced at all* and *which key signs* — correctness- and security-load-bearing.

## Ratified decisions

The user ratified each in the ADR phase; the designer only recommended. Seven
adopted the recommendation; **ADR-444 deviated** (push in scope, not deferred).

| ADR | Decision | Outcome vs. recommendation |
|---|---|---|
| 442 | Signer = pure primitive over the existing `CommandRunner` port; **no new port**. | as recommended |
| 443 | v1 formats = `openpgp` + `ssh`; `x509` out, **typed unsupported error** on request. | as recommended |
| 444 | **Signed push (push certificates) IN scope for v1.** | **deviation** — design recommended deferring; user included it. Triggers this scope-fold revision. |
| 445 | Narrow the commit `gpgSignature` injection guard to **NUL/CR only**. | as recommended |
| 446 | Signing success = **exit-0 + well-formed armor**; `CommandRunner` unchanged. | as recommended |
| 447 | Off-node (no `ctx.command`) signing request → **typed hard-refuse**, never unsigned. | as recommended |
| 448 | Tag signature **appended to the body**; serialize/parse redesigned as a round-trip pair; `gpgsig`-header path removed. | as recommended |
| 449 | Annotated-tag creation is a **prerequisite delivered in this item**, sequenced before signing. | as recommended |

## Implementation parts (partition sketch)

Dependency order: **config → signer → commit signing → tag (annotated → signing)
→ push cert.** Each part is one atomic commit with its own TDD; the signer and
config precede all three surfaces; push cert is last (widest blast radius).

**Part 1 — signing config keys.**
- Files: `src/application/primitives/config-read.ts` (new `merge*` arms in
  `dispatchSection`, mirroring `mergeUser` `config-read.ts:1108`); `ParsedConfig`
  type.
- Adds: `user.signingkey`, `commit.gpgsign`, `tag.gpgSign`,
  `push.gpgSign` (tri-state), `gpg.format`, `gpg.program`, `gpg.ssh.program`.
- Tests: per-key parse + default/absent ≡ today; property lens N/A (flat keys).

**Part 2 — `signPayload` primitive.**
- Files: `src/application/primitives/sign-payload.ts` (new); reuse
  `ctx.command` (`CommandRunner`, `src/ports/command-runner.ts`) and `ctx.fs`.
- Signature: `signPayload(ctx, payload: Uint8Array, keyOverride?: string) =>
  Promise<{ ok: true; armor: string } | { ok: false; reason }>`.
- Behaviour: openpgp stdin→stdout; ssh tempfile→`.sig` (mirror
  `apply-textconv.ts`); x509 → `UNSUPPORTED_SIGNING_FORMAT`; no runner →
  `OFF_NODE`; exit≠0 / malformed armor → `{ok:false}` (ADR-443/446/447).
- Fixtures: a fake signer script (canned armor / failing) installed via
  `gpg.program`; `MemoryCommandRunner` (`memory-command-runner.ts`) for units.
- Tests: unit over a fake `CommandRunner` (both contracts, both failure classes,
  abort threading); error assertions specific (reason + code).

**Part 3 — commit signing + guard narrowing (ADR-445).**
- Files: `src/application/commands/commit.ts` (`CommitOptions` `commit.ts:46` gains
  `sign`/`signKey`; signed flow before `createCommit` `commit.ts:131`);
  `src/application/primitives/create-commit.ts:32` + `validators.ts:61`
  (`hasHeaderInjectionChars` narrowed for the signature field).
- Reuse: `serializeCommitContent` (`commit.ts:120`) as the unsigned payload.
- Tests: guard per char class (NUL/CR rejected, armor accepted); commit-object
  bytes/SHA; atomic refusal on signer failure (HEAD unchanged); interop C-matrix.

**Part 4 — annotated tag creation (ADR-449, unsigned).**
- Files: `src/application/commands/tag.ts` (`TagCreateInput` `tag.ts:25`,
  `tagCreate` `tag.ts:63` gains an annotated path: tagger/message capture,
  tag-object `writeObject`, `updateRef` to the tag OID); `src/domain/objects/tag.ts`
  (unsigned annotated serialize).
- Tests: annotated tag bytes/SHA vs git; lightweight path unchanged.

**Part 5 — tag body-append serialize/parse (ADR-448) + tag signing.**
- Files: `src/domain/objects/tag.ts` (`serializeTagContent` `tag.ts:143-145`
  appends armor to body; `parseTagContent` peels it; remove the `gpgsig`-header
  branch); `src/application/commands/tag.ts` (signed flow on `-s`/`tag.gpgSign`).
- Tests: example test pins T-matrix bytes; `tag.properties.test.ts` round-trip
  (`parse(serialize(x)) ≡ x`, one-armor↔one-signature count); interop T-matrix;
  atomic refusal.

**Part 6 — push certificate (ADR-444).**
- Files: `src/domain/protocol/receive-pack.ts` (new
  `buildSignedReceivePackRequest` beside `buildReceivePackRequest`
  `receive-pack.ts:37`; no-caps `updateLine` variant `receive-pack.ts:32`; new
  `buildPushCertPayload` for P.2); `src/domain/protocol/capabilities.ts:17`
  (`push-cert` token); `src/application/commands/internal/receive-pack-client.ts:33`
  (`selectPushCapabilities` adds `push-cert` when signing); `src/application/commands/push.ts`
  (`PushOptions` `push.ts:50` gains `signed`; nonce parse + mode resolution in
  `sendUpdates` `push.ts:296`; signed-request branch at `push.ts:312`).
- Reuse: `signPayload` (Part 2) unchanged; `session.exchange` (`push.ts:317`)
  unchanged (HTTP + SSH both carry the cert).
- Fixtures: bare server with `receive.certNonceSeed`; a `--receive-pack` wrapper
  capturing stdin; the fake signer from Part 2.
- Tests: unit for `buildSignedReceivePackRequest` (exact P.1 framing incl. opener
  no-LF, no-caps ref lines, `push-cert-end`, flush) and `buildPushCertPayload`
  (exact P.2); refusal + if-asked (P.3); interop P-matrix (recorded cert bytes,
  nonce echo, pusher selector both cases).

## Test strategy

- **Unit (pure, 100% + mutation):**
  - `sign-payload` over a fake `CommandRunner`: openpgp stdin→stdout happy path;
    ssh temp-file → `.sig` read path (assert temp file written, `.sig` read, both
    cleaned in `finally`); non-zero exit / absent runner / malformed stdout /
    x509-unsupported → `{ok:false}` with the specific reason; abort threads
    through. Error/branch assertions specific (code + reason, mutation-resistant).
  - Config parse: each new key incl. `push.gpgSign` tri-state; default/absent ≡
    today's behaviour.
  - Tag payload builder + `serializeTagContent`/`parseTagContent` **round-trip**
    (property lens): `parse(serialize(x)) ≡ x` for a signed tag; count invariant
    (one appended armor ↔ one peeled signature). Example tests pin literal
    T-matrix bytes.
  - `hasHeaderInjectionChars` post-ADR-445: a real armor passes; NUL/CR rejected;
    isolated guard tests per rejected char class.
  - Push cert: `buildSignedReceivePackRequest` frames P.1 exactly (opener with
    negotiated caps + leading space + no trailing LF; ref lines with no caps tail;
    `0005` blank pkts; `push-cert-end`; flush before pack). `buildPushCertPayload`
    yields P.2 exactly for both pusher-selector cases. Mode resolution + refusal
    (P.3) unit-tested at the command seam over a fake session.
- **Integration (node):** a fake signer installed via `gpg.program` /
  `gpg.ssh.program` drives `commit -S` and `tag -s`; assert object bytes, SHA,
  ref/reflog, and atomic refusal on failure (nothing written). Reuses the interop
  env hardening (scrubbed `GIT_*`, isolated `HOME`).
- **Interop (`test/integration/*-interop.test.ts`, the faithfulness gate):**
  twin real-`git` vs tsgit in a `mktemp -d` with a throwaway `GNUPGHOME` + a
  generated unprotected key; **skipIf** signer unavailable; one shared `beforeAll`;
  60s timeout (interop load→validate flake note). Pin: C (signed commit object +
  SHA + no-gpgsig payload), T (signed tag body-append + payload), X (ssh vs gpg
  argv + contract), F1/F2 (failure refusal — reconstruct git's stderr from the
  structured error per ADR-249, do **not** byte-match stderr), **P (push-cert wire
  bytes: nonce advertisement parse, envelope framing, signed payload, pusher
  selector both cases, refusal + if-asked)** via the `--receive-pack` capture
  wrapper + `receive.certNonceSeed` server. Because signatures are
  non-deterministic, assert the **structural** shape (framing, header placement,
  SHA over reconstructed bytes with a fixed canned signature via the fake signer)
  rather than a frozen golden SHA for the real-gpg path.
- **Cross-adapter parity:** memory/browser (no `ctx.command`) with signing
  requested → the typed refusal (ADR-447); parity is cross-adapter only and does
  **not** prove faithfulness (the interop files do).
- **Browser (playwright surface):** `commit -S` / `tag -s` / `push --signed` raise
  the inert refusal; extend the browser-surface audit.

## Out of scope

- **Signature verification** — `--verify`, `%G?`/`%GK`/`%GS` pretty tokens,
  `gpg.ssh.allowedSignersFile`, trust evaluation. Read-side; a separate follow-up.
  This backlog is produce-side only.
- **x509 / `gpgsm`** — out per ADR-443; the enum is parsed and a typed
  `UNSUPPORTED_SIGNING_FORMAT` error is raised on request. The encoding + argv are
  the same shape as `gpg`, so it is additive later (one argv arm + one interop
  pin).
- **`gpg-agent` / key management / passphrase prompting / pinentry** — fully
  delegated to the spawned signer (git's model); tsgit parses no keys and drives
  no agent, exactly as SSH transport delegates to `ssh`.
- **`ssh-keygen` allowed-signers / principals beyond `-n git`** — verification-side.
- **Push options / `--atomic` interaction with the cert beyond the pinned
  framing** — the cert rides the existing atomic/report-status path unchanged;
  push-option lines (`receive.advertisePushOptions`) are not added in this item.
- **The unrelated housekeeping edit** moving backlog item 25.1a into the Parking
  lot section is a docs/backlog-only change handled at the docs phase, not a
  design concern (noted, not designed).
