# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in tsgit, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

## What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response timeline

- Acknowledgment within 48 hours
- Assessment within 7 days
- Fix released within 30 days for critical issues

## Supported Versions

| Version | Supported |
|---|---|
| Latest | Yes |
| < Latest | No |

## Threat Model

tsgit is a library, not a service. Trust flows from the host application
down to the library; users decide what data and which adapters cross
the boundary. The threat model below catalogues the protections the
library applies to that boundary and the assumptions it makes about its
host.

### Trust boundaries

| Boundary | What crosses | Guarantee |
|---|---|---|
| `openRepository(opts)` | user-supplied options | every field is validated synchronously before the `Repository` is returned; rejection surfaces a `TsgitError` with code `INVALID_OPTION`. |
| User-supplied `FileSystem` / `HttpTransport` | adapter instances | wrapped by default with `wrapFsValidator` / `wrapTransportValidator` so every call re-validates inputs. `unsafeRawAdapters: true` opts out (documented as "do not use with code you do not control"). |
| Config record | `RepositoryConfig` | frozen via `deepFreeze` at construction; subsequent mutation throws in strict mode and is silently no-op in sloppy mode. |
| Logger output | strings emitted via `Logger` | wrapped by `wrapLoggerSanitizer` to strip ANSI escapes, redact `Authorization:` headers, and bound message length. |
| Progress reporter | text labels | sanitized identically to logger output before reaching the user-supplied `ProgressReporter`. |
| Errors | `TsgitError.data` | reasons are bounded-length sanitized strings; never include raw secrets or full server responses. |

### SSRF protections

The Node and browser HTTP transports both apply a layered guard before any
request leaves the process:

1. **Scheme allowlist** — only `http:` and `https:` are accepted. `file:`,
   `gopher:`, and arbitrary schemes are rejected with `NETWORK_ERROR`.
2. **Insecure-HTTP gate** — plain `http:` is rejected unless the caller
   passes `allowInsecureHttp: true` (Node) or `config.allowInsecure: true`
   (facade). The flag is loud so a single ad-hoc lift never lingers.
3. **Private-network blocking** — hostnames that resolve to `127.0.0.0/8`,
   `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, or
   the loopback IPv6 range are rejected at validation time.
4. **DNS pinning** — `clone`/`fetch`/`push` resolve the URL host once via
   the injected `DnsResolver` (default: `dns.promises.lookup`), then pin
   the resulting IP across redirects so a server cannot smuggle a private
   address into a 302.

### Sanitization layers

- **Logger** — bounded message length (1 KiB by default), Authorization
  header values redacted, ANSI escapes stripped. Wrapping is automatic —
  user-supplied loggers see only sanitized strings.
- **Progress text** — same sanitization as logger; user labels are
  bounded and stripped.
- **Error `reason`** — every reason that flows into `TsgitError.data` is
  truncated to 256 bytes. Server bodies, file paths, and stack frames
  never leak verbatim.

### Out of scope (deferred to v1.x / v2)

- **Working-tree malware** — tsgit does not execute hooks or `.gitattributes`
  filter drivers. A repo containing those will simply be ignored.
- **Submodule recursion** — explicit opt-in only; the v1 surface does not
  walk submodules.
- **Sparse checkout / partial clone** — full clone semantics only; v2.
- **Defending against a malicious adapter** — users who opt into
  `unsafeRawAdapters: true` are on their own. The default-wrapped path is
  the supported surface.

### How to disclose

Use GitHub's private vulnerability reporting (see top of file). Include
a minimal reproducer using the public `openRepository` surface where
possible.
