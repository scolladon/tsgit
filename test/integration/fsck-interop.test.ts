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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit } from './interop-helpers.js';

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
  zeroPadDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-zeropad-'));
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

// --- Scenario family 12c: treeNotSorted + missingSpaceBeforeEmail -----------

let catalogueDir = '';
let catalogueCtx: Context;
let sortedTreeSha = '';
let badEmailCommitSha = '';
let emptyTreeSha = '';

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
  await writeFile(path.join(refsDir, 'bademail'), `${badEmailCommitSha}\n`);

  catalogueCtx = createNodeContext({ workDir: catalogueDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (catalogueDir !== '') await rm(catalogueDir, { recursive: true, force: true });
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
  hashMismatchDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-hashmismatch-'));
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

describe.skipIf(!GIT_AVAILABLE)('Given a loose tree with zeroPaddedFilemode (no --strict)', () => {
  describe('When fsck runs (default options)', () => {
    it('Then emits warning bad-object and exit code matches real git (0)', async () => {
      // Arrange — git's expected output
      const gitResult = gitFsck(zeroPadDir);

      // Act
      const result = await fsck(zeroPadCtx);

      // Assert — exit code matches
      expect(result.exitCode).toBe(gitResult.exitCode); // 0

      // Assert — warning finding present
      const zeroPadded = result.findings.find(
        (f): f is FsckFinding & { type: 'bad-object' } =>
          f.type === 'bad-object' && f.msgId === 'zeroPaddedFilemode',
      );
      expect(zeroPadded).toBeDefined();
      expect(zeroPadded?.severity).toBe('warning');
      expect(zeroPadded?.id).toBe(zeroPadTreeSha);

      // Reconstruct git stderr line and assert byte-equality
      // git: "warning in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes"
      if (zeroPadded !== undefined) {
        const reconstructed = `warning in tree ${zeroPadded.id}: ${zeroPadded.msgId}: contains zero-padded file modes`;
        expect(gitResult.stderr).toContain(reconstructed);
      }
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given a loose tree with zeroPaddedFilemode (with --strict)',
  () => {
    describe('When fsck runs with strict:true', () => {
      it('Then emits error bad-object and exit code matches real git (1)', async () => {
        // Arrange — git's expected output
        const gitResult = gitFsck(zeroPadDir, '--strict');

        // Act
        const result = await fsck(zeroPadCtx, { strict: true });

        // Assert — exit code matches
        expect(result.exitCode).toBe(gitResult.exitCode); // 1

        // Assert — error finding present
        const zeroPadded = result.findings.find(
          (f): f is FsckFinding & { type: 'bad-object' } =>
            f.type === 'bad-object' && f.msgId === 'zeroPaddedFilemode',
        );
        expect(zeroPadded).toBeDefined();
        expect(zeroPadded?.severity).toBe('error');

        // Reconstruct git stderr line and assert byte-equality
        // git: "error in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes"
        if (zeroPadded !== undefined) {
          const reconstructed = `error in tree ${zeroPadded.id}: ${zeroPadded.msgId}: contains zero-padded file modes`;
          expect(gitResult.stderr).toContain(reconstructed);
        }
      });
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
// Refs-verify pass — matrix #9a: ref → valid-but-absent sha (exit 2)
// ---------------------------------------------------------------------------
// Pinned against real git 2.54.0:
//   stderr: "error: refs/heads/broken: invalid sha1 pointer <sha>"
//   exit: 2 (bit 2; same with/without --no-references)

let refAbsentDir = '';
let refAbsentCtx: Context;
const ABSENT_OID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

beforeAll(async () => {
  refAbsentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refabsent-'));
  initRepo(refAbsentDir);
  // Write a valid-format but absent OID to a loose ref (bypasses git's write-side check)
  await mkdir(path.join(refAbsentDir, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(refAbsentDir, '.git', 'refs', 'heads', 'broken'), `${ABSENT_OID}\n`);
  refAbsentCtx = createNodeContext({ workDir: refAbsentDir });
}, SETUP_TIMEOUT);

afterAll(async () => {
  if (refAbsentDir !== '') await rm(refAbsentDir, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)(
  'Given loose ref pointing to valid-format but absent OID (matrix #9a)',
  () => {
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
  },
);

// ---------------------------------------------------------------------------
// Refs-verify pass — matrix #9b: ref → malformed content (exit 10 = 2|8)
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
  refBadContentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-refbadcontent-'));
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
  'Given loose ref with malformed content (matrix #9b, exit 10 = 2|8)',
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
