/**
 * Helpers for write-surface interop tests. Each helper is small and
 * deliberately inlined-style so the test bodies still read top-down.
 *
 * Intentionally NOT under `test/_helpers/` (which is unit-scoped). These
 * helpers spawn `git` and create on-disk tmpdirs, so they belong with
 * their integration peers.
 *
 * **Isolation discipline (the load-bearing piece).** Every `git`
 * invocation in this file goes through `runGit`, which spawns git with
 * **all `GIT_*` env vars stripped** from `process.env`. This is required
 * because:
 *
 *   1. When `npm run validate` runs from inside the husky pre-push hook,
 *      git invokes the hook with `GIT_DIR`, `GIT_WORK_TREE`,
 *      `GIT_INDEX_FILE`, etc. set in the environment (documented in
 *      `man githooks`).
 *   2. `npm → wireit → vitest → workers` all inherit that env.
 *   3. `git -C <tmp> <cmd>` only changes the CWD; `GIT_DIR` from env
 *      takes precedence over the repo at `<tmp>`, so `git -C tmp commit`
 *      silently lands on the worktree's `.git` instead of `tmp/.git`.
 *
 * The fix is to scrub `GIT_*` from the env we pass to spawned `git`.
 * `GIT_CEILING_DIRECTORIES` is added back as a defence-in-depth guard
 * against discovery-time walk-up when (rarely) `GIT_DIR` isn't set.
 *
 * **Ambient config isolation (same trap class, different vector).** Scrubbing
 * `GIT_*` is not enough: spawned `git` still inherits the developer's `HOME`
 * and so reads `~/.gitconfig` (global). Without `GIT_CONFIG_NOSYSTEM` it also
 * reads `/etc/gitconfig` (system), and it reads `$XDG_CONFIG_HOME/git/config`
 * (XDG) on a path discovered independently of `HOME`. Any of these silently
 * changes git's observable bytes from one machine to another (e.g. a global
 * `merge.conflictStyle=diff3` rewriting conflict markers, or a system
 * `credential.helper`) — the same flakiness class as the `GIT_DIR` leak above.
 * We point `HOME` (and the XDG root under it) at a deterministic NON-existent
 * path inside `os.tmpdir()` and set `GIT_CONFIG_NOSYSTEM=1`: git's lookups miss
 * and it fails soft to "no config". The path is never created — read/init/add/
 * commit (signing off) write nothing under `HOME` — so there is nothing to set
 * up and nothing to clean up.
 *
 * **Fallback identity (what the closed vectors used to supply).** With no
 * global config, git derives an identity from the account: a full name from the
 * passwd GECOS field, so a commit succeeds on a workstation and dies with
 * `empty ident name` on a CI runner whose account has none. `GIT_CONFIG_GLOBAL`
 * names a file holding one fixed `user.name`/`user.email`, read at the global
 * scope so a repository's own `user.*` and a call's `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` still win, exactly as they would over a developer's
 * `~/.gitconfig`. The file lives in one directory per account, created `0700`
 * and refused unless it is still a directory this account owns and keeps
 * private, so no other account can plant or swap the config git reads; it is
 * replaced by a rename, so a concurrent worker never reads it half-written.
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { RevParseEntry } from '../../src/application/commands/rev-parse.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { bytesToHex } from '../../src/domain/objects/encoding.js';

const execFileAsync = promisify(execFile);

// Single source for the isolation HOME: a deterministic path under os.tmpdir()
// that is never created, so git's global/XDG config lookups miss and fail soft.
const ISOLATED_HOME = path.join(os.tmpdir(), 'tsgit-interop-nonexistent-home');

/** git's own test-suite author, the identity a commit falls back to. */
const FALLBACK_IDENTITY_CONFIG = '[user]\n\tname = A U Thor\n\temail = author@example.com\n';

const IDENTITY_DIR = path.join(os.tmpdir(), `tsgit-interop-identity-${os.userInfo().username}`);
const PRIVATE_DIR_MODE = 0o700;
const GROUP_OR_OTHER_BITS = 0o077;

/** Windows keeps `%TEMP%` per account and reports no POSIX owner or mode bits to check. */
export const isPrivateToThisAccount = (dir: string): boolean => {
  const stats = lstatSync(dir);
  if (!stats.isDirectory()) return false;
  if (process.platform === 'win32' || process.getuid === undefined) return true;
  return stats.uid === process.getuid() && (stats.mode & GROUP_OR_OTHER_BITS) === 0;
};

