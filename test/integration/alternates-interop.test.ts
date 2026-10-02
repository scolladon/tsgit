/**
 * Cross-tool interop — alternate object stores. Borrowers are produced by real
 * git (`clone --shared`, `clone --reference`) or by hand-writing
 * `objects/info/alternates`; every row then compares what tsgit resolves with
 * what git 2.55 resolves for the same directory: the alternates list
 * (`count-objects -v` `alternate:` lines vs `repo.primitives.objectSources()`),
 * git's three stderr diagnostics (classified, since the library emits no
 * display string) vs `unusable[].reason`, and which blobs are readable.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         tsgit resolves, reads, enumerates and abbreviates across alternate object stores exactly where real git does
 *   interopSurface: packfile
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffTrees } from '../../src/application/primitives/diff-trees.js';
import { enumerateObjects } from '../../src/application/primitives/enumerate-objects.js';
import { resolveOidPrefix } from '../../src/application/primitives/resolve-oid-prefix.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { mutateMidxOrThrow, writeMultiPackIndex } from './midx-fixture-helpers.js';

const SETUP_TIMEOUT = 120_000;
const ROW_TIMEOUT = 30_000;
const POSIX = process.platform !== 'win32';
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0;
/** glibc and musl cap nested symlinks at 20; macOS keeps git's own fallback of 32. */
const SYMLINK_LIMIT_32 = process.platform === 'darwin';
const MIDX_SIGNATURE_FATAL =
  'multi-pack-index signature 0x58585858 does not match signature 0x4d494458';

let root: string;
const lockedPaths: string[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-alternates-')));
});

afterAll(() => {
  for (const locked of lockedPaths) chmodSync(locked, 0o755);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface Repo {
  readonly dir: string;
  readonly objects: string;
}

const configure = (dir: string): void => {
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
  ] as const) {
    runGit(['-C', dir, 'config', key, value]);
  }
  disableAutoMaintenance(dir);
};

const initBare = (rel: string): Repo => {
  const dir = path.join(root, rel);
  runGit(['init', '-q', '--bare', '-b', 'main', dir]);
  configure(dir);
  return { dir, objects: path.join(dir, 'objects') };
};

const initWorktree = (rel: string): Repo => {
  const dir = path.join(root, rel);
  runGit(['init', '-q', '-b', 'main', dir]);
  configure(dir);
  return { dir, objects: path.join(dir, '.git', 'objects') };
};

const blobIn = (repo: Repo, content: string): string =>
  runGit(['-C', repo.dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

const commitFile = (repo: Repo, file: string, content: string, message: string): void => {
  writeFileSync(path.join(repo.dir, file), content);
  runGit(['-C', repo.dir, 'add', file]);
  runGit(['-C', repo.dir, 'commit', '-q', '-m', message]);
};

const writeAlternates = (objects: string, bytes: string | Buffer): void => {
  mkdirSync(path.join(objects, 'info'), { recursive: true });
  writeFileSync(path.join(objects, 'info', 'alternates'), bytes);
};

const alternatesOf = (repo: Repo, ...targets: ReadonlyArray<string>): void =>
  writeAlternates(repo.objects, `${targets.join('\n')}\n`);

const linkTo = (target: string, linkPath: string): string => {
  symlinkSync(target, linkPath);
  return linkPath;
};

const lock = (target: string): void => {
  chmodSync(target, 0o000);
  lockedPaths.push(target);
};

const open = (dir: string): Promise<Repository> => openRepository({ cwd: dir });

// ---------------------------------------------------------------------------
// git-side view (count-objects) — the oracle
// ---------------------------------------------------------------------------

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 10,
  t: 9,
  r: 13,
  '"': 34,
  '\\': 92,
};
const OCTAL_ESCAPE = /^[0-7]{3}/;

const unquoteC = (text: string): string => {
  if (!text.startsWith('"')) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch));
      continue;
    }
    const octal = OCTAL_ESCAPE.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    i += 1;
    bytes.push(SIMPLE_ESCAPES[body.charAt(i)] ?? 0);
  }
  return Buffer.from(bytes).toString('utf8');
};

const NESTING_MESSAGE = /^error: (.*): ignoring alternate object stores, nesting too deep$/;

const classifyStderrLine = (line: string): string | undefined => {
  const nesting = NESTING_MESSAGE.exec(line);
  if (nesting !== null) return `nesting-too-deep:${nesting[1]}`;
  if (line.startsWith('error: unable to normalize alternate object path:')) return 'unresolvable';
  if (/^error: object directory .* does not exist; check /.test(line)) return 'not-a-directory';
  if (line.startsWith('warning: unable to access ')) return 'unreadable-list';
  return undefined;
};

interface SourcesView {
  readonly alternates: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

const gitSourcesOf = (dir: string): SourcesView => {
  const result = tryRunGitWithExit(['-C', dir, 'count-objects', '-v']);
  const alternates = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('alternate: '))
    .map((line) => unquoteC(line.slice('alternate: '.length)));
  const diagnostics = result.stderr
    .split('\n')
    .map(classifyStderrLine)
    .filter((entry): entry is string => entry !== undefined)
    .sort();
  return { alternates, diagnostics };
};

