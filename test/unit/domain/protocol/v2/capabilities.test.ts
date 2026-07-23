import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../../src/domain/error.js';
import type { PktLine } from '../../../../../src/domain/protocol/pkt-line.js';
import {
  parseV2Capabilities,
  supportsV2Fetch,
} from '../../../../../src/domain/protocol/v2/capabilities.js';

async function* streamOf(lines: ReadonlyArray<string>): AsyncIterable<PktLine> {
  const encoder = new TextEncoder();
  for (const line of lines) {
    yield { kind: 'data', payload: encoder.encode(line) };
  }
  yield { kind: 'flush' };
}

const FULL_ADVERTISEMENT = [
  'version 2\n',
  'agent=git/2.55.0-Darwin\n',
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'server-option\n',
  'object-format=sha1\n',
];

describe('parseV2Capabilities', () => {
  describe('Given a version-2 capability advertisement', () => {
    describe('When parsed', () => {
      it('Then version is 2, commands include ls-refs and fetch, objectFormat is sha1', async () => {
        // Arrange
        const sut = parseV2Capabilities;

        // Act
        const caps = await sut(streamOf(FULL_ADVERTISEMENT));

        // Assert
        expect(caps.version).toBe(2);
        expect(caps.agent).toBe('git/2.55.0-Darwin');
        expect(caps.commands.has('ls-refs')).toBe(true);
        expect(caps.commands.has('fetch')).toBe(true);
        expect(caps.objectFormat).toBe('sha1');
        expect(supportsV2Fetch(caps)).toBe(true);
      });
    });
  });

  describe('Given a version-2 advertisement carrying an unrecognised command line', () => {
    describe('When parsed', () => {
      it('Then commands omits the unrecognised name', async () => {
        // Arrange & Act — FULL_ADVERTISEMENT carries `server-option\n`, a
        // real v2 capability this client does not implement.
        const caps = await parseV2Capabilities(streamOf(FULL_ADVERTISEMENT));

        // Assert
        expect(caps.commands.has('server-option')).toBe(false);
      });
    });
  });

  describe('Given a version-2 advertisement missing the fetch command', () => {
    describe('When supportsV2Fetch is checked', () => {
      it('Then it returns false', async () => {
        // Arrange
        const advertisement = ['version 2\n', 'ls-refs=unborn\n', 'object-format=sha1\n'];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(supportsV2Fetch(caps)).toBe(false);
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch command advertises filter', () => {
    describe('When parsed', () => {
      it('Then fetchFeatures includes filter', async () => {
        // Arrange
        const advertisement = [
          'version 2\n',
          'ls-refs=unborn\n',
          'fetch=shallow wait-for-done filter\n',
          'object-format=sha1\n',
        ];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(caps.fetchFeatures.has('filter')).toBe(true);
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch command does not advertise filter', () => {
    describe('When parsed', () => {
      it('Then fetchFeatures omits filter', async () => {
        // Arrange & Act
        const caps = await parseV2Capabilities(streamOf(FULL_ADVERTISEMENT));

        // Assert
        expect(caps.fetchFeatures.has('filter')).toBe(false);
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch command has no feature list', () => {
    describe('When parsed', () => {
      it('Then fetchFeatures is empty', async () => {
        // Arrange
        const advertisement = ['version 2\n', 'ls-refs\n', 'fetch\n', 'object-format=sha1\n'];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(caps.fetchFeatures.size).toBe(0);
      });
    });
  });

  describe('Given a version-2 advertisement whose fetch value has a doubled separator space', () => {
    describe('When parsed', () => {
      it('Then fetchFeatures never contains an empty string', async () => {
        // Arrange
        const advertisement = [
          'version 2\n',
          'ls-refs\n',
          'fetch=shallow  wait-for-done\n',
          'object-format=sha1\n',
        ];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(caps.fetchFeatures.has('')).toBe(false);
        expect(caps.fetchFeatures).toEqual(new Set(['shallow', 'wait-for-done']));
      });
    });
  });

  describe('Given a version-2 advertisement whose ls-refs command carries its own value', () => {
    describe('When parsed', () => {
      it('Then fetchFeatures stays empty — only the fetch value feeds it', async () => {
        // Arrange
        const advertisement = [
          'version 2\n',
          'ls-refs=unborn\n',
          'fetch\n',
          'object-format=sha1\n',
        ];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(caps.fetchFeatures.size).toBe(0);
      });
    });
  });

  describe('Given an advertisement stream that parseV2Capabilities rejects', () => {
    describe('When parsed', () => {
      it.each([
        {
          advertisement: ['0000000000000000000000000000000000000000 HEAD\n'],
          data: {
            code: 'V2_COMMAND_UNSUPPORTED',
            command: '0000000000000000000000000000000000000000 HEAD',
          },
          label: 'it throws V2_COMMAND_UNSUPPORTED carrying the offending line',
        },
        {
          advertisement: [] as ReadonlyArray<string>,
          data: { code: 'V2_COMMAND_UNSUPPORTED', command: '' },
          label: 'it throws V2_COMMAND_UNSUPPORTED for an empty stream',
        },
        {
          advertisement: ['version 2\n', 'ls-refs\n', 'fetch\n', 'object-format=sha256\n'],
          data: { code: 'UNSUPPORTED_OBJECT_FORMAT', format: 'sha256' },
          label: 'it throws UNSUPPORTED_OBJECT_FORMAT carrying the offending format',
        },
        {
          advertisement: ['version 2\n', 'object-format\n'],
          data: { code: 'UNSUPPORTED_OBJECT_FORMAT', format: '' },
          label: 'it throws UNSUPPORTED_OBJECT_FORMAT carrying an empty format',
        },
      ])('Then $label', async ({ advertisement, data }) => {
        // Arrange & Act
        let sut: unknown;
        try {
          await parseV2Capabilities(streamOf(advertisement));
        } catch (e) {
          sut = e;
        }

        // Assert
        expect(sut).toBeInstanceOf(TsgitError);
        expect((sut as TsgitError).data).toEqual(data);
      });
    });
  });

  describe('Given a version-2 advertisement with no optional capability lines', () => {
    describe('When parsed', () => {
      it('Then agent is absent and objectFormat defaults to sha1', async () => {
        // Arrange
        const advertisement = ['version 2\n'];

        // Act
        const caps = await parseV2Capabilities(streamOf(advertisement));

        // Assert
        expect(Object.hasOwn(caps, 'agent')).toBe(false);
        expect(caps.objectFormat).toBe('sha1');
        expect(caps.commands.size).toBe(0);
      });
    });
  });

  describe('Given a version line with no trailing newline', () => {
    describe('When parsed', () => {
      it('Then it is still recognised as version 2', async () => {
        // Arrange
        async function* stream(): AsyncIterable<PktLine> {
          yield { kind: 'data', payload: new TextEncoder().encode('version 2') };
          yield { kind: 'flush' };
        }

        // Act
        const caps = await parseV2Capabilities(stream());

        // Assert
        expect(caps.version).toBe(2);
      });
    });
  });
});