const publishIdentityConfig = (): string => {
  mkdirSync(IDENTITY_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!isPrivateToThisAccount(IDENTITY_DIR)) {
    throw new Error(
      `refusing an identity config directory another account can write: ${IDENTITY_DIR}`,
    );
  }
  const target = path.join(IDENTITY_DIR, '.gitconfig');
  const staging = `${target}.${process.pid}-${randomUUID()}`;
  writeFileSync(staging, FALLBACK_IDENTITY_CONFIG);
  renameSync(staging, target);
  return target;
};

const buildSafeEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  env.HOME = ISOLATED_HOME;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.XDG_CONFIG_HOME = path.join(ISOLATED_HOME, '.config');
  env.GIT_CONFIG_GLOBAL = publishIdentityConfig();
  // Same guarantee `disableAutoMaintenance` gives one repo, given to every
  // repo any interop test spawns git against — including the ones that never
  // call it. A detached `gc --auto` / `maintenance run --auto` mutates
  // `.git/objects` (creating and removing `objects/maintenance.lock`) while
  // the test is still copying or asserting over that directory, so a plain
  // `fs.cp` of a fixture repo can lose an `lstat` race against a process it
  // never started. Carried on the env rather than per-repo config because the
  // env is the one chokepoint every helper here already funnels through.
  env.GIT_CONFIG_COUNT = '3';
  env.GIT_CONFIG_KEY_0 = 'gc.auto';
  env.GIT_CONFIG_VALUE_0 = '0';
  env.GIT_CONFIG_KEY_1 = 'gc.autoDetach';
  env.GIT_CONFIG_VALUE_1 = 'false';
  env.GIT_CONFIG_KEY_2 = 'maintenance.auto';
  env.GIT_CONFIG_VALUE_2 = 'false';
  return env;
};

const SAFE_ENV: NodeJS.ProcessEnv = buildSafeEnv();

/**
 * Ceiling on a single spawned `git` call. Every interop invocation is local
 * (init/commit/diff/pack — never a network round trip), so 60s sits orders
 * of magnitude above a healthy run, generous even for a loaded CI runner,
 * and only ever trips on a genuine hang. Without it a stuck child blocks the
 * whole suite until the runner's own outer timeout fires, reporting a vague
 * suite-level timeout instead of which `git` call hung.
 */
const GIT_SPAWN_TIMEOUT_MS = 60_000;

/**
 * `true` for a `execFileSync`/`spawnSync` failure caused by the `timeout`
 * option killing the child — `ETIMEDOUT` is never a code git itself exits
 * with, so this is unambiguous. Callers that otherwise swallow a non-zero
 * git exit (`tryRunGit`, `tryRunGitWithExit`) must NOT swallow this one: a
 * hang is a test-infrastructure failure, not a git refusal, and coercing it
 * into a normal-looking result would hide the actual problem.
 */
const isSpawnTimeout = (failure: NodeJS.ErrnoException): boolean => failure.code === 'ETIMEDOUT';

/**
 * Spawn `git` with a sanitised env (no inherited `GIT_*` from the test
 * runner's parent). Use this for every git invocation in interop tests.
 *
 * For commit/tag operations that need deterministic author/committer
 * dates, spread `runGitEnv` and add the `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * vars in the call site's own env override.
 */
export const runGit = (
  args: ReadonlyArray<string>,
  options: { readonly input?: string | Uint8Array; readonly env?: NodeJS.ProcessEnv } = {},
): string => {
  const env = options.env ?? SAFE_ENV;
  // `input` accepts raw bytes as well as text: a string `input` is written by
  // `execFileSync` as UTF-8, which silently mangles any byte >= 0x80 — malformed
  // tree bodies built from arbitrary oid bytes must go through as a Uint8Array.
  const opts: { env: NodeJS.ProcessEnv; input?: string | Uint8Array; timeout: number } = {
    env,
    timeout: GIT_SPAWN_TIMEOUT_MS,
  };
  if (options.input !== undefined) opts.input = options.input;
  return execFileSync('git', args as string[], opts).toString();
};

const REPORT_LINE = /^(add|remove) '(.*)'$/;
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
};
const C_QUOTED_TOKEN = /\\([0-7]{3}|.)|[^\\]/gs;
const OCTAL_RADIX = 8;
const OCTAL_ESCAPE_LENGTH = 3;

const escapedByte = (escaped: string): number =>
  escaped.length === OCTAL_ESCAPE_LENGTH
    ? Number.parseInt(escaped, OCTAL_RADIX)
    : (C_ESCAPES[escaped] ?? escaped.charCodeAt(0));