const tsgitSourcesOf = async (repo: Repository): Promise<SourcesView> => {
  const view = await repo.primitives.objectSources();
  return {
    alternates: view.sources.filter((source) => !source.local).map((source) => source.objectsDir),
    diagnostics: view.unusable
      .map((entry) =>
        entry.reason === 'nesting-too-deep' ? `nesting-too-deep:${entry.path}` : entry.reason,
      )
      .sort(),
  };
};

const gitReads = (dir: string, oid: string): boolean =>
  tryRunGitWithExit(['-C', dir, 'cat-file', '-e', oid]).exitCode === 0;

const tsgitReads = async (repo: Repository, oid: string): Promise<boolean> => {
  try {
    await repo.primitives.readObject(oid as ObjectId);
    return true;
  } catch (error) {
    if (error instanceof TsgitError) return false;
    throw error;
  }
};

// ---------------------------------------------------------------------------
// the generic scenario table: A-independent rows P, R, N, D, O, U
// ---------------------------------------------------------------------------

interface Fixture {
  readonly borrower: string;
  readonly blobs: ReadonlyArray<string>;
}

interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly runnable?: boolean;
  readonly build: () => Fixture;
  /** What the pin says git itself does — guards the oracle against a vacuous pass. */
  readonly alternates: number;
  readonly diagnostics: ReadonlyArray<string>;
  readonly readable: ReadonlyArray<boolean>;
}

const donorAt = (rel: string, content: string): { repo: Repo; oid: string } => {
  const repo = initBare(rel);
  return { repo, oid: blobIn(repo, content) };
};

/** `fmt.git` borrows from `a.git` through a hand-written list. */
const fileFixture = (
  id: string,
  listing: (abs: string, base: string) => string | Buffer,
): Fixture => {
  const a = donorAt(`${id}/a.git`, `${id}-a\n`);
  const borrower = initBare(`${id}/fmt.git`);
  writeAlternates(borrower.objects, listing(a.repo.objects, path.join(root, id)));
  return { borrower: borrower.dir, blobs: [a.oid] };
};

const quotedDonor = (id: string, dirName: string): { repo: Repo; oid: string } =>
  donorAt(`${id}/${dirName}/q.git`, `${id}-q\n`);

const chain = (id: string, length: number): { repos: Repo[]; blobs: string[] } => {
  const repos = Array.from({ length }, (_, i) => initBare(`${id}/n${i}.git`));
  const blobs = repos.map((repo, i) => blobIn(repo, `${id}-n${i}\n`));
  for (const [i, repo] of repos.slice(0, -1).entries()) {
    alternatesOf(repo, (repos[i + 1] as Repo).objects);
  }
  return { repos, blobs };
};

