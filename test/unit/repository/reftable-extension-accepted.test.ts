import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/error.js';
import { ObjectId, RefName } from '../../../src/domain/objects/index.js';
import { openRepository } from '../../../src/index.default.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
} from '../../fixtures/refs/reftable-writers.js';

const encode = (content: string): Uint8Array => new TextEncoder().encode(content);
const oidBytes = (fill: number): Uint8Array => new Uint8Array(20).fill(fill);
const hexOid = (fill: number): string => fill.toString(16).padStart(2, '0').repeat(20);

const MAIN_OID = hexOid(0xaa);
const UPDATED_OID = hexOid(0xbb);

/** A minimal one-record ref-block table: `refs/heads/main -> id`, mirroring
 *  `load-reftable-stack.test.ts`'s own `buildSimpleTable` helper. */
const buildSimpleTable = (refName: string, id: Uint8Array): Uint8Array => {
  const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name: refName, value: { kind: 'direct', id } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  return buildReftable({ ...headerSpec, blocks: [block] });
};

/**
 * A real `--ref-format=reftable` repository's minimal on-disk shape: a
 * loose `HEAD`, `objects/` and `refs/` directories (git-dir discovery's own
 * acceptance gate needs both), `refs/heads` as the compatibility-stub
 * REGULAR FILE real git leaves there (never a directory under reftable),
 * and one reftable table carrying `refs/heads/main`.
 */
const reftableRepoFiles = (): Record<string, Uint8Array> => ({
  '/repo/.git/config': encode(
    '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n',
  ),
  '/repo/.git/HEAD': encode('ref: refs/heads/main\n'),
  '/repo/.git/objects/info/packs': encode(''),
  '/repo/.git/refs/heads': encode('this repository uses the reftable format\n'),
  '/repo/.git/reftable/tables.list': encode('table1.ref\n'),
  '/repo/.git/reftable/table1.ref': buildSimpleTable('refs/heads/main', oidBytes(0xaa)),
});

describe('openRepository (memory shim) — the reftable acceptance-gate inverse', () => {
  describe('Given a repository declaring the reftable ref storage extension', () => {
    describe('When a ref is resolved', () => {
      it('Then it resolves instead of refusing', async () => {
        // Arrange
        const sut = await openRepository({ files: reftableRepoFiles() });

        // Act
        const result = await sut.primitives.resolveRef(RefName.from('refs/heads/main'));

        // Assert
        expect(result).toBe(MAIN_OID);
      });
    });

    describe('When a ref update is applied', () => {
      it('Then a ref update commits instead of refusing', async () => {
        // Arrange
        const sut = await openRepository({ files: reftableRepoFiles() });

        // Act
        await sut.primitives.updateRef(
          RefName.from('refs/heads/main'),
          ObjectId.from(UPDATED_OID),
          {
            reflogMessage: 'inverse test update',
          },
        );
        const result = await sut.primitives.resolveRef(RefName.from('refs/heads/main'));

        // Assert
        expect(result).toBe(UPDATED_OID);
      });
    });
  });
});

describe('openRepository (memory shim) — the unbacked-extension refuse set stays one entry', () => {
  describe('Given a repository declaring the compatObjectFormat extension', () => {
    describe('When openRepository runs', () => {
      it('Then compatObjectFormat is still refused', async () => {
        // Arrange
        const files = {
          '/repo/.git/config': encode(
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n',
          ),
          '/repo/.git/HEAD': encode('ref: refs/heads/main\n'),
          '/repo/.git/objects/info/packs': encode(''),
          '/repo/.git/refs/heads/main': encode(`${'0'.repeat(40)}\n`),
        };

        // Act
        let caught: unknown;
        try {
          await openRepository({ files });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
          extension: 'compatobjectformat',
          value: 'sha1',
        });
      });
    });
  });
});