/** Decodes a path as `git add -v` quotes it; a byte sequence that is not UTF-8 reads as U+FFFD. */
const unquoteGitPath = (reported: string): string => {
  if (!reported.startsWith('"') || !reported.endsWith('"')) return reported;
  const bytes = [...reported.slice(1, -1).matchAll(C_QUOTED_TOKEN)].flatMap(([token, escaped]) =>
    escaped === undefined ? [...Buffer.from(token)] : [escapedByte(escaped)],
  );
  return new TextDecoder().decode(Uint8Array.from(bytes));
};

export interface GitAddReport {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

/** Runs `git add -v <args>` and returns the sorted paths it reports as added and removed. */
export const gitAddVerbose = (dir: string, args: ReadonlyArray<string>): GitAddReport => {
  const reports = runGit(['-C', dir, 'add', '-v', ...args])
    .split('\n')
    .flatMap((line) => {
      const [, verb = '', quoted = ''] = REPORT_LINE.exec(line) ?? [];
      return verb === '' ? [] : [{ verb, path: unquoteGitPath(quoted) }];
    });
  const pathsOf = (verb: string): string[] =>
    reports
      .filter((report) => report.verb === verb)
      .map((report) => report.path)
      .sort();
  return { added: pathsOf('add'), removed: pathsOf('remove') };
};

/** Snapshot of the sanitised env, for tests that need to extend it. */
export const runGitEnv = (): NodeJS.ProcessEnv => ({ ...SAFE_ENV });

/**
 * The sanitised env with no global config at all, fallback identity included:
 * for a test probing that git finds no `user.*` key, which the pinned
 * tsgit side never has.
 */
export const runGitEnvWithoutGlobalConfig = (): NodeJS.ProcessEnv => ({
  ...SAFE_ENV,
  GIT_CONFIG_GLOBAL: path.join(ISOLATED_HOME, '.gitconfig'),
});

/**
 * Async counterpart to `runGit` — spawns git without blocking the event
 * loop. Required whenever the invoked command talks HTTP to a server
 * hosted in this same process (e.g. an in-process `git-http-backend` CGI
 * proxy): `execFileSync`/`runGit` blocks the event loop for the call's
 * entire duration, so the server can never accept or service the request
 * the child git process is waiting on — both sides deadlock. Use this for
 * any command that crosses such a same-process HTTP round trip; plain
 * local operations (init, config, rev-parse, local-path clone/push) are
 * unaffected and may keep using `runGit`/`git`.
 */
export const runGitAsync = async (
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<string> => {
  const env = options.env ?? SAFE_ENV;
  const { stdout } = await execFileAsync('git', args as string[], { env });
  return stdout;
};

/**
 * Spawn `git` and return the raw binary output as a Uint8Array.
 * Unlike `runGit`, this never calls `.toString()` so binary data
 * (e.g. zip archives) is never corrupted by UTF-8 decoding.
 */
export const runGitBytes = (
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Uint8Array => {
  const env = options.env ?? SAFE_ENV;
  return new Uint8Array(
    execFileSync('git', args as string[], { env, timeout: GIT_SPAWN_TIMEOUT_MS }),
  );
};

export const hasGit = (): boolean => {
  try {
    runGit(['--version']);
    return true;
  } catch {
    return false;
  }
};

export const GIT_AVAILABLE = hasGit();

/**
 * Whether the local git was built with Rust support — the switch that gates
 * `extensions.compatObjectFormat`.
 *
 * MEASURED, never assumed. A build reporting `rust: disabled` refuses the
 * extension outright (`fatal: compatibility hash algorithm support requires
 * Rust`, exit 128); a Rust-enabled build accepts it and carries on. Both
 * builds ship as "git 2.55.0", so the version string cannot tell them apart —
 * GitHub's ubuntu-24.04 image moved from a non-Rust git 2.54.0 to a
 * Rust-enabled 2.55.0 between two runs of this suite, turning every
 * hard-coded `expect(exitCode).toBe(128)` on that extension red without a
 * single line of production code changing.
 */
export const gitHasRustCompat = (): boolean => {
  if (!GIT_AVAILABLE) return false;
  try {
    return /^rust:\s*enabled$/m.test(runGit(['version', '--build-options']));
  } catch {
    return false;
  }
};

export const GIT_HAS_RUST_COMPAT = gitHasRustCompat();

export interface PeerPair {
  readonly peer: string;
  readonly ours: string;
  readonly dispose: () => Promise<void>;
}

export const makePeerPair = async (slug: string): Promise<PeerPair> => {
  const peer = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-${slug}-peer-`));
  const ours = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-${slug}-ours-`));
  const dispose = async (): Promise<void> => {
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  };
  return { peer, ours, dispose };
};

export const initBothRepos = (peer: string, ours: string, branch = 'main'): void => {
  runGit(['init', '-q', '-b', branch, peer]);
  runGit(['init', '-q', '-b', branch, ours]);
  for (const dir of [peer, ours]) {
    runGit(['-C', dir, 'config', 'user.name', 'Ada']);
    runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
  }
};

export const git = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args]);