const grammarScenarios: ReadonlyArray<Scenario> = [
  {
    id: 'P1',
    title: 'comments only at column 0; blank and indented lines',
    build: () => fileFixture('P1', (abs) => `# c\n\n   \n  # indented\n${abs}\n`),
    alternates: 1,
    diagnostics: ['not-a-directory', 'not-a-directory'],
    readable: [true],
  },
  {
    id: 'P2',
    title: 'CRLF keeps the carriage return in the path',
    build: () => fileFixture('P2', (abs) => `${abs}\r\n`),
    alternates: 0,
    diagnostics: ['not-a-directory'],
    readable: [false],
  },
  {
    id: 'P3',
    title: 'trailing space is part of the path',
    build: () => fileFixture('P3', (abs) => `${abs} \n`),
    alternates: 0,
    diagnostics: ['not-a-directory'],
    readable: [false],
  },
  {
    id: 'P4',
    title: 'no final newline',
    build: () => fileFixture('P4', (abs) => abs),
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'P5',
    title: 'empty file',
    build: () => fileFixture('P5', () => ''),
    alternates: 0,
    diagnostics: [],
    readable: [false],
  },
  {
    id: 'P6',
    title: 'C-quoted newline escape',
    build: () => {
      const d = quotedDonor('P6', 'nl\nx');
      const borrower = initBare('P6/fmt.git');
      writeAlternates(borrower.objects, `"${path.join(root, 'P6')}/nl\\nx/q.git/objects"\n`);
      return { borrower: borrower.dir, blobs: [d.oid] };
    },
    runnable: POSIX,
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'P7',
    title: 'C-quoted octal space',
    build: () => {
      const d = quotedDonor('P7', 'sp ace');
      const borrower = initBare('P7/fmt.git');
      writeAlternates(borrower.objects, `"${path.join(root, 'P7')}/sp\\040ace/q.git/objects"\n`);
      return { borrower: borrower.dir, blobs: [d.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'P8',
    title: 'C-quoted octal UTF-8 bytes',
    build: () => {
      const d = quotedDonor('P8', 'é');
      const borrower = initBare('P8/fmt.git');
      writeAlternates(borrower.objects, `"${path.join(root, 'P8')}/\\303\\251/q.git/objects"\n`);
      return { borrower: borrower.dir, blobs: [d.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'P9',
    title: 'raw newline inside the quotes is one path',
    build: () => {
      const d = quotedDonor('P9', 'x\ny');
      const borrower = initBare('P9/fmt.git');
      writeAlternates(borrower.objects, `"${path.join(root, 'P9')}/x\ny/q.git/objects"\n`);
      return { borrower: borrower.dir, blobs: [d.oid] };
    },
    runnable: POSIX,
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'P10',
    title: 'unterminated quote falls back to an unquoted relative path',
    build: () => fileFixture('P10', (abs) => `"${abs}\n`),
    alternates: 0,
    diagnostics: ['unresolvable'],
    readable: [false],
  },
  {
    id: 'P11',
    title: 'bad escape falls back to an unquoted relative path',
    build: () => fileFixture('P11', (_abs, base) => `"${base}/a.git/x\\q/objects"\n`),
    alternates: 0,
    diagnostics: ['unresolvable'],
    readable: [false],
  },
  {
    id: 'P12',
    title: 'text after the closing quote becomes a second entry',
    build: () => fileFixture('P12', (abs) => `"${abs}" trailing\n`),
    alternates: 1,
    diagnostics: ['not-a-directory'],
    readable: [true],
  },
  {
    id: 'P13',
    title: 'parsing stops at a NUL byte',
    build: () => {
      const a = donorAt('P13/a.git', 'P13-a\n');
      const b = donorAt('P13/b.git', 'P13-b\n');
      const borrower = initBare('P13/fmt.git');
      writeAlternates(borrower.objects, Buffer.from(`${a.repo.objects}\n\0${b.repo.objects}\n`));
      return { borrower: borrower.dir, blobs: [a.oid, b.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true, false],
  },
  {
    id: 'P14',
    title: 'quoted relative path resolves against the holding directory',
    build: () => fileFixture('P14', () => '"../../a.git/objects"\n'),
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
];

const middleAndLeaf = (
  id: string,
): { borrower: Repo; middle: Repo; leaf: Repo; blobs: string[] } => {
  const borrower = initBare(`${id}/rel.git`);
  const middle = initBare(`${id}/middle.git`);
  const leaf = initBare(`${id}/sub/leaf.git`);
  return {
    borrower,
    middle,
    leaf,
    blobs: [blobIn(middle, `${id}-middle\n`), blobIn(leaf, `${id}-leaf\n`)],
  };
};

/** `b.git` lists the last of `length` absolute symlinks, each pointing at the previous one. */
const symlinkChainFixture = (id: string, length: number): Fixture => {
  const dd = donorAt(`${id}/dd.git`, `${id}-dd\n`);
  const borrower = initBare(`${id}/b.git`);
  mkdirSync(path.join(root, id, 'chain'));
  let previous = dd.repo.objects;
  for (let link = 1; link <= length; link++) {
    previous = linkTo(previous, path.join(root, id, 'chain', `l${link}`));
  }
  alternatesOf(borrower, previous);
  return { borrower: borrower.dir, blobs: [dd.oid] };
};

const resolutionScenarios: ReadonlyArray<Scenario> = [
  {
    id: 'R1',
    title: 'nested relative entries resolve against the holding directory',
    build: () => {
      const f = middleAndLeaf('R1');
      writeAlternates(f.borrower.objects, '../../middle.git/objects\n');
      writeAlternates(f.middle.objects, '../../sub/leaf.git/objects\n');
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    alternates: 2,
    diagnostics: [],
    readable: [true, true],
  },
  {
    id: 'R2',
    title: 'doubled and dotted separators are normalised',
    build: () => {
      const f = middleAndLeaf('R2');
      writeAlternates(f.borrower.objects, `${path.join(root, 'R2')}//middle.git/./objects///\n`);
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true, false],
  },
  {
    id: 'R3/U1',
    title: 'missing intermediate component is unresolvable and skipped',
    build: () => {
      const f = middleAndLeaf('R3');
      alternatesOf(f.borrower, `${path.join(root, 'R3')}/nope/nope2/objects`, f.middle.objects);
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    alternates: 1,
    diagnostics: ['unresolvable'],
    readable: [true, false],
  },
  {
    id: 'R4/U2',
    title: 'missing last component is not a directory and skipped',
    build: () => {
      const f = middleAndLeaf('R4');
      alternatesOf(f.borrower, `${f.middle.dir}/missing-objects`, f.middle.objects);
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    alternates: 1,
    diagnostics: ['not-a-directory'],
    readable: [true, false],
  },
  {
    id: 'R5/U2',
    title: 'an entry naming a regular file is not a directory',
    build: () => {
      const f = middleAndLeaf('R5');
      const file = path.join(root, 'R5', 'plain-file');
      writeFileSync(file, 'x');
      alternatesOf(f.borrower, file, f.middle.objects);
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    alternates: 1,
    diagnostics: ['not-a-directory'],
    readable: [true, false],
  },
  {
    id: 'R6',
    title: 'an entry through a symlink is stored as its realpath',
    build: () => {
      const f = middleAndLeaf('R6');
      const alias = linkTo(f.middle.dir, path.join(root, 'R6', 'middle-alias'));
      alternatesOf(f.borrower, `${alias}/objects`);
      return { borrower: f.borrower.dir, blobs: f.blobs };
    },
    runnable: POSIX,
    alternates: 1,
    diagnostics: [],
    readable: [true, false],
  },
  {
    id: 'R7',
    title: 'wrong-depth relative entry in a non-bare repo is unresolvable',
    build: () => {
      const nb = initWorktree('R7/nb');
      const dd = donorAt('R7/dd/.git', 'R7-dd\n');
      writeAlternates(nb.objects, '../../dd/.git/objects\n');
      return { borrower: nb.dir, blobs: [dd.oid] };
    },
    alternates: 0,
    diagnostics: ['unresolvable'],
    readable: [false],
  },
  {
    id: 'R8',
    title: 'an entry naming a repository root, not an objects dir, finds nothing',
    build: () => {
      const dd = donorAt('R8/dd', 'R8-dd\n');
      const borrower = initBare('R8/b.git');
      alternatesOf(borrower, dd.repo.dir);
      return { borrower: borrower.dir, blobs: [dd.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [false],
  },
  {
    id: 'R9',
    title: 'an entry reached through 34 chained symlinks is unresolvable',
    build: () => symlinkChainFixture('R9', 34),
    runnable: POSIX,
    alternates: 0,
    diagnostics: ['unresolvable'],
    readable: [false],
  },
  {
    id: 'R10',
    title: 'an entry reached through 33 chained symlinks resolves (32-symlink-limit builds)',
    build: () => symlinkChainFixture('R10', 33),
    runnable: SYMLINK_LIMIT_32,
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
];

const nestingScenarios: ReadonlyArray<Scenario> = [
  {
    id: 'N1',
    title: 'depth-5 source ignores its own entries, even for a local read',
    build: () => {
      const c = chain('N1', 9);
      return { borrower: (c.repos[0] as Repo).dir, blobs: c.blobs };
    },
    alternates: 6,
    diagnostics: [`nesting-too-deep:${path.join('<root>', 'N1', 'n6.git', 'objects')}`],
    readable: [true, true, true, true, true, true, true, false, false],
  },
  {
    id: 'N2',
    title: 'depth is relative to the opening repository',
    build: () => {
      const c = chain('N2', 9);
      return { borrower: (c.repos[1] as Repo).dir, blobs: c.blobs };
    },
    alternates: 6,
    diagnostics: [`nesting-too-deep:${path.join('<root>', 'N2', 'n7.git', 'objects')}`],
    readable: [false, true, true, true, true, true, true, true, false],
  },
  {
    id: 'N3',
    title: 'a depth-5 list of only comments reports nothing',
    build: () => {
      const c = chain('N3', 7);
      writeAlternates((c.repos[6] as Repo).objects, '# only\n\n');
      return { borrower: (c.repos[0] as Repo).dir, blobs: c.blobs };
    },
    alternates: 6,
    diagnostics: [],
    readable: [true, true, true, true, true, true, true],
  },
  {
    id: 'N4',
    title: 'a depth-5 list with one unresolvable entry reports only that entry',
    build: () => {
      const c = chain('N4', 7);
      writeAlternates(
        (c.repos[6] as Repo).objects,
        `${path.join(root, 'N4', 'nope', 'x', 'objects')}\n`,
      );
      return { borrower: (c.repos[0] as Repo).dir, blobs: c.blobs };
    },
    alternates: 6,
    diagnostics: ['unresolvable'],
    readable: [true, true, true, true, true, true, true],
  },
];

const duplicateScenarios: ReadonlyArray<Scenario> = [
  {
    id: 'D1',
    title: 'two repositories borrowing from each other and from themselves',
    build: () => {
      const cy1 = donorAt('D1/cy1.git', 'D1-1\n');
      const cy2 = donorAt('D1/cy2.git', 'D1-2\n');
      alternatesOf(cy1.repo, cy2.repo.objects, cy1.repo.objects);
      alternatesOf(cy2.repo, cy1.repo.objects, cy2.repo.objects);
      return { borrower: cy1.repo.dir, blobs: [cy1.oid, cy2.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true, true],
  },
  {
    id: 'D2',
    title: 'self, a repeated line and a trailing-slash spelling are skipped',
    build: () => {
      const dd = donorAt('D2/dd.git', 'D2-dd\n');
      const b = initBare('D2/b.git');
      alternatesOf(b, '.', dd.repo.objects, dd.repo.objects, `${dd.repo.objects}/`);
      return { borrower: b.dir, blobs: [dd.oid] };
    },
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'D3',
    title: 'self through a symlinked spelling is skipped',
    build: () => {
      const dd = donorAt('D3/dd.git', 'D3-dd\n');
      const b = initBare('D3/b.git');
      const alias = linkTo(b.dir, path.join(root, 'D3', 'b-alias.git'));
      alternatesOf(b, `${alias}/objects`, dd.repo.objects);
      return { borrower: b.dir, blobs: [dd.oid] };
    },
    runnable: POSIX,
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'D4',
    title: 'one donor listed under two spellings is deduped by realpath',
    build: () => {
      const dd = donorAt('D4/dd.git', 'D4-dd\n');
      const b = initBare('D4/b.git');
      const alias = linkTo(dd.repo.dir, path.join(root, 'D4', 'dd-alias.git'));
      alternatesOf(b, dd.repo.objects, `${alias}/objects`);
      return { borrower: b.dir, blobs: [dd.oid] };
    },
    runnable: POSIX,
    alternates: 1,
    diagnostics: [],
    readable: [true],
  },
  {
    id: 'O1',
    title: 'depth-first pre-order, deduped by realpath',
    build: () => {
      const names = ['P', 'X', 'Y', 'Z', 'W'] as const;
      const [p, x, y, z, w] = names.map((n) => donorAt(`O1/${n}.git`, `O1-${n}\n`));
      const alias = linkTo((w as { repo: Repo }).repo.dir, path.join(root, 'O1', 'W-alias.git'));
      const objs = (d: unknown): string => (d as { repo: Repo }).repo.objects;
      alternatesOf((p as { repo: Repo }).repo, objs(x), objs(y), `${objs(x)}/`);
      alternatesOf((x as { repo: Repo }).repo, objs(z));
      alternatesOf((y as { repo: Repo }).repo, objs(w));
      alternatesOf((z as { repo: Repo }).repo, objs(x), `${alias}/objects`);
      return {
        borrower: (p as { repo: Repo }).repo.dir,
        blobs: [x, y, z, w].map((d) => (d as { oid: string }).oid),
      };
    },
    runnable: POSIX,
    alternates: 4,
    diagnostics: [],
    readable: [true, true, true, true],
  },
];

const unusableScenarios: ReadonlyArray<Scenario> = [
  {
    id: 'U3',
    title: 'info/alternates that is a directory warns and adds nothing',
    build: () => {
      const b = initBare('U3/b.git');
      mkdirSync(path.join(b.objects, 'info', 'alternates'), { recursive: true });
      return { borrower: b.dir, blobs: [blobIn(b, 'U3-local\n')] };
    },
    alternates: 0,
    diagnostics: ['unreadable-list'],
    readable: [true],
  },
  {
    id: 'U3b',
    title: "an alternate's unreadable list is ignored, its objects stay readable",
    build: () => {
      const d = donorAt('U3b/d.git', 'U3b-d\n');
      const b = initBare('U3b/b.git');
      alternatesOf(b, d.repo.objects);
      writeAlternates(d.repo.objects, `${path.join(root, 'U3b', 'elsewhere')}\n`);
      lock(path.join(d.repo.objects, 'info', 'alternates'));
      return { borrower: b.dir, blobs: [d.oid] };
    },
    runnable: UNPRIVILEGED,
    alternates: 1,
    diagnostics: ['unreadable-list'],
    readable: [true],
  },
  {
    id: 'U4',
    title: 'alternate objects dir mode 000: stat succeeds, reads miss',
    build: () => {
      const d = donorAt('U4/d.git', 'U4-d\n');
      const b = initBare('U4/b.git');
      alternatesOf(b, d.repo.objects);
      lock(d.repo.objects);
      return { borrower: b.dir, blobs: [d.oid] };
    },
    runnable: UNPRIVILEGED,
    alternates: 1,
    diagnostics: ['unreadable-list'],
    readable: [false],
  },
  {
    id: 'U5',
    title: 'alternate fanout dir mode 000: the object is not found',
    build: () => {
      const d = donorAt('U5/d.git', 'U5-d\n');
      const b = initBare('U5/b.git');
      alternatesOf(b, d.repo.objects);
      lock(path.join(d.repo.objects, d.oid.slice(0, 2)));
      return { borrower: b.dir, blobs: [d.oid] };
    },
    runnable: UNPRIVILEGED,
    alternates: 1,
    diagnostics: [],
    readable: [false],
  },
];

const allScenarios: ReadonlyArray<Scenario> = [
  ...grammarScenarios,
  ...resolutionScenarios,
  ...nestingScenarios,
  ...duplicateScenarios,
  ...unusableScenarios,
];

const withRoot = (diagnostics: ReadonlyArray<string>): ReadonlyArray<string> =>
  diagnostics.map((d) => d.replace('<root>', root));

describe.skipIf(!GIT_AVAILABLE)('alternates interop — resolution parity with git', () => {
  describe.each(allScenarios)('Given $id: $title', (row) => {
    describe.skipIf(row.runnable === false)('When tsgit and git open the same borrower', () => {
      let fixture: Fixture;
      let repo: Repository;

      beforeAll(async () => {
        fixture = row.build();
        repo = await open(fixture.borrower);
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await repo.dispose();
      });

      it(
        'Then the alternates list is the one git prints, in git order',
        async () => {
          // Arrange
          const expected = gitSourcesOf(fixture.borrower);

          // Act
          const result = await tsgitSourcesOf(repo);

          // Assert
          expect(expected.alternates).toHaveLength(row.alternates);
          expect(result.alternates).toEqual(expected.alternates);
        },
        ROW_TIMEOUT,
      );

      it(
        'Then the unusable reasons are the diagnostics git prints',
        async () => {
          // Arrange
          const expected = gitSourcesOf(fixture.borrower);

          // Act
          const result = await tsgitSourcesOf(repo);

          // Assert
          expect(expected.diagnostics).toEqual([...withRoot(row.diagnostics)].sort());
          expect(result.diagnostics).toEqual(expected.diagnostics);
        },
        ROW_TIMEOUT,
      );

      it(
        'Then every blob is readable exactly where git reads it',
        async () => {
          // Arrange
          const expected = fixture.blobs.map((oid) => gitReads(fixture.borrower, oid));

          // Act
          const result = await Promise.all(fixture.blobs.map((oid) => tsgitReads(repo, oid)));

          // Assert
          expect(expected).toEqual(row.readable);
          expect(result).toEqual(expected);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// A — what clone writes, and plain reads on a borrower
// ---------------------------------------------------------------------------

const looseFanoutDirs = (objects: string): ReadonlyArray<string> =>
  readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name));

const packFiles = (objects: string): ReadonlyArray<string> => {
  const packDir = path.join(objects, 'pack');
  return existsSync(packDir) ? readdirSync(packDir).filter((name) => name.endsWith('.pack')) : [];
};

describe.skipIf(!GIT_AVAILABLE)('alternates interop — borrowers produced by git clone', () => {
  let donor: Repo;
  let shared: Repo;
  let referenced: Repo;
  let relative: Repo;

  beforeAll(() => {
    donor = initWorktree('d');
    commitFile(donor, 'f', 'd1\n', 'c1');
    commitFile(donor, 'f', 'd2\n', 'c2');
    runGit(['clone', '-q', '--shared', donor.dir, path.join(root, 's')]);
    runGit(['clone', '-q', '--reference', donor.dir, `file://${donor.dir}`, path.join(root, 'r')]);
    runGit(['-C', root, 'clone', '-q', '--shared', './d', 'rel']);
    shared = { dir: path.join(root, 's'), objects: path.join(root, 's', '.git', 'objects') };
    referenced = { dir: path.join(root, 'r'), objects: path.join(root, 'r', '.git', 'objects') };
    relative = { dir: path.join(root, 'rel'), objects: path.join(root, 'rel', '.git', 'objects') };
  }, SETUP_TIMEOUT);

  describe('Given A1: git clone --shared', () => {
    describe('When tsgit opens the borrower', () => {
      it('Then git wrote the absolute realpath and no local object, and tsgit lists that donor', async () => {
        // Arrange
        const repo = await open(shared.dir);

        // Act
        const result = await tsgitSourcesOf(repo);

        // Assert
        expect(readFileSync(path.join(shared.objects, 'info', 'alternates'), 'utf8')).toBe(
          `${donor.objects}\n`,
        );
        expect(looseFanoutDirs(shared.objects)).toEqual([]);
        expect(packFiles(shared.objects)).toEqual([]);
        expect(result).toEqual({ alternates: [donor.objects], diagnostics: [] });
        await repo.dispose();
      });
    });
  });

  describe('Given A2: git clone --reference', () => {
    describe('When tsgit opens the borrower', () => {
      it('Then the file bytes equal the shared clone and tsgit lists the donor', async () => {
        // Arrange
        const repo = await open(referenced.dir);

        // Act
        const result = await tsgitSourcesOf(repo);

        // Assert
        expect(readFileSync(path.join(referenced.objects, 'info', 'alternates'), 'utf8')).toBe(
          `${donor.objects}\n`,
        );
        expect(looseFanoutDirs(referenced.objects)).toEqual([]);
        expect(packFiles(referenced.objects)).toEqual([]);
        expect(result.alternates).toEqual([donor.objects]);
        await repo.dispose();
      });
    });
  });

  describe('Given A3: git clone --shared ./d', () => {
    describe('When tsgit opens the borrower', () => {
      it('Then git wrote an un-normalised absolute path that tsgit normalises', async () => {
        // Arrange
        const repo = await open(relative.dir);

        // Act
        const result = await tsgitSourcesOf(repo);

        // Assert
        expect(readFileSync(path.join(relative.objects, 'info', 'alternates'), 'utf8')).toBe(
          `${root}/./d/.git/objects\n`,
        );
        expect(result.alternates).toEqual([donor.objects]);
        await repo.dispose();
      });
    });
  });

  describe('Given A4: plain reads on the borrower', () => {
    describe('When tsgit reads the commit, blob, history, status and diff', () => {
      it('Then each agrees with git', async () => {
        // Arrange
        const head = runGit(['-C', shared.dir, 'rev-parse', 'HEAD']).trim();
        const parentTree = runGit(['-C', shared.dir, 'rev-parse', 'HEAD~1^{tree}']).trim();
        const headTree = runGit(['-C', shared.dir, 'rev-parse', 'HEAD^{tree}']).trim();
        const blob = runGit(['-C', shared.dir, 'rev-parse', 'HEAD:f']).trim();
        const repo = await open(shared.dir);

        // Act
        const commit = await repo.primitives.readObject(head as ObjectId);
        const content = await repo.primitives.readBlob(blob as ObjectId);
        const history = await repo.log();
        const status = await repo.status();
        const diff = await diffTrees(repo.ctx, parentTree as ObjectId, headTree as ObjectId, {
          withStat: true,
        });

        // Assert
        expect(runGit(['-C', shared.dir, 'cat-file', '-t', head]).trim()).toBe(commit.type);
        expect(new TextDecoder().decode(content.content)).toBe(
          runGit(['-C', shared.dir, 'cat-file', '-p', 'HEAD:f']),
        );
        expect(history.map((entry) => entry.message.trim())).toEqual(
          runGit(['-C', shared.dir, 'log', '--format=%s']).trim().split('\n'),
        );
        expect(status.clean).toBe(true);
        expect(status.branch).toBe('refs/heads/main');
        expect(diff.changes.map((c) => [c.added, c.deleted])).toEqual([[1, 1]]);
        await repo.dispose();
      });
    });
  });

  describe('Given A5: enumeration on the borrower', () => {
    describe('When tsgit enumerates every object', () => {
      it('Then it lists the objects git lists, donor objects included', async () => {
        // Arrange
        const expected = runGit([
          '-C',
          shared.dir,
          'cat-file',
          '--batch-all-objects',
          '--batch-check=%(objectname)',
        ])
          .trim()
          .split('\n')
          .sort();
        const repo = await open(shared.dir);

        // Act
        const result = [...(await enumerateObjects(repo.ctx))].sort();

        // Assert
        expect(expected).toHaveLength(6);
        expect(result).toEqual(expected);
        await repo.dispose();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// M — a multi-pack-index in an alternate
// ---------------------------------------------------------------------------

const midxFixture = (
  slug: string,
): { donor: Repo; borrower: Repo; localOid: string; donorOids: string[] } => {
  const donor = initWorktree(`${slug}-donor`);
  commitFile(donor, 'f', `${slug}-1\n`, 'c1');
  commitFile(donor, 'g', `${slug}-2\n`, 'c2');
  runGit(['-C', donor.dir, 'repack', '-ad', '-q']);
  writeMultiPackIndex(donor.dir);
  const borrowerDir = path.join(root, `${slug}-borrower`);
  runGit(['clone', '-q', '--shared', donor.dir, borrowerDir]);
  configure(borrowerDir);
  const borrower = { dir: borrowerDir, objects: path.join(borrowerDir, '.git', 'objects') };
  const donorOids = runGit(['-C', donor.dir, 'rev-list', '--objects', '--all'])
    .trim()
    .split('\n')
    .map((line) => line.split(' ')[0] as string);
  return { donor, borrower, localOid: blobIn(borrower, `${slug}-local\n`), donorOids };
};

const smashMidxSignature = (donor: Repo): void =>
  mutateMidxOrThrow(path.join(donor.objects, 'pack', 'multi-pack-index'), (bytes) => {
    bytes.write('XXXX', 0, 'latin1');
    return bytes;
  });

const rejectionOf = async (action: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof TsgitError) return error;
    throw error;
  }
  return expect.fail('expected a TsgitError');
};

describe.skipIf(!GIT_AVAILABLE)('alternates interop — multi-pack-index in an alternate', () => {
  describe('Given M1: a healthy donor midx', () => {
    describe('When tsgit reads donor objects through the borrower', () => {
      it('Then every donor object reads, as in git', async () => {
        // Arrange
        const fx = midxFixture('M1');
        const repo = await open(fx.borrower.dir);

        // Act
        const result = await Promise.all(fx.donorOids.map((oid) => tsgitReads(repo, oid)));

        // Assert
        expect(fx.donorOids.map((oid) => gitReads(fx.borrower.dir, oid))).toEqual(result);
        expect(result.every(Boolean)).toBe(true);
        await repo.dispose();
      });
    });
  });

  describe('Given M2: a donor midx whose signature is smashed', () => {
    describe('When tsgit reads a local loose object', () => {
      it('Then it reads, and git agrees (the alternate midx is never loaded)', async () => {
        // Arrange
        const fx = midxFixture('M2');
        smashMidxSignature(fx.donor);
        const repo = await open(fx.borrower.dir);

        // Act
        const result = await tsgitReads(repo, fx.localOid);

        // Assert
        expect(gitReads(fx.borrower.dir, fx.localOid)).toBe(true);
        expect(result).toBe(true);
        await repo.dispose();
      });
    });
  });

  describe('Given M3: a donor midx whose signature is smashed', () => {
    describe('When tsgit reads a donor object', () => {
      it('Then it refuses with the signature check, as git dies 128', async () => {
        // Arrange
        const fx = midxFixture('M3');
        smashMidxSignature(fx.donor);
        const repo = await open(fx.borrower.dir);
        const target = fx.donorOids[0] as string;

        // Act
        const result = await rejectionOf(() => repo.primitives.readObject(target as ObjectId));
        const git = tryRunGitWithExit(['-C', fx.borrower.dir, 'cat-file', '-p', target]);

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(MIDX_SIGNATURE_FATAL);
        expect(result.data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' });
        await repo.dispose();
      });
    });
  });

  describe('Given M4: a donor midx whose signature is smashed', () => {
    describe('When the borrower is fsck-ed', () => {
      it('Then fsck refuses with the signature check, as git dies 128', async () => {
        // Arrange
        const fx = midxFixture('M4');
        smashMidxSignature(fx.donor);
        const repo = await open(fx.borrower.dir);

        // Act
        const result = await rejectionOf(() => repo.fsck());
        const git = tryRunGitWithExit(['-C', fx.borrower.dir, 'fsck']);

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(MIDX_SIGNATURE_FATAL);
        expect(result.data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' });
        await repo.dispose();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// X — abbreviation across stores
// ---------------------------------------------------------------------------

const PREFIX_LENGTH = 7;
const SEARCH_LIMIT = 2_000_000;

const blobOidOf = (content: string): string =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest('hex');

const findPrefixCollision = (): readonly [string, string] => {
  const seen = new Map<string, string>();
  for (let i = 0; i < SEARCH_LIMIT; i += 1) {
    const content = `collide-${i}\n`;
    const prefix = blobOidOf(content).slice(0, PREFIX_LENGTH);
    const earlier = seen.get(prefix);
    if (earlier !== undefined) return [earlier, content];
    seen.set(prefix, content);
  }
  throw new Error('no 7-hex prefix collision found');
};

const commonPrefixLength = (ids: ReadonlyArray<string>): number => {
  const [first = '', ...rest] = ids;
  let length = 0;
  while (rest.every((id) => id.charAt(length) === first.charAt(length))) length += 1;
  return length;
};

const candidatesOf = async (repo: Repository, prefix: string): Promise<ReadonlyArray<string>> => {
  const error = await rejectionOf(() => resolveOidPrefix(repo.ctx, prefix));
  if (error.data.code !== 'AMBIGUOUS_OID_PREFIX')
    return expect.fail(`unexpected ${error.data.code}`);
  return error.data.candidates;
};

describe.skipIf(!GIT_AVAILABLE)('alternates interop — abbreviation across stores', () => {
  let donor: Repo;
  let borrower: Repo;
  let donorOid: string;
  let borrowerOid: string;
  let prefix: string;

  beforeAll(() => {
    const [x, y] = findPrefixCollision();
    donor = initWorktree('X-donor');
    donorOid = blobIn(donor, x);
    runGit(['clone', '-q', '--shared', donor.dir, path.join(root, 'X-borrower')]);
    borrower = {
      dir: path.join(root, 'X-borrower'),
      objects: path.join(root, 'X-borrower', '.git', 'objects'),
    };
    configure(borrower.dir);
    borrowerOid = blobIn(borrower, y);
    prefix = donorOid.slice(0, PREFIX_LENGTH);
  }, SETUP_TIMEOUT);

  describe('Given X1: two blobs sharing a 7-hex prefix across the stores', () => {
    describe('When the abbreviation length is reconstructed from the ambiguity data', () => {
      it('Then it is the length git prints for each blob, and 7 in the donor alone', async () => {
        // Arrange
        const repo = await open(borrower.dir);
        const donorOnly = await open(donor.dir);

        // Act
        const candidates = await candidatesOf(repo, prefix);
        const length = Math.max(PREFIX_LENGTH, commonPrefixLength(candidates) + 1);
        const alone = await resolveOidPrefix(donorOnly.ctx, prefix);

        // Assert
        for (const oid of [donorOid, borrowerOid]) {
          const printed = runGit([
            '-C',
            borrower.dir,
            'rev-parse',
            `--short=${PREFIX_LENGTH}`,
            oid,
          ]).trim();
          expect(oid.slice(0, length)).toBe(printed);
        }
        expect(
          runGit(['-C', donor.dir, 'rev-parse', `--short=${PREFIX_LENGTH}`, donorOid]).trim(),
        ).toBe(prefix);
        expect(alone).toBe(donorOid);
        await repo.dispose();
        await donorOnly.dispose();
      });
    });
  });

  describe('Given X2: the shared prefix', () => {
    describe('When it is resolved in the borrower', () => {
      it("Then tsgit's ambiguity data reconstructs git's message and hints", async () => {
        // Arrange
        const repo = await open(borrower.dir);
        const git = tryRunGitWithExit(['-C', borrower.dir, 'rev-parse', prefix]);

        // Act
        const candidates = [...(await candidatesOf(repo, prefix))].sort();
        const length = Math.max(PREFIX_LENGTH, commonPrefixLength(candidates) + 1);
        const hints = candidates.map((oid) => `hint:   ${oid.slice(0, length)} blob`);

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(`error: short object ID ${prefix} is ambiguous`);
        expect(
          git.stderr.split('\n').filter((line) => /^hint:\s+[0-9a-f]+ blob$/.test(line)),
        ).toEqual(hints);
        expect(candidates).toEqual([donorOid, borrowerOid].sort());
        await repo.dispose();
      });
    });
  });

  describe('Given X3: a longer prefix naming only the donor object', () => {
    describe('When it is resolved in the borrower', () => {
      it('Then tsgit resolves to the donor object, as git does', async () => {
        // Arrange
        const longer = donorOid.slice(0, 12);
        const repo = await open(borrower.dir);

        // Act
        const result = await resolveOidPrefix(repo.ctx, longer);

        // Assert
        expect(runGit(['-C', borrower.dir, 'rev-parse', longer]).trim()).toBe(donorOid);
        expect(result).toBe(donorOid);
        await repo.dispose();
      });
    });
  });

  describe('Given X4: the collision across the stores and the donor alone', () => {
    describe('When abbreviateObjectId runs in each repository', () => {
      it("Then it returns git's rev-parse --short for every object", async () => {
        // Arrange
        const borrowerRepo = await open(borrower.dir);
        const donorRepo = await open(donor.dir);
        const shortIn = (dir: string, oid: string): string =>
          runGit(['-C', dir, 'rev-parse', '--short', oid]).trim();

        // Act
        const borrowed = await Promise.all(
          [donorOid, borrowerOid].map((oid) =>
            borrowerRepo.primitives.abbreviateObjectId(oid as ObjectId),
          ),
        );
        const alone = await donorRepo.primitives.abbreviateObjectId(donorOid as ObjectId);

        // Assert
        expect(borrowed).toEqual([donorOid, borrowerOid].map((oid) => shortIn(borrower.dir, oid)));
        expect(borrowed[0]?.length).toBeGreaterThan(PREFIX_LENGTH);
        expect(alone).toBe(shortIn(donor.dir, donorOid));
        expect(alone).toBe(prefix);
        await borrowerRepo.dispose();
        await donorRepo.dispose();
      });
    });
  });
});
