/**
 * Cross-tool interop — `fsck` object-content validation.
 *
 * Pins tsgit's structured `FsckResult` against real git 2.54.0 behaviour for
 * object-content validation scenarios. Each scenario hand-writes a malformed
 * loose object past git's write-side fsck so the read-side severity is observed.
 * The test reconstructs git's exact stderr lines from the structured fields and
 * asserts byte-equality with `git fsck` output plus the exact exit code.
 *
 * Exit codes pinned against real git 2.54.0:
 *   - corrupt (inflate failure): exit 1 (bit 1)
 *   - corrupt + referenced (missing in BFS): exit 3 (1|2)
 *   - hash-path mismatch: exit 1 (bit 1)
 *   - zeroPaddedFilemode (no --strict): exit 0 (WARN alone)
 *   - zeroPaddedFilemode (--strict): exit 1 (WARN→ERROR)
 *   - treeNotSorted (ERROR): exit 1 (bit 1)
 *   - missingSpaceBeforeEmail (ERROR, valid tree): exit 1 (bit 1)
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck data reconstructs canonical git fsck findings + exit codes
 *   interopSurface: fsck
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit } from './interop-helpers.js';
import { trackedRepositories } from './repository-lifecycle.js';

const openTrackedRepository = trackedRepositories();

const SETUP_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Run git, capturing stdout, stderr AND exit code (never throws). */
function tryRunGitWithExit(
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } {
  const env = options.env ?? buildSafeEnv();
  const result = spawnSync('git', args as string[], { env, encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  const isolatedHome = path.join(os.tmpdir(), 'tsgit-fsck-interop-nonexistent-home');
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  env.HOME = isolatedHome;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
  return env;
}

const SAFE_ENV = buildSafeEnv();

/** Compress bytes with zlib deflate (git loose-object format). */
function deflateSync(data: Buffer): Buffer {
  return zlib.deflateSync(data);
}

/** Compute SHA-1 hex of raw bytes. */
function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/**
 * Build a git loose-object raw bytes: `<type> <size>\0<body>`.
 * Returns { raw, sha1 } where sha1 is the OID.
 */
function buildLooseObject(type: string, body: Buffer): { raw: Buffer; sha1: string } {
  const header = Buffer.from(`${type} ${body.length}\0`);
  const raw = Buffer.concat([header, body]);
  return { raw, sha1: sha1Hex(raw) };
}

/**
 * Write a loose object (possibly malformed) directly to a git repo's object store.
 * `workDir` is the repository's working directory (parent of `.git/`).
 * Returns the OID.
 */
async function writeLooseObject(workDir: string, type: string, body: Buffer): Promise<string> {
  const { raw, sha1 } = buildLooseObject(type, body);
  const prefix = sha1.slice(0, 2);
  const suffix = sha1.slice(2);
  const objDir = path.join(workDir, '.git', 'objects', prefix);
  await mkdir(objDir, { recursive: true });
  await writeFile(path.join(objDir, suffix), deflateSync(raw));
  return sha1;
}

/** Initialize a bare git repo at dir. */
function initRepo(dir: string): void {
  runGit(['-C', dir, 'init', '-q', '-b', 'main'], { env: SAFE_ENV });
  runGit(['-C', dir, 'config', 'user.name', 'Test'], { env: SAFE_ENV });
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com'], { env: SAFE_ENV });
}

function gitFsck(dir: string, ...flags: string[]): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit(['-C', dir, 'fsck', ...flags], { env: SAFE_ENV });
}

// ---------------------------------------------------------------------------
// Scenario families — one shared repo per family (beforeAll, 60s timeout)
// ---------------------------------------------------------------------------

// --- Scenario family 12a/12b: zeroPaddedFilemode ----------------------------

let zeroPadDir = '';
let zeroPadCtx: Context;
let zeroPadTreeSha = '';

beforeAll(async () => {
  zeroPadDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-zeroPad-'));
  initRepo(zeroPadDir);

  // Write a valid blob
  const blobSha = runGit(['-C', zeroPadDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();

  const blobShaBytes = Buffer.from(blobSha, 'hex');

  // Build a tree with zero-padded mode: "0100644" instead of "100644"
  const modeAndName = Buffer.from('0100644 file.txt\0');
  const treeBody = Buffer.concat([modeAndName, blobShaBytes]);
  zeroPadTreeSha = await writeLooseObject(zeroPadDir, 'tree', treeBody);

  // Build and write a commit pointing to this tree directly (bypassing git's write-side fsck).
  // The commit object itself is valid — only the tree it references has the zero-padded mode.
  const commitBody = Buffer.from(
    `tree ${zeroPadTreeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\ntest commit\n`,
  );
  const commitSha = await writeLooseObject(zeroPadDir, 'commit', commitBody);
  await mkdir(path.join(zeroPadDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(zeroPadDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);

  zeroPadCtx = createNodeContext({ workDir: zeroPadDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (zeroPadDir !== '') await rm(zeroPadDir, { recursive: true, force: true });
});

// --- Scenario family: zero-padded modes must strip ALL leading zeros --------
// A single leading zero already normalises correctly (the family above); a
// SECOND leading zero on a directory mode, and any zero-padded symlink mode,
// exercise the fix directly.

let zeroPadAllDir = '';
let zeroPadAllCtx: Context;
let zeroPadDirModeTreeSha = '';
let zeroPadSymlinkTreeSha = '';

beforeAll(async () => {
  zeroPadAllDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-zeroPadAll-'));
  initRepo(zeroPadAllDir);

  const blobSha = runGit(['-C', zeroPadAllDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();
  const blobShaBytes = Buffer.from(blobSha, 'hex');
  const emptyTreeSha = await writeLooseObject(zeroPadAllDir, 'tree', Buffer.alloc(0));
  const emptyTreeShaBytes = Buffer.from(emptyTreeSha, 'hex');

  // Double-zero-padded directory mode: stripping only ONE zero leaves
  // '040000', which VALID_MODES does not contain — the old defect emitted a
  // spurious badFilemode alongside the correct zeroPaddedFilemode. Points at
  // a real (empty) tree so git's own recursive checks stay quiet.
  const dirModeAndName = Buffer.from('0040000 subdir\0');
  zeroPadDirModeTreeSha = await writeLooseObject(
    zeroPadAllDir,
    'tree',
    Buffer.concat([dirModeAndName, emptyTreeShaBytes]),
  );

  // Zero-padded symlink mode named '.gitignore': the old defect compared the
  // raw, still zero-padded mode against '120000', so isSymlink never fired
  // for a zero-padded symlink mode and gitignoreSymlink silently never fired.
  const symlinkModeAndName = Buffer.from('0120000 .gitignore\0');
  zeroPadSymlinkTreeSha = await writeLooseObject(
    zeroPadAllDir,
    'tree',
    Buffer.concat([symlinkModeAndName, blobShaBytes]),
  );

  const refsDir = path.join(zeroPadAllDir, '.git', 'refs', 'heads');
  await mkdir(refsDir, { recursive: true });

  const pointRefAtTree = async (ref: string, treeSha: string): Promise<void> => {
    const commitBody = Buffer.from(
      `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\n${ref}\n`,
    );
    const commitSha = await writeLooseObject(zeroPadAllDir, 'commit', commitBody);
    await writeFile(path.join(refsDir, ref), `${commitSha}\n`);
  };
  await pointRefAtTree('dirMode', zeroPadDirModeTreeSha);
  await pointRefAtTree('symlinkMode', zeroPadSymlinkTreeSha);

  zeroPadAllCtx = createNodeContext({ workDir: zeroPadAllDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (zeroPadAllDir !== '') await rm(zeroPadAllDir, { recursive: true, force: true });
});

// --- Scenario family 12c: treeNotSorted + missingSpaceBeforeEmail -----------

let catalogueDir = '';
let catalogueCtx: Context;
let sortedTreeSha = '';
let badEmailCommitSha = '';
let emptyTreeSha = '';
let duplicateEntriesTreeSha = '';

beforeAll(async () => {
  catalogueDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-catalogue-'));
  initRepo(catalogueDir);

  // Write two blobs for the unsorted tree
  const sha1 = runGit(['-C', catalogueDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'a\n',
  }).trim();
  const sha2 = runGit(['-C', catalogueDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'b\n',
  }).trim();
  const sha1Bytes = Buffer.from(sha1, 'hex');
  const sha2Bytes = Buffer.from(sha2, 'hex');

  // Build a tree with treeNotSorted: 'z.txt' before 'a.txt'
  const e1 = Buffer.from('100644 z.txt\0');
  const e2 = Buffer.from('100644 a.txt\0');
  const treeBody = Buffer.concat([e1, sha1Bytes, e2, sha2Bytes]);
  sortedTreeSha = await writeLooseObject(catalogueDir, 'tree', treeBody);

  // Build a tree with duplicateEntries: 'a.txt' listed twice
  const dupE1 = Buffer.from('100644 a.txt\0');
  const dupE2 = Buffer.from('100644 a.txt\0');
  const duplicateEntriesTreeBody = Buffer.concat([dupE1, sha1Bytes, dupE2, sha2Bytes]);
  duplicateEntriesTreeSha = await writeLooseObject(catalogueDir, 'tree', duplicateEntriesTreeBody);

  // Write the canonical empty-tree object (4b825dc...) directly
  emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  await writeLooseObject(catalogueDir, 'tree', Buffer.alloc(0));

  // Build a commit with missingSpaceBeforeEmail: 'Name<email>' (no space before '<')
  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nauthor Name<bad@example.com> 1700000000 +0000\ncommitter Test <c@example.com> 1700000000 +0000\n\nmessage\n`,
  );
  badEmailCommitSha = await writeLooseObject(catalogueDir, 'commit', commitBody);

  // Build and write a commit for the treeNotSorted tree directly
  const commitForUnsortedBody = Buffer.from(
    `tree ${sortedTreeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nunsorted\n`,
  );
  const commitForTree = await writeLooseObject(catalogueDir, 'commit', commitForUnsortedBody);
  const refsDir = path.join(catalogueDir, '.git', 'refs', 'heads');
  await mkdir(refsDir, { recursive: true });
  await writeFile(path.join(refsDir, 'main'), `${commitForTree}\n`);
  // Point another ref to the bad-email commit
  await writeFile(path.join(refsDir, 'badEmail'), `${badEmailCommitSha}\n`);

  // Point another ref to a commit for the duplicateEntries tree directly
  const commitForDuplicateBody = Buffer.from(
    `tree ${duplicateEntriesTreeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nduplicate\n`,
  );
  const commitForDuplicate = await writeLooseObject(catalogueDir, 'commit', commitForDuplicateBody);
  await writeFile(path.join(refsDir, 'duplicateEntries'), `${commitForDuplicate}\n`);

  catalogueCtx = createNodeContext({ workDir: catalogueDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (catalogueDir !== '') await rm(catalogueDir, { recursive: true, force: true });
});

// --- Scenario family: tree name faults (hasDot, hasDotdot, fullPathname) -----
// Isolated from catalogueDir so each check's own repo carries no other
// content-error finding — the default-mode exit code proves the WARN severity
// in isolation, exactly like the zeroPaddedFilemode family above.

let nameFaultsDir = '';
let nameFaultsCtx: Context;
let hasDotTreeSha = '';
let hasDotdotTreeSha = '';
let fullPathnameTreeSha = '';

beforeAll(async () => {
  nameFaultsDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-nameFaults-'));
  initRepo(nameFaultsDir);

  const blobSha = runGit(['-C', nameFaultsDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();
  const blobShaBytes = Buffer.from(blobSha, 'hex');

  const refsDir = path.join(nameFaultsDir, '.git', 'refs', 'heads');
  await mkdir(refsDir, { recursive: true });

  const writeTreeNamed = async (name: string): Promise<string> => {
    const modeAndName = Buffer.from(`100644 ${name}\0`);
    const treeBody = Buffer.concat([modeAndName, blobShaBytes]);
    return writeLooseObject(nameFaultsDir, 'tree', treeBody);
  };

  const pointRefAtTree = async (ref: string, treeSha: string): Promise<void> => {
    const commitBody = Buffer.from(
      `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\n${ref}\n`,
    );
    const commitSha = await writeLooseObject(nameFaultsDir, 'commit', commitBody);
    await writeFile(path.join(refsDir, ref), `${commitSha}\n`);
  };

  hasDotTreeSha = await writeTreeNamed('.');
  hasDotdotTreeSha = await writeTreeNamed('..');
  fullPathnameTreeSha = await writeTreeNamed('a/b');

  await pointRefAtTree('hasDot', hasDotTreeSha);
  await pointRefAtTree('hasDotdot', hasDotdotTreeSha);
  await pointRefAtTree('fullPathname', fullPathnameTreeSha);

  nameFaultsCtx = createNodeContext({ workDir: nameFaultsDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (nameFaultsDir !== '') await rm(nameFaultsDir, { recursive: true, force: true });
});

// --- Scenario: corrupt loose object ------------------------------------------

let corruptDir = '';
let corruptCtx: Context;
let corruptBlobSha = '';

beforeAll(async () => {
  corruptDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-corrupt-'));
  initRepo(corruptDir);

  // Write a valid blob then overwrite with garbage
  const blobSha = runGit(['-C', corruptDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'to-corrupt\n',
  }).trim();
  corruptBlobSha = blobSha;

  const prefix = blobSha.slice(0, 2);
  const suffix = blobSha.slice(2);
  const objPath = path.join(corruptDir, '.git', 'objects', prefix, suffix);
  // Make writable before overwriting (git writes objects as readonly 444)
  const { chmod } = await import('node:fs/promises');
  await chmod(objPath, 0o644);
  // Overwrite with invalid zlib data
  await writeFile(objPath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

  corruptCtx = createNodeContext({ workDir: corruptDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (corruptDir !== '') await rm(corruptDir, { recursive: true, force: true });
});

// --- Scenario: hash-path mismatch --------------------------------------------

let hashMismatchDir = '';
let hashMismatchCtx: Context;
let pathId = ''; // the oid whose PATH we use
let actualId = ''; // the oid whose CONTENT is stored there

beforeAll(async () => {
  hashMismatchDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-hashMismatch-'));
  initRepo(hashMismatchDir);

  const sha1 = runGit(['-C', hashMismatchDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'hello\n',
  }).trim();
  const sha2 = runGit(['-C', hashMismatchDir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'world\n',
  }).trim();
  pathId = sha1;
  actualId = sha2;

  // Copy sha2's compressed content to sha1's path (hash≠path)
  const sha1Path = path.join(hashMismatchDir, '.git', 'objects', sha1.slice(0, 2), sha1.slice(2));
  const sha2Path = path.join(hashMismatchDir, '.git', 'objects', sha2.slice(0, 2), sha2.slice(2));
  const sha2Content = await readFile(sha2Path);
  // Make sha1 writable before overwriting
  const { chmod } = await import('node:fs/promises');
  await chmod(sha1Path, 0o644);
  await writeFile(sha1Path, sha2Content);

  hashMismatchCtx = createNodeContext({ workDir: hashMismatchDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (hashMismatchDir !== '') await rm(hashMismatchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

// Shared by every WARN-by-default, ERROR-under-`--strict` msg-id: the severity
// flip is identical across zeroPaddedFilemode, hasDot, hasDotdot and
// fullPathname, so one matrix drives the zeroPaddedFilemode `it.each` below
// and, crossed with a 3-row name-fault table, the combined hasDot/hasDotdot/
// fullPathname `it.each` further down.
const WARN_STRICT_UPGRADE_MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly gitFlags: readonly string[];
  readonly strict: boolean;
  readonly severity: 'warning' | 'error';
  readonly exitCode: number;
}> = [
  {
    label: 'no --strict (warning, exit 0)',
    gitFlags: [],
    strict: false,
    severity: 'warning',
    exitCode: 0,
  },
  {
    label: 'with --strict (error, exit 1)',
    gitFlags: ['--strict'],
    strict: true,
    severity: 'error',
    exitCode: 1,
  },
];

// The three tree-entry name faults share one repo fixture (nameFaultsDir /
// nameFaultsCtx) and one oracle shape — only the msgId, the pre-built tree's
// sha, and git's reconstructed message suffix differ. `treeShaOf` is a thunk
// (not a direct value) because the tree shas are only populated inside the
// `beforeAll` above, after this array is defined.
const NAME_FAULT_MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly msgId: 'hasDot' | 'hasDotdot' | 'fullPathname';
  readonly treeShaOf: () => string;
  readonly gitMessageSuffix: string;
}> = [
  {
    label: 'entry name "."',
    msgId: 'hasDot',
    treeShaOf: () => hasDotTreeSha,
    gitMessageSuffix: "contains '.'",
  },
  {
    label: 'entry name ".."',
    msgId: 'hasDotdot',
    treeShaOf: () => hasDotdotTreeSha,
    gitMessageSuffix: "contains '..'",
  },
  {
    label: 'entry name containing "/"',
    msgId: 'fullPathname',
    treeShaOf: () => fullPathnameTreeSha,
    gitMessageSuffix: 'contains full pathnames',
  },
];

const NAME_FAULT_ROWS = NAME_FAULT_MATRIX.flatMap((fault) =>
  WARN_STRICT_UPGRADE_MATRIX.map((upgrade) => ({
    label: `${fault.label}, ${upgrade.label}`,
    msgId: fault.msgId,
    treeShaOf: fault.treeShaOf,
    gitMessageSuffix: fault.gitMessageSuffix,
    gitFlags: upgrade.gitFlags,
    strict: upgrade.strict,
    severity: upgrade.severity,
    exitCode: upgrade.exitCode,
  })),
);

describe.skipIf(!GIT_AVAILABLE)('Given a loose tree with zeroPaddedFilemode', () => {
  describe('When fsck runs', () => {
    it.each(WARN_STRICT_UPGRADE_MATRIX)(
      'Then emits bad-object and exit code matches real git for "$label"',
      async ({ gitFlags, strict, severity, exitCode }) => {
        // Arrange — git's expected output
        const gitResult = gitFsck(zeroPadDir, ...gitFlags);

        // Act
        const result = await fsck(zeroPadCtx, { strict });

        // Assert — exit code matches real git and the pinned expectation
        expect(result.exitCode).toBe(gitResult.exitCode);
        expect(result.exitCode).toBe(exitCode);

        // Assert — finding present with the expected severity
        const zeroPadded = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'zeroPaddedFilemode',
        );
        expect(zeroPadded).toBeDefined();
        expect(zeroPadded?.severity).toBe(severity);
        expect(zeroPadded?.id).toBe(zeroPadTreeSha);

        // Reconstruct git stderr line and assert byte-equality
        // git: "<severity> in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes"
        if (zeroPadded !== undefined) {
          const reconstructed = `${severity} in tree ${zeroPadded.id}: ${zeroPadded.msgId}: contains zero-padded file modes`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      },
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with a double-zero-padded directory mode "0040000"',
  () => {
    describe('When fsck runs with --strict', () => {
      it('Then emits zeroPaddedFilemode only, matching real git — stripping one zero is not enough', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(zeroPadAllDir, '--strict');

        // Act
        const result = await fsck(zeroPadAllCtx, { strict: true });

        // Assert — exactly zeroPaddedFilemode for this tree, no spurious badFilemode
        const msgIds = result.findings
          .filter(
            (f): f is FsckFinding & { type: 'bad-object' } =>
              f.type === 'bad-object' && f.id === zeroPadDirModeTreeSha,
          )
          .map((f) => f.msgId);
        expect(msgIds).toEqual(['zeroPaddedFilemode']);

        // Reconstruct git's stderr line and assert byte-equality
        const reconstructed = `error in tree ${zeroPadDirModeTreeSha}: zeroPaddedFilemode: contains zero-padded file modes`;
        expect(gitResult.stderr).toContain(reconstructed);
        expect(gitResult.stderr).not.toContain(`tree ${zeroPadDirModeTreeSha}: badFilemode`);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree where ".gitignore" is a symlink with zero-padded mode "0120000"',
  () => {
    describe('When fsck runs with --strict', () => {
      it('Then emits gitignoreSymlink and zeroPaddedFilemode, matching real git — the raw padded mode is not "120000"', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(zeroPadAllDir, '--strict');

        // Act
        const result = await fsck(zeroPadAllCtx, { strict: true });

        // Assert — both findings present for this tree
        const msgIds = result.findings
          .filter(
            (f): f is FsckFinding & { type: 'bad-object' } =>
              f.type === 'bad-object' && f.id === zeroPadSymlinkTreeSha,
          )
          .map((f) => f.msgId)
          .sort();
        expect(msgIds).toEqual(['gitignoreSymlink', 'zeroPaddedFilemode'].sort());

        // Reconstruct git's stderr lines and assert byte-equality
        expect(gitResult.stderr).toContain(
          `warning in tree ${zeroPadSymlinkTreeSha}: gitignoreSymlink: .gitignore is a symlink`,
        );
        expect(gitResult.stderr).toContain(
          `error in tree ${zeroPadSymlinkTreeSha}: zeroPaddedFilemode: contains zero-padded file modes`,
        );
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with a name fault only fsck --strict upgrades to error',
  () => {
    describe('When fsck runs', () => {
      it.each(NAME_FAULT_ROWS)(
        'Then emits bad-object and exit code matches real git for $msgId ($label)',
        async ({ msgId, treeShaOf, gitMessageSuffix, gitFlags, strict, severity, exitCode }) => {
          // Arrange — git's expected output
          const gitResult = gitFsck(nameFaultsDir, ...gitFlags);

          // Act
          const result = await fsck(nameFaultsCtx, { strict });

          // Assert — exit code matches real git and the pinned expectation
          expect(result.exitCode).toBe(gitResult.exitCode);
          expect(result.exitCode).toBe(exitCode);

          // Assert — finding present with the expected severity
          const finding = result.findings.find(
            (f): f is FsckFinding & { type: 'bad-object' } =>
              f.type === 'bad-object' && f.msgId === msgId,
          );
          expect(finding).toBeDefined();
          expect(finding?.severity).toBe(severity);
          expect(finding?.id).toBe(treeShaOf());

          // Reconstruct git stderr line and assert byte-equality
          // git: "<severity> in tree <sha>: <msgId>: <gitMessageSuffix>"
          if (finding !== undefined) {
            const reconstructed = `${severity} in tree ${finding.id}: ${finding.msgId}: ${gitMessageSuffix}`;
            expect(gitResult.stderr).toContain(reconstructed);
          }
        },
      );
    });
  },
);

const DUPLICATE_ENTRIES_MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly strict: boolean;
}> = [
  { label: 'no --strict', strict: false },
  { label: 'with --strict', strict: true },
];

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with duplicateEntries (ERROR catalogue entry, unaffected by --strict)',
  () => {
    describe('When fsck runs', () => {
      it.each(DUPLICATE_ENTRIES_MATRIX)(
        'Then emits error bad-object and exit code matches real git for "$label"',
        async ({ strict }) => {
          // Arrange — git's expected output
          const gitFlags = strict ? ['--strict'] : [];
          const gitResult = gitFsck(catalogueDir, ...gitFlags);

          // Act
          const result = await fsck(catalogueCtx, { strict });

          // Assert — exit code includes bit 1 (ERROR finding) in both modes
          expect(result.exitCode & 1).toBe(1);
          expect(gitResult.exitCode & 1).toBe(1);

          // Assert — duplicateEntries stays error severity even under --strict
          const duplicate = result.findings.find(
            (f): f is FsckFinding & { type: 'bad-object' } =>
              f.type === 'bad-object' && f.msgId === 'duplicateEntries',
          );
          expect(duplicate).toBeDefined();
          expect(duplicate?.severity).toBe('error');
          expect(duplicate?.id).toBe(duplicateEntriesTreeSha);

          // Reconstruct git stderr line
          // git: "error in tree <sha>: duplicateEntries: contains duplicate file entries"
          if (duplicate !== undefined) {
            const reconstructed = `error in tree ${duplicate.id}: ${duplicate.msgId}: contains duplicate file entries`;
            expect(gitResult.stderr).toContain(reconstructed);
          }
        },
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with treeNotSorted (ERROR catalogue entry)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output (run fsck for the whole repo, filter for this tree)
        const gitResult = gitFsck(catalogueDir);

        // Act
        const result = await fsck(catalogueCtx);

        // Assert — exit code includes bit 1 (ERROR finding)
        expect(result.exitCode & 1).toBe(1);
        // git exit code also includes bit 1
        expect(gitResult.exitCode & 1).toBe(1);

        // Assert — treeNotSorted finding present
        const notSorted = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'treeNotSorted',
        );
        expect(notSorted).toBeDefined();
        expect(notSorted?.severity).toBe('error');
        expect(notSorted?.id).toBe(sortedTreeSha);

        // Reconstruct git stderr line
        // git: "error in tree <sha>: treeNotSorted: not properly sorted"
        if (notSorted !== undefined) {
          const reconstructed = `error in tree ${notSorted.id}: ${notSorted.msgId}: not properly sorted`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose commit with missingSpaceBeforeEmail (ERROR catalogue entry)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(catalogueDir);

        // Act
        const result = await fsck(catalogueCtx);

        // Assert — missingSpaceBeforeEmail finding present
        const missingSpace = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'missingSpaceBeforeEmail',
        );
        expect(missingSpace).toBeDefined();
        expect(missingSpace?.severity).toBe('error');
        expect(missingSpace?.id).toBe(badEmailCommitSha);

        // Reconstruct git stderr line
        // git: "error in commit <sha>: missingSpaceBeforeEmail: invalid author/committer line - missing space before email"
        if (missingSpace !== undefined) {
          const reconstructed = `error in commit ${missingSpace.id}: ${missingSpace.msgId}: invalid author/committer line - missing space before email`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // exit bit 1 must be set
        expect(result.exitCode & 1).toBe(1);
        expect(gitResult.exitCode & 1).toBe(1);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given a corrupt (undecodable) loose object', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-object finding and exit code has bit 1 (matches real git)', async () => {
      // Arrange
      const gitResult = gitFsck(corruptDir);

      // Act
      const result = await fsck(corruptCtx);

      // Assert — exit code: bit 1 set (matches real git exit 1 for dangling corrupt blob)
      expect(result.exitCode & 1).toBe(1);
      expect(gitResult.exitCode & 1).toBe(1);

      // Assert — bad-object finding for the corrupt oid
      const corrupt = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && f.id === corruptBlobSha,
      );
      expect(corrupt).toBeDefined();
      expect(corrupt?.severity).toBe('error');
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose object whose content hash does not match its path (hash-path mismatch)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits hash-mismatch finding and exit code has bit 1 (matches real git)', async () => {
        // Arrange
        const gitResult = gitFsck(hashMismatchDir);

        // Act
        const result = await fsck(hashMismatchCtx);

        // Assert — exit code bit 1 matches real git (both exit 1)
        expect(result.exitCode & 1).toBe(1);
        expect(gitResult.exitCode & 1).toBe(1);

        // Assert — hash-mismatch finding present
        const mismatch = result.findings.find(
          (f): f is FsckFinding & { type: 'hash-mismatch' } =>
            f.type === 'hash-mismatch' && f.id === pathId,
        );
        expect(mismatch).toBeDefined();
        expect(mismatch?.actual).toBe(actualId);

        // Reconstruct git stderr line
        // git: "error: <actual-sha>: hash-path mismatch, found at: .git/objects/<prefix>/<suffix>"
        if (mismatch !== undefined) {
          const reconstructed = `${mismatch.actual}: hash-path mismatch, found at:`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Refs-verify pass — a ref naming a well-formed but absent sha (exit 2)
// ---------------------------------------------------------------------------
// Pinned against real git 2.54.0:
//   stderr: "error: refs/heads/broken: invalid sha1 pointer <sha>"
//   exit: 2 (bit 2; same with/without --no-references)

let refAbsentDir = '';
let refAbsentCtx: Context;
const ABSENT_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

beforeAll(async () => {
  refAbsentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refAbsent-'));
  initRepo(refAbsentDir);
  // Write a valid-format but absent OID to a loose ref (bypasses git's write-side check)
  await mkdir(path.join(refAbsentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(refAbsentDir, '.git', 'refs', 'heads', 'broken'), `${ABSENT_OID}\n`);
  refAbsentCtx = createNodeContext({ workDir: refAbsentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (refAbsentDir !== '') await rm(refAbsentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)('Given a loose ref naming a well-formed but absent OID', () => {
  describe('When fsck runs', () => {
    it('Then emits bad-ref badRefOid, exit code 2 matches real git', async () => {
      // Arrange — git's expected output
      const gitResult = gitFsck(refAbsentDir);

      // Act
      const result = await fsck(refAbsentCtx);

      // Assert — exit code 2 (absent OID = bit 2)
      expect(result.exitCode).toBe(2);
      expect(gitResult.exitCode).toBe(2);

      // Assert — badRefOid finding present
      const badRef = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefOid',
      );
      expect(badRef).toBeDefined();
      expect(badRef?.severity).toBe('error');
      expect(badRef?.ref).toBe('refs/heads/broken');
      expect(badRef?.target).toBe(ABSENT_OID);

      // Reconstruct git's exact stderr line and assert byte-equality
      // git: "error: refs/heads/broken: invalid sha1 pointer <sha>"
      if (badRef !== undefined) {
        const reconstructed = `${badRef.ref}: invalid sha1 pointer ${badRef.target}`;
        expect(gitResult.stderr).toContain(reconstructed);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Refs-verify pass — a ref holding malformed content (exit 10 = 2|8)
// ---------------------------------------------------------------------------
// Pinned against real git 2.54.0:
//   stderr line 1: "error: refs/heads/garbage: badRefContent: not-a-valid-sha"
//   stderr line 2: "error: refs/heads/garbage: invalid sha1 pointer 0000...0"
//   exit: 10 (2|8)

let refBadContentDir = '';
let refBadContentCtx: Context;
const BAD_CONTENT = 'not-a-valid-sha';
const ZERO_OID_STR = '0000000000000000000000000000000000000000';

beforeAll(async () => {
  refBadContentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refBadContent-'));
  initRepo(refBadContentDir);
  // Write malformed content to a loose ref (bypasses git's write-side check)
  await mkdir(path.join(refBadContentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(refBadContentDir, '.git', 'refs', 'heads', 'garbage'),
    `${BAD_CONTENT}\n`,
  );
  refBadContentCtx = createNodeContext({ workDir: refBadContentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (refBadContentDir !== '') await rm(refBadContentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose ref holding malformed content, so the exit is 10 = 2|8',
  () => {
    describe('When fsck runs', () => {
      it('Then emits badRefContent + badRefOid(zero), composite exit 10 matches real git', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(refBadContentDir);

        // Act
        const result = await fsck(refBadContentCtx);

        // Assert — composite exit 10 = 2|8 (badRefContent bit 8 + absent zero-OID bit 2)
        expect(result.exitCode).toBe(10);
        expect(gitResult.exitCode).toBe(10);

        // Assert — badRefContent finding
        const badRefContent = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefContent',
        );
        expect(badRefContent).toBeDefined();
        expect(badRefContent?.severity).toBe('error');
        expect(badRefContent?.ref).toBe('refs/heads/garbage');

        // Reconstruct git's first stderr line:
        // "error: refs/heads/garbage: badRefContent: not-a-valid-sha"
        if (badRefContent !== undefined) {
          const reconstructed = `${badRefContent.ref}: badRefContent: ${BAD_CONTENT}`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // Assert — badRefOid finding for synthesised zero OID
        const badRefOid = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefOid',
        );
        expect(badRefOid).toBeDefined();
        expect(badRefOid?.target).toBe(ZERO_OID_STR);

        // Reconstruct git's second stderr line:
        // "error: refs/heads/garbage: invalid sha1 pointer 0000...0"
        if (badRefOid !== undefined) {
          const reconstructed = `${badRefOid.ref}: invalid sha1 pointer ${badRefOid.target}`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Null-oid sentinel regression pin — a normal repo with commit + reflog
// must produce exit 0 / no findings (git fsck 2.54.0: "0000…0" in the
// initial reflog entry is the "no object" sentinel, never a real reference)
// ---------------------------------------------------------------------------

let reflogSentinelDir = '';
let reflogSentinelCtx: Context;

beforeAll(async () => {
  reflogSentinelDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-reflogSentinel-'));
  initRepo(reflogSentinelDir);
  // Make a real commit via git so a reflog is written automatically.
  // The initial reflog entry will have oldId = 0000…0 (the null-oid sentinel).
  await writeFile(path.join(reflogSentinelDir, 'readme.txt'), 'hello\n');
  runGit(['-C', reflogSentinelDir, 'add', 'readme.txt'], { env: SAFE_ENV });
  runGit(['-C', reflogSentinelDir, 'commit', '-m', 'initial commit'], { env: SAFE_ENV });
  reflogSentinelCtx = createNodeContext({ workDir: reflogSentinelDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (reflogSentinelDir !== '') await rm(reflogSentinelDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a normal repo with one commit (reflog initial entry has null-oid oldId)',
  () => {
    describe('When fsck runs', () => {
      it('Then exit code 0 and no missing/broken-link findings (null-oid sentinel is not a root)', async () => {
        // Arrange — real git's expected output (clean repo → exit 0, no output)
        const gitResult = gitFsck(reflogSentinelDir);

        // Act
        const result = await fsck(reflogSentinelCtx);

        // Assert — exit code 0 matches real git
        expect(result.exitCode).toBe(0);
        expect(gitResult.exitCode).toBe(0);

        // Assert — no missing or broken-link findings (null-oid is not treated as a root)
        const missingFindings = result.findings.filter((f) => f.type === 'missing');
        expect(missingFindings).toHaveLength(0);

        const brokenLinks = result.findings.filter((f) => f.type === 'broken-link');
        expect(brokenLinks).toHaveLength(0);

        // Assert — git produces no error output for a clean repo
        expect(gitResult.stderr).toBe('');
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FIX 1 — .gitmodules blob content checks (gitmodulesUrl / gitmodulesParse)
// Pinned real git 2.54.0:
//   gitmodulesUrl: stderr "error in blob <sha>: gitmodulesUrl: disallowed submodule url: ..."
//   exit 1 (bit 1 = content-ERROR)
//   gitmodulesParse: stderr "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob"
//   exit 0 (INFO alone)
// ---------------------------------------------------------------------------

let gitmodulesUrlDir = '';
let gitmodulesUrlCtx: Context;
let gitmodulesUrlBlobSha = '';

beforeAll(async () => {
  gitmodulesUrlDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-gitmodulesUrl-'));
  initRepo(gitmodulesUrlDir);

  // Write .gitmodules blob with a disallowed URL (starts with '--')
  const gitmodulesContent = Buffer.from(
    '[submodule "evil"]\n\tpath = evil\n\turl = --upload-pack=evil\n',
  );
  gitmodulesUrlBlobSha = await writeLooseObject(gitmodulesUrlDir, 'blob', gitmodulesContent);

  const blobShaBytes = Buffer.from(gitmodulesUrlBlobSha, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 .gitmodules\0'), blobShaBytes]);
  const treeSha = await writeLooseObject(gitmodulesUrlDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nadd .gitmodules with evil url\n`,
  );
  const commitSha = await writeLooseObject(gitmodulesUrlDir, 'commit', commitBody);
  await mkdir(path.join(gitmodulesUrlDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(gitmodulesUrlDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await writeFile(path.join(gitmodulesUrlDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  gitmodulesUrlCtx = createNodeContext({ workDir: gitmodulesUrlDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (gitmodulesUrlDir !== '') await rm(gitmodulesUrlDir, { recursive: true, force: true });
});

let gitmodulesParseDir = '';
let gitmodulesParseCtx: Context;
let gitmodulesParseBlobSha = '';

beforeAll(async () => {
  gitmodulesParseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-gitmodulesParse-'));
  initRepo(gitmodulesParseDir);

  // Write an unparseable .gitmodules blob (unclosed section header)
  const gitmodulesContent = Buffer.from(
    '[submodule "bad"\npath = evil\nurl = git://example.com/evil\n',
  );
  gitmodulesParseBlobSha = await writeLooseObject(gitmodulesParseDir, 'blob', gitmodulesContent);

  const blobShaBytes = Buffer.from(gitmodulesParseBlobSha, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 .gitmodules\0'), blobShaBytes]);
  const treeSha = await writeLooseObject(gitmodulesParseDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${treeSha}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nbad gitmodules\n`,
  );
  const commitSha = await writeLooseObject(gitmodulesParseDir, 'commit', commitBody);
  await mkdir(path.join(gitmodulesParseDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(gitmodulesParseDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await writeFile(path.join(gitmodulesParseDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  gitmodulesParseCtx = createNodeContext({ workDir: gitmodulesParseDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (gitmodulesParseDir !== '') await rm(gitmodulesParseDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a .gitmodules blob with a disallowed URL (--upload-pack=evil)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits gitmodulesUrl bad-object finding and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        // Pinned real git 2.54.0: stderr "error in blob <sha>: gitmodulesUrl: disallowed submodule url: --upload-pack=evil", exit 1
        const gitResult = gitFsck(gitmodulesUrlDir);

        // Act
        const result = await fsck(gitmodulesUrlCtx);

        // Assert — exit code 1 matches real git
        expect(result.exitCode).toBe(1);
        expect(gitResult.exitCode).toBe(1);

        // Assert — gitmodulesUrl finding present
        const gitmodulesUrl = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'gitmodulesUrl',
        );
        expect(gitmodulesUrl).toBeDefined();
        expect(gitmodulesUrl?.id).toBe(gitmodulesUrlBlobSha);
        expect(gitmodulesUrl?.objectType).toBe('blob');
        expect(gitmodulesUrl?.severity).toBe('error');

        // Reconstruct git's exact stderr line and assert byte-equality
        // git: "error in blob <sha>: gitmodulesUrl: disallowed submodule url: --upload-pack=evil"
        if (gitmodulesUrl !== undefined) {
          const reconstructed = `error in blob ${gitmodulesUrl.id}: ${gitmodulesUrl.msgId}: disallowed submodule url:`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a .gitmodules blob that cannot be parsed (malformed INI)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits gitmodulesParse bad-object finding with info severity and exit code 0 (INFO alone)', async () => {
        // Arrange — git's expected output
        // Pinned real git 2.54.0: stderr "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob", exit 0
        const gitResult = gitFsck(gitmodulesParseDir);

        // Act
        const result = await fsck(gitmodulesParseCtx);

        // Assert — exit code 0 matches real git (INFO finding alone does not set exit bit)
        expect(result.exitCode).toBe(0);
        expect(gitResult.exitCode).toBe(0);

        // Assert — gitmodulesParse finding present
        const gitmodulesParse = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'gitmodulesParse',
        );
        expect(gitmodulesParse).toBeDefined();
        expect(gitmodulesParse?.id).toBe(gitmodulesParseBlobSha);
        expect(gitmodulesParse?.objectType).toBe('blob');
        expect(gitmodulesParse?.severity).toBe('info');

        // Reconstruct git's exact stderr line and assert byte-equality
        // git: "warning in blob <sha>: gitmodulesParse: could not parse gitmodules blob"
        if (gitmodulesParse !== undefined) {
          const reconstructed = `warning in blob ${gitmodulesParse.id}: ${gitmodulesParse.msgId}: could not parse gitmodules blob`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

// ---------------------------------------------------------------------------
// FIX A — per-edge-type broken-link + missing taxonomy
//
// Pinned real git 2.54.0: for EVERY edge type (tree→blob, tree→tree,
// commit→tree, commit→parent, tag→target) git emits:
//   "broken link from <fromType> <fromId>\n              to  <toType> <toId>"
//   "missing <toType> <toId>"
// exit 2 (bit 2 = missing/broken-link).
// tsgit's structured findings must produce the same reconstruction.
// ---------------------------------------------------------------------------

// -- Shared helpers for connectivity pin scenarios --------------------------

/**
 * Format a "broken link from … to …" line the same way git prints it, for
 * byte-equality assertion against real git stderr.
 * git pads the "from" type to 6 chars and "to" type to 6 chars.
 */
function reconstructBrokenLink(
  fromType: string,
  fromId: string,
  _toType: string,
  _toId: string,
): string {
  // git fsck 2.54.0 format (stdout):
  //   "broken link from    tree <sha>"
  //   "              to    blob <sha>"
  // The type name is right-padded in a field of width 8 (no space between "from" and field):
  //   commit (6) → "  commit", tree (4) → "    tree", blob (4) → "    blob", tag (3) → "     tag"
  return `broken link from${fromType.padStart(8)} ${fromId}`;
}

function reconstructMissing(objectType: string, id: string): string {
  return `missing ${objectType} ${id}`;
}

// --- Connectivity scenario: tree → missing blob ----------------------------

let connTreeBlobDir = '';
let connTreeBlobCtx: Context;
let connTreeBlobTreeSha = '';
const CONN_MISSING_BLOB = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';

beforeAll(async () => {
  connTreeBlobDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-blob-'));
  initRepo(connTreeBlobDir);

  const blobShaBytes = Buffer.from(CONN_MISSING_BLOB, 'hex');
  const treeBody = Buffer.concat([Buffer.from('100644 file.txt\0'), blobShaBytes]);
  connTreeBlobTreeSha = await writeLooseObject(connTreeBlobDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${connTreeBlobTreeSha}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ntree-miss-blob\n`,
  );
  const commitSha = await writeLooseObject(connTreeBlobDir, 'commit', commitBody);
  await mkdir(path.join(connTreeBlobDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(connTreeBlobDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await rm(path.join(connTreeBlobDir, '.git', 'logs'), { recursive: true, force: true });

  connTreeBlobCtx = createNodeContext({ workDir: connTreeBlobDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTreeBlobDir !== '') await rm(connTreeBlobDir, { recursive: true, force: true });
});

// --- Connectivity scenario: tree → missing sub-tree ------------------------

let connTreeSubtreeDir = '';
let connTreeSubtreeCtx: Context;
let connTreeSubtreeTreeSha = '';
const CONN_MISSING_SUBTREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbc';

beforeAll(async () => {
  connTreeSubtreeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-subtree-'));
  initRepo(connTreeSubtreeDir);

  const subtreeShaBytes = Buffer.from(CONN_MISSING_SUBTREE, 'hex');
  const treeBody = Buffer.concat([Buffer.from('40000 subdir\0'), subtreeShaBytes]);
  connTreeSubtreeTreeSha = await writeLooseObject(connTreeSubtreeDir, 'tree', treeBody);

  const commitBody = Buffer.from(
    `tree ${connTreeSubtreeTreeSha}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ntree-miss-subtree\n`,
  );
  const commitSha = await writeLooseObject(connTreeSubtreeDir, 'commit', commitBody);
  await mkdir(path.join(connTreeSubtreeDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(connTreeSubtreeDir, '.git', 'refs', 'heads', 'main'), `${commitSha}\n`);
  await rm(path.join(connTreeSubtreeDir, '.git', 'logs'), { recursive: true, force: true });

  connTreeSubtreeCtx = createNodeContext({ workDir: connTreeSubtreeDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTreeSubtreeDir !== '') await rm(connTreeSubtreeDir, { recursive: true, force: true });
});

// --- Connectivity scenario: commit → missing tree --------------------------

let connCommitTreeDir = '';
let connCommitTreeCtx: Context;
let connCommitTreeCommitSha = '';
const CONN_MISSING_TREE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef0';

beforeAll(async () => {
  connCommitTreeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-tree-'));
  initRepo(connCommitTreeDir);

  const commitBody = Buffer.from(
    `tree ${CONN_MISSING_TREE}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ncommit-miss-tree\n`,
  );
  connCommitTreeCommitSha = await writeLooseObject(connCommitTreeDir, 'commit', commitBody);
  await mkdir(path.join(connCommitTreeDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(connCommitTreeDir, '.git', 'refs', 'heads', 'main'),
    `${connCommitTreeCommitSha}\n`,
  );
  await rm(path.join(connCommitTreeDir, '.git', 'logs'), { recursive: true, force: true });

  connCommitTreeCtx = createNodeContext({ workDir: connCommitTreeDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connCommitTreeDir !== '') await rm(connCommitTreeDir, { recursive: true, force: true });
});

// --- Connectivity scenario: commit → missing parent commit -----------------

let connCommitParentDir = '';
let connCommitParentCtx: Context;
let connCommitParentCommitSha = '';
const CONN_MISSING_PARENT = 'cccccccccccccccccccccccccccccccccccccccd';

beforeAll(async () => {
  connCommitParentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-parent-'));
  initRepo(connCommitParentDir);

  // Write an empty tree (4b825dc…) to the object store
  const emptyTreeBody = Buffer.alloc(0);
  const emptyTreeSha = await writeLooseObject(connCommitParentDir, 'tree', emptyTreeBody);

  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nparent ${CONN_MISSING_PARENT}\nauthor Test <t@t.com> 1700000000 +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\ncommit-miss-parent\n`,
  );
  connCommitParentCommitSha = await writeLooseObject(connCommitParentDir, 'commit', commitBody);
  await mkdir(path.join(connCommitParentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(connCommitParentDir, '.git', 'refs', 'heads', 'main'),
    `${connCommitParentCommitSha}\n`,
  );
  await rm(path.join(connCommitParentDir, '.git', 'logs'), { recursive: true, force: true });

  connCommitParentCtx = createNodeContext({ workDir: connCommitParentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connCommitParentDir !== '') await rm(connCommitParentDir, { recursive: true, force: true });
});

// --- Connectivity scenario: tag → missing target ---------------------------

let connTagTargetDir = '';
let connTagTargetCtx: Context;
let connTagTargetTagSha = '';
const CONN_MISSING_TAG_TARGET = 'ddddddddddddddddddddddddddddddddddddddde';

beforeAll(async () => {
  connTagTargetDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-conn-tag-'));
  initRepo(connTagTargetDir);

  const tagBody = Buffer.from(
    `object ${CONN_MISSING_TAG_TARGET}\ntype commit\ntag v-missing\ntagger Test <t@t.com> 1700000000 +0000\n\ntag with missing target\n`,
  );
  connTagTargetTagSha = await writeLooseObject(connTagTargetDir, 'tag', tagBody);
  await mkdir(path.join(connTagTargetDir, '.git', 'refs', 'tags'), { recursive: true });
  await writeFile(
    path.join(connTagTargetDir, '.git', 'refs', 'tags', 'v-missing'),
    `${connTagTargetTagSha}\n`,
  );
  await rm(path.join(connTagTargetDir, '.git', 'logs'), { recursive: true, force: true });

  connTagTargetCtx = createNodeContext({ workDir: connTagTargetDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (connTagTargetDir !== '') await rm(connTagTargetDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// FIX B — badDateOverflow
//
// Pinned real git 2.54.0:
//   Commit with author/committer timestamp > INT64_MAX (9223372036854775807):
//     stderr: "error in commit <sha>: badDateOverflow: invalid author/committer
//              line - date causes integer overflow"
//     exit: 1 (bit 1 = content error)
//   Tag with tagger timestamp > INT64_MAX:
//     stderr: "error in tag <sha>: badDateOverflow: invalid author/committer
//              line - date causes integer overflow"
//     exit: 1
//   Boundary value 9223372036854775807 (INT64_MAX itself): NO error.
//   Non-numeric date: badDate (not badDateOverflow).
// ---------------------------------------------------------------------------

const OVERFLOW_TIMESTAMP = '99999999999999999999';

let badDateOverflowDir = '';
let badDateOverflowCtx: Context;
let overflowCommitSha = '';
let overflowTagSha = '';

beforeAll(async () => {
  badDateOverflowDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-badDateOvf-'));
  initRepo(badDateOverflowDir);

  // Empty tree
  const emptyTreeBody = Buffer.alloc(0);
  const emptyTreeSha = await writeLooseObject(badDateOverflowDir, 'tree', emptyTreeBody);

  // Commit with overflowing author timestamp
  const commitBody = Buffer.from(
    `tree ${emptyTreeSha}\nauthor Test <t@t.com> ${OVERFLOW_TIMESTAMP} +0000\ncommitter Test <t@t.com> 1700000000 +0000\n\noverflow commit\n`,
  );
  overflowCommitSha = await writeLooseObject(badDateOverflowDir, 'commit', commitBody);
  await mkdir(path.join(badDateOverflowDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(
    path.join(badDateOverflowDir, '.git', 'refs', 'heads', 'main'),
    `${overflowCommitSha}\n`,
  );

  // Tag with overflowing tagger timestamp
  const tagBody = Buffer.from(
    `object ${emptyTreeSha}\ntype tree\ntag v-overflow\ntagger Test <t@t.com> ${OVERFLOW_TIMESTAMP} +0000\n\noverflow tag\n`,
  );
  overflowTagSha = await writeLooseObject(badDateOverflowDir, 'tag', tagBody);
  await mkdir(path.join(badDateOverflowDir, '.git', 'refs', 'tags'), { recursive: true });
  await writeFile(
    path.join(badDateOverflowDir, '.git', 'refs', 'tags', 'v-overflow'),
    `${overflowTagSha}\n`,
  );

  await rm(path.join(badDateOverflowDir, '.git', 'logs'), { recursive: true, force: true });

  badDateOverflowCtx = createNodeContext({ workDir: badDateOverflowDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (badDateOverflowDir !== '') await rm(badDateOverflowDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given commit and tag with tagger/author timestamps overflowing INT64_MAX (badDateOverflow)',
  () => {
    describe('When fsck runs', () => {
      it('Then emits badDateOverflow bad-object findings and exit code 1 matches real git', async () => {
        // Arrange
        // Pinned real git 2.54.0:
        //   "error in commit <sha>: badDateOverflow: invalid author/committer line - date causes integer overflow"
        //   "error in tag <sha>: badDateOverflow: invalid author/committer line - date causes integer overflow"
        //   exit: 1
        const gitResult = gitFsck(badDateOverflowDir, '--no-reflogs');

        // Act
        const result = await fsck(badDateOverflowCtx, { reflogRoots: false });

        // Assert — exit code 1 matches real git
        expect(result.exitCode).toBe(1);
        expect(gitResult.exitCode).toBe(1);

        // Assert — badDateOverflow finding on commit
        const commitFinding = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' &&
            f.msgId === 'badDateOverflow' &&
            (f as { id: string }).id === overflowCommitSha,
        );
        expect(commitFinding).toBeDefined();
        expect(commitFinding?.severity).toBe('error');
        expect(commitFinding?.objectType).toBe('commit');

        // Reconstruct git's stderr line for commit
        if (commitFinding !== undefined) {
          const reconstructed = `error in commit ${(commitFinding as { id: string }).id}: badDateOverflow: invalid author/committer line - date causes integer overflow`;
          expect(gitResult.stderr).toContain(reconstructed);
        }

        // Assert — badDateOverflow finding on tag
        const tagFinding = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' &&
            f.msgId === 'badDateOverflow' &&
            (f as { id: string }).id === overflowTagSha,
        );
        expect(tagFinding).toBeDefined();
        expect(tagFinding?.severity).toBe('error');
        expect(tagFinding?.objectType).toBe('tag');

        // Reconstruct git's stderr line for tag
        if (tagFinding !== undefined) {
          const reconstructed = `error in tag ${(tagFinding as { id: string }).id}: badDateOverflow: invalid author/committer line - date causes integer overflow`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
    });
  },
);

type BrokenLinkMissingEdgeType = 'blob' | 'tree' | 'commit';

const BROKEN_LINK_MISSING_MATRIX: ReadonlyArray<{
  readonly label: string;
  readonly getDir: () => string;
  readonly getCtx: () => Context;
  readonly getFromId: () => string;
  readonly toId: string;
  readonly fromType: 'tree' | 'commit' | 'tag';
  readonly toType: BrokenLinkMissingEdgeType;
}> = [
  {
    label: 'tree→missing-blob',
    getDir: () => connTreeBlobDir,
    getCtx: () => connTreeBlobCtx,
    getFromId: () => connTreeBlobTreeSha,
    toId: CONN_MISSING_BLOB,
    fromType: 'tree',
    toType: 'blob',
  },
  {
    label: 'tree→missing-subtree',
    getDir: () => connTreeSubtreeDir,
    getCtx: () => connTreeSubtreeCtx,
    getFromId: () => connTreeSubtreeTreeSha,
    toId: CONN_MISSING_SUBTREE,
    fromType: 'tree',
    toType: 'tree',
  },
  {
    label: 'commit→missing-tree',
    getDir: () => connCommitTreeDir,
    getCtx: () => connCommitTreeCtx,
    getFromId: () => connCommitTreeCommitSha,
    toId: CONN_MISSING_TREE,
    fromType: 'commit',
    toType: 'tree',
  },
  {
    label: 'commit→missing-parent',
    getDir: () => connCommitParentDir,
    getCtx: () => connCommitParentCtx,
    getFromId: () => connCommitParentCommitSha,
    toId: CONN_MISSING_PARENT,
    fromType: 'commit',
    toType: 'commit',
  },
  {
    label: 'tag→missing-target',
    getDir: () => connTagTargetDir,
    getCtx: () => connTagTargetCtx,
    getFromId: () => connTagTargetTagSha,
    toId: CONN_MISSING_TAG_TARGET,
    fromType: 'tag',
    toType: 'commit',
  },
];

describe.skipIf(!GIT_AVAILABLE)(
  'Given a broken link to a missing object across every edge type (tree→blob, tree→tree, commit→tree, commit→parent, tag→commit)',
  () => {
    describe('When fsck runs', () => {
      it.each(BROKEN_LINK_MISSING_MATRIX)(
        'Then emits broken-link + missing findings and exit code 2 matches real git for "$label"',
        async ({ getDir, getCtx, getFromId, toId, fromType, toType }) => {
          // Arrange
          // Pinned real git 2.54.0, for every edge type:
          //   "broken link from <fromType> <fromId>\n              to  <toType> <toId>"
          //   "missing <toType> <toId>"
          //   exit 2
          const dir = getDir();
          const fromId = getFromId();
          const gitResult = gitFsck(dir, '--no-reflogs');

          // Act
          const result = await fsck(getCtx(), { reflogRoots: false });

          // Assert — exit code 2
          expect(result.exitCode).toBe(2);
          expect(gitResult.exitCode).toBe(2);

          // Assert — broken-link finding
          const brokenLink = result.findings.find(
            (f): f is FsckFinding & { type: 'broken-link' } =>
              f.type === 'broken-link' &&
              (f as { fromId: string }).fromId === fromId &&
              (f as { toId: string }).toId === toId,
          );
          expect(brokenLink).toBeDefined();
          expect(brokenLink).toMatchObject({ fromType, toType });

          // Reconstruct "broken link from ... to ..." line (stdout)
          if (brokenLink !== undefined) {
            const reconstructed = reconstructBrokenLink(fromType, fromId, toType, toId);
            expect(gitResult.stdout).toContain(reconstructed);
          }

          // Assert — missing finding
          const missing = result.findings.find(
            (f): f is FsckFinding & { type: 'missing' } =>
              f.type === 'missing' && (f as { id: string }).id === toId,
          );
          expect(missing).toBeDefined();
          expect(missing).toMatchObject({ objectType: toType });

          if (missing !== undefined) {
            expect(gitResult.stdout).toContain(reconstructMissing(toType, toId));
          }
        },
      );
    });
  },
);

// --- Scenario: oid width is fixed by the repository's hash algorithm --------
//
// A commit whose `tree` line carries the OTHER algorithm's hex width is
// corrupt. Measured on git 2.55.0, `git fsck --strict` exits 1 in BOTH
// directions — a 64-hex tree pointer in a SHA-1 repository and a 40-hex one
// in a SHA-256 repository — because `parse_oid_hex` takes its width from the
// repository's algorithm, so neither is a whole oid there.
//
// git reports these as unparseable objects ("bogus commit object") rather
// than through a catalogue msg-id, because the object fails to parse before
// fsck's content checks run. tsgit parses tolerantly on purpose so the
// catalogue stays reachable (see `validateObject`), so what is pinned here is
// the VERDICT both tools agree on — a bad-object finding and exit bit 1 — not
// git's message text.

function initRepoWithFormat(dir: string, objectFormat: 'sha1' | 'sha256'): void {
  runGit(['-C', dir, 'init', '-q', '-b', 'main', `--object-format=${objectFormat}`], {
    env: SAFE_ENV,
  });
  runGit(['-C', dir, 'config', 'user.name', 'Test'], { env: SAFE_ENV });
  runGit(['-C', dir, 'config', 'user.email', 'test@example.com'], { env: SAFE_ENV });
}

/** Write a commit whose `tree` line carries `treeOid`, bypassing git's own validation. */
function writeCommitWithTreeOid(dir: string, treeOid: string): string {
  const identity = 'Test <test@example.com> 1234567890 +0000';
  const body = `tree ${treeOid}\nauthor ${identity}\ncommitter ${identity}\n\nwidth\n`;
  return runGit(['-C', dir, 'hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], {
    env: SAFE_ENV,
    input: body,
  }).trim();
}

const SHA1_WIDTH_TREE_OID = 'a'.repeat(40);
const SHA256_WIDTH_TREE_OID = 'a'.repeat(64);

let widthSha1Dir = '';
let widthSha256Dir = '';

beforeAll(async () => {
  widthSha1Dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-width-sha1-'));
  initRepoWithFormat(widthSha1Dir, 'sha1');
  writeCommitWithTreeOid(widthSha1Dir, SHA256_WIDTH_TREE_OID);

  widthSha256Dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-width-sha256-'));
  initRepoWithFormat(widthSha256Dir, 'sha256');
  writeCommitWithTreeOid(widthSha256Dir, SHA1_WIDTH_TREE_OID);
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (widthSha1Dir !== '') await rm(widthSha1Dir, { recursive: true, force: true });
  if (widthSha256Dir !== '') await rm(widthSha256Dir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a SHA-1 repository holding a commit whose tree oid is SHA-256 width',
  () => {
    describe('When fsck runs', () => {
      it('Then reports the commit as bad and exits 1, as real git does', async () => {
        // Arrange
        const gitResult = gitFsck(widthSha1Dir, '--strict');
        const sut = await openTrackedRepository({ cwd: widthSha1Dir });

        // Act
        const result = await sut.fsck({ strict: true });

        // Assert — both tools call the repository corrupt
        expect(gitResult.exitCode & 1).toBe(1);
        expect(result.exitCode & 1).toBe(1);

        // Assert — tsgit attributes it to the tree pointer
        const badTree = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'badTreeSha1',
        );
        expect(badTree).toBeDefined();
        expect(badTree?.severity).toBe('error');
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a SHA-256 repository holding a commit whose tree oid is SHA-1 width',
  () => {
    describe('When fsck runs', () => {
      it('Then reports the commit as bad and exits 1, as real git does', async () => {
        // Arrange
        const gitResult = gitFsck(widthSha256Dir, '--strict');
        const sut = await openTrackedRepository({ cwd: widthSha256Dir });

        // Act
        const result = await sut.fsck({ strict: true });

        // Assert — both tools call the repository corrupt
        expect(gitResult.exitCode & 1).toBe(1);
        expect(result.exitCode & 1).toBe(1);

        // Assert — tsgit attributes it to the tree pointer
        const badTree = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'badTreeSha1',
        );
        expect(badTree).toBeDefined();
        expect(badTree?.severity).toBe('error');
      });
    });
  },
);

// ---------------------------------------------------------------------------
// Refs-verify pass — a loose ref that is a symbolic link
// ---------------------------------------------------------------------------
// Pinned against real git 2.55.0:
//   stderr: "warning: refs/heads/rel: symlinkRef: use deprecated symbolic link for symref"
//   exit: 0 — the notice never fails the audit

let symlinkRefDir = '';
let symlinkRefCtx: Context;
const SYMLINKED_REF = 'refs/heads/rel';

/** Roots created per row below, removed together in this family's teardown. */
const symlinkDepthRoots: string[] = [];

/** Every `symlinkRef` finding, in ref order — the whole set, so an extra
 *  finding on either side changes the comparison. */
const symlinkRefFindings = (
  findings: ReadonlyArray<FsckFinding>,
): ReadonlyArray<FsckFinding & { type: 'bad-ref' }> =>
  findings
    .filter(
      (f): f is FsckFinding & { type: 'bad-ref' } =>
        f.type === 'bad-ref' && f.msgId === 'symlinkRef',
    )
    .slice()
    .sort((a, b) => (a.ref < b.ref ? -1 : 1));

/** git's own stderr for a set of `symlinkRef` notices, rebuilt from tsgit's
 *  structured findings alone — the library never renders a line. */
const symlinkRefStderr = (
  findings: ReadonlyArray<FsckFinding & { type: 'bad-ref' }>,
  prefix: string,
): string =>
  findings
    .map((f) => `${prefix}: ${f.ref}: ${f.msgId}: use deprecated symbolic link for symref\n`)
    .join('');

beforeAll(async () => {
  symlinkRefDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-symlinkRef-'));
  initRepo(symlinkRefDir);
  await writeFile(path.join(symlinkRefDir, 'f.txt'), 'c1\n');
  runGit(['-C', symlinkRefDir, 'add', '-A'], { env: SAFE_ENV });
  runGit(['-C', symlinkRefDir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
  runGit(['-C', symlinkRefDir, 'branch', 'side', 'main'], { env: SAFE_ENV });
  // Read-through text, so the link also resolves as a path and git's own
  // worktree probe stays out of the way.
  await symlink('side', path.join(symlinkRefDir, '.git', 'refs', 'heads', 'rel'));
  symlinkRefCtx = createNodeContext({ workDir: symlinkRefDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (symlinkRefDir !== '') await rm(symlinkRefDir, { recursive: true, force: true });
  await Promise.all(
    symlinkDepthRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!GIT_AVAILABLE)('Given a loose ref that is a symbolic link', () => {
  describe('When fsck runs', () => {
    it('Then emits a symlinkRef warning and the clean exit code real git reports', async () => {
      // Arrange — git's expected output
      const gitResult = gitFsck(symlinkRefDir);

      // Act
      const result = await fsck(symlinkRefCtx);

      // Assert — the notice never fails the audit
      expect(gitResult.exitCode).toBe(0);
      expect(result.exitCode).toBe(0);

      // Assert — the whole warning SET, not just one member: an extra
      // finding on either side changes the list and fails the row.
      const warned = symlinkRefFindings(result.findings);
      expect(warned.map((f) => f.severity)).toEqual(['warning']);
      expect(warned.map((f) => f.ref)).toEqual([SYMLINKED_REF]);

      // Reconstruct git's exact stderr and assert byte-equality
      expect(gitResult.stderr).toBe(symlinkRefStderr(warned, 'warning'));
    });
  });
});

/** git's stderr lines for a ref walk, rebuilt from the structured findings:
 *  one line per symlink notice, one per content notice, one per zero pointer.
 *  `content` is the raw text the broken ref holds, which git echoes verbatim. */
const refWalkStderr = (findings: ReadonlyArray<FsckFinding>, content: string): string[] =>
  findings
    .filter((f): f is FsckFinding & { type: 'bad-ref' } => f.type === 'bad-ref')
    .map((f) => {
      if (f.msgId === 'symlinkRef') {
        return `warning: ${f.ref}: symlinkRef: use deprecated symbolic link for symref`;
      }
      if (f.msgId === 'badRefContent') {
        return `${f.severity === 'error' ? 'error' : 'warning'}: ${f.ref}: badRefContent: ${content}`;
      }
      return `error: ${f.ref}: invalid sha1 pointer ${f.target}`;
    });

describe.skipIf(!GIT_AVAILABLE)(
  'Given links at several depths and one naming a directory holding a broken ref',
  () => {
    describe('When fsck runs', () => {
      it('Then both warn once per link and report the broken ref under its real name only', async () => {
        // Arrange — `refs/heads/other/broken` holds text that is not an object
        // name, so a walk that followed `refs/heads/dl` into that directory
        // would report the SAME fault a second time, under the linked name.
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-symlink-depths-'));
        symlinkDepthRoots.push(dir);
        initRepo(dir);
        await writeFile(path.join(dir, 'f.txt'), 'c1\n');
        runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
        runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
        runGit(['-C', dir, 'branch', 'side', 'main'], { env: SAFE_ENV });
        runGit(['-C', dir, 'update-ref', 'refs/heads/other/x', 'HEAD'], { env: SAFE_ENV });
        const heads = path.join(dir, '.git', 'refs', 'heads');
        await writeFile(path.join(heads, 'other', 'broken'), 'garbage\n');
        await mkdir(path.join(heads, 'nest'), { recursive: true });
        await symlink('other', path.join(heads, 'dl'));
        await symlink('../side', path.join(heads, 'nest', 'deep'));
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);
        const enumerated = runGit(['-C', dir, 'for-each-ref', '--format=%(refname)'], {
          env: SAFE_ENV,
        })
          .trim()
          .split('\n');

        // Assert — git's own ref enumeration DOES read through the link, so the
        // audit's silence about `refs/heads/dl/broken` is a property of the fsck
        // walk, not of the link being unreadable.
        expect(enumerated).toContain('refs/heads/dl/x');

        // Assert — exactly one notice per link
        const warned = symlinkRefFindings(result.findings);
        expect(warned.map((f) => f.ref)).toEqual(['refs/heads/dl', 'refs/heads/nest/deep']);

        // Assert — the CONTENT notice names the real ref alone, while the zero
        // pointer the broken body stands for is reported under both names.
        expect(
          result.findings
            .filter((f) => f.type === 'bad-ref' && f.msgId !== 'symlinkRef')
            .map((f) => (f.type === 'bad-ref' ? `${f.msgId} ${f.ref}` : ''))
            .sort(),
        ).toEqual([
          'badRefContent refs/heads/other/broken',
          'badRefOid refs/heads/dl/broken',
          'badRefOid refs/heads/other/broken',
        ]);

        // Assert — git's whole stderr, rebuilt from those structured fields
        expect(gitResult.stderr.split('\n').filter(Boolean).sort()).toEqual(
          refWalkStderr(result.findings, 'garbage').sort(),
        );
        expect(gitResult.exitCode).toBe(10);
        expect(result.exitCode).toBe(gitResult.exitCode);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given a link whose target ref holds text that is not an object name',
  () => {
    describe('When fsck runs', () => {
      it('Then the content notice names the real ref alone and both names carry the pointer', async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-symlink-broken-'));
        symlinkDepthRoots.push(dir);
        initRepo(dir);
        await writeFile(path.join(dir, 'f.txt'), 'c1\n');
        runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
        runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
        const heads = path.join(dir, '.git', 'refs', 'heads');
        await writeFile(path.join(heads, 'broken-ref'), 'garbage\n');
        await symlink('broken-ref', path.join(heads, 'broken-link'));
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert — one content notice, two pointers, one symlink notice
        expect(
          result.findings
            .filter((f): f is FsckFinding & { type: 'bad-ref' } => f.type === 'bad-ref')
            .map((f) => `${f.msgId} ${f.ref}`)
            .sort(),
        ).toEqual([
          'badRefContent refs/heads/broken-ref',
          'badRefOid refs/heads/broken-link',
          'badRefOid refs/heads/broken-ref',
          'symlinkRef refs/heads/broken-link',
        ]);

        // Assert — git's whole stderr, rebuilt from those structured fields
        expect(gitResult.stderr.split('\n').filter(Boolean).sort()).toEqual(
          refWalkStderr(result.findings, 'garbage').sort(),
        );
        expect(gitResult.exitCode).toBe(10);
        expect(result.exitCode).toBe(gitResult.exitCode);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given HEAD itself stored as a symbolic link to a branch', () => {
  describe('When fsck runs', () => {
    it('Then neither tool reports anything — the walk covers refs only', async () => {
      // Arrange
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-symlink-head-'));
      symlinkDepthRoots.push(dir);
      initRepo(dir);
      await writeFile(path.join(dir, 'f.txt'), 'c1\n');
      runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
      runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
      await rm(path.join(dir, '.git', 'HEAD'));
      await symlink('refs/heads/main', path.join(dir, '.git', 'HEAD'));
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitResult = gitFsck(dir, '--full');
      const result = await fsck(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(gitResult.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(symlinkRefFindings(result.findings)).toEqual([]);
    });
  });
});

/** A repository carrying exactly one symlinked loose ref, plus whatever
 *  `[fsck]` entries a row needs. */
const symlinkRefRepoWith = async (
  slug: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<{ readonly dir: string; readonly ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-symlink-${slug}-`));
  symlinkDepthRoots.push(dir);
  initRepo(dir);
  await writeFile(path.join(dir, 'f.txt'), 'c1\n');
  runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
  runGit(['-C', dir, 'branch', 'side', 'main'], { env: SAFE_ENV });
  await symlink('side', path.join(dir, '.git', 'refs', 'heads', 'rel'));
  for (const [key, value] of entries) {
    runGit(['-C', dir, 'config', key, value], { env: SAFE_ENV });
  }
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

const catchFsckError = async (ctx: Context): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fsck(ctx);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  return caught as TsgitError;
};

describe.skipIf(!GIT_AVAILABLE)('Given fsck.symlinkRef re-typed in the configuration', () => {
  // `warn` is the catalogue default for this notice, so a row asking for it
  // would pass with the whole table ignored; the `warn` spelling is pinned
  // where it re-types something — over `badRefContent`, an ERROR default.
  describe.each([
    { level: 'error', exitCode: 8, prefix: 'error', severities: ['error'] },
    { level: 'ignore', exitCode: 0, prefix: undefined, severities: [] },
  ])('When fsck runs with the notice set to $level', (row) => {
    it('Then both re-type it the same way, down to the exit code', async () => {
      // Arrange
      const { dir, ctx } = await symlinkRefRepoWith(row.level, [['fsck.symlinkRef', row.level]]);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const result = await fsck(ctx);

      // Assert — git's side
      expect(gitResult.exitCode).toBe(row.exitCode);
      expect(gitResult.stderr).toBe(
        row.prefix === undefined
          ? ''
          : `${row.prefix}: ${SYMLINKED_REF}: symlinkRef: use deprecated symbolic link for symref\n`,
      );

      // Assert — tsgit's side, re-typed by the same key
      const reported = symlinkRefFindings(result.findings);
      expect(reported.map((f) => f.severity)).toEqual(row.severities);
      expect(result.exitCode).toBe(row.exitCode);
      expect(gitResult.stderr).toBe(
        row.prefix === undefined ? '' : symlinkRefStderr(reported, row.prefix),
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given the msg-id written in a different case', () => {
  describe('When fsck runs', () => {
    it('Then both honour it — the key half of a config name is case-insensitive', async () => {
      // Arrange
      const { dir, ctx } = await symlinkRefRepoWith('case', [
        [`fsck.${'symlinkRef'.toLowerCase()}`, 'error'],
      ]);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const result = await fsck(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(8);
      expect(result.exitCode).toBe(8);
      expect(symlinkRefFindings(result.findings).map((f) => f.severity)).toEqual(['error']);
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a msg-id no fsck check knows', () => {
  describe('When fsck runs', () => {
    it('Then both refuse before auditing anything', async () => {
      // Arrange
      const { dir, ctx } = await symlinkRefRepoWith('unknown-id', [['fsck.noSuchThing', 'error']]);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const err = await catchFsckError(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toBe(
        `fatal: Unhandled message id: ${'noSuchThing'.toLowerCase()}\n`,
      );
      expect(err.data).toEqual({
        code: 'FSCK_UNKNOWN_MSG_ID',
        msgId: 'noSuchThing'.toLowerCase(),
        source: path.join(dir, '.git', 'config'),
        line: expect.any(Number),
      });
    });
  });
});

/**
 * A repository whose `.git/config` ends with `text` verbatim. `git config`
 * refuses to write a subsection header of its own, and a valueless entry has
 * no CLI spelling at all, so raw bytes are the only way to plant these rows.
 */
const fsckRepoWithConfigText = async (
  slug: string,
  text: string,
): Promise<{ readonly dir: string; readonly ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-config-${slug}-`));
  symlinkDepthRoots.push(dir);
  initRepo(dir);
  await writeFile(path.join(dir, 'f.txt'), 'c1\n');
  runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
  await appendFile(path.join(dir, '.git', 'config'), text);
  __resetConfigCacheForTests();
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

describe.skipIf(!GIT_AVAILABLE)('Given a fsck msg-id sitting under a subsection header', () => {
  describe.each([
    {
      slug: 'quoted',
      text: '[fsck "SubName"]\n\tBadTree = ignore\n',
      msgId: `SubName.${'BadTree'.toLowerCase()}`,
      label: 'a quoted subsection contributes its bytes unfolded',
    },
    {
      slug: 'dotted',
      text: '[fsck.Sub]\n\tbadTree = ignore\n',
      msgId: `sub.${'badTree'.toLowerCase()}`,
      label: 'a dotted subsection contributes its bytes folded down',
    },
    {
      slug: 'empty',
      text: '[fsck ""]\n\tbadTree = ignore\n',
      msgId: `.${'badTree'.toLowerCase()}`,
      label: 'an empty subsection still contributes its separating dot',
    },
    {
      slug: 'list-key',
      text: '[fsck "x"]\n\tskipList = /names.txt\n',
      msgId: `x.${'skipList'.toLowerCase()}`,
      label: 'the list key under a subsection is graded as a msg-id, not read as a list',
    },
  ])('When fsck runs and $label', ({ slug, text, msgId }) => {
    it('Then both refuse on the composed msg-id before auditing anything', async () => {
      // Arrange
      const { dir, ctx } = await fsckRepoWithConfigText(`subsection-${slug}`, text);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const err = await catchFsckError(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toBe(`fatal: Unhandled message id: ${msgId}\n`);
      expect(err.data).toEqual({
        code: 'FSCK_UNKNOWN_MSG_ID',
        msgId,
        source: path.join(dir, '.git', 'config'),
        line: expect.any(Number),
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a valueless fsck msg-id under a subsection header', () => {
  describe('When fsck runs', () => {
    it('Then both name the composed key in the missing-value refusal', async () => {
      // Arrange
      const { dir, ctx } = await fsckRepoWithConfigText(
        'subsection-valueless',
        '[fsck "x"]\n\tbadTree\n',
      );

      // Act
      const gitResult = gitFsck(dir, '--full');
      const err = await catchFsckError(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain(
        `error: missing value for 'fsck.x.${'badTree'.toLowerCase()}'\n`,
      );
      expect(err.data).toEqual({
        code: 'CONFIG_MISSING_VALUE',
        key: `fsck.x.${'badTree'.toLowerCase()}`,
        source: path.join(dir, '.git', 'config'),
        line: expect.any(Number),
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a fatal msg-id asked for a softer severity', () => {
  describe.each([{ word: 'ignore' }, { word: 'warn' }])('When fsck runs with $word', (row) => {
    it.each([{ msgId: 'nulInHeader' }, { msgId: 'unterminatedHeader' }])(
      'Then both refuse $msgId before auditing anything',
      async ({ msgId }) => {
        // Arrange
        const { dir, ctx } = await symlinkRefRepoWith(`demote-${msgId}-${row.word}`, [
          [`fsck.${msgId}`, row.word],
        ]);

        // Act
        const gitResult = gitFsck(dir, '--full');
        const err = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(
          `fatal: Cannot demote ${msgId.toLowerCase()} to ${row.word}\n`,
        );
        expect(err.data).toEqual({
          code: 'FSCK_CANNOT_DEMOTE',
          msgId: msgId.toLowerCase(),
          severity: row.word,
          source: path.join(dir, '.git', 'config'),
          line: expect.any(Number),
        });
      },
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a fatal msg-id asked for error', () => {
  describe.each([{ msgId: 'nulInHeader' }, { msgId: 'unterminatedHeader' }])(
    'When fsck runs with $msgId set to error',
    (row) => {
      it('Then both accept it and audit as usual', async () => {
        // Arrange
        const { dir, ctx } = await symlinkRefRepoWith(`keep-${row.msgId}`, [
          [`fsck.${row.msgId}`, 'error'],
        ]);

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).not.toContain('Cannot demote');
        expect(result.exitCode).toBe(gitResult.exitCode);
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('Given a severity outside the three git accepts', () => {
  describe('When fsck runs', () => {
    it('Then both refuse before auditing anything', async () => {
      // Arrange
      const { dir, ctx } = await symlinkRefRepoWith('bad-value', [['fsck.symlinkRef', 'bogus']]);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const err = await catchFsckError(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toBe("fatal: Unknown fsck message type: 'bogus'\n");
      expect(err.data).toEqual({
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: `fsck.${'symlinkRef'.toLowerCase()}`,
        source: path.join(dir, '.git', 'config'),
        value: 'bogus',
        line: expect.any(Number),
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given the same msg-id typed twice', () => {
  describe('When fsck runs', () => {
    it('Then both take the last entry', async () => {
      // Arrange
      const { dir, ctx } = await symlinkRefRepoWith('last-wins', []);
      runGit(['-C', dir, 'config', '--add', 'fsck.symlinkRef', 'error'], { env: SAFE_ENV });
      runGit(['-C', dir, 'config', '--add', 'fsck.symlinkRef', 'ignore'], { env: SAFE_ENV });

      // Act
      const gitResult = gitFsck(dir, '--full');
      const result = await fsck(ctx);

      // Assert
      expect(gitResult.exitCode).toBe(0);
      expect(gitResult.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(symlinkRefFindings(result.findings)).toEqual([]);
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given the receive and fetch fsck namespaces', () => {
  describe.each([{ key: 'receive.fsck.symlinkRef' }, { key: 'fetch.fsck.symlinkRef' }])(
    'When fsck runs with $key set to ignore',
    (row) => {
      it('Then neither honours it — the audit reads the fsck namespace alone', async () => {
        // Arrange
        const { dir, ctx } = await symlinkRefRepoWith(row.key.split('.')[0] as string, [
          [row.key, 'ignore'],
        ]);

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert — the notice survives on both sides
        const reported = symlinkRefFindings(result.findings);
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(reported.map((f) => f.severity)).toEqual(['warning']);
        expect(gitResult.stderr).toBe(symlinkRefStderr(reported, 'warning'));
      });
    },
  );
});

// ---------------------------------------------------------------------------
// The severity table over the object catalogue and the ref-content notice
// ---------------------------------------------------------------------------

/** A repository holding one commit whose message carries a NUL — the
 *  `nulInCommit` notice, a WARN default the strict flag upgrades. */
const nulInCommitRepoWith = async (
  slug: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<{ readonly dir: string; readonly ctx: Context; readonly commitSha: string }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-nul-${slug}-`));
  symlinkDepthRoots.push(dir);
  initRepo(dir);
  await writeFile(path.join(dir, 'f.txt'), 'c1\n');
  runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
  const tree = runGit(['-C', dir, 'rev-parse', 'HEAD^{tree}'], { env: SAFE_ENV }).trim();
  const body = Buffer.concat([
    Buffer.from(
      `tree ${tree}\nauthor A <a@x> 1700000000 +0000\ncommitter A <a@x> 1700000000 +0000\n\nmsg`,
    ),
    Buffer.from([0]),
    Buffer.from('nul\n'),
  ]);
  const raw = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
  const id = sha1Hex(raw);
  const objDir = path.join(dir, '.git', 'objects', id.slice(0, 2));
  await mkdir(objDir, { recursive: true });
  await writeFile(path.join(objDir, id.slice(2)), deflateSync(raw));
  runGit(['-C', dir, 'update-ref', 'refs/heads/nul', id], { env: SAFE_ENV });
  for (const [key, value] of entries) {
    runGit(['-C', dir, 'config', key, value], { env: SAFE_ENV });
  }
  __resetConfigCacheForTests();
  return { dir, ctx: createNodeContext({ workDir: dir }), commitSha: id };
};

/** Every `nulInCommit` finding the audit reported. */
const nulFindings = (
  findings: ReadonlyArray<FsckFinding>,
): ReadonlyArray<FsckFinding & { type: 'bad-object' }> =>
  findings.filter(
    (f): f is FsckFinding & { type: 'bad-object' } =>
      f.type === 'bad-object' && f.msgId === 'nulInCommit',
  );

describe.skipIf(!GIT_AVAILABLE)(
  'Given an object-catalogue notice re-typed in the configuration',
  () => {
    describe.each([
      { level: 'error', flags: [] as string[], exitCode: 1, severities: ['error'] },
      { level: 'ignore', flags: [] as string[], exitCode: 0, severities: [] },
      { level: 'warn', flags: ['--strict'], exitCode: 0, severities: ['warning'] },
    ])('When fsck runs with the notice set to $level and flags $flags', (row) => {
      it('Then both land on the same severity and exit code, the key beating the strict upgrade', async () => {
        // Arrange
        const { dir, ctx, commitSha } = await nulInCommitRepoWith(
          `${row.level}${row.flags.join('')}`,
          [['fsck.nulInCommit', row.level]],
        );

        // Act
        const gitResult = gitFsck(dir, ...row.flags);
        const result = await fsck(ctx, row.flags.includes('--strict') ? { strict: true } : {});

        // Assert
        expect(gitResult.exitCode).toBe(row.exitCode);
        expect(result.exitCode).toBe(gitResult.exitCode);
        const reported = nulFindings(result.findings);
        expect(reported.map((f) => f.severity)).toEqual(row.severities);
        expect(reported.map((f) => f.id)).toEqual(row.severities.map(() => commitSha));

        // Assert — git's exact stderr, rebuilt from those structured fields.
        // The severity word git prints for a notice is the word the audit
        // resolved, so a divergence in either direction fails this line.
        expect(gitResult.stderr).toBe(
          reported
            .map(
              (f) =>
                `${f.severity} in commit ${f.id}: ${f.msgId}: NUL byte in the commit object body\n`,
            )
            .join(''),
        );
      });
    });
  },
);

const BAD_CONTENT_REF = 'refs/heads/bad';
const BAD_CONTENT_TEXT = 'garbage';
const ZERO_OID = '0'.repeat(40);

/** A repository whose one extra loose ref holds text that is not an object
 *  name, plus whatever `[fsck]` entries a row needs. */
const badRefContentRepo = async (
  slug: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<{ readonly dir: string; readonly ctx: Context }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-ref-content-${slug}-`));
  symlinkDepthRoots.push(dir);
  initRepo(dir);
  await writeFile(path.join(dir, 'f.txt'), 'c1\n');
  runGit(['-C', dir, 'add', '-A'], { env: SAFE_ENV });
  runGit(['-C', dir, 'commit', '-q', '-m', 'c1'], { env: SAFE_ENV });
  await writeFile(path.join(dir, '.git', 'refs', 'heads', 'bad'), `${BAD_CONTENT_TEXT}\n`);
  for (const [key, value] of entries) {
    runGit(['-C', dir, 'config', key, value], { env: SAFE_ENV });
  }
  __resetConfigCacheForTests();
  return { dir, ctx: createNodeContext({ workDir: dir }) };
};

describe.skipIf(!GIT_AVAILABLE)('Given a loose ref whose content is not an object name', () => {
  describe.each([
    { label: 'no re-typing at all', entries: [], exit: 10, contentSeverity: 'error' },
    {
      label: 'badRefContent left at error',
      entries: [['fsck.badRefContent', 'error']],
      exit: 10,
      contentSeverity: 'error',
    },
    {
      label: 'badRefContent softened to warn',
      entries: [['fsck.badRefContent', 'warn']],
      exit: 2,
      contentSeverity: 'warning',
    },
    {
      label: 'badRefContent silenced',
      entries: [['fsck.badRefContent', 'ignore']],
      exit: 2,
      contentSeverity: undefined,
    },
    {
      label: 'badRefOid silenced',
      entries: [['fsck.badRefOid', 'ignore']],
      exit: 10,
      contentSeverity: 'error',
    },
  ] as ReadonlyArray<{
    label: string;
    entries: ReadonlyArray<readonly [string, string]>;
    exit: number;
    contentSeverity: string | undefined;
  }>)('When fsck runs with $label', (row) => {
    it('Then only the content notice re-types — the synthesised pointer never does', async () => {
      // Arrange
      const { dir, ctx } = await badRefContentRepo(row.label.replace(/\s+/g, '-'), row.entries);

      // Act
      const gitResult = gitFsck(dir, '--full');
      const result = await fsck(ctx);

      // Assert — the content notice, named and graded
      const content = result.findings.filter(
        (f): f is FsckFinding & { type: 'bad-ref' } =>
          f.type === 'bad-ref' && f.msgId === 'badRefContent',
      );
      expect(content).toEqual(
        row.contentSeverity === undefined
          ? []
          : [
              {
                type: 'bad-ref',
                ref: BAD_CONTENT_REF,
                msgId: 'badRefContent',
                severity: row.contentSeverity,
              },
            ],
      );

      // Assert — the pointer stands whatever the configuration says, at error
      // severity, naming the all-zero oid git synthesises for a broken body
      expect(
        result.findings.filter(
          (f): f is FsckFinding & { type: 'bad-ref' } =>
            f.type === 'bad-ref' && f.msgId === 'badRefOid',
        ),
      ).toEqual([
        {
          type: 'bad-ref',
          ref: BAD_CONTENT_REF,
          msgId: 'badRefOid',
          severity: 'error',
          target: ZERO_OID,
        },
      ]);

      // Assert — git's exact stderr, rebuilt from those structured fields
      expect(gitResult.stderr).toBe(
        refWalkStderr(result.findings, BAD_CONTENT_TEXT)
          .map((line) => `${line}\n`)
          .join(''),
      );
      expect(gitResult.exitCode).toBe(row.exit);
      expect(result.exitCode).toBe(gitResult.exitCode);
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given fsck.skipList, which names a file rather than a check',
  () => {
    describe('When fsck runs', () => {
      it('Then neither takes it for a msg-id', async () => {
        // Arrange
        const { dir, ctx } = await symlinkRefRepoWith('skip-list', []);
        const names = path.join(dir, 'names.txt');
        await writeFile(names, '');
        runGit(['-C', dir, 'config', 'fsck.skipList', names], { env: SAFE_ENV });

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert — the notice survives; neither side refuses on the key itself
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(symlinkRefFindings(result.findings).map((f) => f.severity)).toEqual(['warning']);
      });
    });
  },
);

// --- Scenario family: fsck.skipList -----------------------------------------

const valuelessDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    valuelessDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const skipListRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    skipListRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface SkipListRepo {
  readonly dir: string;
  readonly commitSha: string;
  readonly danglingSha: string;
}

/**
 * A repository OF ITS OWN whose only branch roots a commit carrying
 * `missingSpaceBeforeEmail`, plus one loose blob nothing references. Every row
 * builds its own, so a row that rewrites the list file — or the `[fsck]`
 * section — cannot reach any other row's repository.
 */
const skipListRepo = async (slug: string): Promise<SkipListRepo> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-skip-list-${slug}-`));
  skipListRoots.push(dir);
  initRepo(dir);
  const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  await writeLooseObject(dir, 'tree', Buffer.alloc(0));
  const commitBody = Buffer.from(
    `tree ${emptyTree}\nauthor Name<bad@example.com> 1700000000 +0000\ncommitter Test <c@example.com> 1700000000 +0000\n\nmessage\n`,
  );
  const commitSha = await writeLooseObject(dir, 'commit', commitBody);
  const refsDir = path.join(dir, '.git', 'refs', 'heads');
  await mkdir(refsDir, { recursive: true });
  await writeFile(path.join(refsDir, 'main'), `${commitSha}\n`);
  const danglingSha = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
    env: SAFE_ENV,
    input: 'loose and unreferenced\n',
  }).trim();
  return { dir, commitSha, danglingSha };
};

/** That repository with its own list file, `fsck.skipList` pointed at it, and
 *  a Context whose config read has not been cached yet. */
const withSkipList = async (
  slug: string,
  makeBody: (repo: SkipListRepo) => string,
): Promise<SkipListRepo & { readonly list: string; readonly ctx: Context }> => {
  const repo = await skipListRepo(slug);
  const list = path.join(repo.dir, 'names.txt');
  await writeFile(list, makeBody(repo));
  runGit(['-C', repo.dir, 'config', 'fsck.skipList', list], { env: SAFE_ENV });
  __resetConfigCacheForTests();
  return { ...repo, list, ctx: createNodeContext({ workDir: repo.dir }) };
};

/** The same repository with `fsck.skipList` naming a file that was never
 *  created — the one list shape `withSkipList` cannot build, since it always
 *  writes the file it points at. */
const skipListRepoPointedAtAbsentList = async (slug: string): Promise<SkipListRepo> => {
  const repo = await skipListRepo(slug);
  const absent = path.join(repo.dir, 'absent-names.txt');
  runGit(['-C', repo.dir, 'config', 'fsck.skipList', absent], { env: SAFE_ENV });
  __resetConfigCacheForTests();
  return repo;
};

describe.skipIf(!GIT_AVAILABLE)(
  'Given fsck.skipList naming the object whose content check fires',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both fall silent and exit clean',
        async () => {
          // Arrange
          const { dir, ctx } = await withSkipList('named', (r) => `${r.commitSha}\n`);

          // Act
          const gitResult = gitFsck(dir, '--full');
          const result = await fsck(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(result.exitCode).toBe(gitResult.exitCode);
          expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([]);
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given fsck.skipList naming some other object', () => {
  describe('When git fsck and tsgit fsck both run', () => {
    it(
      'Then both still report the finding and exit 1',
      async () => {
        // Arrange
        const { dir, ctx, commitSha } = await withSkipList(
          'other-name',
          () => '0123456789abcdef0123456789abcdef01234567\n',
        );

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(1);
        expect(gitResult.stderr).toBe(
          `error in commit ${commitSha}: missingSpaceBeforeEmail: invalid author/committer line - missing space before email\n`,
        );
        expect(result.exitCode).toBe(gitResult.exitCode);
        expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([
          {
            type: 'bad-object',
            id: commitSha,
            objectType: 'commit',
            msgId: 'missingSpaceBeforeEmail',
            severity: 'error',
          },
        ]);
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a skip list decorated with comments, blanks and upper-case hex',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both still recognise the name and fall silent',
        async () => {
          // Arrange
          const { dir, ctx } = await withSkipList(
            'decorated',
            (r) => `# names to ignore\r\n\r\n   ${r.commitSha.toUpperCase()}   \r\n`,
          );

          // Act
          const gitResult = gitFsck(dir, '--full');
          const result = await fsck(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(result.exitCode).toBe(gitResult.exitCode);
          expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([]);
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given a skip list entry carrying a trailing comment', () => {
  describe('When git fsck and tsgit fsck both run', () => {
    it(
      'Then both truncate the line at the marker and fall silent',
      async () => {
        // Arrange
        const { dir, ctx } = await withSkipList(
          'trailing-comment',
          (r) => `${r.commitSha} # forgiven for now\n`,
        );

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toBe('');
        expect(result.exitCode).toBe(gitResult.exitCode);
        expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([]);
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a skip list whose name sits behind a mid-line marker',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both drop the whole line and keep reporting the object',
        async () => {
          // Arrange
          const { dir, ctx, commitSha } = await withSkipList(
            'mid-line-marker',
            (r) => `   #${r.commitSha}\n`,
          );

          // Act
          const gitResult = gitFsck(dir, '--full');
          const result = await fsck(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(result.exitCode).toBe(gitResult.exitCode);
          expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([
            {
              type: 'bad-object',
              id: commitSha,
              objectType: 'commit',
              msgId: 'missingSpaceBeforeEmail',
              severity: 'error',
            },
          ]);
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given fsck.skipList present with no value at all', () => {
  describe('When git fsck and tsgit fsck both run', () => {
    it(
      'Then both refuse the valueless key, naming it and the line it sits on',
      async () => {
        // Arrange
        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-valueless-'));
        valuelessDirs.push(dir);
        initRepo(dir);
        const configPath = path.join(dir, '.git', 'config');
        const before = (await readFile(configPath, 'utf8')).split('\n').filter((l) => l !== '');
        await writeFile(configPath, `${before.join('\n')}\n[fsck]\n\tskipList\n`);
        __resetConfigCacheForTests();
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitResult = gitFsck(dir, '--full');
        const caught = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain(
          `error: missing value for 'fsck.${'skipList'.toLowerCase()}'`,
        );
        expect(caught.data).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: `fsck.${'skipList'.toLowerCase()}`,
          source: configPath,
          line: before.length + 2,
        });
        expect(gitResult.stderr).toContain(`at line ${before.length + 2}`);
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a skip list holding an abbreviated object name', () => {
  describe('When git fsck and tsgit fsck both run', () => {
    it(
      'Then both refuse the whole audit rather than dropping the line',
      async () => {
        // Arrange
        let abbreviated = '';
        const { dir, list, ctx } = await withSkipList('abbreviated', (r) => {
          abbreviated = r.commitSha.slice(0, 8);
          return `${abbreviated}\n`;
        });

        // Act
        const gitResult = gitFsck(dir, '--full');
        const caught = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(`fatal: invalid object name: ${abbreviated}\n`);
        expect(caught.data).toEqual({
          code: 'FSCK_SKIP_LIST_INVALID_NAME',
          name: abbreviated,
          path: list,
          line: 1,
        });
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given fsck.skipList pointed at a file that was never created',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both refuse, naming the path they could not open',
        async () => {
          // Arrange
          const { dir } = await skipListRepoPointedAtAbsentList('absent');
          const absent = path.join(dir, 'absent-names.txt');
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitResult = gitFsck(dir, '--full');
          const caught = await catchFsckError(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe(`fatal: could not open object name list: ${absent}\n`);
          expect(caught.data).toEqual({
            code: 'FSCK_SKIP_LIST_UNREADABLE',
            path: absent,
            reason: 'FILE_NOT_FOUND',
          });
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given a skip list naming a dangling object', () => {
  describe('When git fsck and tsgit fsck both run', () => {
    it(
      'Then both still report it — the list only silences content checks',
      async () => {
        // Arrange
        const { dir, ctx, danglingSha } = await withSkipList(
          'dangling',
          (r) => `${r.commitSha}\n${r.danglingSha}\n`,
        );

        // Act
        const gitResult = gitFsck(dir, '--full');
        const result = await fsck(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(gitResult.exitCode);
        expect(gitResult.stdout).toBe(`dangling blob ${danglingSha}\n`);
        expect(result.findings.filter((f) => f.type === 'dangling')).toEqual([
          { type: 'dangling', id: danglingSha, objectType: 'blob' },
        ]);
      },
      SETUP_TIMEOUT,
    );
  });
});

// --- Scenario: fsck.<msg-id> aimed at an unreadable object --------------------

let unreadableDir = '';
let unreadableSha = '';

beforeAll(async () => {
  unreadableDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-unreadable-'));
  initRepo(unreadableDir);
  await writeFile(path.join(unreadableDir, 'f.txt'), 'seed\n');
  runGit(['-C', unreadableDir, 'add', 'f.txt'], { env: SAFE_ENV });
  runGit(['-C', unreadableDir, 'commit', '-q', '-m', 'seed'], { env: SAFE_ENV });
  unreadableSha = await writeLooseObject(unreadableDir, 'bogus', Buffer.from('hello'));
  runGit(['-C', unreadableDir, 'config', 'fsck.unknownType', 'ignore'], { env: SAFE_ENV });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (unreadableDir !== '') await rm(unreadableDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given fsck.unknownType set to ignore and an unreadable object',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both still report it and set the corrupt bit — no msg-id re-types an error()',
        async () => {
          // Arrange
          __resetConfigCacheForTests();
          const ctx = createNodeContext({ workDir: unreadableDir });

          // Act
          const gitResult = gitFsck(unreadableDir);
          const result = await fsck(ctx);

          // Assert
          expect(gitResult.exitCode & 1).toBe(1);
          expect(gitResult.stderr).toContain(
            `error: ${unreadableSha}: object corrupt or missing: `,
          );
          expect(result.exitCode & 1).toBe(1);
          expect(result.findings).toContainEqual({
            type: 'bad-object',
            id: unreadableSha,
            objectType: 'unknown',
            msgId: 'unknownType',
            severity: 'error',
          });
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

// --- Scenario family: fsck.skipList written more than once --------------------

const repeatedListRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    repeatedListRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A repository of its own whose two branches each root a commit carrying
 * `missingSpaceBeforeEmail`, plus one list file per `bodies` entry, each
 * pointed at by its own `fsck.skipList` line.
 */
const repeatedSkipListRepo = async (
  slug: string,
  bodies: (oids: ReadonlyArray<string>) => ReadonlyArray<string>,
): Promise<{ readonly dir: string; readonly ctx: Context; readonly lists: string[] }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-fsck-repeated-list-${slug}-`));
  repeatedListRoots.push(dir);
  initRepo(dir);
  const emptyTree = await writeLooseObject(dir, 'tree', Buffer.alloc(0));
  const oids: string[] = [];
  for (const [index, branch] of ['main', 'side'].entries()) {
    const body = Buffer.from(
      `tree ${emptyTree}\nauthor Name<bad@example.com> 1700000000 +0000\ncommitter Test <c@example.com> 170000000${index} +0000\n\nmessage\n`,
    );
    const oid = await writeLooseObject(dir, 'commit', body);
    oids.push(oid);
    const refsDir = path.join(dir, '.git', 'refs', 'heads');
    await mkdir(refsDir, { recursive: true });
    await writeFile(path.join(refsDir, branch), `${oid}\n`);
  }
  const lists: string[] = [];
  for (const [index, listBody] of bodies(oids).entries()) {
    const list = path.join(dir, `names-${index}.txt`);
    await writeFile(list, listBody);
    lists.push(list);
    runGit(['-C', dir, 'config', '--add', 'fsck.skipList', list], { env: SAFE_ENV });
  }
  __resetConfigCacheForTests();
  return { dir, ctx: createNodeContext({ workDir: dir }), lists };
};

describe.skipIf(!GIT_AVAILABLE)(
  'Given two fsck.skipList entries, each naming a different reported object',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both fall silent — the second list adds to the first rather than replacing it',
        async () => {
          // Arrange
          const { dir, ctx } = await repeatedSkipListRepo('union', (oids) =>
            oids.map((oid) => `${oid}\n`),
          );

          // Act
          const gitResult = gitFsck(dir, '--full');
          const result = await fsck(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toBe('');
          expect(result.exitCode).toBe(0);
          expect(result.findings.filter((f) => f.type === 'bad-object')).toEqual([]);
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'Given two fsck.skipList entries of which the first names a file that is not there',
  () => {
    describe('When git fsck and tsgit fsck both run', () => {
      it(
        'Then both refuse on that first list, never reaching the usable one',
        async () => {
          // Arrange
          const { dir, ctx, lists } = await repeatedSkipListRepo('first-absent', (oids) =>
            oids.map((oid) => `${oid}\n`),
          );
          const absent = path.join(dir, 'names-absent.txt');
          runGit(['-C', dir, 'config', '--replace-all', 'fsck.skipList', absent], {
            env: SAFE_ENV,
          });
          runGit(['-C', dir, 'config', '--add', 'fsck.skipList', lists[0] as string], {
            env: SAFE_ENV,
          });
          __resetConfigCacheForTests();

          // Act
          const gitResult = gitFsck(dir, '--full');
          const caught = await catchFsckError(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe(`fatal: could not open object name list: ${absent}\n`);
          expect(caught.data).toEqual({
            code: 'FSCK_SKIP_LIST_UNREADABLE',
            path: absent,
            reason: 'FILE_NOT_FOUND',
          });
        },
        SETUP_TIMEOUT,
      );
    });
  },
);

// --- Scenario family: a valueless fsck.<msg-id> -------------------------------

const valuelessMsgIdRoots: string[] = [];

afterAll(async () => {
  await Promise.all(
    valuelessMsgIdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.skipIf(!GIT_AVAILABLE)('Given a fsck msg-id written with no value at all', () => {
  describe.each([{ msgId: 'badTree' }, { msgId: 'noSuchThing' }, { msgId: 'nulInHeader' }])(
    'When fsck runs with $msgId valueless',
    (row) => {
      it(
        'Then both name the missing value rather than grading the id or the severity',
        async () => {
          // Arrange
          const dir = await mkdtemp(
            path.join(os.tmpdir(), `tsgit-fsck-valueless-id-${row.msgId}-`),
          );
          valuelessMsgIdRoots.push(dir);
          initRepo(dir);
          const configPath = path.join(dir, '.git', 'config');
          const before = (await readFile(configPath, 'utf8')).split('\n').filter((l) => l !== '');
          await writeFile(configPath, `${before.join('\n')}\n[fsck]\n\t${row.msgId}\n`);
          __resetConfigCacheForTests();
          const ctx = createNodeContext({ workDir: dir });

          // Act
          const gitResult = gitFsck(dir, '--full');
          const caught = await catchFsckError(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe(
            `error: missing value for 'fsck.${row.msgId.toLowerCase()}'\n` +
              `fatal: bad config variable 'fsck.${row.msgId.toLowerCase()}' in file '.git/config' at line ${before.length + 2}\n`,
          );
          expect(caught.data).toEqual({
            code: 'CONFIG_MISSING_VALUE',
            key: `fsck.${row.msgId.toLowerCase()}`,
            source: configPath,
            line: before.length + 2,
          });
        },
        SETUP_TIMEOUT,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// [fsck] refusal order — git reads the section once, in file order, opening
// each list as it reaches it, so the FIRST fault in the file is the one that
// kills the audit. Neither kind of fault has a fixed precedence over the other.
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('Given an unopenable list and an out-of-grammar severity', () => {
  describe('When the list is written first', () => {
    it(
      'Then both refuse on the list, never reaching the severity word',
      async () => {
        // Arrange
        const { dir, ctx } = await fsckRepoWithConfigText('order-list-first', '');
        const absent = path.join(dir, 'absent-names.txt');
        await appendFile(
          path.join(dir, '.git', 'config'),
          `[fsck]\n\tskipList = ${absent}\n\tbadTree = bogus\n`,
        );
        __resetConfigCacheForTests();

        // Act
        const gitResult = gitFsck(dir, '--full');
        const caught = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(`fatal: could not open object name list: ${absent}\n`);
        expect(caught.data).toEqual({
          code: 'FSCK_SKIP_LIST_UNREADABLE',
          path: absent,
          reason: 'FILE_NOT_FOUND',
        });
      },
      SETUP_TIMEOUT,
    );
  });

  describe('When the severity word is written first', () => {
    it(
      'Then both refuse on the value, never opening the list',
      async () => {
        // Arrange
        const { dir, ctx } = await fsckRepoWithConfigText('order-value-first', '');
        const absent = path.join(dir, 'absent-names.txt');
        await appendFile(
          path.join(dir, '.git', 'config'),
          `[fsck]\n\tbadTree = bogus\n\tskipList = ${absent}\n`,
        );
        __resetConfigCacheForTests();

        // Act
        const gitResult = gitFsck(dir, '--full');
        const caught = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe("fatal: Unknown fsck message type: 'bogus'\n");
        expect(caught.data).toEqual({
          code: 'CONFIG_INVALID_ENUM_VALUE',
          key: `fsck.${'badTree'.toLowerCase()}`,
          source: path.join(dir, '.git', 'config'),
          value: 'bogus',
          line: expect.any(Number),
        });
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)('Given a list, then a bad severity, then a second list', () => {
  describe('When fsck runs', () => {
    it(
      'Then both refuse on the FIRST list — the order is the file order, not a fixed precedence',
      async () => {
        // Arrange
        const { dir, ctx } = await fsckRepoWithConfigText('order-three', '');
        const first = path.join(dir, 'absent-one.txt');
        const second = path.join(dir, 'absent-two.txt');
        await appendFile(
          path.join(dir, '.git', 'config'),
          `[fsck]\n\tskipList = ${first}\n\tbadTree = bogus\n\tskipList = ${second}\n`,
        );
        __resetConfigCacheForTests();

        // Act
        const gitResult = gitFsck(dir, '--full');
        const caught = await catchFsckError(ctx);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toBe(`fatal: could not open object name list: ${first}\n`);
        expect(caught.data).toEqual({
          code: 'FSCK_SKIP_LIST_UNREADABLE',
          path: first,
          reason: 'FILE_NOT_FOUND',
        });
      },
      SETUP_TIMEOUT,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a readable list carrying a line that is not an object name',
  () => {
    describe('When a bad severity word follows it', () => {
      it(
        'Then both refuse on the list line, which is reached first',
        async () => {
          // Arrange
          const { dir, ctx } = await fsckRepoWithConfigText('order-bad-line', '');
          const listPath = path.join(dir, 'names.txt');
          const abbreviated = '0'.repeat(7);
          await writeFile(listPath, `${abbreviated}\n`);
          await appendFile(
            path.join(dir, '.git', 'config'),
            `[fsck]\n\tskipList = ${listPath}\n\tbadTree = bogus\n`,
          );
          __resetConfigCacheForTests();

          // Act
          const gitResult = gitFsck(dir, '--full');
          const caught = await catchFsckError(ctx);

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toBe(`fatal: invalid object name: ${abbreviated}\n`);
          expect(caught.data).toEqual({
            code: 'FSCK_SKIP_LIST_INVALID_NAME',
            name: abbreviated,
            path: listPath,
            line: 1,
          });
        },
        SETUP_TIMEOUT,
      );
    });
  },
);