/** Async counterpart to `git` — see `runGitAsync` for when this is required. */
export const gitAsync = (dir: string, ...args: ReadonlyArray<string>): Promise<string> =>
  runGitAsync(['-C', dir, ...args]);

/**
 * Stops this repository ever repacking itself behind the test's back.
 *
 * `git commit` (and several other porcelain commands) can fork a DETACHED
 * `gc --auto` / `maintenance run --auto`, which is free to rewrite
 * `objects/pack/` while the test is still building its fixture. A fixture
 * that asserts the shape of that directory — "exactly one `.idx`", a
 * specific pack name, a bitmap sibling — is then racing a process it never
 * started and cannot see, and the race only ever loses on a loaded runner.
 *
 * Set on the repo rather than the environment so it survives every helper
 * that spawns git against this directory, including `runGit` calls that
 * build their own env.
 */
export const disableAutoMaintenance = (dir: string): void => {
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'gc.autoDetach', 'false');
  git(dir, 'config', 'maintenance.auto', 'false');
};

/**
 * `git ls-files --stage` — the host-independent (mode sha stage\tpath)
 * listing. Stat-cache fields differ per host, so this readback (not raw
 * index bytes) is how two writers' indexes are compared.
 */
export const lsStage = (dir: string): string => git(dir, 'ls-files', '--stage');

/**
 * `git write-tree` — materialise the index to a tree id. Reads whichever
 * `.git/index` the directory holds (tsgit's or canonical git's), so equal
 * ids across two repos is the stat-independent state-equivalence proof.
 */
export const writeTreeOf = (dir: string): string => git(dir, 'write-tree').trim();

/**
 * Newest reflog subject (`%gs`) for `ref` — reads whichever `.git/logs` the
 * directory holds (tsgit's or canonical git's), so it doubles as a cross-tool
 * reflog-parity probe (`'refs/heads/main'` for the branch, `'HEAD'` for the
 * symref log-only path).
 */
export const topReflogSubject = (dir: string, ref: string): string =>
  git(dir, 'log', '-g', '--format=%gs', ref).split('\n')[0] ?? '';

/**
 * A git that refuses before reading its stdin (a fatal in setup, a bad
 * argument) closes the pipe while the parent is still writing a payload
 * larger than the pipe buffer, so `spawnSync` reports `EPIPE` alongside the
 * real exit status. That is git's verdict, not a spawn failure.
 */
const isStdinClosedByExitedGit = (result: {
  readonly error?: Error;
  readonly status: number | null;
}): boolean =>
  (result.error as NodeJS.ErrnoException | undefined)?.code === 'EPIPE' && result.status !== null;

/**
 * Run `git`, capturing stdout, stderr AND the numeric exit code (never
 * throws on a normal git refusal) — for co-refusal assertions where the
 * exact exit code matters, not just success/failure. `tryRunGit` above only
 * distinguishes ok/not-ok; this reports the code so a caller can assert
 * git's documented refusal exit (128 for a structural `fatal:`, 1 for
 * `fsck`'s WARN/ERROR bits). Rethrows on every spawn failure (`result.error`
 * — a timeout kill included, but also an unresolvable binary or any other
 * reason the child never ran) except an `EPIPE` that arrives with an exit
 * status, which is git refusing before it read its stdin (see
 * `isStdinClosedByExitedGit`), and on `status === null` (killed by a signal
 * with no `error` set): `spawnSync`'s own invariant is that `status` is
 * `null` exactly when the process never exited normally, so coercing either
 * case to a fake `1` would misreport a process that never actually ran as a
 * `fsck` WARN/ERROR exit.
 */
