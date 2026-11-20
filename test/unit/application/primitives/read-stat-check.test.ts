import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { __resetSectionsCacheForTests } from '../../../../src/application/primitives/config-scoped-read.js';
import { commonGitDir } from '../../../../src/application/primitives/path-layout.js';
import { readStatCheck } from '../../../../src/application/primitives/read-stat-check.js';
import type { StatCheck } from '../../../../src/domain/git-index/stat-check.js';

const EXT_ON = '[extensions]\n\tworktreeConfig = true\n';
const ALL: StatCheck = { ctime: true, ownerAndInode: true };
const NO_CTIME: StatCheck = { ctime: false, ownerAndInode: true };
const MINIMAL: StatCheck = { ctime: false, ownerAndInode: false };

interface Row {
  readonly id: string;
  readonly local: string;
  readonly worktree: string;
  readonly expected: StatCheck;
}

const ROWS: ReadonlyArray<Row> = [
  { id: 'nothing set', local: '', worktree: '', expected: ALL },
  {
    id: 'trustctime false',
    local: '[core]\n\ttrustctime = false\n',
    worktree: '',
    expected: NO_CTIME,
  },
  {
    id: 'trustctime camel case',
    local: '[core]\n\ttrustCtime = no\n',
    worktree: '',
    expected: NO_CTIME,
  },
  {
    id: 'checkstat minimal',
    local: '[core]\n\tcheckstat = minimal\n',
    worktree: '',
    expected: MINIMAL,
  },
  {
    id: 'checkstat Minimal',
    local: '[core]\n\tcheckStat = Minimal\n',
    worktree: '',
    expected: MINIMAL,
  },
  {
    id: 'checkstat default',
    local: '[core]\n\tcheckstat = default\n',
    worktree: '',
    expected: ALL,
  },
  { id: 'checkstat bogus', local: '[core]\n\tcheckstat = bogus\n', worktree: '', expected: ALL },
  { id: 'checkstat valueless', local: '[core]\n\tcheckstat\n', worktree: '', expected: ALL },
  {
    id: 'checkstat minimal then bogus',
    local: '[core]\n\tcheckstat = minimal\n\tcheckstat = bogus\n',
    worktree: '',
    expected: MINIMAL,
  },
  {
    id: 'checkstat minimal then default',
    local: '[core]\n\tcheckstat = minimal\n\tcheckstat = default\n',
    worktree: '',
    expected: ALL,
  },
  {
    id: 'worktree default then minimal',
    local: EXT_ON,
    worktree: '[core]\n\tcheckstat = default\n\tcheckstat = minimal\n',
    expected: MINIMAL,
  },
  {
    id: 'worktree minimal then default',
    local: EXT_ON,
    worktree: '[core]\n\tcheckstat = minimal\n\tcheckstat = default\n',
    expected: ALL,
  },
  {
    id: 'trustctime false then true',
    local: '[core]\n\ttrustctime = false\n\ttrustctime = true\n',
    worktree: '',
    expected: ALL,
  },
  {
    id: 'trustctime true then false',
    local: '[core]\n\ttrustctime = true\n\ttrustctime = false\n',
    worktree: '',
    expected: NO_CTIME,
  },
  {
    id: 'worktree trustctime false over local true',
    local: `${EXT_ON}[core]\n\ttrustctime = true\n`,
    worktree: '[core]\n\ttrustctime = false\n',
    expected: NO_CTIME,
  },
  {
    id: 'worktree minimal over local default',
    local: `${EXT_ON}[core]\n\tcheckstat = default\n`,
    worktree: '[core]\n\tcheckstat = minimal\n',
    expected: MINIMAL,
  },
  {
    id: 'worktree default over local minimal',
    local: `${EXT_ON}[core]\n\tcheckstat = minimal\n`,
    worktree: '[core]\n\tcheckstat = default\n',
    expected: ALL,
  },
  {
    id: 'worktree bogus checkstat leaves local minimal',
    local: `${EXT_ON}[core]\n\tcheckstat = minimal\n`,
    worktree: '[core]\n\tcheckstat = bogus\n',
    expected: MINIMAL,
  },
  {
    id: 'worktree minimal then bogus',
    local: EXT_ON,
    worktree: '[core]\n\tcheckstat = minimal\n\tcheckstat = bogus\n',
    expected: MINIMAL,
  },
  {
    id: 'worktree file ignored with the extension off',
    local: '',
    worktree: '[core]\n\tcheckstat = minimal\n\ttrustctime = false\n',
    expected: ALL,
  },
  {
    id: 'worktree key under a subsection',
    local: EXT_ON,
    worktree: '[core "x"]\n\ttrustctime = false\n',
    expected: ALL,
  },
];

describe('primitives/read-stat-check', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe.each(ROWS)('Given the local and worktree files of row $id', (row) => {
    describe('When readStatCheck', () => {
      it('Then it resolves the fields git compares', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/config`, row.local);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config.worktree`, row.worktree);
        const sut = readStatCheck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual(row.expected);
      });
    });
  });
});