export const tryRunGitWithExit = (
  args: ReadonlyArray<string>,
  options: { readonly input?: string | Uint8Array; readonly env?: NodeJS.ProcessEnv } = {},
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } => {
  const env = options.env ?? SAFE_ENV;
  const opts = {
    env,
    encoding: 'utf8' as const,
    timeout: GIT_SPAWN_TIMEOUT_MS,
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  const result = spawnSync('git', args as string[], opts);
  if (result.error !== undefined && !isStdinClosedByExitedGit(result)) {
    throw new Error(`git ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(`git ${args.join(' ')} was killed by signal ${String(result.signal)}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
};

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `git` without throwing on a non-zero exit — for co-refusal assertions
 * (proving canonical git refuses exactly where tsgit does). Keeps the same
 * `SAFE_ENV` scrubbing as `runGit`; never shells through a string.
 */
export const tryRunGit = (
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): GitRunResult => {
  try {
    return { ok: true, stdout: runGit(args, options), stderr: '' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      readonly stdout?: Buffer | string;
      readonly stderr?: Buffer | string;
    };
    if (isSpawnTimeout(failure)) throw error;
    return {
      ok: false,
      stdout: failure.stdout?.toString() ?? '',
      stderr: failure.stderr?.toString() ?? '',
    };
  }
};

const EXCLUDED_MARK = '^';

const revParseLine = (entry: RevParseEntry): string =>
  entry.kind === 'path' ? entry.path : `${entry.negated ? EXCLUDED_MARK : ''}${entry.id}`;

/**
 * `git rev-parse`'s stdout rebuilt from `revParse`'s entries: one line each,
 * an excluded object marked `^`, a path as given.
 */
export const revParseStdout = (entries: ReadonlyArray<RevParseEntry>): string =>
  entries.map(revParseLine).join('\n');

export const NUL = 0x00;
const TAB = 0x09;

export const hex = (bytes: Uint8Array): string => bytesToHex(bytes);

export const pathHexOfRecords = (records: Uint8Array): string[] => {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < records.length; i++) {
    if (records[i] !== NUL) continue;
    const record = records.subarray(start, i);
    out.push(hex(record.subarray(record.indexOf(TAB) + 1)));
    start = i + 1;
  }
  return out;
};

export const lsFilesPathHex = (dir: string): string[] =>
  pathHexOfRecords(runGitBytes(['-C', dir, 'ls-files', '-s', '-z']));

export const lsTreePathHex = (dir: string, rev: string): string[] =>
  pathHexOfRecords(runGitBytes(['-C', dir, 'ls-tree', '-r', '-z', rev]));

export const hashBlob = (dir: string, content: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

export const stageRaw = (
  dir: string,
  rows: ReadonlyArray<{ mode: string; oid: string; path: Uint8Array }>,
): void => {
  const encoder = new TextEncoder();
  const chunks = rows.flatMap((row) => [
    encoder.encode(`${row.mode} ${row.oid}\t`),
    row.path,
    Uint8Array.of(NUL),
  ]);
  const input = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  runGit(['-C', dir, 'update-index', '-z', '--index-info'], { input });
};

export interface ConflictedEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  readonly pathHex: string;
}

export interface MergeTreeResult {
  readonly tree: string;
  readonly conflicted: ReadonlyArray<ConflictedEntry>;
}

const parseConflictedEntry = (record: Uint8Array): ConflictedEntry => {
  const tab = record.indexOf(TAB);
  const [mode = '', oid = '', stage = ''] = Buffer.from(record.subarray(0, tab))
    .toString('latin1')
    .split(' ');
  return { mode, oid, stage: Number(stage), pathHex: hex(record.subarray(tab + 1)) };
};

/** `git merge-tree` exits 1 on a conflicted merge and still prints the result on stdout. */
const MERGE_TREE_CONFLICT_EXIT = 1;

const runMergeTree = (args: ReadonlyArray<string>): Uint8Array => {
  try {
    return runGitBytes(args);
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer };
    if (failure.status !== MERGE_TREE_CONFLICT_EXIT || failure.stdout === undefined) throw error;
    return new Uint8Array(failure.stdout);
  }
};

export const mergeTreeResult = (dir: string, ours: string, theirs: string): MergeTreeResult => {
  const output = runMergeTree([
    '-C',
    dir,
    '-c',
    'merge.conflictStyle=merge',
    'merge-tree',
    '--write-tree',
    '-z',
    ours,
    theirs,
  ]);
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < output.length; i++) {
    if (output[i] !== NUL) continue;
    fields.push(output.subarray(start, i));
    start = i + 1;
  }
  const [treeField = new Uint8Array(), ...rest] = fields;
  const end = rest.findIndex((field) => field.length === 0);
  const records = end === -1 ? rest : rest.slice(0, end);
  return {
    tree: Buffer.from(treeField).toString('latin1'),
    conflicted: records.map(parseConflictedEntry),
  };
};

/** The bytes of the index extension `signature` in `dir`, or `undefined` when the index lacks it. */
export const indexExtensionOf = async (
  dir: string,
  signature: string,
): Promise<Uint8Array | undefined> => {
  const index = await readIndex(createNodeContext({ workDir: dir }));
  return index.extensions.find((extension) => extension.signature === signature)?.data;
};
